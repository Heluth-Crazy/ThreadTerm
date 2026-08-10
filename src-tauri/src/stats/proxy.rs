//! Loopback-only usage proxy.
//!
//! The proxy is deliberately scoped to provider-specific routes and an
//! ephemeral random path. It forwards bytes to an explicit upstream allowlist
//! and records only usage metadata after the response stream completes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use super::pricing;
use super::types::UsageSummary;

const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CAPTURED_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsProxyConfig {
    pub anthropic_upstream: Option<String>,
    pub openai_upstream: Option<String>,
    pub gemini_upstream: Option<String>,
    pub xai_upstream: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsProxyStatus {
    pub running: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub route_prefix: Option<String>,
}

struct Runtime {
    status: StatsProxyStatus,
    stop: Option<oneshot::Sender<()>>,
    project_routes: SharedProjectRoutes,
}

#[derive(Clone)]
struct ProxyState {
    config: Arc<ValidatedProxyConfig>,
    client: Client,
    project_routes: SharedProjectRoutes,
}

type SharedProjectRoutes = Arc<Mutex<ProjectRouteRegistry>>;

#[derive(Default)]
struct ProjectRouteRegistry {
    by_token: HashMap<String, String>,
    by_project: HashMap<String, String>,
}

impl ProjectRouteRegistry {
    fn register(&mut self, project_path: &str) -> Option<String> {
        let project_path = project_path.trim();
        if project_path.is_empty() {
            return None;
        }
        let key = normalize_project_route_path(project_path);
        if key.is_empty() {
            return None;
        }
        if let Some(token) = self.by_project.get(&key) {
            return Some(token.clone());
        }

        let token = format!("project-{:016x}", rand::thread_rng().gen::<u64>());
        self.by_project.insert(key, token.clone());
        self.by_token
            .insert(token.clone(), project_path.to_string());
        Some(token)
    }

    fn resolve(&self, token: &str) -> Option<String> {
        self.by_token.get(token).cloned()
    }
}

/// Owns the final write for one response stream. A client can disconnect by
/// dropping the response body before the upstream reaches EOF; `Drop` keeps
/// that request visible instead of losing its status/timing metadata.
struct ProxyStreamFinalizer {
    captured: Arc<Mutex<Vec<u8>>>,
    provider: String,
    request_id: String,
    model: String,
    project_path: Option<String>,
    status_code: i64,
    first_token_ms: Option<u64>,
    started: Instant,
    streaming: bool,
    finalized: bool,
}

impl ProxyStreamFinalizer {
    fn finalize(&mut self, error: Option<String>) {
        if self.finalized {
            return;
        }
        self.finalized = true;
        finalize_proxy_record(
            &self.captured,
            &self.provider,
            &self.request_id,
            &self.model,
            self.project_path.as_deref(),
            self.status_code,
            error,
            self.first_token_ms,
            self.started,
            self.streaming,
        );
    }
}

impl Drop for ProxyStreamFinalizer {
    fn drop(&mut self) {
        self.finalize(Some(
            "client disconnected before response completed".to_string(),
        ));
    }
}

#[derive(Clone, Debug)]
struct ValidatedProxyConfig {
    anthropic_upstream: String,
    openai_upstream: String,
    gemini_upstream: String,
    xai_upstream: String,
}

static RUNTIME: Lazy<Mutex<Option<Runtime>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
pub async fn stats_proxy_start(
    config: Option<StatsProxyConfig>,
) -> Result<StatsProxyStatus, String> {
    if let Some(runtime) = RUNTIME
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
    {
        return Ok(runtime.status.clone());
    }

    let config = validate_config(config.unwrap_or_default())?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Failed to bind stats proxy: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Failed to read stats proxy address: {error}"))?;
    let route_prefix = format!("threadterm-{:016x}", rand::thread_rng().gen::<u64>());
    let base_url = format!("http://127.0.0.1:{}/{}", address.port(), route_prefix);
    let project_routes = Arc::new(Mutex::new(ProjectRouteRegistry::default()));
    let state = ProxyState {
        config: Arc::new(config),
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("Failed to create stats proxy client: {error}"))?,
        project_routes: project_routes.clone(),
    };
    let route = format!("/{route_prefix}/{{provider}}/{{*path}}");
    let root_route = format!("/{route_prefix}/{{provider}}");
    let app = Router::new()
        .route(&route, any(proxy_handler))
        .route(&root_route, any(proxy_root_handler))
        .with_state(state);
    let (stop_tx, stop_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = stop_rx.await;
            })
            .await;
    });

    let status = StatsProxyStatus {
        running: true,
        host: Some("127.0.0.1".to_string()),
        port: Some(address.port()),
        url: Some(base_url),
        route_prefix: Some(route_prefix),
    };
    RUNTIME
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .replace(Runtime {
            status: status.clone(),
            stop: Some(stop_tx),
            project_routes,
        });
    tracing::info!(port = address.port(), "Stats loopback proxy started");
    Ok(status)
}

#[tauri::command]
pub async fn stats_proxy_stop() -> Result<(), String> {
    if let Some(mut runtime) = RUNTIME
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take()
    {
        if let Some(stop) = runtime.stop.take() {
            let _ = stop.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stats_proxy_status() -> StatsProxyStatus {
    RUNTIME
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|runtime| runtime.status.clone())
        .unwrap_or_default()
}

/// Start the proxy on demand and return only provider URL overrides. The
/// caller injects these into a child process; ThreadTerm's global environment
/// is never mutated.
#[tauri::command]
pub async fn stats_proxy_prepare(
    provider: String,
    project_path: Option<String>,
) -> Result<HashMap<String, String>, String> {
    if !is_supported_provider(&provider) {
        return Err(format!("Unsupported stats proxy provider: {provider}"));
    }
    let status = stats_proxy_start(None).await?;
    let project_route = register_project_route(project_path.as_deref());
    Ok(env_for_status(&status, &provider, project_route.as_deref()))
}

/// Internal child-process hook used by PTY and provider sidecars.
pub async fn prepare_env(
    provider: &str,
    project_path: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    if !is_supported_provider(provider) {
        return Ok(Vec::new());
    }
    let status = stats_proxy_start(None).await?;
    let project_route = register_project_route(project_path);
    Ok(env_for_status(&status, provider, project_route.as_deref())
        .into_iter()
        .collect())
}

fn register_project_route(project_path: Option<&str>) -> Option<String> {
    let project_path = project_path?.trim();
    if project_path.is_empty() {
        return None;
    }
    let runtime = RUNTIME.lock().unwrap_or_else(|poison| poison.into_inner());
    let project_routes = runtime.as_ref()?.project_routes.clone();
    let route = project_routes
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .register(project_path);
    route
}

fn normalize_project_route_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    if cfg!(target_os = "windows") {
        normalized = normalized.to_ascii_lowercase();
    }
    let minimum_length = if cfg!(target_os = "windows") { 3 } else { 1 };
    while normalized.len() > minimum_length && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn is_supported_provider(provider: &str) -> bool {
    matches!(
        provider.to_ascii_lowercase().as_str(),
        "anthropic"
            | "claude"
            | "openai"
            | "codex"
            | "opencode"
            | "gemini"
            | "xai"
            | "grok"
            | "grokbuild"
    )
}

fn env_for_status(
    status: &StatsProxyStatus,
    provider: &str,
    project_route: Option<&str>,
) -> HashMap<String, String> {
    let Some(base) = status.url.as_deref() else {
        return HashMap::new();
    };
    let provider = provider.to_ascii_lowercase();
    let project_suffix = project_route
        .map(|route| format!("/{route}"))
        .unwrap_or_default();
    let mut env = HashMap::new();
    match provider.as_str() {
        "claude" | "anthropic" => {
            env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                format!("{base}/claude{project_suffix}"),
            );
        }
        "codex" => {
            env.insert(
                "OPENAI_BASE_URL".to_string(),
                format!("{base}/codex{project_suffix}/v1"),
            );
        }
        "openai" => {
            env.insert(
                "OPENAI_BASE_URL".to_string(),
                format!("{base}/openai{project_suffix}/v1"),
            );
        }
        "opencode" => {
            env.insert(
                "OPENAI_BASE_URL".to_string(),
                format!("{base}/opencode{project_suffix}/v1"),
            );
        }
        "gemini" => {
            let url = format!("{base}/gemini{project_suffix}");
            env.insert("GOOGLE_GEMINI_BASE_URL".to_string(), url.clone());
            env.insert("GEMINI_API_BASE_URL".to_string(), url);
        }
        "grok" | "xai" | "grokbuild" => {
            env.insert(
                "XAI_BASE_URL".to_string(),
                format!("{base}/grok{project_suffix}/v1"),
            );
        }
        _ => {}
    }
    env
}

async fn proxy_root_handler(
    State(state): State<ProxyState>,
    Path(provider): Path<String>,
    request: Request<Body>,
) -> Response {
    proxy_request(state, provider, String::new(), request).await
}

async fn proxy_handler(
    State(state): State<ProxyState>,
    Path((provider, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    proxy_request(state, provider, path, request).await
}

async fn proxy_request(
    state: ProxyState,
    provider: String,
    path: String,
    request: Request<Body>,
) -> Response {
    let provider = provider.to_ascii_lowercase();
    if !matches!(
        provider.as_str(),
        "anthropic" | "claude" | "openai" | "codex" | "opencode" | "gemini" | "xai" | "grok"
    ) {
        return plain_response(StatusCode::NOT_FOUND, "unknown stats proxy provider");
    }
    let (project_path, upstream_path) = split_project_route(&state.project_routes, &path);
    let query = request.uri().query().map(str::to_string);
    let method = request.method().clone();
    let request_headers = request.headers().clone();
    let target = match upstream_url(&state.config, &provider, &upstream_path, query.as_deref()) {
        Ok(target) => target,
        Err(error) => return plain_response(StatusCode::BAD_REQUEST, &error),
    };
    let request_bytes = match to_bytes(request.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return plain_response(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
    };

    let request_model = serde_json::from_slice::<Value>(&request_bytes)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let request_id = new_request_id();
    let started = Instant::now();
    let streaming_request = serde_json::from_slice::<Value>(&request_bytes)
        .ok()
        .and_then(|value| value.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    let mut upstream = state.client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::POST),
        target,
    );
    for (name, value) in &request_headers {
        if name == axum::http::header::HOST || name == axum::http::header::CONTENT_LENGTH {
            continue;
        }
        upstream = upstream.header(name, value);
    }
    upstream = upstream
        .header("accept-encoding", "identity")
        .body(request_bytes);
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            write_proxy_record(ProxyRecordInput {
                request_id,
                provider,
                model: request_model,
                project_path,
                usage: UsageSummary::default(),
                status_code: None,
                error: Some("upstream request failed".to_string()),
                latency_ms: Some(started.elapsed().as_millis() as u64),
                first_token_ms: None,
                duration_ms: Some(started.elapsed().as_millis() as u64),
                streaming: streaming_request,
            });
            tracing::debug!(%error, "Stats proxy upstream request failed");
            return plain_response(
                StatusCode::BAD_GATEWAY,
                "stats proxy upstream request failed",
            );
        }
    };

    let status_code = upstream.status().as_u16() as i64;
    let response_streaming = streaming_request
        || upstream
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));
    let response_headers = copy_response_headers(upstream.headers());
    let body_stream = upstream.bytes_stream();
    let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
    let finalizer = ProxyStreamFinalizer {
        captured,
        provider,
        request_id,
        model: request_model,
        project_path,
        status_code,
        first_token_ms: None,
        started,
        streaming: response_streaming,
        finalized: false,
    };
    let stream = futures_util::stream::unfold(
        (body_stream, finalizer, false),
        move |(mut body_stream, mut finalizer, done)| async move {
            if done {
                return None;
            }
            match body_stream.next().await {
                Some(Ok(chunk)) => {
                    let first_token_ms = if finalizer.first_token_ms.is_none() && !chunk.is_empty()
                    {
                        Some(finalizer.started.elapsed().as_millis() as u64)
                    } else {
                        finalizer.first_token_ms
                    };
                    finalizer.first_token_ms = first_token_ms;
                    {
                        let mut captured = finalizer
                            .captured
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        let remaining = MAX_CAPTURED_RESPONSE_BYTES.saturating_sub(captured.len());
                        if remaining > 0 {
                            captured.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                        }
                    }
                    Some((
                        Ok::<Bytes, std::io::Error>(chunk),
                        (body_stream, finalizer, false),
                    ))
                }
                Some(Err(error)) => {
                    finalizer.finalize(Some("upstream response stream failed".to_string()));
                    Some((
                        Err(std::io::Error::other(error.to_string())),
                        (body_stream, finalizer, true),
                    ))
                }
                None => {
                    finalizer.finalize(if (200..=299).contains(&(finalizer.status_code as u16)) {
                        None
                    } else {
                        Some(format!("HTTP {}", finalizer.status_code))
                    });
                    None
                }
            }
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() =
        StatusCode::from_u16(status_code as u16).unwrap_or(StatusCode::BAD_GATEWAY);
    *response.headers_mut() = response_headers;
    response
}

fn split_project_route(routes: &SharedProjectRoutes, path: &str) -> (Option<String>, String) {
    let trimmed = path.trim_start_matches('/');
    let (candidate, remainder) = trimmed
        .split_once('/')
        .map_or((trimmed, ""), |(candidate, remainder)| {
            (candidate, remainder)
        });
    let project_path = routes
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .resolve(candidate);
    if project_path.is_some() {
        (project_path, remainder.to_string())
    } else {
        (None, path.to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn finalize_proxy_record(
    captured: &Arc<Mutex<Vec<u8>>>,
    provider: &str,
    request_id: &str,
    model: &str,
    project_path: Option<&str>,
    status_code: i64,
    error: Option<String>,
    first_token_ms: Option<u64>,
    started: Instant,
    streaming: bool,
) {
    let body = captured
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    write_proxy_record(ProxyRecordInput {
        request_id: request_id.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        project_path: project_path.map(ToOwned::to_owned),
        usage: parse_usage(provider, &body),
        status_code: Some(status_code),
        error,
        latency_ms: first_token_ms,
        first_token_ms,
        duration_ms: Some(started.elapsed().as_millis() as u64),
        streaming,
    });
}

fn upstream_url(
    config: &ValidatedProxyConfig,
    provider: &str,
    path: &str,
    query: Option<&str>,
) -> Result<String, String> {
    let base = match provider {
        "anthropic" | "claude" => &config.anthropic_upstream,
        "openai" | "codex" | "opencode" => &config.openai_upstream,
        "gemini" => &config.gemini_upstream,
        "xai" | "grok" => &config.xai_upstream,
        _ => return Err("unsupported provider".to_string()),
    };
    let mut target = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    if path.trim().is_empty() {
        target = base.trim_end_matches('/').to_string();
    }
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        target.push('?');
        target.push_str(query);
    }
    Ok(target)
}

fn validate_config(config: StatsProxyConfig) -> Result<ValidatedProxyConfig, String> {
    Ok(ValidatedProxyConfig {
        anthropic_upstream: validate_upstream(
            "anthropic",
            config
                .anthropic_upstream
                .or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok())
                .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            true,
        )?,
        openai_upstream: validate_upstream(
            "openai",
            config
                .openai_upstream
                .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
                .unwrap_or_else(|| "https://api.openai.com".to_string()),
            true,
        )?,
        gemini_upstream: validate_upstream(
            "gemini",
            config
                .gemini_upstream
                .or_else(|| std::env::var("GOOGLE_GEMINI_BASE_URL").ok())
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string()),
            false,
        )?,
        xai_upstream: validate_upstream(
            "xai",
            config
                .xai_upstream
                .or_else(|| std::env::var("XAI_BASE_URL").ok())
                .unwrap_or_else(|| "https://api.x.ai".to_string()),
            true,
        )?,
    })
}

fn validate_upstream(provider: &str, value: String, strip_v1: bool) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value.trim())
        .map_err(|error| format!("Invalid {provider} stats proxy upstream: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!(
            "Invalid {provider} stats proxy upstream scheme/host"
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "Stats proxy upstream for {provider} cannot contain query or fragment"
        ));
    }
    if strip_v1 && url.path().trim_end_matches('/').ends_with("/v1") {
        let path = url.path().trim_end_matches('/').to_string();
        let new_path = path.strip_suffix("/v1").unwrap_or("").to_string();
        url.set_path(&new_path);
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn copy_response_headers(source: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in source {
        if name == reqwest::header::CONTENT_LENGTH
            || name == reqwest::header::TRANSFER_ENCODING
            || name == reqwest::header::CONTENT_ENCODING
        {
            continue;
        }
        if let Ok(value) = HeaderValue::from_bytes(value.as_bytes()) {
            headers.insert(name.clone(), value);
        }
    }
    headers
}

fn parse_usage(provider: &str, body: &[u8]) -> UsageSummary {
    let text = String::from_utf8_lossy(body);
    let mut usage = UsageSummary::default();
    let mut found = false;
    for candidate in response_json_candidates(&text) {
        let Some(value) = candidate else { continue };
        let Some(parsed) = parse_usage_value(provider, value) else {
            continue;
        };
        found = true;
        usage.input = usage.input.max(parsed.input);
        usage.output = usage.output.max(parsed.output);
        usage.cache_creation = usage.cache_creation.max(parsed.cache_creation);
        usage.cache_read = usage.cache_read.max(parsed.cache_read);
    }
    if found {
        usage
    } else {
        UsageSummary::default()
    }
}

fn response_json_candidates(text: &str) -> Vec<Option<Value>> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return vec![Some(value)];
    }
    text.lines()
        .filter_map(|line| {
            let data = line.trim().strip_prefix("data:")?.trim();
            if data.is_empty() || data == "[DONE]" {
                return None;
            }
            serde_json::from_str::<Value>(data).ok().map(Some)
        })
        .collect()
}

fn parse_usage_value(provider: &str, value: Value) -> Option<UsageSummary> {
    match provider {
        "anthropic" | "claude" => {
            let usage = value.get("usage").or_else(|| {
                value
                    .get("message")
                    .and_then(|message| message.get("usage"))
            })?;
            Some(UsageSummary {
                input: usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output: usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_creation: usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_read: usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            })
        }
        "gemini" => {
            let usage = value.get("usageMetadata")?;
            let input = usage
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cache_read = usage
                .get("cachedContentTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Some(UsageSummary {
                input: input.saturating_sub(cache_read),
                output: usage
                    .get("candidatesTokenCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_creation: 0,
                cache_read,
            })
        }
        "openai" | "codex" | "opencode" | "xai" | "grok" => {
            let usage = value.get("usage")?;
            let input_total = usage
                .get("prompt_tokens")
                .or_else(|| usage.get("input_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cache_read = usage
                .get("prompt_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .or_else(|| {
                    usage
                        .get("input_tokens_details")
                        .and_then(|details| details.get("cached_tokens"))
                })
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Some(UsageSummary {
                input: input_total.saturating_sub(cache_read),
                output: usage
                    .get("completion_tokens")
                    .or_else(|| usage.get("output_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_creation: 0,
                cache_read,
            })
        }
        _ => None,
    }
}

struct ProxyRecordInput {
    request_id: String,
    provider: String,
    model: String,
    project_path: Option<String>,
    usage: UsageSummary,
    status_code: Option<i64>,
    error: Option<String>,
    latency_ms: Option<u64>,
    first_token_ms: Option<u64>,
    duration_ms: Option<u64>,
    streaming: bool,
}

fn write_proxy_record(input: ProxyRecordInput) {
    let Ok(conn) = crate::db::get_db() else {
        return;
    };
    let cost = pricing::cost_breakdown(&input.model, &input.usage);
    let status_code = input.status_code;
    let pricing_status = if pricing::lookup(&input.model).is_some() {
        "builtin"
    } else {
        "unknown"
    };
    let _ = conn.execute(
        "INSERT OR IGNORE INTO usage_records
            (request_id, provider, model, request_model, pricing_model,
             input_semantics, input_tokens, output_tokens, cache_read_tokens,
             cache_creation_tokens, input_cost_usd, output_cost_usd,
             cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            created_at, data_source, app_type, status_code, error, latency_ms,
            first_token_ms, duration_ms, streaming, provider_type,
             dedup_fingerprint, pricing_status, pricing_version, project_path)
         VALUES (?1, ?2, ?3, ?4, ?5, 'uncached', ?6, ?7, ?8, ?9, ?10, ?11,
                 ?12, ?13, ?14, ?15, 'proxy', ?2, ?16, ?17, ?18, ?19, ?20,
                 ?21, ?2, ?22, ?23, ?24, ?25)",
        rusqlite::params![
            input.request_id,
            input.provider,
            input.model,
            input.model,
            input.model,
            input.usage.input,
            input.usage.output,
            input.usage.cache_read,
            input.usage.cache_creation,
            cost.input,
            cost.output,
            cost.cache_read,
            cost.cache_write,
            cost.total,
            now_secs(),
            status_code,
            input.error,
            input.latency_ms.map(|value| value as i64),
            input.first_token_ms.map(|value| value as i64),
            input.duration_ms.map(|value| value as i64),
            i64::from(input.streaming),
            format!(
                "{}:{}:{}:{}:{}",
                input.provider,
                input.model,
                input.usage.input,
                input.usage.output,
                input.usage.cache_read
            ),
            pricing_status,
            pricing::BUILTIN_PRICING_VERSION,
            input.project_path,
        ],
    );
}

fn new_request_id() -> String {
    format!(
        "proxy-{}-{:016x}",
        now_ms(),
        rand::thread_rng().gen::<u64>()
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> i64 {
    (now_ms() / 1000) as i64
}

fn plain_response(status: StatusCode, message: &str) -> Response {
    let mut response = Response::new(Body::from(message.to_string()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_anthropic_stream_usage_without_persisting_body() {
        let body = br#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":30}}}

data: {"type":"message_delta","usage":{"output_tokens":7}}"#;
        let usage = parse_usage("anthropic", body);
        assert_eq!(usage.input, 10);
        assert_eq!(usage.cache_read, 30);
        assert_eq!(usage.output, 7);
    }

    #[test]
    fn openai_cached_input_is_split_from_uncached_input() {
        let body = br#"{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}"#;
        let usage = parse_usage("openai", body);
        assert_eq!(usage.input, 60);
        assert_eq!(usage.cache_read, 40);
        assert_eq!(usage.output, 20);
    }

    #[test]
    fn upstream_rejects_query_in_configuration() {
        let error = validate_upstream("openai", "https://example.com/v1?x=1".to_string(), true)
            .expect_err("query must be rejected");
        assert!(error.contains("query"));
    }

    #[test]
    fn project_route_is_stable_and_removed_before_upstream_forwarding() {
        let mut registry = ProjectRouteRegistry::default();
        let first_path = if cfg!(target_os = "windows") {
            "D:/Repo/One/"
        } else {
            "/repo/one/"
        };
        let second_path = if cfg!(target_os = "windows") {
            "d:\\repo\\one"
        } else {
            "/repo/one"
        };
        let first = registry.register(first_path).expect("route");
        let second = registry.register(second_path).expect("same route");
        assert_eq!(first, second);
        assert_eq!(registry.resolve(&first).as_deref(), Some(first_path));

        let routes = Arc::new(Mutex::new(registry));
        let (project_path, upstream_path) =
            split_project_route(&routes, &format!("{first}/v1/messages"));
        assert_eq!(project_path.as_deref(), Some(first_path));
        assert_eq!(upstream_path, "v1/messages");
    }

    #[test]
    fn project_route_is_added_after_provider_before_api_version() {
        let status = StatsProxyStatus {
            url: Some("http://127.0.0.1:1234/threadterm-test".to_string()),
            ..Default::default()
        };
        let env = env_for_status(&status, "codex", Some("project-token"));
        assert_eq!(
            env.get("OPENAI_BASE_URL").map(String::as_str),
            Some("http://127.0.0.1:1234/threadterm-test/codex/project-token/v1")
        );
    }
}
