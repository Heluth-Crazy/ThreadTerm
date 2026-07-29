use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
#[cfg(all(windows, test))]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const NOTIFICATION_EVENT: &str = "codex-app://notification";
const REQUEST_EVENT: &str = "codex-app://request";
const DISCONNECTED_EVENT: &str = "codex-app://disconnected";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);

type PendingRequest = oneshot::Sender<Result<Value, String>>;
type PendingMap = Arc<Mutex<HashMap<u64, PendingRequest>>>;

use crate::service_child::{
    spawn_managed_service_child as spawn_managed_codex_child,
    ManagedServiceChild as ManagedCodexChild,
};

static CODEX_APP_MANAGER: Lazy<CodexAppManager> = Lazy::new(CodexAppManager::default);
static CLIENT_MESSAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct CodexAppManager {
    state: Mutex<CodexAppState>,
}

#[derive(Default)]
struct CodexAppState {
    child: Option<ManagedCodexChild>,
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

/// Paginated `thread/list` for the on-demand Agent Session Catalog.
/// Discovery-only: does not create/resume threads or open cards.
pub async fn list_threads_raw(app: &AppHandle, params: Value) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(app).await?;
    CODEX_APP_MANAGER.send_request("thread/list", params).await
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
        provider_session_id: Option<String>,
    ) -> Result<CodexAppOpenCardResult, String> {
        self.ensure_initialized(&app).await?;
        let provider_session_id = clean_optional_string(provider_session_id);

        // A cwd is not a session ownership boundary: the raw Codex TUI may
        // already be driving its latest CLI thread. Only resume the card's
        // explicit app thread after inspecting it, otherwise create a fresh one.
        if let Some(thread_id) = clean_optional_string(codex_app_thread_id) {
            match self.read_thread(&thread_id).await {
                Ok(candidate)
                    if is_safe_app_thread_resume(
                        &candidate,
                        &thread_id,
                        provider_session_id.as_deref(),
                    ) =>
                {
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
                Ok(candidate) => {
                    tracing::debug!(
                        thread_id = %thread_id,
                        source = ?thread_source_kind(&candidate),
                        "Skipped a Codex CLI-owned thread for app-server isolation"
                    );
                }
                Err(err) => {
                    tracing::debug!(
                        thread_id = %thread_id,
                        error = %err,
                        "Codex app-server could not inspect its resume candidate"
                    );
                }
            }
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

    async fn read_thread(&self, thread_id: &str) -> Result<Value, String> {
        let response = self
            .send_request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": false,
                }),
            )
            .await?;
        extract_thread(response)
            .ok_or_else(|| "Codex app-server returned no thread for thread/read".to_string())
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
            .stderr(Stdio::piped());

        let mut child = spawn_managed_codex_child(command)
            .map_err(|err| format!("Failed to start `{}`: {err}", launch.display()))?;

        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
        let stderr = child.stderr().take();
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

fn thread_source_kind(thread: &Value) -> Option<&str> {
    ["source", "sourceKind", "threadSource"]
        .into_iter()
        .find_map(|key| {
            let source = thread.get(key)?;
            source
                .as_str()
                .or_else(|| source.get("type").and_then(Value::as_str))
        })
}

fn is_safe_app_thread_resume(
    thread: &Value,
    thread_id: &str,
    provider_session_id: Option<&str>,
) -> bool {
    if provider_session_id.is_some_and(|provider_session_id| {
        provider_session_id == thread_id
            || thread.get("sessionId").and_then(Value::as_str) == Some(provider_session_id)
    }) {
        return false;
    }

    !thread_source_kind(thread).is_some_and(|source| source.eq_ignore_ascii_case("cli"))
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
    let sequence = CLIENT_MESSAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{}-{sequence}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn windows_process_is_running(pid: u32) -> bool {
        use std::os::windows::process::CommandExt;

        let output = std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW.0)
            .output()
            .expect("query Windows process list");
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }

    #[cfg(windows)]
    async fn wait_for_windows_process_exit(pid: u32) -> bool {
        for _ in 0..20 {
            if !windows_process_is_running(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[cfg(windows)]
    fn windows_child_process_id(parent_pid: u32, executable: &str) -> Option<u32> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
        while next.is_ok() {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if entry.th32ParentProcessID == parent_pid && name.eq_ignore_ascii_case(executable) {
                found = Some(entry.th32ProcessID);
                break;
            }
            next = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) }.ok();
        found
    }

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
    fn client_message_suffix_is_unique_during_bursts() {
        let suffixes = (0..1_000)
            .map(|_| next_client_message_suffix())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(suffixes.len(), 1_000);
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
    fn app_thread_resume_rejects_cli_owned_threads() {
        assert!(!is_safe_app_thread_resume(
            &json!({
                "id": "thread-cli",
                "sessionId": "session-cli",
                "source": "cli"
            }),
            "thread-cli",
            None,
        ));
        assert!(!is_safe_app_thread_resume(
            &json!({
                "id": "thread-cli",
                "sourceKind": {"type": "CLI"}
            }),
            "thread-cli",
            None,
        ));
    }

    #[test]
    fn app_thread_resume_rejects_provider_session_aliases() {
        assert!(!is_safe_app_thread_resume(
            &json!({
                "id": "thread-shared",
                "sessionId": "provider-session",
                "source": "vscode"
            }),
            "thread-shared",
            Some("thread-shared"),
        ));
        assert!(!is_safe_app_thread_resume(
            &json!({
                "id": "thread-app",
                "sessionId": "provider-session",
                "source": "vscode"
            }),
            "thread-app",
            Some("provider-session"),
        ));
    }

    #[test]
    fn app_thread_resume_accepts_isolated_app_threads() {
        assert!(is_safe_app_thread_resume(
            &json!({
                "id": "thread-app",
                "sessionId": "session-app",
                "source": "vscode"
            }),
            "thread-app",
            Some("provider-session"),
        ));
        assert!(is_safe_app_thread_resume(
            &json!({"id": "thread-future"}),
            "thread-future",
            None,
        ));
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

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_windows_process_allows_normal_exit() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/s", "/c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut child = spawn_managed_codex_child(command).expect("spawn managed command");
        let status = child.wait().await.expect("wait for managed command");
        assert!(status.success());
    }

    #[cfg(windows)]
    #[test]
    fn managed_windows_process_reports_spawn_failure() {
        let command = Command::new(format!(
            "threadterm-missing-managed-process-{}.exe",
            std::process::id()
        ));
        assert!(spawn_managed_codex_child(command).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dropping_managed_windows_process_ends_descendant_tree() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/s", "/c", "ping.exe -t 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = spawn_managed_codex_child(command).expect("spawn managed process tree");
        let parent_pid = child.id().expect("managed parent pid");
        let descendant_pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(pid) = windows_child_process_id(parent_pid, "ping.exe") {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("descendant pid timeout");

        assert!(windows_process_is_running(parent_pid));
        assert!(windows_process_is_running(descendant_pid));

        drop(child);

        assert!(wait_for_windows_process_exit(parent_pid).await);
        assert!(wait_for_windows_process_exit(descendant_pid).await);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_windows_process_tree_ends_after_owner_crash() {
        use std::os::windows::process::CommandExt;

        let marker = std::env::temp_dir().join(format!(
            "threadterm-managed-crash-{}.txt",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker);
        let status =
            std::process::Command::new(std::env::current_exe().expect("current test executable"))
                .args([
                    "--exact",
                    "codex_app::tests::managed_windows_process_crash_helper",
                    "--nocapture",
                ])
                .env("THREADTERM_MANAGED_CRASH_MARKER", &marker)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW.0)
                .status()
                .expect("run managed process crash helper");
        assert!(!status.success());

        let marker_text = std::fs::read_to_string(&marker).expect("read managed crash marker");
        let (parent_pid, descendant_pid) = marker_text
            .trim()
            .split_once(':')
            .expect("managed crash marker format");
        let parent_pid = parent_pid.parse::<u32>().expect("parse managed parent pid");
        let descendant_pid = descendant_pid
            .parse::<u32>()
            .expect("parse managed descendant pid");
        let _ = std::fs::remove_file(&marker);

        assert!(wait_for_windows_process_exit(parent_pid).await);
        assert!(wait_for_windows_process_exit(descendant_pid).await);
    }

    #[cfg(windows)]
    #[test]
    fn managed_windows_process_crash_helper() {
        let Some(marker) = std::env::var_os("THREADTERM_MANAGED_CRASH_MARKER") else {
            return;
        };

        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/s", "/c", "ping.exe -t 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_managed_codex_child(command).expect("spawn crash helper process tree");
        let parent_pid = child.id().expect("crash helper parent pid");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let descendant_pid = loop {
            if let Some(pid) = windows_child_process_id(parent_pid, "ping.exe") {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "crash helper descendant pid timeout"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        std::fs::write(marker, format!("{parent_pid}:{descendant_pid}"))
            .expect("write managed crash marker");

        std::mem::forget(child);
        std::process::abort();
    }
}
