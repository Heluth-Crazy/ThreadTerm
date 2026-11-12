use crate::{
    config::RuntimeConfig,
    db::{CreateSession, Database},
    domain::{RpcError, RpcRequest, Session},
    leases::LeaseManager,
    output::OutputStore,
    providers::{NativeSessionRef, ProviderEvent, ProviderRuntime, Providers, TerminalCapture},
    pty::PtyManager,
    RUNTIME_VERSION,
};
mod project_trust;
mod permission_modes;
#[cfg(test)]
mod permission_modes_tests;
#[cfg(test)]
mod project_trust_tests;
use anyhow::Result;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, RwLock, Weak,
    },
};

#[derive(Default)]
struct DeferredLaunchGate {
    stopping: bool,
    next_generation: u64,
    generations: HashMap<String, u64>,
}

pub struct RuntimeService {
    pub config: RuntimeConfig,
    pub db: Arc<Database>,
    pub(crate) leases: LeaseManager,
    output: Arc<OutputStore>,
    providers: Arc<Providers>,
    pty: Arc<PtyManager>,
    deferred_launch: Arc<Mutex<DeferredLaunchGate>>,
    shutdown_requested: AtomicBool,
    shutdown_pending: AtomicBool,
    shutdown_changed: tokio::sync::Notify,
    relocation_gate: RwLock<()>,
    retry_gate: Mutex<()>,
    settings_apply_gate: Mutex<()>,
    plugin_gate: Mutex<()>,
    pub(crate) remote: OnceLock<Arc<crate::remote_access::RemoteAccess>>,
    delegations: Arc<crate::delegation::Delegations>,
    chat_queues: Arc<crate::chat_queue::ChatQueues>,
    pub(crate) previews: Arc<crate::preview::Previews>,
    pub(crate) browser_tools: Arc<crate::browser_tools::BrowserTools>,
    desktop_files: crate::desktop_files::DesktopFiles,
    pub(crate) editor_navigation: Arc<crate::editor_navigation::EditorNavigation>,
    /// Last use per session; the idle sweep reads it under each admission lock.
    pub(crate) idle: Arc<crate::idle_release::IdleClock>,
}

/// A release only has work while the session is live; a released, ended or
/// unknown status is a successful no-op.
fn is_releasable_status(status: &str) -> bool {
    matches!(status, "starting" | "running" | "idle" | "waiting")
}

const DEFAULT_IDLE_RELEASE_MINUTES: i64 = 30;
/// The configured threshold, or the debug-only seconds override a QA probe uses.
fn idle_release_seconds(db: &Database) -> i64 {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("THREADTERM_QA_IDLE_RELEASE_SECONDS") {
        if let Ok(seconds) = value.parse::<i64>() {
            return seconds.max(0);
        }
    }
    idle_release_minutes(db) * 60
}

fn idle_release_minutes(db: &Database) -> i64 {
    db.settings_value()
        .ok()
        .and_then(|settings| {
            settings
                .get("sessions.idleReleaseMinutes")
                .and_then(Value::as_i64)
        })
        .unwrap_or(DEFAULT_IDLE_RELEASE_MINUTES)
}

fn idle_sweep_interval() -> std::time::Duration {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("THREADTERM_QA_IDLE_SWEEP_SECONDS") {
        if let Ok(seconds) = value.parse::<u64>() {
            return std::time::Duration::from_secs(seconds.max(1));
        }
    }
    std::time::Duration::from_secs(60)
}

#[cfg(test)]
static RELEASE_FAILURES: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn fail_next_release_for(session_id: &str) {
    RELEASE_FAILURES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(session_id.to_owned());
}

#[cfg(test)]
fn take_release_failure(session_id: &str) -> bool {
    RELEASE_FAILURES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(session_id)
}

/// Opens a session's provider Chat. Shared by `chat.connect` (after the
/// ChatView lease check) and the runtime-owned delegation start.
pub(crate) fn connect_chat_session(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    resume: bool,
) -> Result<()> {
    let admission = crate::chat_fork::session_admission(db, session_id)?;
    let _admission = admission.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
    if session.mode != "chat" {
        return Err(anyhow::anyhow!("chat_unavailable"));
    }
    if session.read_only || (session.status == "exited" && !session.released) {
        return Err(anyhow::anyhow!("session_read_only_resume_required"));
    }
    // Releasing kept the native identity, so reopening it starts a new worker.
    // Only an explicit Continue, send or keystroke may do that; an automatic
    // reconnect (mount, visibility, disconnected phase, lease renewal) must not.
    if session.released && !resume {
        return Err(anyhow::anyhow!("session_resume_required"));
    }
    let connected = ensure_chat_session_open(db, providers, session_id);
    if connected.is_err() {
        // Preserve the previous synchronous-create failure contract in
        // durable session state. The provider connection snapshot carries
        // the structured error used by the overlay, while this transition
        // prevents a failed initial launch or explicit retry from remaining
        // "starting" forever. The conditional database update preserves a
        // concurrent stop or another provider-owned lifecycle transition.
        db.fail_starting_session(session_id)?;
    }
    connected
}

fn ensure_chat_session_open(db: &Database, providers: &Providers, session_id: &str) -> Result<()> {
    if providers.chat_is_open(session_id) {
        return Ok(());
    }
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
    if session.mode != "chat" {
        return Ok(());
    }
    if session.read_only || (session.status == "exited" && !session.released) {
        return Err(anyhow::anyhow!("session_read_only_resume_required"));
    }
    let config = crate::session_configs::read(db, session_id)?;
    let cwd = config
        .as_ref()
        .map(|value| value.launch.cwd.as_str())
        .or(session.worktree_path.as_deref())
        .ok_or_else(|| anyhow::anyhow!("cwd_required"))?;
    let cwd_path = std::path::Path::new(cwd);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(anyhow::anyhow!("cwd_missing_choose_relocation"));
    }
    if !db.begin_chat_connection(session_id)? {
        return Err(anyhow::anyhow!("session_read_only_resume_required"));
    }
    let opened = open_chat_with_empty_native_recovery(
        db,
        providers,
        session_id,
        &session.provider,
        cwd,
        session.native_id.as_deref(),
    )
    .map_err(anyhow::Error::from)?;
    if let Err(error) = restore_chat_options(db, providers, session_id, &session.provider) {
        let _ = providers.chat_stop(session_id);
        return Err(error);
    }
    let accepted =
        db.accept_chat_connection(session_id, opened.get("nativeId").and_then(Value::as_str));
    if !matches!(accepted, Ok(true)) {
        let _ = providers.chat_stop(session_id);
    }
    match accepted {
        Ok(true) => {}
        Ok(false) => return Err(anyhow::anyhow!("chat_connect_superseded")),
        Err(error) => return Err(error),
    }
    if let Err(error) = apply_pending_chat_options(db, providers, session_id, &session.provider) {
        let _ = providers.chat_stop(session_id);
        return Err(error);
    }
    let _ = crate::chat_projection::expire_pending_approvals(db, session_id);
    Ok(())
}

fn open_chat_with_empty_native_recovery(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
    cwd: &str,
    expected_native_id: Option<&str>,
) -> Result<Value, crate::providers::ProviderError> {
    let options = permission_modes::startup_options(db, session_id, provider)
        .map_err(|error| crate::providers::ProviderError::new("chat_permission_restore_failed", error.to_string()))?;
    providers.chat_open_recovering_with_options(
        session_id,
        provider,
        cwd,
        expected_native_id,
        &options,
        &|replacement| {
            let Some(expected_native_id) = expected_native_id else {
                return Ok(false);
            };
            let result = match replacement {
                Some(replacement) => db.replace_empty_chat_native_id(
                    session_id,
                    expected_native_id,
                    replacement,
                ),
                None => db.empty_chat_native_recovery_eligible(session_id, expected_native_id),
            };
            result.map_err(|error| {
                crate::providers::ProviderError::new("chat_persistence", error.to_string())
            })
        },
    )
}

fn restore_pi_auto_retry(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
) -> Result<()> {
    if provider != "pi" {
        return Ok(());
    }
    if let Some(enabled) = db.pi_auto_retry(session_id)? {
        providers
            .chat_set_option(session_id, "auto-retry", if enabled { "true" } else { "false" })
            .map_err(anyhow::Error::from)?;
    }
    Ok(())
}

fn selected_chat_options(state: &Value) -> Value {
    json!(state.get("options").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|option| Some(json!({"id":option.get("id")?.as_str()?,"value":option.get("value")?.as_str()?})))
        .collect::<Vec<_>>())
}

fn restore_chat_options(db: &Database, providers: &Providers, session_id: &str, provider: &str) -> Result<()> {
    restore_pi_auto_retry(db, providers, session_id, provider)?;
    permission_modes::verify(db, providers, session_id, provider)?;
    if provider != "opencode" { return Ok(()); }
    let saved = db.chat_option_selections(session_id, provider)?;
    if saved.as_array().is_none_or(Vec::is_empty) { return Ok(()); }
    let state = providers.chat_options(session_id)?;
    if state.get("loadState").and_then(Value::as_str) == Some("error") {
        return Err(anyhow::anyhow!(state.pointer("/error/message").and_then(Value::as_str).unwrap_or("OpenCode options could not be validated. Reconnect to retry." ).to_owned()));
    }
    let mut invalid = None;
    // A model change re-scopes variants. Pending fork options are applied only
    // after this restore, so the fork's explicit choices always win.
    for id in ["next-model", "agent", "variant"] {
        let Some(value) = saved.as_array().into_iter().flatten().find(|row| row.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|row| row.get("value")).and_then(Value::as_str) else { continue };
        match providers.chat_set_option(session_id, id, value) {
            Ok(_) => {}
            Err(error) if matches!(error.code.as_str(), "chat_option_invalid" | "option_unknown") => invalid = Some((id, value)),
            Err(error) => return Err(error.into()),
        }
    }
    // Valid later choices clear a previous selection error. Publish the final
    // unavailable choice last so both chat.options and scoped chat.ui retain
    // the adapter's readable notice without adding another renderer contract.
    if let Some((id, value)) = invalid {
        match providers.chat_set_option(session_id, id, value) {
            Err(error) if !matches!(error.code.as_str(), "chat_option_invalid" | "option_unknown") => return Err(error.into()),
            _ => {}
        }
    }
    Ok(())
}

fn apply_pending_chat_options(db: &Database, providers: &Providers, session_id: &str, provider: &str) -> Result<()> {
    if provider == "opencode" {
        crate::chat_fork::apply_pending_options(db, providers, session_id)?;
    } else {
        permission_modes::apply_pending(db, providers, session_id, provider)?;
    }
    if provider == "opencode" {
        if !providers.chat_is_open(session_id) { return Err(anyhow::anyhow!("OpenCode disconnected while restoring options")); }
        let state = providers.chat_options(session_id)?;
        // A missing catalogue is not proof that saved choices became invalid.
        if state.get("loadState").and_then(Value::as_str) != Some("error") || state.pointer("/error/code").and_then(Value::as_str) == Some("chat_option_invalid") {
            db.set_chat_option_selections(session_id, provider, &selected_chat_options(&state))?;
        }
    }
    Ok(())
}

fn set_chat_option(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
    option_id: &str,
    value: &str,
) -> Result<Value> {
    let admission = crate::chat_fork::session_admission(db, session_id)?;
    let _admission = admission.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
    if !providers.chat_is_open(session_id)
        && providers.chat_connection(session_id).pointer("/error/code").and_then(Value::as_str) == Some("chat_permission_restore_failed") {
        db.require_interactive(session_id)?;
        return permission_modes::stage_recovery(db, providers, session_id, provider, option_id, value);
    }
    let previous = providers.chat_options(session_id)?;
    let permission_change = permission_modes::is_permission_option(provider, &json!({"id":option_id}))
        || previous["options"].as_array().into_iter().flatten().any(|row| row["id"] == option_id && permission_modes::is_permission_option(provider, row));
    let result = providers
        .chat_set_option(session_id, option_id, value)
        .map_err(anyhow::Error::from)?;
    if provider == "pi" && option_id == "auto-retry" {
        let enabled = match value {
            "true" | "on" => true,
            "false" | "off" => false,
            _ => return Err(anyhow::anyhow!("chat_option_invalid")),
        };
        db.set_pi_auto_retry(session_id, enabled)?;
    }
    if provider == "opencode" {
        db.set_chat_option_selections(session_id, provider, &selected_chat_options(&result))?;
    }
    if permission_change {
        if let Err(error) = crate::providers::verify_permission_options(&result, &json!([{"id":option_id,"value":value}])) {
            let _ = providers.chat_stop(session_id);
            return Err(error.into());
        }
        permission_modes::remember(db, session_id, provider, &result)?;
    } else if provider == "claude" && option_id == "model" && result["options"].as_array().into_iter().flatten().any(|row| row["id"] == "mode" && row["value"] == "auto") {
        permission_modes::remember(db, session_id, provider, &result)?;
    }
    let _ = crate::code_review::remember_provider_options(db, provider, &result);
    Ok(result)
}

/// Sends one user message to an open Chat. Shared by `chat.send` (after the
/// ChatView lease check) and the runtime-owned delegation start.
pub(crate) fn send_chat_message(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    text: &str,
    images: &[String],
    operation_id: &str,
) -> Result<Value> {
    if text.trim() == "/fork" && images.is_empty() && !crate::group_chat::owns_delivery(db, session_id, operation_id)? {
        let fork_operation = operation_id.strip_prefix("queue:")
            .map(|_| format!("{operation_id}:fork"));
        let fork_operation_id = fork_operation.as_deref().unwrap_or(operation_id);
        crate::chat_fork::fork(db, providers, crate::chat_fork::ForkRequest {
            session_id,
            item_id: None,
            operation_id: fork_operation_id,
        })?;
        let result = json!({"turnId":fork_operation_id});
        if fork_operation.is_some() && db.operation(operation_id)?.is_none() {
            db.complete_operation(operation_id, "chat.queue.dispatch", &result)?;
        }
        return Ok(result);
    }
    let admission = crate::chat_fork::session_admission(db, session_id)?;
    let _admission = admission.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
    let _trace_context = crate::send_trace::Context::capture(None, Some(operation_id), Some(session_id))
        .map(crate::send_trace::Context::enter);
    let _trace_span = crate::send_trace::Span::begin(
        "service.chat_send.begin", "service.chat_send.end", "chat.send",
    );
    db.require_interactive(session_id)?;
    if !providers.chat_is_open(session_id) {
        return Err(anyhow::anyhow!("chat_not_open"));
    }
    validate_chat_images(images)?;
    if (text.trim().is_empty() && images.is_empty()) || text.len() > 1024 * 1024 {
        return Err(anyhow::anyhow!("invalid_message"));
    }
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    let group_text = crate::group_chat::before_send(db, providers, session_id, operation_id, text)?;
    let text = group_text.as_deref().unwrap_or(text);
    if text.len() > 1024 * 1024 { return Err(anyhow::anyhow!("invalid_message")); }
    let previous_permissions = text.trim_start().starts_with('/').then(|| providers.chat_options(session_id).ok()).flatten();
    // The existing worker-locked admission runs before any checkpoint work.
    // Keep the same snapshot/deadline and capture it only for an admitted send.
    let mut checkpoint = None;
    let result = providers
        .chat_send_recording(session_id, text, images, operation_id, || {
            use crate::providers::ProviderError;
            if !db
                .claim_external_operation(operation_id)
                .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))?
            {
                return Err(ProviderError::new(
                    "operation_outcome_unknown",
                    "operation_outcome_unknown",
                ));
            }
            checkpoint = crate::review::capture_before_turn(db, session_id, operation_id, text);
            db.record_provider_event(
                session_id,
                Some(operation_id),
                "message.user",
                &json!({"text":text,"images":images,"operationId":operation_id}),
            )
            .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))
        })
        .map_err(anyhow::Error::from)?;
    if let Some(turn_id) = result.get("turnId").and_then(Value::as_str) {
        db.bind_chat_activity_turn(session_id, operation_id, turn_id)?;
    }
    crate::group_chat::sent(db, session_id, operation_id, &result)?;
    if let Some(checkpoint) = &checkpoint {
        crate::review::attach_turn(db, checkpoint, result.get("turnId").and_then(Value::as_str));
    }
    let completion_timer = crate::send_trace::Timer::start();
    crate::send_trace::emit(crate::send_trace::Event::new("persistence.complete.begin")
        .method("chat.send"));
    let completion = db.complete_operation(operation_id, "chat.send", &result);
    crate::send_trace::emit(crate::send_trace::Event::new("persistence.complete.end")
        .method("chat.send")
        .outcome(if completion.is_ok() { "ok" } else { "error" })
        .duration_us(completion_timer.elapsed_us()));
    completion?;
    if let Err(error) = permission_modes::remember_command(db, providers, session_id, text, previous_permissions.as_ref()) {
        return Err(crate::providers::ProviderError::new("chat_persistence", format!("Permission change was confirmed but could not be saved: {error}")).into());
    }
    Ok(result)
}

/// Inserts into the turn that is already running. The row is recorded before
/// the provider call. A completed operation replays its disposition and does
/// not dispatch again. An explicit `turn_changed` removes the row; a timeout
/// or any other post-dispatch failure leaves the row and the claim so a retry
/// of the same operation cannot send a second copy.
pub(crate) fn steer_chat_message(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    turn_id: &str,
    text: &str,
    images: &[String],
    operation_id: &str,
) -> Result<Value> {
    db.require_interactive(session_id)?;
    if !providers.chat_is_open(session_id) {
        return Err(anyhow::anyhow!("chat_not_open"));
    }
    validate_chat_images(images)?;
    if (text.trim().is_empty() && images.is_empty()) || text.len() > 1024 * 1024 {
        return Err(anyhow::anyhow!("invalid_message"));
    }
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    if !steer_activity_open(db, session_id)? {
        return Err(crate::providers::ProviderError::new(
            "turn_changed",
            crate::providers::STEER_TURN_ENDED,
        )
        .into());
    }
    let recorded = providers.chat_steer_recording(
        session_id,
        turn_id,
        text,
        images,
        operation_id,
        || {
            use crate::providers::ProviderError;
            if !db
                .claim_external_operation(operation_id)
                .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))?
            {
                return Err(ProviderError::new(
                    "operation_outcome_unknown",
                    "operation_outcome_unknown",
                ));
            }
            db.record_provider_event(
                session_id,
                Some(turn_id),
                "message.user",
                &json!({
                    "text": text,
                    "images": images,
                    "operationId": operation_id,
                    "steered": true,
                    "turnId": turn_id,
                    "item": {"id": format!("steer:{operation_id}")},
                }),
            )
            .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))
        },
    );
    match recorded {
        Ok(result) => {
            db.complete_operation(operation_id, "chat.steer", &result)?;
            Ok(result)
        }
        Err(error) if error.code == "turn_changed" => {
            // The provider rejected the insert. Drop the row so the composer
            // still holds the only copy. A failed retract leaves the row.
            let _ = crate::chat_projection::retract_steered_message(db, session_id, operation_id);
            Err(error.into())
        }
        Err(error) => Err(error.into()),
    }
}

fn steer_activity_open(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| {
        let activity = crate::db::session_activity_tx(tx, session_id)?;
        Ok(activity.is_some_and(|activity| {
            matches!(
                activity.state.as_str(),
                "running" | "awaiting_approval" | "awaiting_parent"
            )
        }))
    })
}

/// Answers one pending Chat approval. Shared by `chat.approve` (after the
/// ChatView lease check) and a parent agent's `delegation.respond`.
pub(crate) fn approve_chat_request(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    turn_id: &str,
    approval_id: &str,
    choice_id: &str,
    operation_id: &str,
) -> Result<Value> {
    let admission = crate::chat_fork::session_admission(db, session_id)?;
    let _admission = admission.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
    db.require_interactive(session_id)?;
    // Runtime eval approvals are never forwarded to providers or delegation.
    if let Some((_, part)) = db.chat_approval_part(session_id, approval_id)? {
        if part["type"] == "approval"
            && part.pointer("/data/runtimeOwned").and_then(Value::as_bool) == Some(true)
            && part.pointer("/data/requestType").and_then(Value::as_str) == Some("threadterm.browser_eval")
        {
            return Err(crate::providers::ProviderError::new(
                "browser_approval_required", "Use the browser approval controls for this request"
            ).into());
        }
    }
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    if question_request_data(db, session_id, turn_id, approval_id, false)?.is_some() {
        return Err(crate::providers::ProviderError::new("answer_required", "Use chat.answer for this question").into());
    }
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow::anyhow!("operation_outcome_unknown"));
    }
    providers
        .chat_approve(session_id, turn_id, approval_id, choice_id, operation_id)
        .map_err(anyhow::Error::from)?;
    if let Some(session) = db.session_by_id(session_id)? {
        permission_modes::remember(db, session_id, &session.provider, &providers.chat_options(session_id)?)?;
    }
    db.complete_null_operation(operation_id, "chat.approve")?;
    Ok(Value::Null)
}

/// Read the canonical approval part; native adapters still own the pending map.
fn question_request_data(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    approval_id: &str,
    require_pending: bool,
) -> Result<Option<Value>> {
    let Some((item_turn, part)) = db.chat_approval_part(session_id, approval_id)? else {
        if require_pending {
            return Err(crate::providers::ProviderError::new("approval_expired", "This question is no longer pending").into());
        }
        return Ok(None);
    };
    if part["type"] != "approval" {
        if require_pending { return Err(crate::providers::ProviderError::new("answer_invalid", "This part is not a question").into()); }
        return Ok(None);
    }
    if !matches!(part.pointer("/data/interaction").and_then(Value::as_str), Some("question" | "plan")) {
        if require_pending { return Err(crate::providers::ProviderError::new("answer_invalid", "This part is not a question").into()); }
        return Ok(None);
    }
    if require_pending && (item_turn.as_deref() != Some(turn_id) || part["status"] != "pending") {
        return Err(crate::providers::ProviderError::new("approval_expired", "This question is no longer pending for this turn").into());
    }
    Ok(Some(part["data"].clone()))
}

struct AnswerChatRequest<'a> {
    session_id: &'a str,
    turn_id: &'a str,
    approval_id: &'a str,
    response: &'a Value,
    operation_id: &'a str,
}

fn answer_chat_request(
    db: &Database,
    providers: &Providers,
    chat_tools: &crate::chat_tools::ChatTools,
    request: AnswerChatRequest<'_>,
) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let AnswerChatRequest { session_id, turn_id, approval_id, response, operation_id } = request;
    db.require_interactive(session_id)?;
    // Reuse the operation binding, without persisting raw (possibly secret)
    // values. The caller has already fenced the current lease; lease renewal
    // is not part of the identity of an answer.
    let mut fingerprint = Sha256::new();
    fingerprint.update(operation_id.as_bytes());
    fingerprint.update(serde_json::to_vec(response)?);
    db.bind_operation(operation_id, "chat.answer", &json!({
        "sessionId":session_id,"turnId":turn_id,"approvalId":approval_id,
        "responseFingerprint":format!("{:x}", fingerprint.finalize())
    }))?;
    if let Some(result) = db.operation(operation_id)? { return Ok(result); }
    let data = question_request_data(db, session_id, turn_id, approval_id, true)?
        .ok_or_else(|| anyhow::anyhow!("answer_invalid"))?;
    let is_plan = data["interaction"] == "plan";
    if is_plan {
        crate::chat_plan_approval::validate_response(response, data["runtimeOwned"] == true)?;
    } else {
        crate::chat_questions::validate_response(&data, response)?;
        if data.get("threadtermTool").and_then(Value::as_str) == Some("ask_user") {
            if chat_tools.answer(session_id, turn_id, approval_id, response, Some(operation_id))? {
                db.complete_null_operation(operation_id, "chat.answer")?;
                return Ok(Value::Null);
            }
            return Err(crate::providers::ProviderError::new(
                "approval_expired",
                "This app-hosted question is no longer pending. / 此应用内的问题已不再等待回答。",
            ).into());
        }
    }
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow::anyhow!("operation_outcome_unknown"));
    }
    let mut receipt = json!({"approvalId":approval_id,"status":"answered","outcome":"submitted"});
    let mut receipt_kind = "chat.approval.resolved";
    if is_plan {
        // A deterministic child receipt prevents decision replay from issuing
        // another implementation turn, including after a client reconnect.
        let hash = Sha256::digest(format!("plan:{operation_id}").as_bytes());
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&hash[..16]);
        let implementation_id = uuid::Uuid::from_bytes(bytes).to_string();
        let checkpoint = (data["runtimeOwned"] == true && response["action"] == "approve")
            .then(|| crate::review::capture_before_turn(db, session_id, &implementation_id, "Implement the plan.")).flatten();
        let implementation = providers.chat_plan_response_recording(crate::providers::PlanResponseRequest { session_id, turn_id, approval_id, response, operation_id, implementation_id: &implementation_id }, |prompt| {
            use crate::providers::ProviderError;
            if !db.claim_external_operation(&implementation_id).map_err(|error| ProviderError::new("chat_persistence", error.to_string()))? {
                return Err(ProviderError::new("operation_outcome_unknown", "Implementation outcome is unknown"));
            }
            db.record_provider_event(session_id, Some(&implementation_id), "message.user", &json!({"text":prompt,"images":[],"operationId":implementation_id}))
                .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))
        });
        match implementation {
            Ok((result, native_receipt)) => {
                receipt = native_receipt.unwrap_or_else(|| {
                    let outcome = match response["action"].as_str() {
                        Some("approve") => "approved", Some("request_changes") => "changes_requested", _ => "abandoned",
                    };
                    let mut receipt = json!({"approvalId":approval_id,"status":"answered","outcome":"submitted","planOutcome":outcome});
                    if let Some(feedback) = response.get("feedback") { receipt["feedback"] = feedback.clone(); }
                    if data["runtimeOwned"] == true {
                        receipt["returnToIdle"] = json!(response["action"] == "abandon");
                        receipt["preserveSessionState"] = json!(response["action"] != "abandon");
                    }
                    receipt
                });
                // Request changes first releases the composer; the next prompt
                // is the decision. Persist that intermediate card before ack.
                if data["runtimeOwned"] == true && response["action"] == "request_changes" {
                    let mut pending = data.clone();
                    pending["waitingForPrompt"] = json!(true);
                    receipt_kind = "chat.approval";
                    receipt = json!({"approvalId":approval_id,"part":{"type":"approval","approvalId":approval_id,"status":"pending","data":pending}});
                }
                if let Some(result) = result {
                if let Some(next_turn) = result.get("turnId").and_then(Value::as_str) {
                    db.bind_chat_activity_turn(session_id, &implementation_id, next_turn)?;
                }
                if let Some(checkpoint) = checkpoint.as_ref() { crate::review::attach_turn(db, checkpoint, result.get("turnId").and_then(Value::as_str)); }
                db.complete_operation(&implementation_id, "chat.send", &result)?;
                }
            }
            Err(error) => {
                db.record_provider_event(session_id, Some(turn_id), "chat.approval.resolved", &json!({"approvalId":approval_id,"status":"outcomeUnknown","message":"The plan decision could not be completed; review the session before retrying.","preserveSessionState":true}))?;
                return Err(error.into());
            }
        }
    } else {
        providers.chat_answer(session_id, turn_id, approval_id, response, operation_id)?;
        receipt["status"] = json!(if response["action"] == "dismiss" { "dismissed" } else { "answered" });
        receipt["answerSummary"] = crate::chat_questions::answer_summary(&data, response);
    }
    crate::chat_projection::record_answer_receipt(db, session_id, turn_id, receipt_kind, &receipt, operation_id)?;
    Ok(Value::Null)
}

/// Coalesce only deltas with identical routing and non-text metadata. In
/// particular native item/part indexes and worker tokens must never cross.
fn merge_projection_delta(prior: &mut ProviderEvent, next: &ProviderEvent) -> bool {
    if prior.kind != "chat.delta" || next.kind != "chat.delta"
        || prior.provider != next.provider || prior.session_id != next.session_id
        || prior.native_id != next.native_id || prior.turn_id != next.turn_id
        || prior.worker_token != next.worker_token {
        return false;
    }
    let text = |data: &Value| data.pointer("/part/text").or_else(|| data.get("text"))
        .and_then(Value::as_str).map(str::to_owned);
    let (Some(left), Some(right)) = (text(&prior.data), text(&next.data)) else { return false; };
    if left.len() + right.len() > 64 * 1024 { return false; }
    let metadata = |data: &Value| {
        let mut data = data.clone();
        if let Some(part) = data.get_mut("part").and_then(Value::as_object_mut) { part.remove("text"); }
        if let Some(object) = data.as_object_mut() { object.remove("text"); }
        if let Some(params) = data.pointer_mut("/raw/params").and_then(Value::as_object_mut) { params.remove("delta"); }
        data
    };
    if metadata(&prior.data) != metadata(&next.data) { return false; }
    let joined = Value::String(left + &right);
    if let Some(target) = prior.data.pointer_mut("/part/text") { *target = joined.clone(); }
    else { prior.data["text"] = joined.clone(); }
    if let Some(target) = prior.data.pointer_mut("/raw/params/delta") { *target = joined; }
    true
}

fn qa_projection_sessions() -> &'static Mutex<HashMap<String, bool>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    SESSIONS.get_or_init(Mutex::default)
}

fn qa_fail_projection(session_id: &str) -> bool {
    if !cfg!(debug_assertions) || std::env::var("THREADTERM_V3_RELOCATION_QA").as_deref() != Ok("1") { return false; }
    if let Ok(mut sessions) = qa_projection_sessions().lock() {
        if let Some(failed) = sessions.get_mut(session_id) {
            if !*failed { *failed = true; return true; }
        }
    }
    false
}

fn qa_projection_failed(session_id: &str) -> bool {
    if !cfg!(debug_assertions) { return false; }
    qa_projection_sessions().lock().is_ok_and(|mut sessions| sessions.get(session_id) == Some(&true) && sessions.remove(session_id).is_some())
}

fn project_provider_event(db: &Arc<Database>, providers: &Providers, event: &ProviderEvent) -> bool {
    let confirmed_permission = event.kind == "chat.ui" && event.data.get("permissionChangeConfirmed").and_then(Value::as_bool) == Some(true);
    let admission = if confirmed_permission { crate::chat_fork::session_admission(db, &event.session_id).ok() } else { None };
    let _admission = admission.as_ref().and_then(|gate| gate.lock().ok());
    if confirmed_permission && _admission.is_none() { return false; }
    let confirmed_state = if confirmed_permission && providers.chat_is_open(&event.session_id) { providers.chat_options(&event.session_id).ok() } else { None };
    let stale_permission = confirmed_permission && confirmed_state.as_ref().is_none_or(|state| !permission_modes::matches_current(&event.provider, &event.data, state));
    let accepted = providers.with_current_event(event, || {
        if stale_permission { return true; }
        let injected_failure = event.provider != "runtime" && qa_fail_projection(&event.session_id);
        if injected_failure {
            let _ = db.mark_chat_degraded(Some(&event.session_id), "QA: Chat update could not be persisted; transcript may be incomplete");
            return false;
        }
        if event.kind == "chat.session.replaced" {
            let replacement = if event.provider != "pi" {
                Err(anyhow::anyhow!("native_identity_replacement_unsupported"))
            } else {
                let previous = match event.data.get("previousNativeId") {
                    Some(Value::Null) => Ok(None),
                    Some(Value::String(value)) => Ok(Some(value.as_str())),
                    _ => Err(anyhow::anyhow!("invalid_native_identity_replacement")),
                };
                previous.and_then(|previous| {
                    let new_native_id = event
                        .native_id
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("invalid_native_id"))?;
                    db.replace_pi_chat_native_id(
                        &event.session_id,
                        previous,
                        new_native_id,
                    )
                })
            };
            if let Err(error) = replacement {
                eprintln!("chat native identity replacement failed for {}: {error}", event.session_id);
                let _ = crate::chat_queue::pause(db, &event.session_id, "failed");
                return false;
            }
        }
        if let Err(error) = db.bind_session(&event.session_id, None, event.native_id.as_deref()) {
            eprintln!("chat bind failed for {}: {error}", event.session_id);
            let _ = crate::chat_queue::pause(db, &event.session_id, "failed");
            return false;
        }
        if let Err(error) = db.record_provider_event(
            &event.session_id,
            event.turn_id.as_deref(),
            &event.kind,
            confirmed_state.as_ref().unwrap_or(&event.data),
        ) {
            eprintln!("chat projection failed for {}: {error}", event.session_id);
            let reason = format!(
                "Chat update could not be persisted; transcript may be incomplete ({error})"
            );
            let reason = if reason.len() > 240 {
                format!("{}…", reason.chars().take(239).collect::<String>())
            } else {
                reason
            };
            if let Err(error) = db.mark_chat_degraded(Some(&event.session_id), &reason) {
                eprintln!("could not persist degraded state: {error}");
            }
            let _ = crate::chat_queue::pause(db, &event.session_id, "failed");
            return false;
        }
        if confirmed_permission {
            if let Err(error) = permission_modes::remember(db, &event.session_id, &event.provider, confirmed_state.as_ref().unwrap_or(&event.data)) {
                eprintln!("confirmed permission choice could not be saved for {}: {error}", event.session_id);
                let _ = db.mark_chat_degraded(Some(&event.session_id), "Permission choice could not be saved. Select the mode again before reconnecting.");
                return false;
            }
        }
        if event.kind == "chat.ui"
            && (event.data.get("loadState").and_then(Value::as_str) != Some("error")
                || event
                    .data
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    == Some("chat_option_invalid"))
        {
            let _ = crate::code_review::remember_provider_options(db, &event.provider, &event.data);
        }
        true
    });
    if accepted == Some(true) && event.kind == "session.closed" {
        providers.note_session_closed_scoped(&event.session_id, event.worker_token.as_deref());
    }
    // The pre-turn checkpoint is created before the provider knows the turn
    // id. Tag it here, on the ordered projection path, so a completion that
    // races the `chat.send` response still pairs with its before-tree.
    if accepted == Some(true) && event.kind == "chat.turn.started" {
        if let Some(turn_id) = event.turn_id.as_deref() {
            crate::review::attach_turn_to_latest(db, &event.session_id, turn_id);
        }
    }
    // A completion is the only event that freezes an after-turn review tree.
    // The Git work runs on its own worker so the single provider-event
    // projection thread keeps draining every other session; the worker emits
    // the updated item once the capture is ready, after projection committed.
    if accepted == Some(true) && event.kind == "chat.turn.completed" {
        if let Some(turn_id) = event.turn_id.as_deref() {
            crate::review::capture_after_turn_in_background(
                Arc::clone(db),
                event.session_id.clone(),
                turn_id.to_owned(),
            );
        }
    }
    accepted == Some(true)
}

fn report_projection_failure(db: &Database, providers: &Providers, queues: &crate::chat_queue::ChatQueues, reason: &str) {
    let affected = providers.registered_chat_sessions();
    queues.projection_failed(db);
    eprintln!("chat event projection stopped: {reason}");
    let warning = format!("Chat updates could not be read; reconnect the runtime and reload native history ({reason})");
    let warning: String = warning.chars().take(240).collect();
    if let Err(error) = db.mark_chat_degraded_for_sessions(&affected, &warning) {
        eprintln!("could not persist projection diagnostic: {error}");
    }
}

// Deduplicate only simultaneous retries of one operation. This does not gate
// sends, worker lifecycle, or different repairs, and holds no SQLite lock.
fn repair_operation_lock(database_path: &std::path::Path, operation_id: &str) -> Result<Arc<Mutex<()>>> {
    type Flights = HashMap<(std::path::PathBuf, String), Weak<Mutex<()>>>;
    static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
    let mut flights = FLIGHTS.get_or_init(Mutex::default).lock()
        .map_err(|_| anyhow::anyhow!("provider_internal"))?;
    flights.retain(|_, flight| flight.strong_count() > 0);
    let key = (database_path.to_owned(), operation_id.to_owned());
    if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) { return Ok(flight); }
    let flight = Arc::new(Mutex::new(()));
    flights.insert(key, Arc::downgrade(&flight));
    Ok(flight)
}


/// The single durability projection loop: every provider event is recorded once,
/// settles one delegation turn and retries a finished child's release. It owns
/// the projection receiver, so exactly one of these runs per registry.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn spawn_projection_pump(
    mut events: crate::provider_events::ProjectionReceiver,
    event_db: Arc<Database>,
    event_providers: Arc<Providers>,
    event_queues: Arc<crate::chat_queue::ChatQueues>,
    event_previews: Arc<crate::preview::Previews>,
    event_chat_tools: Arc<crate::chat_tools::ChatTools>,
    event_delegations: Arc<crate::delegation::Delegations>,
    turn_speeds: Arc<crate::turn_speed::TurnSpeeds>,
    idle: Arc<crate::idle_release::IdleClock>,
) {
    std::thread::spawn(move || loop {
            // Own the shared tracker for the lifetime of canonical projection.
            let _keep_speed_tracker_alive = &turn_speeds;
            match events.blocking_recv() {
                Ok(event) => {
                    // Drain a bounded burst before taking the provider/DB locks.
                    // Only adjacent compatible text deltas combine; approvals,
                    // completions and worker generations keep their exact order.
                    let mut batch_bytes = event.data.to_string().len();
                    let mut batch = vec![event];
                    let mut failure = None;
                    for _ in 1..256 {
                        if batch_bytes >= 4 * 1024 * 1024 { break; }
                        let event = match events.try_recv() {
                            Ok(event) => event,
                            Err(crate::provider_events::TryRecvError::Failed(reason)) => {
                                // Capture/mark workers at failure detection,
                                // before drained lifecycle events can unregister them.
                                report_projection_failure(&event_db, &event_providers, &event_queues, &reason);
                                failure = Some(reason);
                                break;
                            }
                            Err(_) => break,
                        };
                        batch_bytes += event.data.to_string().len();
                        if !merge_projection_delta(batch.last_mut().unwrap(), &event) {
                            batch.push(event);
                        }
                    }
                    for event in batch {
                        if project_provider_event(&event_db, &event_providers, &event) {
                            // A provider UI snapshot is not user activity: the idle
                            // check itself asks for background tasks and every such
                            // answer emits `chat.ui`, which would reset the clock.
                            if event.kind != "chat.ui" {
                                idle.touch(&event.session_id);
                            }
                            event_queues.provider_event(&event_db, &event_providers, &event);
                            crate::group_chat::provider_event(&event_db, &event_providers, &event_queues, &event);
                            if matches!(event.kind.as_str(), "chat.turn.completed" | "chat.error" | "chat.approval.resolved") {
                                // Only the turn that settled a delegation may release its
                                // child. A turnless event (a Codex compaction, a worker
                                // restart) never does, and a hold the user's Continue put
                                // in place is not cleared by events at all.
                                if let Some(turn) = event.turn_id.as_deref() {
                                    if let Err(error) = crate::delegation::release_finished_child(
                                        &event_db,
                                        &event_providers,
                                        &event_delegations,
                                        &event_previews,
                                        &event.session_id,
                                        Some(turn),
                                    ) {
                                        eprintln!("delegated child release failed for {}: {error}", event.session_id);
                                    }
                                }
                            }
                            let settled = match event.kind.as_str() {
                                "chat.turn.completed" | "chat.error" => event.turn_id.as_deref().map(|turn| {
                                    event_chat_tools.cancel_turn(&event.session_id, turn)?;
                                    let cancelled = event.kind == "chat.error"
                                        || matches!(event.data.get("status").and_then(Value::as_str), Some("failed" | "error" | "cancelled" | "canceled" | "interrupted"));
                                    if cancelled {
                                        event_chat_tools.clear_waiting_feedback(&event.session_id, Some(turn))?;
                                    }
                                    Ok(())
                                }),
                                "session.closed" => Some(event_chat_tools.revoke_session(&event.session_id)),
                                _ => None,
                            };
                            if let Some(Err(error)) = settled {
                                eprintln!("app-hosted Chat tool cleanup failed for {}: {error}", event.session_id);
                            }
                            if event.kind == "session.closed" { let _ = event_previews.revoke_disabled(&event_providers); }
                        } else if qa_projection_failed(&event.session_id) {
                            report_projection_failure(&event_db, &event_providers, &event_queues, "QA injected projection ingress failure");
                        }
                    }
                    if failure.is_some() {
                        break;
                    }
                }
                Err(crate::provider_events::RecvError::Closed) => {
                    event_queues.projection_failed(&event_db);
                    break;
                }
                Err(crate::provider_events::RecvError::Failed(reason)) => {
                    report_projection_failure(&event_db, &event_providers, &event_queues, &reason);
                    break;
                }
            }
        });
}
impl RuntimeService {
    fn set_pi_project_trust(&self, principal: &str, params: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Decision {
            session_id: String,
            decision: String,
            lease_epoch: i64,
            operation_id: String,
        }
        let p: Decision = parse(params)?;
        if p.session_id.is_empty()
            || p.operation_id.is_empty()
            || !matches!(p.decision.as_str(), "trusted" | "declined" | "none")
        {
            return Err(anyhow::anyhow!("invalid_request"));
        }
        self.leases
            .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
        let session = self
            .db
            .session_by_id(&p.session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if session.provider != "pi" || session.mode != "chat" {
            return Err(anyhow::anyhow!("project_trust_unavailable"));
        }
        self.db.require_interactive(&p.session_id)?;
        let project_id = session
            .project_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("project_required"))?;
        self.db.bind_operation(
            &p.operation_id,
            "chat.projectTrust.set",
            &json!({"sessionId":p.session_id,"decision":p.decision}),
        )?;
        let flight = repair_operation_lock(&self.config.database_path, &p.operation_id)?;
        let _request = flight
            .lock()
            .map_err(|_| anyhow::anyhow!("provider_internal"))?;
        self.leases
            .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
        if let Some(result) = self.db.operation(&p.operation_id)? {
            return Ok(result);
        }
        // Serialize project decisions and their recovery against one another.
        // Normal Chat opens read the saved value after registry admission.
        let project_flight = repair_operation_lock(&self.config.database_path, &format!("pi-trust:{project_id}"))?;
        let _project = project_flight.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
        self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
        let resume = project_trust::pending(&self.db, project_id, &p.operation_id)?;
        let sessions = if let Some(sessions) = resume {
            sessions
        } else if p.decision == "trusted" {
            self.providers.restart_idle_chat(&p.session_id, || {
                self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                self.db.require_interactive(&p.session_id)?;
                project_trust::save(&self.db, project_id, &p.decision, &p.operation_id, std::slice::from_ref(&p.session_id))
            })?;
            vec![p.session_id.clone()]
        } else {
            // Validate and lock ALL matching Pi workers before persisting any
            // change. A busy peer refuses the revoke without changing trust.
            self.providers.restart_idle_project_chats(&p.session_id, |id| {
                Ok(self.db.session_by_id(id)?.is_some_and(|peer| peer.provider == "pi"
                    && peer.mode == "chat" && peer.project_id.as_deref() == Some(project_id)))
            }, |sessions| {
                self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                self.db.require_interactive(&p.session_id)?;
                project_trust::save(&self.db, project_id, &p.decision, &p.operation_id, sessions)
            })?
        };
        // A failed reconnect leaves the durable route intact. Replaying this
        // operation resumes connection only; it never replays the decision.
        let mut failure = None;
        for id in &sessions {
            if let Err(error) = self.connect_chat(id, false) { failure.get_or_insert(error); }
        }
        if let Some(error) = failure { return Err(error); }
        let state = self.providers.chat_options(&p.session_id)?;
        project_trust::complete(&self.db, &p.operation_id, &state)?;
        Ok(state)
    }


    fn repair_chat_history(&self, principal: &str, p: &ChatRepair) -> Result<Value> {
        if p.session_id.is_empty() || p.operation_id.is_empty() || p.lease_epoch < 1 {
            return Err(anyhow::anyhow!("invalid_request"));
        }
        // Authorization precedes request binding and completed-receipt replay.
        self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
        self.db.bind_operation(&p.operation_id, "chat.repair", &json!({"sessionId":p.session_id}))?;
        let flight = repair_operation_lock(&self.config.database_path, &p.operation_id)?;
        let _retry = flight.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
        self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
        if let Some(result) = self.db.operation(&p.operation_id)? { return Ok(result); }
        let session = self.db.session_by_id(&p.session_id)?.ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        let available = self.providers.history_reader_available(&session.provider);
        let capture = self.providers.with_chat_repair_state(&p.session_id, |worker| {
            self.db.transaction(|tx| crate::chat_repair::capture(tx, &p.session_id, &worker, available))
        })?;
        // The only native call. Neither SQLite nor the registry is locked here.
        let history = self.providers.history_read(&capture.provider, &capture.native_id)?;
        let items: Vec<crate::domain::ChatItem> = serde_json::from_value(history)
            .map_err(|_| anyhow::anyhow!("invalid_history_transcript"))?;
        let plan = crate::chat_repair::prepare(&capture, &items)?;
        let available = self.providers.history_reader_available(&capture.provider);
        self.providers.with_chat_repair_state(&p.session_id, |worker| {
            self.db.transaction(|tx| Ok(serde_json::to_value(crate::chat_repair::commit(
                tx, &capture, &plan, &worker, available,
                crate::chat_repair::RepairCommitContext { principal, lease_epoch: p.lease_epoch, operation_id: &p.operation_id },
            )?)?))
        })
    }

    pub fn new(config: RuntimeConfig, db: Arc<Database>) -> Self {
        let providers = Arc::new(Providers::with_plugins(
            &config.data_dir,
            &db.settings_value().unwrap_or_else(|_| json!({})),
        ));
        Self::with_providers(config, db, providers)
    }

    #[cfg(test)]
    pub(crate) fn with_test_providers(
        config: RuntimeConfig,
        db: Arc<Database>,
        adapters: Vec<Arc<dyn crate::providers::ProviderAdapter>>,
    ) -> Self {
        Self::with_providers(config, db, Arc::new(Providers::for_test(adapters)))
    }

    fn with_providers(config: RuntimeConfig, db: Arc<Database>, providers: Arc<Providers>) -> Self {
        if let Err(error) = crate::attachments::recover(&db, &config.data_dir) { eprintln!("Attachment cleanup deferred: {error}"); }
        crate::code_review::forget_provider_options(&db);
        crate::chat_queue::initialize(&db).expect("initialize durable prompt queues");
        crate::group_chat::initialize(&db).expect("initialize group chats");
        let chat_queues = Arc::new(crate::chat_queue::ChatQueues::default());
        let output = Arc::new(OutputStore::default());
        crate::group_chat::kick(&db, &providers, &chat_queues);
        let retirement_db = Arc::downgrade(&db);
        providers.set_retirement_projector(Arc::new(move |event| {
            let db = retirement_db.upgrade().ok_or_else(|| crate::providers::ProviderError::new("runtime_stopped", "Runtime stopped"))?;
            db.record_provider_event(&event.session_id, event.turn_id.as_deref(), &event.kind, &event.data)
                .map_err(|error| crate::providers::ProviderError::new("chat_persistence", error.to_string()))
        }));
        // Resolve the project decision on each Pi connection. Other providers
        // neither read this table nor inspect Pi's configuration files.
        let trust_db = Arc::downgrade(&db);
        providers.set_project_trust_resolver(Arc::new(move |session_id, provider| {
            if provider != "pi" {
                return Ok(None);
            }
            let db = trust_db.upgrade().ok_or_else(|| {
                crate::providers::ProviderError::new("runtime_stopped", "Runtime stopped")
            })?;
            let session = db
                .session_by_id(session_id)
                .map_err(|error| {
                    crate::providers::ProviderError::new("chat_persistence", error.to_string())
                })?
                .ok_or_else(|| {
                    crate::providers::ProviderError::new("session_not_found", "Session not found")
                })?;
            session
                .project_id
                .as_deref()
                .map(|project_id| crate::pi_project_trust::read(&db, project_id))
                .transpose()
                .map(Option::flatten)
                .map_err(|error| {
                    crate::providers::ProviderError::new("chat_persistence", error.to_string())
                })
        }));
        let capability_db = Arc::downgrade(&db);
        providers.set_capability_listener(Arc::new(move |update: crate::providers::CapabilityUpdate| {
            let Some(db) = capability_db.upgrade() else { return };
            let payload = json!({"kind":"providers","generation":update.generation,"outcome":update.outcome});
            if let Err(error) = db.transaction(|tx| {
                tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
                    rusqlite::params![payload.to_string(), chrono::Utc::now().to_rfc3339()])?;
                Ok(())
            }) {
                eprintln!("provider capability notification failed: {error}");
            }
        }));
        match db.settings_value() {
            Ok(settings) => {
                if let Err(error) = providers.configure_network(&settings) {
                    eprintln!("provider network settings could not be loaded: {error}");
                }
            }
            Err(error) => eprintln!("provider network settings could not be read: {error}"),
        }
        let delegations = Arc::new(crate::delegation::Delegations::default());
        let chat_tools = crate::chat_tools::shared(&config.database_path, Arc::clone(&db))
            .expect("initialize app-hosted chat tools");
        let previews = Arc::new(crate::preview::Previews::new(Arc::clone(&db)).expect("initialize preview operations"));
        let browser_providers = Arc::downgrade(&providers);
        let browser_tools = Arc::new(crate::browser_tools::BrowserTools::new(
            Arc::clone(&db), uuid::Uuid::new_v4().to_string(),
            Arc::new(move |session, generation, allow_reserved| {
                browser_providers.upgrade().is_some_and(|registry| {
                    registry.browser_generation_is_current(session, generation, allow_reserved)
                })
            }),
        ));
        let editor_navigation = Arc::new(crate::editor_navigation::EditorNavigation::new(&config.data_dir));
        let idle = Arc::new(crate::idle_release::IdleClock::default());
        providers.set_tool_server_resolver(crate::group_chat::tool_server_resolver(Arc::clone(&db), crate::preview::tool_server_resolver(
            Arc::clone(&db),
            Arc::clone(&delegations),
            Arc::clone(&chat_tools),
            crate::preview::BrowserCapabilities { previews: Arc::clone(&previews), tools: Arc::clone(&browser_tools) },
            Arc::downgrade(&providers),
            config.clone(),
            crate::delegation::default_mcp_executable(),
        )));
        let turn_speeds = crate::turn_speed::shared(db.path());
        let events = providers.take_projection_events().expect("new provider projection receiver");
        let event_db = Arc::clone(&db);
        let event_providers = Arc::clone(&providers);
        let event_queues = Arc::clone(&chat_queues);
        let event_previews = Arc::clone(&previews);
        let event_chat_tools = Arc::clone(&chat_tools);
        let event_delegations = Arc::clone(&delegations);
        spawn_projection_pump(
            events,
            event_db,
            event_providers,
            event_queues,
            event_previews,
            event_chat_tools,
            event_delegations,
            turn_speeds,
            Arc::clone(&idle),
        );
        Self {
            config,
            db,
            leases: LeaseManager::default(),
            pty: Arc::new(PtyManager::new(Arc::clone(&output))),
            deferred_launch: Arc::new(Mutex::new(DeferredLaunchGate::default())),
            output,
            providers,
            shutdown_requested: AtomicBool::new(false),
            shutdown_pending: AtomicBool::new(false),
            shutdown_changed: tokio::sync::Notify::new(),
            relocation_gate: RwLock::new(()),
            retry_gate: Mutex::new(()),
            settings_apply_gate: Mutex::new(()),
            plugin_gate: Mutex::new(()),
            remote: OnceLock::new(),
            delegations,
            chat_queues,
            previews,
            browser_tools,
            desktop_files: crate::desktop_files::DesktopFiles::default(),
            editor_navigation,
            idle,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_provider_events(&self) -> crate::provider_events::Sender {
        self.providers.test_event_sender()
    }
    #[cfg(test)]
    fn browser_test_tools(db: &Arc<Database>) -> Arc<crate::browser_tools::BrowserTools> {
        Arc::new(crate::browser_tools::BrowserTools::new(
            Arc::clone(db), uuid::Uuid::new_v4().to_string(), Arc::new(|_, _, _| false),
        ))
    }
    pub fn start_retry_scheduler(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        let mut cursor = self
            .db
            .snapshot()
            .map(|snapshot| snapshot.revision)
            .unwrap_or_default();
        std::thread::spawn(move || retry_runner(service, &mut cursor));
    }
    /// The idle sweep runs every minute and takes each candidate's admission
    /// lock before it decides, so a send that won the lock is never killed.
    pub fn start_idle_sweeper(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(idle_sweep_interval());
            let Some(service) = service.upgrade() else { return };
            if service.shutdown_requested.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = service.sweep_idle(chrono::Utc::now()) {
                eprintln!("idle release sweep failed: {error}");
            }
        });
    }
    pub fn start_terminal_agent_watcher(self: &Arc<Self>) {
        // PTYs do not survive a restart; drop any stale agent detections first.
        if let Err(error) = crate::terminal_agents::clear_all(&self.db) {
            eprintln!("terminal agent startup clear failed: {error}");
        }
        crate::terminal_agents::spawn(&self.db, &self.pty);
    }
    fn dispatch_retry_attempt(&self, attempt: &crate::retry_scheduler::RetryAttempt) {
        let Ok(_relocation) = self.relocation_gate.read() else {
            return;
        };
        let Ok(_retry) = self.retry_gate.lock() else {
            return;
        };
        let success = crate::retry_scheduler::claimed_still_enabled(&self.db, &attempt.id)
            .unwrap_or(false)
            && self.dispatch_under_gate("retry-scheduler", RpcRequest {
                v: 1, id: format!("retry:{}", attempt.id), method: "session.rerun".into(),
                params: json!({"sessionId":attempt.source_session_id,"operationId":attempt.operation_id}),
            }).is_ok();
        let _ = crate::retry_scheduler::finish(&self.db, &attempt.id, success);
    }
    pub fn shutdown(&self) {
        // Fence navigation start/wait/idle work before the general shutdown
        // threads begin terminating managed children.
        self.editor_navigation.shutdown();
        let db = self.db.clone();
        let config = self.config.clone();
        let deferred = self.deferred_launch.clone();
        let remote = self.remote.get().cloned();
        let pty = self.pty.clone();
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        // Teardown can itself wait on SQLite. Keep that wait off the caller so
        // an unavailable writer cannot prevent the independent loss record.
        let _ = std::thread::Builder::new().name("runtime-shutdown-prepare".into()).spawn(move || {
            if let Ok(chat_tools) = crate::chat_tools::shared(&config.database_path, Arc::clone(&db)) {
                if let Err(error) = chat_tools.revoke_all() {
                    eprintln!("app-hosted Chat tool shutdown failed: {error}");
                }
            }
            if let Err(error) = Self::cancel_deferred_launches(&db, &deferred) {
                eprintln!("deferred terminal shutdown failed: {error}");
            }
            let _ = crate::retry_scheduler::cancel_all(&db);
            if let Some(remote) = remote { remote.shutdown(); }
            pty.terminate_all(&db);
            let _ = sent.send(());
        });
        if received.recv_timeout(std::time::Duration::from_millis(2100)).is_err() {
            eprintln!("Runtime shutdown preparation exceeded its deadline");
        }
        let pending = self.output.drain_pending(
            &self.db,
            std::time::Instant::now() + std::time::Duration::from_secs(2),
        );
        if pending != 0 {
            self.output.record_shutdown_loss(&self.db);
        }
        let config = self.config.clone();
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        let _ = std::thread::Builder::new().name("runtime-shutdown-release".into()).spawn(move || {
            let _ = crate::settings_services::release_relocation(&config);
            let _ = sent.send(());
        });
        let _ = received.recv_timeout(std::time::Duration::from_millis(25));
    }
    fn cancel_all_deferred_launches(&self) -> Result<()> {
        Self::cancel_deferred_launches(&self.db, &self.deferred_launch)
    }
    fn cancel_deferred_launches(db: &Database, deferred: &Mutex<DeferredLaunchGate>) -> Result<()> {
        let mut gate = deferred
            .lock()
            .map_err(|_| anyhow::anyhow!("deferred launch gate poisoned"))?;
        gate.stopping = true;
        for session_id in gate.generations.keys() {
            db.cancel_deferred_codex_launch(session_id)?;
        }
        gate.generations.clear();
        Ok(())
    }
    pub fn initialize_remote(self: &Arc<Self>) -> Result<()> {
        let remote = crate::remote_access::RemoteAccess::new(
            Arc::downgrade(self),
            Arc::clone(&self.db),
            self.config.clone(),
        )?;
        self.remote
            .set(remote)
            .map_err(|_| anyhow::anyhow!("remote access already initialized"))
    }
    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::Acquire)
    }
    pub fn acknowledge_shutdown(&self) {
        if self.shutdown_pending.load(Ordering::Acquire) {
            self.shutdown_requested.store(true, Ordering::Release);
            self.shutdown_changed.notify_waiters();
        }
    }
    /// The private browser listener has no idle polling timer.
    pub(crate) async fn wait_for_shutdown(&self) {
        loop {
            let notified = self.shutdown_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.shutdown_requested() { return; }
            notified.await;
        }
    }
    pub(crate) async fn browser_tool_call(&self, principal: &str, request: RpcRequest) -> std::result::Result<Value, RpcError> {
        if request.v != 1 { return Err(error("unsupported_version", "only protocol version 1 is supported")); }
        if self.shutdown_pending.load(Ordering::Acquire) { return Err(error("runtime_stopping", "Runtime is shutting down")); }
        {
            let _gate = self.relocation_gate.read().map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
            if crate::settings_services::relocation_blocks(&self.config, &request.method)
                .map_err(|_| error("browser_unavailable", "Browser scope is unavailable"))? {
                return Err(error("relocation_pending", "data relocation is awaiting activation or cancellation"));
            }
        }
        self.browser_tools.tool_call_for(principal, request.params).await.map_err(browser_rpc_error)
    }
    /// Ephemeral Chat-only pushes. The transport subscribes per connection;
    /// payloads use the protocol chat.turnSpeed event and never enter SQLite.
    pub fn subscribe_turn_speed(&self) -> tokio::sync::broadcast::Receiver<Value> {
        crate::turn_speed::shared(self.db.path()).subscribe()
    }
    pub fn output_notified(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.output.notified()
    }
    pub fn dispatch(
        &self,
        principal: &str,
        request: RpcRequest,
    ) -> std::result::Result<Value, RpcError> {
        // Navigation uses its own bounded admission/context locks and can wait
        // for managed LSP I/O.  Keep it outside the relocation/ordered path so
        // it cannot stall terminal traffic or hold a global gate while waiting.
        if request.method.starts_with("editorNavigation.") {
            if request.v != 1 {
                return Err(error("unsupported_version", "only protocol version 1 is supported"));
            }
            if self.shutdown_pending.load(Ordering::Acquire) {
                return Err(error("runtime_stopping", "Runtime is shutting down"));
            }
            // Configuration persists under the runtime data directory. Once the
            // manager's detection path is cached/quick, retain the relocation
            // read fence across that small write so a relocation cannot copy an
            // obsolete configuration. Prepare writes no data, but does not
            // admit a new server while relocation is pending.
            let relocation_checked = matches!(
                request.method.as_str(),
                "editorNavigation.configure" | "editorNavigation.prepare"
            );
            let _navigation_gate = if relocation_checked {
                Some(self.relocation_gate.read().map_err(|_| error("runtime_error", "relocation lock poisoned"))?)
            } else {
                None
            };
            if relocation_checked
                && crate::settings_services::relocation_blocks(&self.config, &request.method)
                    .map_err(|failure| error("runtime_error", &failure.to_string()))?
            {
                return Err(error("relocation_pending", "data relocation is awaiting activation or cancellation"));
            }
            return self
                .editor_navigation
                .dispatch(&self.db, principal, &request.method, &request.params)
                .map_err(editor_navigation_rpc_error)?
                .ok_or_else(|| error("unknown_method", "unknown_method"));
        }
        if request.method == "browser.tool.cancel" {
            if request.v != 1 { return Err(error("unsupported_version", "only protocol version 1 is supported")); }
            return self.browser_tools.cancel(request.params).map_err(browser_rpc_error);
        }
        // `ask_user` waits for a later `chat.answer`, so release the global
        // relocation fence after its short admission and publication step. The run
        // tools reuse that card: only the approval waits; the launch itself is a
        // mutation and re-takes the fence once the user decided.
        if matches!(
            request.method.as_str(),
            "chat.tool.ask" | "chat.tool.run.start" | "chat.tool.run.restart"
        ) {
            if request.v != 1 {
                return Err(error("unsupported_version", "only protocol version 1 is supported"));
            }
            if self.shutdown_pending.load(Ordering::Acquire) {
                return Err(error("runtime_stopping", "Runtime is shutting down"));
            }
            let gate = self.relocation_gate.read()
                .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
            if crate::settings_services::relocation_blocks(&self.config, &request.method)
                .map_err(|failure| error("runtime_error", &failure.to_string()))?
            {
                return Err(error("relocation_pending", "data relocation is awaiting activation or cancellation"));
            }
            let tools = crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))
                .map_err(|failure| map_error(&failure.to_string()))?;
            if request.method == "chat.tool.ask" {
                let waiter = tools.prepare_ask(&self.providers, &request.params)
                    .map_err(|failure| map_error(&failure.to_string()))?;
                drop(gate);
                return waiter.wait().map_err(|failure| map_error(&failure.to_string()));
            }
            let plan = tools.prepare_run(&self.providers, &request.method, &request.params)
                .map_err(|failure| map_error(&failure.to_string()))?;
            drop(gate);
            let run = tools.await_run(&self.providers, plan)
                .map_err(|failure| map_error(&failure.to_string()))?;
            // The approval may have been answered minutes later, while the runtime was
            // shutting down or a data relocation was waiting. Re-check what `dispatch`
            // checks before a mutation, so the launch cannot slip past it.
            if self.shutdown_pending.load(Ordering::Acquire) {
                return Err(error("runtime_stopping", "Runtime is shutting down"));
            }
            let _gate = self.relocation_gate.read()
                .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
            if crate::settings_services::relocation_blocks(&self.config, &request.method)
                .map_err(|failure| error("runtime_error", &failure.to_string()))?
            {
                return Err(error(
                    "relocation_pending",
                    "data relocation is awaiting activation or cancellation",
                ));
            }
            return tools.execute_run(&self.providers, &self.pty, run)
                .map_err(|failure| map_error(&failure.to_string()));
        }
        let local_file_lifecycle = matches!(
            request.method.as_str(),
            "data.relocation.prepare"
                | "project.remove"
                | "worktree.relocate"
                | "worktree.remove"
                | "runtime.shutdown"
        );
        let public_file_mutation = matches!(
            request.method.as_str(),
            "filesystem.write"
                | "filesystem.create"
                | "filesystem.rename"
                | "filesystem.delete"
        );
        let exclusive = local_file_lifecycle
            || public_file_mutation
            || matches!(
                request.method.as_str(),
                "data.relocation.cancel" | "session.resume"
            );
        if exclusive {
            let _gate = self
                .relocation_gate
                .write()
                .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
            if local_file_lifecycle {
                self.desktop_files
                    .require_idle(&self.db)
                    .map_err(|failure| error("desktop_files_busy", &failure.to_string()))?;
            } else if public_file_mutation {
                self.desktop_files
                    .require_no_writer(&self.db)
                    .map_err(|failure| error("desktop_files_busy", &failure.to_string()))?;
            }
            self.dispatch_under_gate(principal, request)
        } else {
            let _gate = self
                .relocation_gate
                .read()
                .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
            self.dispatch_under_gate(principal, request)
        }
    }
    /// Remote HTTP must call this before taking its own access gate so every
    /// request follows the global-relocation -> remote-access lock order.
    pub(crate) fn with_remote_gate<T>(
        &self,
        action: impl FnOnce() -> std::result::Result<T, RpcError>,
    ) -> std::result::Result<T, RpcError> {
        let _gate = self
            .relocation_gate
            .read()
            .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
        action()
    }
    /// Dispatch with the relocation gate already held by `dispatch` or
    /// `with_remote_gate`. Never call this directly without that guard.
    pub(crate) fn dispatch_under_gate(
        &self,
        principal: &str,
        request: RpcRequest,
    ) -> std::result::Result<Value, RpcError> {
        if request.v != 1 {
            return Err(error(
                "unsupported_version",
                "only protocol version 1 is supported",
            ));
        }
        if self.shutdown_pending.load(Ordering::Acquire) && request.method != "runtime.shutdown" {
            return Err(error("runtime_stopping", "Runtime is shutting down"));
        }
        let relocation_blocks =
            crate::settings_services::relocation_blocks(&self.config, &request.method)
                .map_err(|failure| error("runtime_error", &failure.to_string()))?;
        if relocation_blocks {
            return Err(error(
                "relocation_pending",
                "data relocation is awaiting activation or cancellation",
            ));
        }
        if request.method.starts_with("desktop.files.") {
            return self
                .desktop_files
                .dispatch(&self.db, principal, &request.method, &request.params)
                .map_err(|failure| {
                    let message = failure.to_string();
                    let code = crate::desktop_files::ERROR_CODES
                        .iter()
                        .copied()
                        .find(|code| {
                            message == *code
                                || message
                                    .strip_prefix(code)
                                    .is_some_and(|suffix| suffix.starts_with(':'))
                        })
                        .unwrap_or("runtime_error");
                    error(code, &message)
                });
        }
        let retry_mutation = matches!(
            request.method.as_str(),
            "session.retry.update" | "session.stop" | "runtime.shutdown"
        );
        let _retry_guard = if retry_mutation {
            Some(
                self.retry_gate
                    .lock()
                    .map_err(|_| error("runtime_error", "retry lock poisoned"))?,
            )
        } else {
            None
        };
        if request.method == "filesystem.resolve" {
            let p: FileResolve = parse(&request.params)
                .map_err(|failure| error("invalid_request", &failure.to_string()))?;
            return crate::workspace_services::resolve_file_reference_with_source_search(
                &self.db,
                &p.session_id,
                &p.path,
                p.line,
                p.column,
                p.source_search,
            )
            .map_err(file_reference_rpc_error);
        }
        if request.method.starts_with("filesystem.sheet.")
            || request.method == "filesystem.external.sheet.open"
        {
            // Handles are bound to the principal, so this dispatch needs it: the sheet
            // host sits here rather than inside the two method dispatchers.
            return crate::sheet_preview::dispatch(
                &self.db,
                principal,
                &request.method,
                &request.params,
            )
            .and_then(|value| value.ok_or_else(|| anyhow::anyhow!("unknown_method")))
            .map_err(|failure| {
                let message = failure.to_string();
                if crate::sheet_preview::ERROR_CODES.contains(&message.as_str()) {
                    error(&message, &message)
                } else {
                    map_error(&message)
                }
            });
        }
        if request.method.starts_with("filesystem.external.") {
            return crate::external_files::dispatch(&self.db, &request.method, &request.params)
                .and_then(|value| value.ok_or_else(|| anyhow::anyhow!("unknown_method")))
                .map_err(|failure| {
                    let message = failure.to_string();
                    if crate::external_files::ERROR_CODES.contains(&message.as_str()) {
                        error(&message, &message)
                    } else {
                        map_error(&message)
                    }
                });
        }
        self.touch_idle_request(&request.method, &request.params);
        let outcome = (|| -> Result<Value> {
            if let Some(value) = crate::host_files::dispatch(&self.db, &request.method, &request.params)? { return Ok(value); }
            if let Some(value) = crate::attachments::dispatch(&self.db, &self.config.data_dir, &request.method, &request.params)? { return Ok(value); }
            if let Some(value) = crate::usage_ledger::dispatch(&self.db, &request.method, &request.params)? { return Ok(value); }
            if request.method == "browser.approval.read" {
                return self.browser_tools.approval_read(principal, &request.params);
            }
            if request.method == "browser.approval.resolve" {
                return self.browser_tools.approval_resolve(principal, &request.params);
            }
            if request.method.starts_with("chat.tool.") {
                let tools = crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?;
                // A run stop is the user's Stop: the intent flag plus the PTY stop.
                if request.method == "chat.tool.run.stop" {
                    return tools.run_stop(&self.providers, &self.pty, &request.params);
                }
                return tools.dispatch(&self.providers, &request.method, &request.params);
            }
            if request.method.starts_with("preview.") {
                return self.previews.dispatch(&self.providers, principal, &request.method, &request.params);
            }
            if request.method.starts_with("chat.queue.") {
                if let Some(operation_id) = request.params.get("operationId").and_then(Value::as_str) {
                    self.db.bind_operation(operation_id, &request.method, &request.params)?;
                }
                let touched = request.params.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                let result = self.chat_queues.dispatch(&self.db, &self.providers, &self.leases, principal, &request.method, &request.params)?;
                // A child whose queue just emptied (or lost its follow-up) is a
                // release candidate again; removing an item emits no provider event.
                // A read changes nothing, and every chat view reads on mount.
                if let Some(session_id) = touched.filter(|_| request.method != "chat.queue.read") {
                    self.retry_finished_child_release(&session_id);
                }
                return Ok(result);
            }
            crate::plugin_services::validate(&request.method, &request.params)?;
            crate::quick_launch::validate(&request.method, &request.params)?;
            if request.method == "data.relocation.prepare"
                && self.remote.get().is_some_and(|remote| remote.is_enabled())
            {
                return Err(anyhow::anyhow!(
                    "Disable device access before relocating data"
                ));
            }
            // lookup references an existing operation; it does not reserve one.
            let slash_fork = request.method == "chat.send"
                && request.params.get("text").and_then(Value::as_str).is_some_and(|text| text.trim() == "/fork")
                && request.params.get("images").and_then(Value::as_array).is_none_or(Vec::is_empty);
            if request.method != "session.lookup" && request.method != "chat.answer" && request.method != "chat.repair" && request.method != "chat.projectTrust.set" && request.method != "chat.feedback.add" && request.method != "chat.feedback.dismiss"
                && request.method != "chat.fork" && request.method != "git.undo" && !slash_fork {
                if let Some(operation_id) =
                    request.params.get("operationId").and_then(Value::as_str)
                {
                    if operation_id.is_empty() {
                        return Err(anyhow::anyhow!("invalid operationId"));
                    }
                    self.db
                        .bind_operation(operation_id, &request.method, &request.params)?;
                }
            }
            if let Some(remote) = self.remote.get() {
                if let Some(result) = remote.dispatch(&request.method, &request.params)? {
                    return Ok(result);
                }
            }
            if crate::quick_launch::handles(&request.method) {
                return crate::quick_launch::dispatch(&self.db, &self.pty, &request.method, &request.params);
            }
            if let Some(result) =
                crate::retry_scheduler::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::session_configs::dispatch(&self.db, &self.providers, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::git_selected_commit::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::git_actions::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::git_read::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::file_ops::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::review::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::project_catalog::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::workspace_services::dispatch(&self.db, &request.method, &request.params)?
            {
                if request.method == "worktree.create" { crate::quick_launch::setup_after_worktree_create(&self.db, &self.pty, &result); }
                return Ok(result);
            }
            if let Some(result) = crate::settings_services::dispatch(
                &self.config,
                &self.db,
                &request.method,
                &request.params,
            )? {
                return Ok(result);
            }
            // Agent delegation, called by the MCP host on a parent's behalf.
            if request.method == "delegation.start" {
                return self.start_delegation(&request.params);
            }
            if let Some(result) = crate::delegation::dispatch(
                &self.delegations,
                &self.db,
                &self.providers,
                &request.method,
                &request.params,
            )? {
                return Ok(result);
            }
            if request.method.starts_with("group.") {
                return crate::group_chat::dispatch(&self.db, &self.providers, &self.chat_queues, &request.method, &request.params, &|create| self.create_session(&parse(create)?, None));
            }
            if request.method.starts_with("agentReview.") {
                return crate::agent_review::dispatch(&self.db, &self.providers, &request.method, &request.params, &|create| self.create_session(&parse(create)?, None));
            }
            if request.method.starts_with("codeReview.") {
                return crate::code_review::dispatch(
                    &self.db,
                    &self.providers,
                    &request.method,
                    &request.params,
                    &|session_id, epoch| self.leases.require(&self.db, session_id, principal, epoch).map(|_| ()),
                    &|create| self.create_session(&parse(create)?, None),
                );
            }
            match request.method.as_str() {
                "inbox.read" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct ReadInbox {
                        ids: Vec<String>,
                        operation_id: String,
                    }
                    let p: ReadInbox = parse(&request.params)?;
                    if p.ids.len() > 500 || p.ids.iter().any(|id| id.is_empty()) {
                        return Err(anyhow::anyhow!("invalid inbox ids"));
                    }
                    self.db.read_inbox(&p.ids, &p.operation_id)?;
                    Ok(Value::Null)
                }
                "runtime.health" => Ok(
                    json!({"version":RUNTIME_VERSION,"epoch":self.db.epoch()?,"contract":crate::PROTOCOL_CONTRACT}),
                ),
                "runtime.resourceSample" => self.resource_sample(),
                // The console host actually in use (conpty.rs), so xterm's Windows heuristics match it.
                "terminal.host" => Ok(json!({"conptyHost": crate::conpty::active().as_str(), "bundledAvailable": crate::conpty::bundled_available(), "pwshAvailable": crate::providers::common::find_executable("pwsh.exe").is_some()})),
                "runtime.snapshot" => {
                    let mut snapshot = self.db.snapshot()?;
                    // A failed provider probe does not make the runtime/catalog
                    // unavailable. Provider UI checks provider.list for its error.
                    snapshot.providers = self.providers.capability_snapshot();
                    Ok(serde_json::to_value(snapshot)?)
                }
                "runtime.shutdown" => {
                    let p: OperationOnly = parse(&request.params)?;
                    crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
                        .revoke_all()?;
                    self.cancel_all_deferred_launches()?;
                    if self
                        .db
                        .complete_null_operation(&p.operation_id, "runtime.shutdown")?
                    {
                        self.shutdown_pending.store(true, Ordering::Release);
                    }
                    Ok(Value::Null)
                }
                "terminal.read" => {
                    let p: TerminalRead = parse(&request.params)?;
                    if p.cursor.is_some() && p.tail {
                        return Err(anyhow::anyhow!("tail_and_cursor_are_mutually_exclusive"));
                    }
                    if p.cursor.is_some_and(|cursor| cursor < 0) {
                        return Err(anyhow::anyhow!("invalid_output_cursor"));
                    }
                    let max_limit = if p.tail { 8 * 1024 } else { 1024 * 1024 };
                    let limit = p.limit.unwrap_or(if p.tail { 8 * 1024 } else { 64 * 1024 });
                    if limit == 0 || limit > max_limit {
                        return Err(anyhow::anyhow!("invalid_output_limit"));
                    }
                    let (from, next, truncated, data) = self.db.read_output_window(
                        &p.session_id, p.cursor, p.tail, limit as usize,
                    )?;
                    // Replay needs persistent loss diagnostics as well as live
                    // recording failures, independently of terminal.storage events.
                    let mut result = json!({"sessionId":p.session_id,"fromCursor":from,"nextCursor":next,"truncated":truncated,"encoding":"base64","data":base64::engine::general_purpose::STANDARD.encode(data)});
                    if let Some(degraded) = self.db.terminal_storage_degraded(&p.session_id)? {
                        result["storageDegraded"] = json!({
                            "reason": degraded.get("reason").cloned().unwrap_or_else(|| json!(crate::db::TERMINAL_STORAGE_FAILED)),
                            "cursor": degraded.get("cursor").cloned().unwrap_or_else(|| json!(next)),
                        });
                        if let Some(pending) = degraded.get("pendingBytes") {
                            result["storageDegraded"]["pendingBytes"] = pending.clone();
                        }
                    }
                    Ok(result)
                }
                "session.launch.read" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct LaunchRead {
                        session_id: String,
                    }
                    let p: LaunchRead = parse(&request.params)?;
                    self.db
                        .deferred_codex_launch(&p.session_id)?
                        .ok_or_else(|| anyhow::anyhow!("session_launch_unavailable"))
                }
                "session.lookup" => {
                    let p: OperationOnly = parse(&request.params)?;
                    let result = self.db.operation(&p.operation_id)?;
                    let id = result
                        .as_ref()
                        .and_then(|v| v.get("id"))
                        .and_then(Value::as_str);
                    Ok(serde_json::to_value(
                        id.map(|id| self.db.session_by_id(id)).transpose()?,
                    )?)
                }
                "session.present" => {
                    let p: SessionPresent = parse(&request.params)?;
                    if !matches!(p.placement.as_str(), "workspace" | "window")
                        || !matches!(p.presentation.as_str(), "background" | "focused")
                    {
                        return Err(anyhow::anyhow!("invalid presentation"));
                    };
                    self.db.presentation_request(
                        &p.session_id,
                        &p.placement,
                        &p.presentation,
                        p.workspace_path.as_deref(),
                        &p.operation_id,
                    )?;
                    Ok(json!({"queued":true}))
                }
                "project.add" => {
                    let p: ProjectAdd = parse(&request.params)?;
                    Ok(serde_json::to_value(self.db.add_project(
                        &p.path,
                        p.name.as_deref(),
                        &p.operation_id,
                    )?)?)
                }
                "project.remove" => {
                    let p: ProjectRemove = parse(&request.params)?;
                    self.db.remove_project(&p.id, &p.operation_id)?;
                    Ok(Value::Null)
                }
                "session.create" => {
                    let p: SessionCreate = parse(&request.params)?;
                    if let Some(source) = request.params.get("forkFromNativeId") {
                        let source = source.as_str().ok_or_else(|| anyhow::anyhow!("invalid Pi terminal fork source"))?;
                        self.create_pi_terminal_fork(p, source)
                    } else {
                        self.create_session(&p, None)
                    }
                }
                "history.import" => self.import_native_history(&request.params),
                "session.rerun" => self.rerun(&request.params),
                "session.stop" => {
                    let p: SessionStop = parse(&request.params)?;
                    if self.db.operation(&p.operation_id)?.is_some() {
                        return Ok(Value::Null);
                    }
                    let session = self
                        .db
                        .session_by_id(&p.session_id)?
                        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
                    crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
                        .revoke_session(&p.session_id)?;
                    self.browser_tools.revoke_session(&p.session_id);
                    if session.read_only {
                        self.record_null(&p.operation_id, "session.stop")?;
                        return Ok(Value::Null);
                    }
                    crate::retry_scheduler::cancel_session(&self.db, &p.session_id)?;
                    if session.run.is_some() {
                        crate::quick_launch::request_stop(&self.db, &p.session_id)?;
                    }
                    let cancelled_pending = {
                        let mut gate = self
                            .deferred_launch
                            .lock()
                            .map_err(|_| anyhow::anyhow!("deferred launch gate poisoned"))?;
                        if gate.generations.remove(&p.session_id).is_some() {
                            self.db.cancel_deferred_codex_launch(&p.session_id)?;
                            true
                        } else {
                            false
                        }
                    };
                    // Preparation may have failed or completed between the
                    // first row read and acquiring the launch fence. Decide
                    // whether a PTY exists from the post-fence state.
                    let current = self
                        .db
                        .session_by_id(&p.session_id)?
                        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
                    if !cancelled_pending
                        && !matches!(current.status.as_str(), "exited" | "interrupted" | "error")
                    {
                        if current.mode == "chat" {
                            self.providers.chat_stop(&p.session_id)?;
                            self.previews.revoke_disabled(&self.providers)?;
                            self.db.set_session_status(&p.session_id, "exited", None)?;
                        } else {
                            self.pty.stop(&self.db, &p.session_id, p.force)?;
                        }
                    }
                    // A stopped parent can no longer answer its delegates; a
                    // stopped delegate ends its delegation.
                    crate::chat_projection::escalate_parent_requests_now(&self.db, &p.session_id)?;
                    crate::delegation::cancel_stopped(&self.db, &p.session_id)?;
                    crate::group_chat::session_stopped(&self.db, &p.session_id)?;
                    crate::group_chat::kick(&self.db, &self.providers, &self.chat_queues);
                    self.record_null(&p.operation_id, "session.stop")?;
                    Ok(Value::Null)
                }
                "session.releaseResources" => {
                    let p: SessionReleaseResources = parse(&request.params)?;
                    if let Some(prior) = self.db.operation(&p.operation_id)? {
                        return Ok(prior);
                    }
                    let session = self.release_session_resources(&p.session_id)?;
                    let result = serde_json::to_value(&session)?;
                    self.db.complete_operation(&p.operation_id, "session.releaseResources", &result)?;
                    Ok(result)
                }
                "session.releaseResources.bulk" => {
                    let p: SessionReleaseResourcesBulk = parse(&request.params)?;
                    if let Some(prior) = self.db.operation(&p.operation_id)? {
                        return Ok(prior);
                    }
                    let result = self.release_sessions_bulk(&p.session_ids)?;
                    self.db.complete_operation(&p.operation_id, "session.releaseResources.bulk", &result)?;
                    Ok(result)
                }
                "session.releaseIdle" => {
                    let p: SessionReleaseIdle = parse(&request.params)?;
                    if let Some(prior) = self.db.operation(&p.operation_id)? {
                        return Ok(prior);
                    }
                    let result = self.release_idle_sessions(
                        p.project_id.as_deref(),
                        p.worktree_path.as_deref(),
                        chrono::Utc::now(),
                    )?;
                    self.db.complete_operation(&p.operation_id, "session.releaseIdle", &result)?;
                    Ok(result)
                }
                "session.processes" => {
                    let p: SessionProcesses = parse(&request.params)?;
                    self.session_processes(p.project_id.as_deref(), p.worktree_path.as_deref())
                }
                "session.update" => {
                    let p: SessionUpdate = parse(&request.params)?;
                    Ok(serde_json::to_value(self.db.update_session(
                        &p.session_id,
                        p.title.as_deref(),
                        p.followed,
                        &p.operation_id,
                    )?)?)
                }
                "session.organize" => {
                    let p: crate::domain::SessionOrganize = parse(&request.params)?;
                    Ok(serde_json::to_value(self.db.organize_session(&p)?)?)
                }
                "session.attention.acknowledge" => {
                    let p: SessionAttentionAcknowledge = parse(&request.params)?;
                    Ok(serde_json::to_value(
                        self.db.acknowledge_session_attention(
                            &p.session_id,
                            p.expected_revision,
                            &p.operation_id,
                        )?,
                    )?)
                }
                "session.resume" => self.resume_native(&request.params),
                "session.claim" => {
                    let p: SessionClaim = parse(&request.params)?;
                    let epoch = if p.takeover {
                        let session = self.db.session_by_id(&p.session_id)?.ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
                        if session.mode != "terminal" { return Err(anyhow::anyhow!("invalid_request")); }
                        self.db.require_interactive(&p.session_id)?;
                        self.leases.take_control(&self.db, &p.session_id, principal)?
                    } else { self.leases.claim(&self.db, &p.session_id, principal)? };

                    Ok(json!({"leaseEpoch":epoch}))
                }
                "session.release" => {
                    let p: SessionRelease = parse(&request.params)?;
                    self.leases
                        .release(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    Ok(Value::Null)
                }
                "session.renew" => {
                    let p: SessionRelease = parse(&request.params)?;
                    let epoch =
                        self.leases
                            .renew(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.idle.renew(&p.session_id, p.visible);
                    Ok(json!({"leaseEpoch": epoch}))
                }
                "terminal.input" => {
                    let p: TerminalInput = parse(&request.params)?;
                    // Fence → short require (DB released) → PTY write. Never hold SQLite across I/O.
                    let _fence = self.leases.fence(&p.session_id);
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    self.pty.input(&p.session_id, p.data.as_bytes())?;
                    Ok(Value::Null)
                }
                "terminal.resize" => {
                    let p: TerminalResize = parse(&request.params)?;
                    let _fence = self.leases.fence(&p.session_id);
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.pty.resize(&p.session_id, p.cols, p.rows)?;
                    if let Err(error) = self.db.set_session_terminal_size(
                        &p.session_id,
                        i32::from(p.cols),
                        i32::from(p.rows),
                    ) {
                        eprintln!("terminal size could not be persisted: {error}");
                    }
                    Ok(Value::Null)
                }
                "settings.update" => {
                    let p: SettingsUpdate = parse(&request.params)?;
                    crate::settings_services::valid_runtime_patch(&p.patch)?;
                    let _settings_apply = self
                        .settings_apply_gate
                        .lock()
                        .map_err(|_| anyhow::anyhow!("settings apply lock poisoned"))?;
                    let settings =
                        self.db
                            .update_settings(&p.patch, p.expected_revision, &p.operation_id)?;
                    if p.patch.get("providerNetwork").is_some() {
                        crate::code_review::forget_provider_options(&self.db);
                    }
                    self.providers.configure_network(&settings.value)?;
                    if p.patch.get("modelPrices").is_some() { crate::usage_ledger::schedule_pricing(&self.db)?; }
                    Ok(serde_json::to_value(settings)?)
                }
                "provider.list" => Ok(Value::Array(self.providers.capability_snapshot_result()?)),
                "provider.refresh" => {
                    crate::code_review::forget_provider_options(&self.db);
                    Ok(json!({"refreshId": self.providers.request_capability_refresh()}))
                }
                "plugin.list" | "plugin.setEnabled" | "plugin.reload" | "plugin.selectBrowserBinding" => {
                    let _plugins = self.plugin_gate.lock().map_err(|_| anyhow::anyhow!("plugin registry lock poisoned"))?;
                    let _settings = self.settings_apply_gate.lock().map_err(|_| anyhow::anyhow!("settings apply lock poisoned"))?;
                    let result = crate::plugin_services::dispatch(&self.config, &self.db, &self.providers, &request.method, &request.params)?;
                    if request.method != "plugin.list" { self.previews.revoke_disabled(&self.providers)?; }
                    Ok(result)
                }
                "history.list" => {
                    let p: HistoryList = parse(&request.params)?;
                    self.providers
                        .history_list(
                            &p.provider,
                            p.cursor.as_deref(),
                            p.limit.unwrap_or(50),
                            p.cwd.as_deref(),
                        )
                        .map_err(anyhow::Error::from)
                }
                "history.read" => {
                    let p: HistoryRead = parse(&request.params)?;
                    self.providers
                        .history_read(&p.provider, &p.native_id)
                        .map_err(anyhow::Error::from)
                }
                "chat.fork" => {
                    let p: ChatFork = parse(&request.params)?;
                    self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.bind_operation(&p.operation_id, "chat.fork", &json!({
                        "sessionId":p.session_id,
                        "itemId":p.item_id,
                        "operationId":p.operation_id,
                    }))?;
                    crate::chat_fork::fork(&self.db, &self.providers, crate::chat_fork::ForkRequest {
                        session_id: &p.session_id,
                        item_id: p.item_id.as_deref(),
                        operation_id: &p.operation_id,
                    })
                }
                "chat.send" => {
                    let p: ChatSend = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    let images = p.images.unwrap_or_default();
                    if p.text.trim() == "/fork" && images.is_empty() {
                        self.db.bind_operation(&p.operation_id, "chat.fork", &json!({
                            "sessionId":p.session_id,
                            "itemId":Value::Null,
                            "operationId":p.operation_id,
                        }))?;
                        return send_chat_message(
                            &self.db, &self.providers, &p.session_id, &p.text, &images, &p.operation_id,
                        );
                    }
                    send_chat_message(
                        &self.db,
                        &self.providers,
                        &p.session_id,
                        &p.text,
                        &images,
                        &p.operation_id,
                    )
                }
                "chat.steer" => {
                    let p: ChatSteer = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    let images = p.images.unwrap_or_default();
                    if let Some(item_id) = p.queue_item_id.filter(|item_id| !item_id.is_empty()) {
                        self.chat_queues.steer_queued(
                            &self.db,
                            &self.providers,
                            &p.session_id,
                            &p.turn_id,
                            &item_id,
                            &p.operation_id,
                        )
                    } else {
                        steer_chat_message(
                            &self.db,
                            &self.providers,
                            &p.session_id,
                            &p.turn_id,
                            &p.text,
                            &images,
                            &p.operation_id,
                        )
                    }
                }
                "chat.read" => {
                    let p: ChatReadTranscript = parse(&request.params)?;
                    let limit = p.limit.map(|limit| limit.clamp(1, CHAT_READ_MAX_ITEMS));
                    let limit = match (limit, principal.starts_with("peer:")) {
                        (Some(limit), _) => Some(limit),
                        (None, true) => Some(CHAT_READ_REMOTE_ITEMS),
                        (None, false) => None,
                    };
                    let items = match limit {
                        Some(limit) => self.db.chat_items_tail(&p.session_id, limit)?,
                        None => self.db.chat_items(&p.session_id)?,
                    };
                    Ok(serde_json::to_value(items)?)
                }
                "chat.subagent.read" => {
                    let p: ChatSubagentRead = parse(&request.params)?;
                    Ok(read_subagent_transcript(&self.db, &self.providers, p)?)
                }
                "chat.draft.read" => {
                    let p: ChatRead = parse(&request.params)?;
                    self.db.chat_draft(&p.session_id)
                }
                "chat.draft.save" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct ChatDraftSave {
                        session_id: String,
                        text: String,
                        expected_revision: i64,
                        operation_id: String,
                        lease_epoch: i64,
                    }
                    let p: ChatDraftSave = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.save_chat_draft(
                        &p.session_id,
                        &p.text,
                        p.expected_revision,
                        &p.operation_id,
                    )
                }
                "reviewDrafts.list" | "reviewDrafts.assetReferences" => {
                    crate::review_drafts::read(&self.db, &request.method, &request.params)
                }
                "reviewDrafts.upsert" | "reviewDrafts.delete" | "reviewDrafts.importLegacy" => {
                    let persist = || {
                        if principal.starts_with("peer:") { crate::review_drafts::validate_host_assets(&self.db, &self.config.data_dir, &request.params)?; }
                        let operation_id = request.params.get("operationId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| anyhow::anyhow!("invalid_request"))?;
                        self.db.bind_operation(operation_id, &request.method, &request.params)?;
                        crate::review_drafts::mutate(&self.db, &request.method, &request.params)
                    };
                    if principal.starts_with("peer:") { crate::attachments::with_reference_lock(persist) } else { persist() }
                }
                "chat.snapshot" => {
                    let p: ChatSnapshotRead = parse(&request.params)?;
                    self.db.acknowledge_session_replies(&p.session_id)?;
                    let session = self.db.session_by_id(&p.session_id)?.ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
                    let available = self.providers.history_reader_available(&session.provider);
                    let page = crate::chat_repair::ChatSnapshotPage {
                        before: p.before,
                        max_bytes: p.max_bytes.map(|bytes| bytes as usize),
                    };
                    self.providers.with_chat_repair_state(&p.session_id, |worker| {
                        self.db.transaction(|tx| {
                            let mut snapshot = crate::chat_repair::snapshot(tx, &p.session_id, &page, &worker, available)?;
                            if self.chat_queues.ingress_failed() { snapshot.repair.ingress_failed = Some(true); }
                            Ok(serde_json::to_value(snapshot)?)
                        })
                    })
                }
                "chat.image.read" => {
                    let p: ChatImageRead = parse(&request.params)?;
                    self.db.chat_image(&p.session_id, &p.item_id, p.part, p.index)
                }
                "chat.feedback.add" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct AddFeedback {
                        session_id: String,
                        turn_id: String,
                        text: String,
                        operation_id: String,
                        lease_epoch: i64,
                    }
                    let p: AddFeedback = parse(&request.params)?;
                    self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.bind_operation(&p.operation_id, "chat.feedback.add", &json!({
                        "sessionId":p.session_id,
                        "turnId":p.turn_id,
                        "text":p.text,
                        "operationId":p.operation_id,
                    }))?;
                    crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
                        .feedback_add(crate::chat_tools::FeedbackAdd {
                            session_id: p.session_id,
                            turn_id: p.turn_id,
                            text: p.text,
                            operation_id: p.operation_id,
                        })
                }
                "chat.feedback.read" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct ReadFeedback { session_id: String }
                    let p: ReadFeedback = parse(&request.params)?;
                    // Reads follow the existing unleased local-read model
                    // (`chat.read`, `chat.snapshot`): the local control pipe is
                    // trusted, and the write path above still requires a lease.
                    crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
                        .feedback_read(&p.session_id)
                }
                "chat.feedback.dismiss" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct DismissFeedback { session_id: String, note_ids: Vec<String>, operation_id: String, lease_epoch: i64 }
                    let p: DismissFeedback = parse(&request.params)?;
                    self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.bind_operation(&p.operation_id, "chat.feedback.dismiss", &json!({
                        "sessionId":p.session_id,
                        "noteIds":p.note_ids,
                        "operationId":p.operation_id,
                    }))?;
                    crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
                        .feedback_dismiss(crate::chat_tools::FeedbackDismiss {
                            session_id: p.session_id,
                            note_ids: p.note_ids,
                            operation_id: p.operation_id,
                        })
                }
                "chat.repair" => {
                    let p: ChatRepair = parse(&request.params)?;
                    self.repair_chat_history(principal, &p)
                }
                "qa.chat.projection.fail" => {
                    let p: ChatRead = parse(&request.params)?;
                    if !cfg!(debug_assertions) || std::env::var("THREADTERM_V3_RELOCATION_QA").as_deref() != Ok("1") {
                        return Err(anyhow::anyhow!("unknown_method"));
                    }
                    if self.db.session_by_id(&p.session_id)?.is_none() { return Err(anyhow::anyhow!("session_not_found")); }
                    qa_projection_sessions().lock().map_err(|_| anyhow::anyhow!("provider_internal"))?.insert(p.session_id, false);
                    Ok(Value::Null)
                }
                "chat.cancel" => {
                    let p: ChatCancel = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.stop_chat_turn(&p.session_id, &p.turn_id)?;
                    Ok(Value::Null)
                }
                "chat.approve" => {
                    let p: ChatApprove = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    // F07: the user's widening decision is the runtime's to
                    // record, not the provider's.
                    if let Some(result) = self.approve_delegation_authority(&p)? {
                        return Ok(result);
                    }
                    // A running review's hidden reviewers ask through the chat that owns it;
                    // holding that chat's lease is the authority to answer them.
                    let target = crate::code_review::approval_owner(&self.db, &p.session_id, &p.turn_id, &p.approval_id)?
                        .unwrap_or_else(|| p.session_id.clone());
                    approve_chat_request(
                        &self.db,
                        &self.providers,
                        &target,
                        &p.turn_id,
                        &p.approval_id,
                        &p.choice_id,
                        &p.operation_id,
                    )
                }
                "chat.answer" => {
                    let p: ChatAnswer = parse(&request.params)?;
                    self.leases.require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    if [&p.session_id, &p.turn_id, &p.approval_id, &p.operation_id].iter().any(|s| s.is_empty()) {
                        return Err(crate::providers::ProviderError::new("answer_invalid", "Question identifiers must not be empty").into());
                    }
                    let chat_tools = crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?;
                    let target = crate::code_review::approval_owner(&self.db, &p.session_id, &p.turn_id, &p.approval_id)?
                        .unwrap_or_else(|| p.session_id.clone());
                    let result = answer_chat_request(&self.db, &self.providers, &chat_tools, AnswerChatRequest {
                        session_id: &target,
                        turn_id: &p.turn_id,
                        approval_id: &p.approval_id,
                        response: &p.response,
                        operation_id: &p.operation_id,
                    })?;
                    if let Err(error) = self.chat_queues.plan_resolved(&self.db, &self.providers, &target, &p.approval_id) {
                        eprintln!("prompt queue plan resolution failed for {target}: {error}");
                    }
                    Ok(result)
                }
                "chat.projectTrust.set" => self.set_pi_project_trust(principal, &request.params),
                "chat.options" => {
                    let p: ChatRead = parse(&request.params)?;
                    let state = permission_modes::options(&self.db, &self.providers, &p.session_id)?;
                    if let Ok(Some(session)) = self.db.session_by_id(&p.session_id) {
                        let _ = crate::code_review::remember_provider_options(&self.db, &session.provider, &state);
                    }
                    Ok(state)
                }
                "chat.backgroundTasks.list" => {
                    let p: ChatRead = parse(&request.params)?;
                    if self.db.session_by_id(&p.session_id)?.is_none() {
                        return Err(anyhow::anyhow!("session_not_found"));
                    }
                    self.providers
                        .chat_background_tasks(&p.session_id)
                        .map_err(anyhow::Error::from)
                }
                "chat.backgroundTask.stop" => {
                    let p: ChatBackgroundTaskStop = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    background_task_stop_recording(&self.db, &p.operation_id, || {
                        self.providers.chat_background_task_stop(&p.session_id, &p.task_id)
                            .map_err(anyhow::Error::from)
                    })
                }
                "chat.connection" => {
                    let p: ChatRead = parse(&request.params)?;
                    Ok(self.connection_state(&p.session_id)?)
                }
                "chat.context.read" => {
                    let p: ChatRead = parse(&request.params)?;
                    if self.db.session_by_id(&p.session_id)?.is_none() {
                        return Err(anyhow::anyhow!("session_not_found"));
                    }
                    Ok(self.db.chat_context(&p.session_id)?.unwrap_or(Value::Null))
                }
                "chat.connect" => {
                    let p: ChatConnect = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    if let Some(result) = self.db.operation(&p.operation_id)? {
                        return Ok(result);
                    }
                    self.connect_chat(&p.session_id, p.resume)?;
                    if p.resume {
                        // A user Continue or send on a finished delegation keeps
                        // the child open until its new turn finishes.
                        self.delegations.note_user_resume(&p.session_id);
                    }
                    let state = self.connection_state(&p.session_id)?;
                    self.db
                        .complete_operation(&p.operation_id, "chat.connect", &state)?;
                    Ok(state)
                }
                "chat.option.set" => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct ChatOptionSet {
                        session_id: String,
                        option_id: String,
                        value: String,
                        lease_epoch: i64,
                        #[allow(dead_code)]
                        operation_id: String,
                    }
                    let p: ChatOptionSet = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    let session = self.db.session_by_id(&p.session_id)?
                        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
                    set_chat_option(&self.db, &self.providers, &p.session_id, &session.provider, &p.option_id, &p.value)
                }
                _ => Err(anyhow::anyhow!("unknown_method")),
            }
        })();
        // Every settings writer uses Database's connection guard. Invalidate
        // after that guard (and plugin/provider locks) has been released, even
        // if a later writer step failed after committing its revision.
        if matches!(request.method.as_str(), "settings.update" | "settings.import.apply"
            | "plugin.setEnabled" | "plugin.selectBrowserBinding" | "plugin.reload") {
            self.browser_tools.invalidate_eval_settings().map_err(browser_rpc_error)?;
        }
        outcome.map_err(|e| {
            if matches!(request.method.as_str(), "browser.approval.read" | "browser.approval.resolve") {
                return browser_rpc_error(e);
            }
            if let Some(error) = e.downcast_ref::<crate::providers::ProviderError>() {
                RpcError {
                    code: error.code.clone(),
                    message: error.message.clone(),
                    details: error.details.clone(),
                }
            } else {
                map_error(&e.to_string())
            }
        })
    }
    fn record_null(&self, operation_id: &str, method: &str) -> Result<()> {
        self.db.complete_null_operation(operation_id, method)?;
        Ok(())
    }
    /// `delegation.start`: creates the delegate's Chat session linked to the
    /// calling parent and returns at once; a worker connects it and auto-sends
    /// the prompt.
    fn start_delegation(&self, params: &Value) -> Result<Value> {
        let p: crate::delegation::StartRequest = parse(params)?;
        let parent =
            self.delegations
                .authorize(&self.db, &p.caller_session_id, &p.caller_token)?;
        if let Some(result) = self.db.operation(&p.operation_id)? {
            return Ok(result);
        }
        let _gate = self
            .delegations
            .start_gate
            .lock()
            .map_err(|_| anyhow::anyhow!("delegation gate poisoned"))?;
        crate::delegation::validate_start(&self.db, &self.providers, &parent, &p)?;
        // F07: the parent is a ceiling. A child that cannot be narrowed to fit
        // needs the user's explicit widening, which is asked for here and
        // answered in the parent chat - never by the delegating agent.
        let fit = crate::delegation::authority_fit(&self.db, &self.providers, &parent, &p.agent)?;
        if fit.widening.is_some() {
            let approval_id = crate::delegation::request_widening(&self.db, &parent, &p.agent, &fit, params)?;
            let awaiting = json!({
                "delegationId": Value::Null,
                "state": "awaiting_user",
                "agent": p.agent,
                "parentAuthority": fit.parent.as_str(),
                "childAuthority": fit.child.as_str(),
                "approvalId": approval_id,
            });
            // The same operation retried reports the pending decision instead
            // of asking the user again.
            self.db
                .complete_operation(&p.operation_id, "delegation.start", &awaiting)?;
            return Err(anyhow::anyhow!("delegation_authority_exceeded"));
        }
        self.begin_delegation(&p, &parent, &fit)
    }

    /// The user's answer to a widening card (F07). `Ok(None)` means the card is
    /// not ours and the provider approval path handles it.
    fn approve_delegation_authority(&self, p: &ChatApprove) -> Result<Option<Value>> {
        if crate::delegation::widening_part(&self.db, &p.session_id, &p.approval_id)?.is_none() {
            return Ok(None);
        }
        if let Some(result) = self.db.operation(&p.operation_id)? {
            return Ok(Some(result));
        }
        if !matches!(p.choice_id.as_str(), "allow_once" | "deny") {
            return Err(crate::providers::ProviderError::new(
                "invalid_choice",
                "Choose Allow once or Deny for this delegation",
            )
            .into());
        }
        let (request_id, stored) =
            crate::delegation::pending_widening(&self.db, &p.session_id, &p.approval_id)?;
        let allow = p.choice_id == "allow_once";
        // Everything the start needs is checked before the decision is spent, so
        // a refusal here leaves the user's pending card usable.
        let mut stored: crate::delegation::StartRequest = serde_json::from_value(stored)?;
        let parent = self
            .db
            .session_by_id(&stored.caller_session_id)?
            .ok_or_else(|| anyhow::anyhow!("delegation_not_found"))?;
        if allow {
            // The user's decision is a new operation: the asking start is
            // already recorded with its `awaiting_user` outcome.
            stored.operation_id = format!("{}:granted", stored.operation_id);
            crate::delegation::validate_start(&self.db, &self.providers, &parent, &stored)?;
        }
        if !crate::delegation::settle_widening(&self.db, &request_id, allow)? {
            return Err(anyhow::anyhow!("delegation_authority_expired"));
        }
        self.resolve_widening_card(&p.session_id, &p.approval_id, allow)?;
        if !allow {
            let denied = json!({"accepted": true, "allowed": false});
            self.db.complete_operation(&p.operation_id, "chat.approve", &denied)?;
            return Ok(Some(denied));
        }
        let _gate = self
            .delegations
            .start_gate
            .lock()
            .map_err(|_| anyhow::anyhow!("delegation gate poisoned"))?;
        crate::delegation::validate_start(&self.db, &self.providers, &parent, &stored)?;
        let fit = crate::delegation::authority_fit(&self.db, &self.providers, &parent, &stored.agent)?;
        let started = self.begin_delegation(&stored, &parent, &fit.widened())?;
        let result = json!({"accepted": true, "allowed": true, "delegationId": started["delegationId"].clone()});
        self.db.complete_operation(&p.operation_id, "chat.approve", &result)?;
        Ok(Some(result))
    }

    fn resolve_widening_card(&self, session_id: &str, approval_id: &str, allow: bool) -> Result<()> {
        let turn = self
            .db
            .chat_approval_part(session_id, approval_id)?
            .and_then(|(turn, _)| turn);
        crate::chat_projection::record(
            &self.db,
            session_id,
            turn.as_deref(),
            "chat.approval.resolved",
            &json!({"approvalId": approval_id, "status": "resolved", "outcome": if allow { "allowed" } else { "denied" }}),
        )
    }

    /// Creates and starts the delegate with the authority already decided.
    fn begin_delegation(
        &self,
        p: &crate::delegation::StartRequest,
        parent: &Session,
        fit: &crate::delegation::AuthorityFit,
    ) -> Result<Value> {
        let parent_cwd = crate::delegation::session_cwd(&self.db, parent)?;
        let delegation_id = uuid::Uuid::new_v4().to_string();
        let short = &delegation_id[..8];
        let workspace = p.workspace.as_deref().unwrap_or("shared");
        let (cwd, branch) = if workspace == "worktree" {
            let (path, branch) = crate::delegation::create_worktree(
                &self.db,
                parent,
                &parent_cwd,
                &p.agent,
                short,
                &p.operation_id,
            )?;
            crate::quick_launch::setup_after_worktree_create(&self.db, &self.pty, &json!({"projectId":parent.project_id,"path":path}));
            (path, Some(branch))
        } else {
            (parent_cwd, None)
        };
        let title = p
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| title.chars().take(120).collect::<String>())
            .unwrap_or_else(|| {
                let first = p.prompt.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
                first.trim().chars().take(60).collect()
            });
        let created = self.create_session(
            &SessionCreate {
                project_id: parent.project_id.clone(),
                cwd: Some(cwd.clone()),
                title: Some(title),
                provider: p.agent.clone(),
                mode: "chat".into(),
                executable: None,
                args: Vec::new(),
                native_id: None,
                operation_id: format!("{}:session", p.operation_id),
                defer_launch: false,
            },
            None,
        )?;
        let child_id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("session_create_failed"))?
            .to_owned();
        // The fitted authority is staged before the delegate's Chat opens, so
        // its first prompt never runs under a broader mode (F07).
        crate::delegation::stage_authority(&self.db, &child_id, fit.rows)?;
        let send_operation_id = format!("{}:send", p.operation_id);
        // The user's own words from the parent chat, copied by the runtime so
        // the delegating agent cannot paraphrase them (task 10-02-delegation-handoff).
        let (words, left_out) = crate::delegation::user_words_from_chat(
            &self.db,
            &parent.id,
            p.user_messages
                .unwrap_or(crate::delegation::DEFAULT_USER_MESSAGES),
        )?;
        let first_message = crate::delegation::first_message(&words, left_out, &p.prompt);
        crate::delegation::insert(
            &self.db,
            &crate::delegation::NewDelegation {
                id: &delegation_id,
                parent_session_id: &parent.id,
                child_session_id: &child_id,
                agent: &p.agent,
                workspace,
                workspace_path: &cwd,
                branch: branch.as_deref(),
                prompt: &p.prompt,
                user_messages: words.len() as u32,
                authority: Some(fit.child.as_str()),
                operation_id: &send_operation_id,
            },
        )?;
        let (db, providers) = (Arc::clone(&self.db), Arc::clone(&self.providers));
        let worker_delegations = Arc::clone(&self.delegations);
        let (worker_delegation, worker_child, prompt) =
            (delegation_id.clone(), child_id.clone(), first_message);
        std::thread::Builder::new()
            .name(format!("delegate-{short}"))
            .spawn(move || {
                crate::delegation::run_start(
                    &worker_delegations,
                    &db,
                    &providers,
                    &worker_delegation,
                    &worker_child,
                    &prompt,
                    &send_operation_id,
                )
            })?;
        let result = json!({
            "delegationId": delegation_id,
            "sessionId": child_id,
            "agent": p.agent,
            "state": "starting",
            "authority": fit.child.as_str(),
            "workspace": workspace,
            "workspacePath": cwd,
            "branch": branch,
        });
        self.db
            .complete_operation(&p.operation_id, "delegation.start", &result)?;
        Ok(result)
    }
    fn create_pi_terminal_fork(&self, mut p: SessionCreate, source: &str) -> Result<Value> {
        if p.provider != "pi" || p.mode != "terminal" || p.native_id.is_some()
            || p.defer_launch || p.executable.is_some() || !p.args.is_empty()
        {
            return Err(anyhow::anyhow!("invalid Pi terminal fork"));
        }
        if self.db.operation(&p.operation_id)?.is_some() {
            return self.create_session(&p, None);
        }
        let cwd = p.cwd.as_deref().ok_or_else(|| anyhow::anyhow!("cwd_required"))?;
        let destination = std::path::Path::new(cwd);
        if !destination.is_absolute() || !destination.is_dir() {
            return Err(anyhow::anyhow!("cwd must be an existing absolute directory"));
        }
        if let Some(project_id) = p.project_id.as_deref() {
            crate::workspace_services::workspace_root_for_cwd(&self.db, project_id, cwd)?;
        }
        validate_provider(&self.providers, &p.provider)?;
        crate::providers::common::validate_native_id(source)?;
        if !self.db.claim_external_operation(&p.operation_id)? {
            return Err(anyhow::anyhow!("operation_outcome_unknown"));
        }
        p.native_id = Some(self.providers.prepare_pi_terminal_fork(cwd, source)?);
        self.create_session(&p, None)
    }

    fn create_session(&self, p: &SessionCreate, source_session_id: Option<&str>) -> Result<Value> {
        validate_provider(&self.providers, &p.provider)?;
        validate_mode(&p.mode)?;
        if p.defer_launch
            && (p.provider != "codex"
                || p.mode != "terminal"
                || p.native_id.is_some()
                || p.executable.is_some()
                || !p.args.is_empty())
        {
            return Err(anyhow::anyhow!("deferred_launch_unsupported"));
        }
        let cwd = p
            .cwd
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("cwd is required"))?;
        let launch_cwd = std::path::Path::new(cwd);
        if !launch_cwd.is_absolute() || !launch_cwd.is_dir() {
            return Err(anyhow::anyhow!(
                "cwd must be an existing absolute directory"
            ));
        }
        // create_session persists an early starting snapshot for durability. A replay
        // must return the current row, rather than that stale starting snapshot.
        if let Some(existing) = self.db.operation(&p.operation_id)? {
            let id = existing
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("invalid prior session operation"))?;
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        let history = if let Some(native_id) = &p.native_id {
            if !self.providers.contains(&p.provider) {
                return Err(anyhow::anyhow!("provider_has_no_native_history"));
            }
            if let Some(owner) = self.db.native_owner(&p.provider, native_id)? {
                return Err(anyhow::anyhow!("native_session_exists:{}", owner.id));
            }
            if matches!(p.provider.as_str(), "grok" | "pi") && p.mode == "terminal" {
                self.providers
                    .preflight_terminal_resume(&p.provider, cwd, native_id)?;
            }
            // Codex must reject a child or ephemeral history before durable
            // session creation. Its terminal adapter performs the exact
            // thread/read validation without launching a PTY.
            if p.provider == "codex" {
                self.providers
                    .terminal_command(&p.provider, Some(native_id), None)
                    .map_err(anyhow::Error::from)?;
            }
            Some(serde_json::from_value::<Vec<crate::domain::ChatItem>>(
                self.providers.history_read(&p.provider, native_id)?,
            )?)
        } else {
            None
        };
        let workspace_root = if let Some(project_id) = p.project_id.as_deref() {
            crate::workspace_services::workspace_root_for_cwd(&self.db, project_id, cwd)?
        } else {
            std::fs::canonicalize(cwd)?
        };
        let session = self.db.create_session_with_deferred(
            CreateSession {
                project_id: p.project_id.as_deref(),
                title: p.title.as_deref(),
                provider: &p.provider,
                mode: &p.mode,
                native_id: p.native_id.as_deref(),
                operation_id: &p.operation_id,
            },
            p.defer_launch.then_some(cwd),
        )?;
        if let Err(error) =
            self.db
                .bind_session(&session.id, Some(&workspace_root.to_string_lossy()), None)
        {
            if p.defer_launch {
                let (code, message) = deferred_failure(&error);
                let _ = self
                    .db
                    .fail_deferred_codex_launch(&session.id, &code, &message);
            }
            return Err(error);
        }
        let launch = resolve_shell_launch(p, &self.db.settings_value()?);
        let spec = crate::session_configs::LaunchSpec {
            provider: launch.provider.clone(),
            mode: launch.mode.clone(),
            cwd: cwd.to_owned(),
            project_id: launch.project_id.clone(),
            title: launch.title.clone(),
            executable: launch.executable.clone(),
            args: launch.args.clone(),
        };
        if let Err(error) =
            crate::session_configs::save_new(&self.db, &session.id, &spec, source_session_id)
        {
            if p.defer_launch {
                let (code, message) = deferred_failure(&error);
                self.db
                    .fail_deferred_codex_launch(&session.id, &code, &message)?;
            } else {
                self.db.set_session_status(&session.id, "error", None)?;
            }
            return Err(error);
        }
        if p.mode == "chat" {
            if let Some(history) = history {
                self.db.import_chat_history(&session.id, &history)?;
            }
            // ChatView owns the explicit `chat.connect` action after it has
            // mounted and acquired the write lease. Returning the durable
            // `starting` row here lets the renderer show connection feedback
            // while the provider handshake is in progress. Codex terminals
            // with deferLaunch use their own durable background launch path.
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(&session.id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        if p.defer_launch {
            self.start_deferred_codex_launch(&session.id, p.clone(), cwd.to_owned())?;
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(&session.id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        let result = self.launch_session(&session.id, &launch, cwd);
        if result.is_err() {
            self.db.set_session_status(&session.id, "error", None)?;
        }
        result
    }
    fn start_deferred_codex_launch(
        &self,
        session_id: &str,
        request: SessionCreate,
        cwd: String,
    ) -> Result<()> {
        let mut gate = self
            .deferred_launch
            .lock()
            .map_err(|_| anyhow::anyhow!("deferred launch gate poisoned"))?;
        if gate.stopping {
            self.db.begin_deferred_codex_launch(session_id)?;
            self.db.fail_deferred_codex_launch(
                session_id,
                "runtime_stopping",
                "Runtime is shutting down; retry this session after restart",
            )?;
            return Err(anyhow::anyhow!("runtime_stopping"));
        }
        if gate.generations.contains_key(session_id) {
            return Err(anyhow::anyhow!("session_already_active"));
        }
        self.db.begin_deferred_codex_launch(session_id)?;
        gate.next_generation = gate
            .next_generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("deferred launch generation exhausted"))?;
        let generation = gate.next_generation;
        gate.generations.insert(session_id.to_owned(), generation);
        let id = session_id.to_owned();
        let db = Arc::clone(&self.db);
        let providers = Arc::clone(&self.providers);
        let pty = Arc::clone(&self.pty);
        let worker_gate = Arc::clone(&self.deferred_launch);
        let spawned = std::thread::Builder::new()
            .name(format!("codex-start-{session_id}"))
            .spawn(move || {
                let preparation_provider = Arc::clone(&providers);
                let launch_provider = Arc::clone(&providers);
                let launch_db = Arc::clone(&db);
                run_deferred_codex_launch(
                    &db,
                    &worker_gate,
                    &id,
                    generation,
                    || {
                        preparation_provider
                            .prepare_terminal("codex", &cwd)
                            .map_err(anyhow::Error::from)?
                            .ok_or_else(|| anyhow::anyhow!("codex returned no native session id"))
                    },
                    |native_id| {
                        let mut launch = request;
                        launch.native_id = Some(native_id.to_owned());
                        RuntimeService::launch_session_with(
                            &launch_db,
                            &launch_provider,
                            &pty,
                            &id,
                            &launch,
                            &cwd,
                        )?;
                        Ok(())
                    },
                );
            });
        if let Err(error) = spawned {
            gate.generations.remove(session_id);
            self.db.fail_deferred_codex_launch(
                session_id,
                "terminal_launch_failed",
                &format!("Could not start Codex preparation: {error}"),
            )?;
        }
        Ok(())
    }
    fn launch_session(&self, session_id: &str, p: &SessionCreate, cwd: &str) -> Result<Value> {
        Self::launch_session_with(&self.db, &self.providers, &self.pty, session_id, p, cwd)
    }
    fn launch_session_with(
        db: &Arc<Database>,
        providers: &Arc<Providers>,
        pty: &Arc<PtyManager>,
        session_id: &str,
        p: &SessionCreate,
        cwd: &str,
    ) -> Result<Value> {
        let _decision = (!matches!(p.provider.as_str(), "shell" | "custom"))
            .then(crate::environment::provider_decision);
        let admission = crate::chat_fork::session_admission(db, session_id)?;
        let _admission = admission.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?;
        if p.mode == "terminal" {
            let agent_provider = !matches!(p.provider.as_str(), "shell" | "custom");
            // Obtain the exact identity before launching the terminal. Some
            // providers accept a UUID; others create it through a native API.
            let assign_id = if agent_provider
                && p.native_id.is_none()
                && providers.terminal_capture(&p.provider) == TerminalCapture::PreAssigned
            {
                providers
                    .prepare_terminal(&p.provider, cwd)
                    .map_err(anyhow::Error::from)?
                    .or_else(|| Some(uuid::Uuid::new_v4().to_string()))
            } else {
                None
            };
            let launch = if !agent_provider {
                None
            } else {
                // A deferred Codex worker already proved this exact native ID
                // is durable before entering the launch fence. Avoid a second
                // potentially slow app-server read while stop waits on it.
                let resume_id = (!p.defer_launch)
                    .then_some(p.native_id.as_deref())
                    .flatten();
                let prepared_id = if p.defer_launch {
                    p.native_id.as_deref()
                } else {
                    assign_id.as_deref()
                };
                Some(
                    providers
                        .terminal_command(&p.provider, resume_id, prepared_id)
                        .map_err(anyhow::Error::from)?,
                )
            };
            let executable = launch
                .as_ref()
                .and_then(|v| v.get("program"))
                .and_then(Value::as_str)
                .or(p.executable.as_deref());
            let args = launch
                .as_ref()
                .and_then(|v| v.get("args"))
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()?
                .unwrap_or_else(|| p.args.clone());
            if agent_provider && executable.is_some_and(|program| !std::path::Path::new(program).is_file()) {
                return Err(crate::providers::ProviderError::unavailable(
                    &p.provider, format!("{} executable was not found on PATH", p.provider),
                ).into());
            }
            if let Some(assign_id) = assign_id.as_deref() {
                // Persist before the process can receive user input. Binding
                // failure must not leave an unowned, unrecoverable terminal.
                db.bind_native_id(session_id, assign_id)?;
            }
            if let Err(error) = pty.launch(Arc::clone(db), session_id, cwd, executable, &args) {
                db.set_session_status(session_id, "error", None)?;
                return Err(error);
            }
            if agent_provider {
                // Background snapshot keeps launch latency unchanged; an agent
                // TUI needs a prompt before it edits files.
                crate::review::capture_launch_in_background(Arc::clone(db), session_id.to_owned());
            }
        } else {
            let opened =
                match open_chat_with_empty_native_recovery(
                    db,
                    providers,
                    session_id,
                    &p.provider,
                    cwd,
                    p.native_id.as_deref(),
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        db.set_session_status(session_id, "error", None)?;
                        return Err(error.into());
                    }
                };
            if let Err(error) = restore_chat_options(db, providers, session_id, &p.provider) {
                let _ = providers.chat_stop(session_id);
                db.set_session_status(session_id, "error", None)?;
                return Err(error);
            }
            if let Err(error) = db.bind_session(
                session_id,
                None,
                opened.get("nativeId").and_then(Value::as_str),
            ) {
                // chat_open has already registered a live worker. A failed
                // durable binding must not leave that unowned worker alive.
                let _ = providers.chat_stop(session_id);
                db.set_session_status(session_id, "error", None)?;
                return Err(error);
            }
            if let Err(error) = apply_pending_chat_options(db, providers, session_id, &p.provider) {
                let _ = providers.chat_stop(session_id);
                db.set_session_status(session_id, "error", None)?;
                return Err(error);
            }
            db.set_session_status(session_id, "idle", None)?;
        }
        Ok(serde_json::to_value(
            db.session_by_id(session_id)?
                .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
        )?)
    }
    fn connection_state(&self, session_id: &str) -> Result<Value> {
        let session = self
            .db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        let mut state = self.providers.chat_connection(session_id);
        state["runtimeEpoch"] = json!(self.db.epoch()?);
        if session.mode != "chat"
            || ((session.read_only || (session.status == "exited" && !session.released))
                && state.get("phase").and_then(Value::as_str) != Some("ready"))
        {
            state["phase"] = json!("unavailable");
        }
        if state.get("nativeId").and_then(Value::as_str).is_none() {
            if let Some(native_id) = session.native_id {
                state["nativeId"] = json!(native_id);
            }
        }
        Ok(state)
    }
    fn connect_chat(&self, session_id: &str, resume: bool) -> Result<()> {
        connect_chat_session(&self.db, &self.providers, session_id, resume)
    }
    /// Retry an auto-release after the child's queue changed: a removed or
    /// drained follow-up leaves nothing to keep the worker for.
    fn retry_finished_child_release(&self, session_id: &str) {
        if crate::chat_queue::pending_work(&self.db, session_id).unwrap_or(true) {
            return;
        }
        if let Err(error) = crate::delegation::release_finished_child(
            &self.db,
            &self.providers,
            &self.delegations,
            &self.previews,
            session_id,
            None,
        ) {
            eprintln!("delegated child release failed for {session_id}: {error}");
        }
    }
    /// Stops a live session's process tree without ending the session. The
    /// native identity is kept, so a later Chat connect or terminal resume
    /// continues the same conversation. Releasing an already released or
    /// already ended session is a successful no-op.
    fn release_session_resources(&self, session_id: &str) -> Result<Session> {
        // One admission lock per session: chat.send, chat.connect, queue dispatch
        // and group delivery take the same lock, so none of them can start work
        // between the checks below, the kill, and the single status write.
        let admission = crate::chat_fork::session_admission(&self.db, session_id)?;
        let _admission = admission
            .lock()
            .map_err(|_| anyhow::anyhow!("provider_internal"))?;
        let session = self
            .db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if let Some((code, message)) = self.release_refusal(&session)? {
            return Err(anyhow::anyhow!("{code}: {message}"));
        }
        if session.released || !is_releasable_status(&session.status) {
            return Ok(session);
        }
        self.release_session_locked(&session)
    }
    /// Why this session cannot be released now, as a stable code and a sentence
    /// the UI can show. `None` means it can be released (or already is).
    fn release_refusal(&self, session: &Session) -> Result<Option<(&'static str, String)>> {
        let session_id = session.id.as_str();
        if session.read_only {
            return Ok(Some(("session_release_unavailable", "read-only history".into())));
        }
        if session.released || !is_releasable_status(&session.status) {
            return Ok(None);
        }
        if session.status == "starting"
            || session.activity.as_ref().is_some_and(|activity| {
                matches!(activity.state.as_str(), "running" | "awaiting_approval" | "awaiting_parent")
            })
        {
            return Ok(Some(("session_release_blocked", "the session is working or waiting for your answer".into())));
        }
        if session.mode == "chat" {
            if matches!(session.status.as_str(), "running" | "waiting") {
                return Ok(Some(("session_release_blocked", "the session is working or waiting for your answer".into())));
            }
            if crate::chat_projection::has_pending_request(&self.db, session_id)? {
                return Ok(Some(("session_release_blocked", "answer or dismiss the pending request first".into())));
            }
            if crate::chat_queue::pending_work(&self.db, session_id)? {
                return Ok(Some(("session_release_blocked", "send or remove the queued messages first".into())));
            }
        }
        if session.native_id.is_none() {
            return Ok(Some(("session_release_unavailable", "no native session ID was recorded".into())));
        }
        // Static adapter information only: a release must never start a provider
        // probe (version/login checks) just to decide whether resume can work.
        if session.mode == "terminal"
            && self.providers.terminal_capture(&session.provider) == crate::providers::TerminalCapture::None
        {
            return Ok(Some(("session_release_unavailable", "this provider cannot resume a terminal by ID".into())));
        }
        Ok(None)
    }
    /// The kill and the single status write. The caller holds the session's
    /// admission lock and has already run `release_refusal`.
    fn release_session_locked(&self, session: &Session) -> Result<Session> {
        let session_id = session.id.as_str();
        #[cfg(test)]
        if take_release_failure(session_id) {
            return Err(anyhow::anyhow!(
                "session_release_blocked: injected release failure"
            ));
        }
        crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?
            .revoke_session(session_id)?;
        self.browser_tools.revoke_session(session_id);
        crate::retry_scheduler::cancel_session(&self.db, session_id)?;
        if session.run.is_some() {
            crate::quick_launch::request_stop(&self.db, session_id)?;
        }
        {
            let mut gate = self
                .deferred_launch
                .lock()
                .map_err(|_| anyhow::anyhow!("deferred launch gate poisoned"))?;
            if gate.generations.remove(session_id).is_some() {
                self.db.cancel_deferred_codex_launch(session_id)?;
            }
        }
        if session.mode == "chat" {
            self.providers.chat_stop(session_id)?;
            self.previews.revoke_disabled(&self.providers)?;
            // status + released are written by one transaction, so a crash
            // cannot leave the session ended with no way to resume.
            self.db.release_session(session_id)?;
        } else {
            match self.pty.stop_for_release(&self.db, session_id) {
                Ok(()) => {}
                // The process may already be gone between the snapshot and the kill.
                Err(error) if error.to_string().contains("no live PTY") => {
                    self.db.release_session(session_id)?;
                }
                Err(error) => return Err(error),
            }
        }
        self.db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))
    }
    /// Release a list of sessions all or none: every admission lock is taken in
    /// sorted order first, every session is checked, and only if nothing refuses
    /// is anything stopped. One refusal changes nothing and names the sessions.
    fn release_sessions_bulk(&self, session_ids: &[String]) -> Result<Value> {
        let mut ordered: Vec<String> = session_ids.to_vec();
        ordered.sort();
        ordered.dedup();
        let mut locks = Vec::with_capacity(ordered.len());
        for id in &ordered {
            locks.push(crate::chat_fork::session_admission(&self.db, id)?);
        }
        let mut guards = Vec::with_capacity(locks.len());
        for lock in &locks {
            guards.push(lock.lock().map_err(|_| anyhow::anyhow!("provider_internal"))?);
        }
        let mut ready = Vec::new();
        let mut refused = Vec::new();
        for id in &ordered {
            let Some(session) = self.db.session_by_id(id)? else {
                refused.push(json!({"sessionId": id, "code": "session_not_found", "message": "The session no longer exists."}));
                continue;
            };
            match self.release_refusal(&session)? {
                Some((code, message)) => {
                    refused.push(json!({"sessionId": id, "code": code, "message": message}))
                }
                None => ready.push(session),
            }
        }
        if !refused.is_empty() {
            return Ok(json!({"released": Vec::<Value>::new(), "refused": refused}));
        }
        let mut released = Vec::with_capacity(ready.len());
        for session in ready {
            let session = if session.released || !is_releasable_status(&session.status) {
                session
            } else {
                self.release_session_locked(&session)?
            };
            released.push(serde_json::to_value(session)?);
        }
        Ok(json!({"released": released, "refused": Vec::<Value>::new()}))
    }
    /// The renderer's scope rule: separators, trailing slash and case do not
    /// distinguish paths, and a missing worktree path means the project path.
    fn same_canonical_scope(left: &str, right: &str) -> bool {
        let key = |value: &str| {
            let plain = crate::git_read::plain_path(std::path::Path::new(value));
            let mut text = plain.to_string_lossy().replace('\\', "/");
            while text.ends_with('/') {
                text.pop();
            }
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text
            }
        };
        !left.trim().is_empty() && !right.trim().is_empty() && key(left) == key(right)
    }
    fn session_in_scope(
        session: &Session,
        project_id: Option<&str>,
        worktree_path: Option<&str>,
        project_path: Option<&str>,
    ) -> bool {
        if !project_id.is_none_or(|id| session.project_id.as_deref() == Some(id)) {
            return false;
        }
        worktree_path.is_none_or(|path| {
            session
                .worktree_path
                .as_deref()
                .or(project_path)
                .is_some_and(|session_path| Self::same_canonical_scope(session_path, path))
        })
    }
    /// Requests that mean the user used this session. A queue read, a lease
    /// release and a hidden renew are deliberately absent.
    fn touch_idle_request(&self, method: &str, params: &Value) {
        if matches!(
            method,
            "chat.send"
                | "chat.steer"
                | "chat.approve"
                | "chat.answer"
                | "chat.cancel"
                | "chat.connect"
                | "session.claim"
                | "terminal.input"
                | "chat.queue.add"
                | "chat.queue.update"
                | "chat.queue.remove"
                | "chat.queue.move"
                | "chat.queue.pause"
                | "chat.queue.resume"
                | "chat.queue.send"
        ) {
            if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
                self.idle.touch(session_id);
            }
        }
    }
    fn session_process_ids_with_busy(&self, session: &Session) -> (Vec<u32>, bool) {
        if session.mode == "chat" {
            self.providers.chat_process_ids(&session.id)
        } else {
            (self.pty.process_ids(&session.id), false)
        }
    }
    fn session_process_ids(&self, session: &Session) -> Vec<u32> {
        self.session_process_ids_with_busy(session).0
    }
    /// Why this session cannot be released now, as the sentence the row shows.
    fn release_blocked_reason(&self, session: &Session) -> Result<Option<String>> {
        if let Some((_, message)) = self.release_refusal(session)? {
            return Ok(Some(message));
        }
        if session.mode == "chat" {
            return Ok(match self
                .providers
                .chat_has_running_background_task(&session.id)
            {
                Ok(true) => Some("a background task is running".into()),
                Ok(false) => None,
                Err(_) => Some("the session is busy".into()),
            });
        }
        Ok(None)
    }
    /// One predicate for Running agents, the menu count and `releaseIdle`:
    /// nothing refuses it, no background task runs, the last use is at least
    /// `min_seconds` ago, and no holder reported visible in the last 30 s.
    fn idle_now(
        &self,
        session: &Session,
        now: chrono::DateTime<chrono::Utc>,
        min_seconds: i64,
    ) -> Result<bool> {
        if self.release_blocked_reason(session)?.is_some() {
            return Ok(false);
        }
        Ok(self.idle.idle_seconds(&session.id, now).unwrap_or(0) >= min_seconds
            && !self.idle.visible_within(&session.id, now, 30))
    }
    /// One sweep over chat workers. `now` is a parameter so tests drive it.
    pub(crate) fn sweep_idle(&self, now: chrono::DateTime<chrono::Utc>) -> Result<usize> {
        let threshold = idle_release_seconds(&self.db);
        if threshold <= 0 {
            return Ok(0);
        }
        let mut released = 0;
        for session_id in self.providers.registered_chat_sessions() {
            match self.sweep_idle_candidate(&session_id, now, threshold) {
                Ok(true) => released += 1,
                Ok(false) => {}
                Err(error) => eprintln!("idle release for {session_id} failed: {error}"),
            }
        }
        Ok(released)
    }
    fn sweep_idle_candidate(
        &self,
        session_id: &str,
        now: chrono::DateTime<chrono::Utc>,
        threshold: i64,
    ) -> Result<bool> {
        let Some(session) = self.db.session_by_id(session_id)? else { return Ok(false) };
        if session.mode != "chat" || session.released || !is_releasable_status(&session.status) {
            self.idle.forget(session_id);
            return Ok(false);
        }
        // The first sweep after start seeds the clock; never release from it.
        if self.idle.seed(session_id, now) {
            return Ok(false);
        }
        if !self.idle_now(&session, now, threshold)? {
            return Ok(false);
        }
        let admission = crate::chat_fork::session_admission(&self.db, session_id)?;
        let _admission = admission
            .lock()
            .map_err(|_| anyhow::anyhow!("provider_internal"))?;
        // Re-read under the lock: a send or connect that won it touched the
        // clock, and a queue or approval may have appeared meanwhile.
        let Some(session) = self.db.session_by_id(session_id)? else { return Ok(false) };
        if session.released || !is_releasable_status(&session.status) {
            return Ok(false);
        }
        if !self.idle_now(&session, now, threshold)? {
            return Ok(false);
        }
        self.release_session_locked(&session)?;
        // A resumed delegate has no hold left once its idle release won.
        self.delegations.clear_user_resume(session_id);
        self.idle.forget(session_id);
        Ok(true)
    }
    /// Bulk Stop idle: the same predicate, each session under its own admission
    /// lock. A refusal is skipped; a failure is logged, counted and skipped, so
    /// one session never aborts the pass or loses the operation result.
    fn release_idle_sessions(
        &self,
        project_id: Option<&str>,
        worktree_path: Option<&str>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Value> {
        let sessions = self.db.sessions()?;
        let project_path = match (project_id, worktree_path) {
            (Some(id), Some(_)) => self.db.project_path(id)?,
            _ => None,
        };
        let mut released = Vec::new();
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let mut freed = std::collections::HashSet::new();
        for session in sessions.into_iter().filter(|session| {
            Self::session_in_scope(session, project_id, worktree_path, project_path.as_deref())
        }) {
            if session.read_only || session.released || !is_releasable_status(&session.status) {
                continue;
            }
            // Running agents lists only live trees; the menu count and this
            // action must release the same set, so a worker with no process
            // tree is not a candidate.
            if self.session_process_ids_with_busy(&session).0.is_empty() {
                continue;
            }
            let outcome = (|| -> Result<Option<Session>> {
                if !self.idle_now(&session, now, 30)? {
                    return Ok(None);
                }
                let admission = crate::chat_fork::session_admission(&self.db, &session.id)?;
                let _admission = admission
                    .lock()
                    .map_err(|_| anyhow::anyhow!("provider_internal"))?;
                let Some(current) = self.db.session_by_id(&session.id)? else { return Ok(None) };
                if current.released || !is_releasable_status(&current.status) {
                    return Ok(None);
                }
                if !self.idle_now(&current, now, 30)? {
                    return Ok(None);
                }
                freed.extend(self.session_process_ids(&current));
                let released_session = self.release_session_locked(&current)?;
                self.delegations.clear_user_resume(&current.id);
                self.idle.forget(&current.id);
                Ok(Some(released_session))
            })();
            match outcome {
                Ok(Some(session)) => released.push(serde_json::to_value(session)?),
                Ok(None) => skipped += 1,
                Err(error) => {
                    eprintln!("idle release for {} failed: {error}", session.id);
                    failed += 1;
                }
            }
        }
        let freed_bytes: u64 = freed
            .into_iter()
            .filter_map(crate::idle_release::process_memory_bytes)
            .sum();
        let mut result = json!({"released": released, "skipped": skipped, "failed": failed});
        if cfg!(windows) {
            result["freedBytes"] = json!(freed_bytes);
        }
        Ok(result)
    }
    fn resource_sample(&self) -> Result<Value> {
        #[cfg(windows)]
        {
            let runtime_pid = std::process::id();
            let Some(runtime) = crate::idle_release::process_sample(runtime_pid) else {
                return Ok(Value::Null);
            };
            let pids: std::collections::BTreeSet<_> = self
                .db
                .sessions()?
                .iter()
                .flat_map(|session| self.session_process_ids(session))
                .filter(|&pid| pid != runtime_pid)
                .collect();
            let mut processes = vec![runtime];
            processes.extend(pids.into_iter().filter_map(crate::idle_release::process_sample));
            Ok(serde_json::to_value(processes)?)
        }
        #[cfg(not(windows))]
        Ok(Value::Null)
    }

    /// Running agents: live session trees, with memory on Windows. On demand only.
    fn session_processes(
        &self,
        project_id: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<Value> {
        let now = chrono::Utc::now();
        let sessions = self.db.sessions()?;
        let project_path = match (project_id, worktree_path) {
            (Some(id), Some(_)) => self.db.project_path(id)?,
            _ => None,
        };
        let mut memory: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();
        let mut rows = Vec::new();
        for session in sessions.into_iter().filter(|session| {
            Self::session_in_scope(session, project_id, worktree_path, project_path.as_deref())
        }) {
            let (mut pids, busy) = self.session_process_ids_with_busy(&session);
            pids.sort_unstable();
            pids.dedup();
            if pids.is_empty() && !busy {
                continue;
            }
            let mut row_memory = 0u64;
            for pid in &pids {
                let bytes = *memory
                    .entry(*pid)
                    .or_insert_with(|| crate::idle_release::process_memory_bytes(*pid).unwrap_or(0));
                row_memory += bytes;
            }
            let idle_seconds = self.idle.idle_seconds(&session.id, now);
            let visible = self.idle.visible_within(&session.id, now, 30);
            let blocked = if busy {
                Some("the session is working or waiting for your answer".to_owned())
            } else {
                self.release_blocked_reason(&session)?
            };
            let idle = !busy
                && blocked.is_none()
                && idle_seconds.is_some_and(|seconds| seconds >= 30)
                && !visible;
            let mut row = json!({
                "sessionId": session.id,
                "processCount": pids.len(),
                "visible": visible,
                "idle": idle,
            });
            if cfg!(windows) {
                row["memoryBytes"] = json!(row_memory);
            }
            if let Some(seconds) = idle_seconds {
                row["idleSeconds"] = json!(seconds);
            }
            if busy {
                row["busy"] = json!(true);
            }
            if let Some(reason) = blocked {
                row["blocked"] = json!(reason);
            }
            rows.push(row);
        }
        let total: u64 = memory.values().sum();
        let mut result = json!({
            "sessions": rows,
            "idleReleaseMinutes": idle_release_minutes(&self.db),
        });
        if cfg!(windows) {
            result["memoryBytes"] = json!(total);
        }
        Ok(result)
    }
    /// One Stop: fence the queue, apply the turn-scoped effects, then let the
    /// provider decide. A provider that refuses did not stop a turn, so the
    /// session-wide pause is undone (turn-scoped cleanup for a turn that is
    /// really over may stay); an unhealthy provider pauses the queue again
    /// through dispatch and `state.changed` with the right reason.
    fn stop_chat_turn(&self, session_id: &str, turn_id: &str) -> Result<()> {
        let pause = self
            .chat_queues
            .pause_dispatch_capturing(&self.db, session_id, "stopped")?;
        let stopped = (|| -> Result<()> {
            self.browser_tools.cancel_session_pending(session_id, turn_id)?;
            let chat_tools =
                crate::chat_tools::shared(&self.config.database_path, Arc::clone(&self.db))?;
            chat_tools.cancel_turn(session_id, turn_id)?;
            chat_tools.clear_waiting_feedback(session_id, Some(turn_id))?;
            self.providers
                .chat_cancel(session_id, turn_id)
                .map_err(anyhow::Error::from)
        })();
        if stopped.is_err() {
            if let Err(error) = self.chat_queues.restore_dispatch(&self.db, session_id, pause) {
                eprintln!("prompt queue was not restored after a refused Stop: {error}");
            }
        }
        stopped
    }
    fn import_native_history(&self, params: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct HistoryImport {
            project_id: Option<String>,
            provider: String,
            native_id: String,
            cwd: String,
            mode: String,
            title: Option<String>,
            operation_id: String,
        }
        let p: HistoryImport = parse(params)?;
        validate_provider(&self.providers, &p.provider)?;
        validate_mode(&p.mode)?;
        if !self.providers.contains(&p.provider) {
            return Err(anyhow::anyhow!("provider_has_no_native_history"));
        }
        if let Some(result) = self.db.operation(&p.operation_id)? {
            let id = result
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("invalid prior history import operation"))?;
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        // Ownership is durable across active, ended, imported, and archived
        // sessions. Reusing an owner does not require re-reading provider data
        // or accepting a replacement cwd.
        if self.db.native_owner(&p.provider, &p.native_id)?.is_some() {
            let (owner, _) = self
                .db
                .import_history_session(crate::db::ImportHistorySession {
                    project_id: p.project_id.as_deref(),
                    title: p.title.as_deref(),
                    provider: &p.provider,
                    mode: &p.mode,
                    cwd: &p.cwd,
                    native_id: &p.native_id,
                    operation_id: &p.operation_id,
                    transcript: &[],
                })?;
            return Ok(serde_json::to_value(owner)?);
        }
        let cwd = std::path::Path::new(&p.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(anyhow::anyhow!("cwd_missing_choose_relocation"));
        }
        if p.provider == "grok" && p.mode == "terminal" {
            // An imported card claims the native ID and its project before
            // the user resumes it. Check the folder before making that claim.
            self.providers
                .preflight_terminal_resume(&p.provider, &p.cwd, &p.native_id)?;
        }
        if let Some(project_id) = p.project_id.as_deref() {
            crate::workspace_services::workspace_root_for_cwd(&self.db, project_id, &p.cwd)?;
        }
        let project_id = p.project_id.or_else(|| {
            crate::workspace_services::project_for_cwd(&self.db, &p.cwd)
                .ok()
                .flatten()
        });
        // Read the provider-owned record before creating a local owner. This does
        // not start a PTY or provider turn; the stored card remains read-only.
        let transcript: Vec<crate::domain::ChatItem> =
            serde_json::from_value(self.providers.history_read(&p.provider, &p.native_id)?)?;
        let (session, _) = self
            .db
            .import_history_session(crate::db::ImportHistorySession {
                project_id: project_id.as_deref(),
                title: p.title.as_deref(),
                provider: &p.provider,
                mode: &p.mode,
                cwd: &p.cwd,
                native_id: &p.native_id,
                operation_id: &p.operation_id,
                transcript: &transcript,
            })?;
        Ok(serde_json::to_value(session)?)
    }
    fn resume_native(&self, params: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Resume {
            session_id: String,
            cwd: Option<String>,
            operation_id: String,
            #[serde(default)]
            resume: bool,
        }
        let p: Resume = parse(params)?;
        let existing = self
            .db
            .session_by_id(&p.session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        // A released terminal kept its native identity but its process is gone.
        // Only an explicit Continue, send or keystroke may start it again.
        if existing.released && !p.resume {
            return Err(anyhow::anyhow!("session_resume_required"));
        }
        if p.resume {
            // Like an explicit chat.connect: the user resumed this child, so the
            // delegation path must not stop it again.
            self.delegations.note_user_resume(&p.session_id);
        }
        if self.db.operation(&p.operation_id)?.is_some() {
            return Ok(serde_json::to_value(existing)?);
        }
        if !existing.read_only
            && !matches!(existing.status.as_str(), "exited" | "error" | "interrupted")
        {
            return Err(anyhow::anyhow!("session_already_active"));
        }
        if !self.providers.contains(&existing.provider) {
            self.providers.require_agent(&existing.provider)?;
            return Err(anyhow::anyhow!("provider_has_no_native_history"));
        }
        let deferred_codex = existing.provider == "codex"
            && existing.mode == "terminal"
            && self.db.deferred_codex_launch(&existing.id)?.is_some();
        let stored_config = crate::session_configs::read(&self.db, &existing.id)?;
        let deferred_cwd = if deferred_codex {
            self.db.deferred_codex_cwd(&existing.id)?
        } else {
            None
        };
        let cwd = p
            .cwd
            .as_deref()
            .or(stored_config
                .as_ref()
                .map(|config| config.launch.cwd.as_str()))
            .or(deferred_cwd.as_deref())
            .or(existing.worktree_path.as_deref())
            .ok_or_else(|| anyhow::anyhow!("cwd_required"))?;
        if !std::path::Path::new(cwd).is_absolute() || !std::path::Path::new(cwd).is_dir() {
            return Err(anyhow::anyhow!("cwd_missing_choose_relocation"));
        }
        let grok_terminal = existing.provider == "grok" && existing.mode == "terminal";
        if let Some(native_id) = existing.native_id.as_deref().filter(|_| grok_terminal) {
            // Report the recorded directory even if the requested cwd is
            // outside the card's workspace. The workspace check still applies.
            self.providers
                .preflight_terminal_resume(&existing.provider, cwd, native_id)?;
        }
        let workspace_root = if let Some(project_id) = existing.project_id.as_deref() {
            crate::workspace_services::workspace_root_for_cwd(&self.db, project_id, cwd)?
        } else {
            std::fs::canonicalize(cwd)?
        };
        if existing.native_id.is_none() && deferred_codex {
            if stored_config.is_none() {
                crate::session_configs::save_new(
                    &self.db,
                    &existing.id,
                    &crate::session_configs::LaunchSpec {
                        provider: "codex".into(),
                        mode: "terminal".into(),
                        cwd: cwd.to_owned(),
                        project_id: existing.project_id.clone(),
                        title: Some(existing.title.clone()),
                        executable: None,
                        args: vec![],
                    },
                    None,
                )?;
            }
            self.db.reserve_resume(
                &existing.id,
                &workspace_root.to_string_lossy(),
                cwd,
                &p.operation_id,
            )?;
            self.output
                .seed(&existing.id, self.db.output_end(&existing.id)?);
            let launch = SessionCreate {
                project_id: existing.project_id.clone(),
                cwd: Some(cwd.to_owned()),
                title: Some(existing.title.clone()),
                provider: "codex".into(),
                mode: "terminal".into(),
                executable: None,
                args: vec![],
                native_id: None,
                operation_id: p.operation_id,
                defer_launch: true,
            };
            self.start_deferred_codex_launch(&existing.id, launch, cwd.to_owned())?;
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(&existing.id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        let native_id = existing
            .native_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("session_has_no_native_history"))?;
        if existing.mode == "terminal" && !grok_terminal {
            // Read-only validation must fail before reserving a launch or
            // appending a run marker. Missing history is not a new conversation.
            self.providers
                .preflight_terminal_resume(&existing.provider, cwd, native_id)?;
        }
        // The transcript pre-read only serves Chat history import. Terminal
        // resumes replay natively inside the provider TUI, and Codex validates
        // the exact thread when its terminal command is built.
        let history: Vec<crate::domain::ChatItem> = if existing.mode == "chat" {
            serde_json::from_value(self.providers.history_read(&existing.provider, native_id)?)?
        } else {
            Vec::new()
        };
        // Reserve the durable launch owner before touching provider state. Two
        // callers can both observe the same resumable snapshot above; only the
        // transaction winner may stop or replace the provider worker.
        self.db.reserve_resume(
            &existing.id,
            &workspace_root.to_string_lossy(),
            cwd,
            &p.operation_id,
        )?;
        if deferred_codex {
            self.db.begin_deferred_codex_launch(&existing.id)?;
            self.db
                .set_deferred_codex_launch_phase(&existing.id, "launching")?;
        }
        let launch = SessionCreate {
            project_id: existing.project_id.clone(),
            cwd: Some(cwd.into()),
            title: Some(existing.title.clone()),
            provider: existing.provider.clone(),
            mode: existing.mode.clone(),
            executable: None,
            args: vec![],
            native_id: Some(native_id.into()),
            operation_id: p.operation_id,
            defer_launch: false,
        };
        let result = (|| {
            // A failed Chat turn can leave the worker alive; end it before replacing it.
            if existing.mode == "chat" {
                let _ = self.providers.chat_stop(&existing.id);
            }
            crate::retry_scheduler::clear_suppression(&self.db, &existing.id)?;
            if existing.mode == "chat" {
                // Import native transcript only for an empty runtime history, avoiding
                // duplicating messages already projected during this app's lifetime.
                if self.db.chat_items(&existing.id)?.is_empty() {
                    self.db.import_chat_history(&existing.id, &history)?;
                }
            } else {
                // Continue the retained byte stream: seed the in-memory cursor
                // at the persisted end so post-restart appends never collide
                // with retained chunks. Codex startup evidence must consist
                // of native PTY bytes, never a host-written resume banner.
                let end = self.db.output_end(&existing.id)?;
                self.output.seed(&existing.id, end);
                if existing.provider != "codex" {
                    let marker = format!(
                        "\r\n\x1b[90m── ThreadTerm: session resumed at {} ──\x1b[0m\r\n",
                        chrono::Utc::now().to_rfc3339()
                    );
                    self.output
                        .append(&self.db, &existing.id, marker.as_bytes())?;
                }
            }
            self.launch_session(&existing.id, &launch, cwd)
        })();
        if deferred_codex {
            if let Err(ref failure) = result {
                let (code, message) = deferred_failure(failure);
                self.db
                    .fail_deferred_codex_launch(&existing.id, &code, &message)?;
            } else {
                self.db
                    .set_deferred_codex_launch_phase(&existing.id, "running")?;
            }
        }
        if result.is_err() {
            if existing.read_only {
                // A read-only import must remain an inspectable durable record
                // when a later explicit resume cannot launch. Its captured
                // transcript and native identity stay intact for another retry.
                self.db.restore_imported_read_only(&existing)?;
            } else {
                self.db.set_session_status(&existing.id, "error", None)?;
            }
        }
        result
    }
    fn rerun(&self, params: &Value) -> Result<Value> {
        if let Some(result) = crate::quick_launch::rerun(&self.db, &self.pty, params)? {
            return Ok(result);
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Rerun {
            session_id: String,
            operation_id: String,
        }
        let p: Rerun = parse(params)?;
        if let Some(existing) = self.db.operation(&p.operation_id)? {
            let id = existing
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("invalid prior rerun operation"))?;
            return Ok(serde_json::to_value(
                self.db
                    .session_by_id(id)?
                    .ok_or_else(|| anyhow::anyhow!("session disappeared"))?,
            )?);
        }
        let source = self
            .db
            .session_by_id(&p.session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if matches!(
            source.status.as_str(),
            "starting" | "running" | "idle" | "waiting"
        ) {
            return Err(anyhow::anyhow!(
                "End the current session before rerunning it"
            ));
        }
        let config = crate::session_configs::read(&self.db, &p.session_id)?
            .ok_or_else(|| anyhow::anyhow!("launch_config_missing"))?;
        // Launch configs written before defaultShell stored no executable. They were cmd.exe at
        // creation, so preserve that historical choice instead of applying today's setting.
        let executable = rerun_executable(&config.launch);
        let create = SessionCreate {
            project_id: config.launch.project_id,
            cwd: Some(config.launch.cwd),
            title: config.launch.title,
            provider: config.launch.provider,
            mode: config.launch.mode,
            executable,
            args: config.launch.args,
            native_id: None,
            operation_id: format!("{}:create", p.operation_id),
            defer_launch: false,
        };
        let result = self.create_session(&create, Some(&p.session_id))?;
        self.db
            .complete_operation(&p.operation_id, "session.rerun", &result)?;
        Ok(result)
    }
}
fn run_deferred_codex_launch<P, L>(
    db: &Arc<Database>,
    gate: &Arc<Mutex<DeferredLaunchGate>>,
    session_id: &str,
    generation: u64,
    prepare: P,
    launch: L,
) where
    P: FnOnce() -> Result<String>,
    L: FnOnce(&str) -> Result<()>,
{
    let _decision = crate::environment::provider_decision();
    let prepared = prepare();
    let Ok(mut owner) = gate.lock() else {
        eprintln!("deferred Codex launch gate poisoned for {session_id}");
        return;
    };
    if owner.generations.get(session_id) != Some(&generation) || owner.stopping {
        return;
    }
    let result = prepared.and_then(|native_id| {
        db.bind_native_id(session_id, &native_id)?;
        db.set_deferred_codex_launch_phase(session_id, "launching")?;
        launch(&native_id)?;
        db.set_deferred_codex_launch_phase(session_id, "running")?;
        Ok(())
    });
    if let Err(error) = result {
        let (code, message) = deferred_failure(&error);
        if let Err(write_error) = db.fail_deferred_codex_launch(session_id, &code, &message) {
            eprintln!("could not record Codex launch failure for {session_id}: {write_error}");
        }
    }
    owner.generations.remove(session_id);
}
fn deferred_failure(error: &anyhow::Error) -> (String, String) {
    let (code, message) =
        if let Some(provider) = error.downcast_ref::<crate::providers::ProviderError>() {
            (provider.code.clone(), provider.message.clone())
        } else {
            ("terminal_launch_failed".to_owned(), error.to_string())
        };
    (
        code,
        message
            .chars()
            .filter(|ch| !ch.is_control())
            .take(500)
            .collect(),
    )
}
fn parse<T: for<'a> Deserialize<'a>>(value: &Value) -> Result<T> {
    Ok(serde_json::from_value(value.clone())?)
}

fn validate_provider(providers: &Providers, provider: &str) -> Result<()> {
    if matches!(provider, "shell" | "custom") { return Ok(()); }
    providers.require_agent(provider).map_err(Into::into)
}
fn validate_mode(p: &str) -> Result<()> {
    if matches!(p, "terminal" | "chat") {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid_mode"))
    }
}
fn error(code: &str, message: &str) -> RpcError {
    RpcError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}
pub(crate) fn browser_rpc_error(failure: anyhow::Error) -> RpcError {
    let message = failure.to_string();
    let code = message.split(':').next().unwrap_or("");
    if code.starts_with("browser_") && code.len() <= 64
        && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_') {
        error(code, code)
    } else {
        error("browser_request_failed", "Browser request could not be completed")
    }
}
fn file_reference_rpc_error(failure: anyhow::Error) -> RpcError {
    let message = failure.to_string();
    match message.as_str() {
        "file_reference_invalid_path"
        | "file_reference_uri"
        | "file_reference_invalid_position"
        | "file_reference_session_not_found"
        | "file_reference_config_missing"
        | "file_reference_project_missing"
        | "file_reference_cwd_unavailable"
        | "file_reference_scope_mismatch"
        | "file_reference_relative_requires_absolute"
        | "file_reference_not_found"
        | "file_reference_outside_scope"
        | "file_reference_not_file"
        | "file_too_large"
        | "image_too_large"
        | "unsupported_image" => error(&message, &message),
        _ => error("file_reference_unavailable", "file_reference_unavailable"),
    }
}
fn map_error(message: &str) -> RpcError {
    let code = match message {
        value if value.starts_with("chat_repair_unavailable:") => "chat_repair_unavailable",
        value if value.starts_with("invalid_history_transcript:") => "invalid_history_transcript",
        value if value.starts_with("operation_conflict:") => "operation_conflict",
        value if value.starts_with("checkpoint_unavailable:") => "checkpoint_unavailable",
        value if value.starts_with("native_session_exists:") => "native_session_exists",
        "lease_held" => "lease_held",
        "lease_missing" | "stale_lease" => "stale_lease",
        "revision_conflict" => "revision_conflict",
        "file_changed" => "file_changed",
        "file_too_large" => "file_too_large",
        "unsupported_document" => "unsupported_document",
        "document_protected" => "document_protected",
        "invalid_offset" => "invalid_offset",
        "invalid_limit" => "invalid_limit",
        "invalid_path" => "invalid_path",
        "file_not_found" => "file_not_found",
        "file_unavailable" => "file_unavailable",
        "unknown_method" => "unknown_method",
        "provider adapter is not registered" => "provider_unavailable",
        "chat_not_open" => "chat_not_open",
        "chat_unavailable" => "chat_unavailable",
        "session_not_found" => "session_not_found",
        "session_already_active" => "session_already_active",
        "session_read_only_resume_required" => "session_read_only_resume_required",
        "session_has_no_native_history" => "session_has_no_native_history",
        "session_launch_unavailable" => "session_launch_unavailable",
        "deferred_launch_unsupported" => "deferred_launch_unsupported",
        "runtime_stopping" => "runtime_stopping",
        "cwd_required" | "cwd_missing_choose_relocation" => "cwd_missing",
        "native_identity_conflict" => "native_identity_conflict",
        "chat_repair_unavailable" | "chat_busy" | "chat_repair_superseded" | "invalid_history_transcript" => message,
        "operation_outcome_unknown" => "operation_outcome_unknown",
        value if crate::delegation::ERROR_CODES.contains(&value) => value,
        value if crate::quick_launch::ERROR_CODES.contains(&value.split(':').next().unwrap_or(value)) => {
            value.split(':').next().unwrap_or(value)
        }
        value
            if crate::git_selected_commit::ERROR_CODES
                .contains(&value.split(':').next().unwrap_or(value)) =>
        {
            value.split(':').next().unwrap_or(value)
        }
        "git_status_changed" => "git_status_changed",
        _ => "invalid_request",
    };
    let mut failure = error(code, message);
    if code == "chat_repair_unavailable" {
        failure.details = message.strip_prefix("chat_repair_unavailable:").map(|reason| json!({"reason":reason}));
    }
    failure
}

fn editor_navigation_rpc_error(failure: anyhow::Error) -> RpcError {
    let message = failure.to_string();
    let (code, detail) = message.split_once(':').unwrap_or((&message, &message));
    if code.starts_with("navigation_") {
        return error(code, detail.trim());
    }
    error("editor_navigation_unavailable", &message)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAdd {
    path: String,
    name: Option<String>,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRemove {
    id: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileResolve {
    session_id: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
    /// Untrusted hint from the renderer; validated by the runtime's own source path rules.
    #[serde(default)]
    source_search: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreate {
    project_id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    provider: String,
    mode: String,
    executable: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    native_id: Option<String>,
    operation_id: String,
    #[serde(default)]
    defer_launch: bool,
}

const PWSH_FALLBACK_NOTE: &str = "PowerShell 7 was not found; using Windows PowerShell. 未找到 PowerShell 7，已使用 Windows PowerShell。";

/// A Shell terminal stores its selected executable before launch, so restart and rerun do not
/// silently change with a later settings edit. Other providers and explicit non-pwsh launches
/// retain their requested command exactly.
fn resolve_shell_launch(request: &SessionCreate, settings: &Value) -> SessionCreate {
    if !cfg!(windows) || request.provider != "shell" || request.mode != "terminal" {
        return request.clone();
    }
    let requested = request.executable.as_deref().filter(|program| !program.trim().is_empty());
    if requested.is_some_and(|program| !program.eq_ignore_ascii_case("pwsh.exe")) {
        return request.clone();
    }
    resolve_shell_launch_with_pwsh(
        request,
        settings,
        crate::providers::common::find_executable("pwsh.exe"),
    )
}

fn resolve_shell_launch_with_pwsh(
    request: &SessionCreate,
    settings: &Value,
    pwsh: Option<std::path::PathBuf>,
) -> SessionCreate {
    if !cfg!(windows) || request.provider != "shell" || request.mode != "terminal" {
        return request.clone();
    }
    let requested = request.executable.as_deref().filter(|program| !program.trim().is_empty());
    // Only the renderer's bare PowerShell 7 request is eligible for fallback. A stored
    // absolute executable belongs to an existing session and must remain its exact launch.
    let wants_pwsh = requested.is_some_and(|program| program.eq_ignore_ascii_case("pwsh.exe"));
    let choice = settings.get("defaultShell").and_then(Value::as_str).unwrap_or("cmd");
    let use_default = requested.is_none();
    if !use_default && !wants_pwsh {
        return request.clone();
    }

    let mut launch = request.clone();
    if use_default && choice == "powershell" {
        launch.executable = Some("powershell.exe".into());
        launch.args.insert(0, "-NoLogo".into());
        return launch;
    }
    if use_default && choice == "cmd" {
        launch.executable = Some("cmd.exe".into());
        return launch;
    }
    if use_default && choice != "pwsh" {
        launch.executable = Some("cmd.exe".into());
        return launch;
    }
    if let Some(pwsh) = pwsh {
        launch.executable = Some(pwsh.to_string_lossy().into_owned());
        if use_default {
            launch.args.insert(0, "-NoLogo".into());
        }
        return launch;
    }

    launch.executable = Some("powershell.exe".into());
    launch.args = powershell_fallback_args(&request.args);
    launch
}

/// Windows PowerShell ships with Windows and reads the same command text as PowerShell 7, so a
/// missing pwsh falls back to it rather than running PowerShell commands in cmd.exe. The note is
/// printed first; the user's `-Command` text stays one argv item, so no second quoting layer.
fn powershell_fallback_args(args: &[String]) -> Vec<String> {
    let note = format!("Write-Host '{PWSH_FALLBACK_NOTE}'");
    let mut fallback = Vec::with_capacity(args.len() + 4);
    if !args.iter().any(|arg| arg.eq_ignore_ascii_case("-NoLogo")) {
        fallback.push("-NoLogo".to_owned());
    }
    let mut command_seen = false;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        fallback.push(arg.clone());
        if arg.eq_ignore_ascii_case("-Command") {
            if let Some(command) = rest.next() {
                fallback.push(format!("{note}; {command}"));
                command_seen = true;
            }
        }
    }
    if !command_seen {
        if !fallback.iter().any(|arg| arg.eq_ignore_ascii_case("-NoExit")) {
            fallback.push("-NoExit".into());
        }
        fallback.extend(["-Command".to_owned(), note]);
    }
    fallback
}

fn rerun_executable(launch: &crate::session_configs::LaunchSpec) -> Option<String> {
    if cfg!(windows)
        && launch.executable.as_deref().is_none_or(|program| program.trim().is_empty())
        && launch.provider == "shell"
        && launch.mode == "terminal"
    {
        Some("cmd.exe".into())
    } else {
        launch.executable.clone()
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStop {
    session_id: String,
    #[serde(default)]
    force: bool,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUpdate {
    session_id: String,
    title: Option<String>,
    followed: Option<bool>,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionClaim {
    session_id: String,
    #[serde(default)]
    takeover: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRelease {
    session_id: String,
    lease_epoch: i64,
    /// A renew from a view reports whether any holder is really visible.
    #[serde(default)]
    visible: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReleaseResources {
    session_id: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReleaseResourcesBulk {
    session_ids: Vec<String>,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReleaseIdle {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    worktree_path: Option<String>,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionProcesses {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    worktree_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalInput {
    session_id: String,
    data: String,
    lease_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResize {
    session_id: String,
    cols: u16,
    rows: u16,
    lease_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsUpdate {
    patch: Value,
    expected_revision: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationOnly {
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryList {
    provider: String,
    cursor: Option<String>,
    limit: Option<u32>,
    cwd: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRead {
    provider: String,
    native_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSend {
    session_id: String,
    text: String,
    #[serde(default)]
    images: Option<Vec<String>>,
    operation_id: String,
    lease_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSteer {
    session_id: String,
    turn_id: String,
    text: String,
    #[serde(default)]
    images: Option<Vec<String>>,
    operation_id: String,
    lease_epoch: i64,
    #[serde(default)]
    queue_item_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatFork {
    session_id: String,
    item_id: Option<String>,
    operation_id: String,
    lease_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatRepair {
    session_id: String,
    lease_epoch: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionAttentionAcknowledge {
    session_id: String,
    expected_revision: i64,
    operation_id: String,
}

const MAX_CHAT_IMAGES: usize = 4;
const MAX_CHAT_IMAGE_ENCODED_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn validate_chat_images(images: &[String]) -> Result<()> {
    if images.len() > MAX_CHAT_IMAGES {
        return Err(anyhow::anyhow!("too_many_images: at most {MAX_CHAT_IMAGES} images are supported / 最多支持 {MAX_CHAT_IMAGES} 张图片"));
    }
    let mut encoded_bytes = 0usize;
    for image in images {
        let Some((header, encoded)) = image.split_once(',') else {
            return Err(anyhow::anyhow!(
                "invalid_image: expected a base64 data URL / 图片必须是 base64 data URL"
            ));
        };
        if !matches!(
            header,
            "data:image/png;base64"
                | "data:image/jpeg;base64"
                | "data:image/webp;base64"
                | "data:image/gif;base64"
        ) {
            return Err(anyhow::anyhow!("unsupported_image: supported formats are PNG, JPEG, WebP, and GIF / 支持 PNG、JPEG、WebP 和 GIF"));
        }
        encoded_bytes = encoded_bytes.saturating_add(image.len());
        if encoded_bytes > MAX_CHAT_IMAGE_ENCODED_BYTES {
            return Err(anyhow::anyhow!("images_too_large: total encoded image data must not exceed 4 MiB / 图片编码总大小不能超过 4 MiB"));
        }
        if encoded.is_empty()
            || base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .is_err()
        {
            return Err(anyhow::anyhow!(
                "invalid_image: image data is not valid base64 / 图片数据不是有效的 base64"
            ));
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCancel {
    session_id: String,
    turn_id: String,
    lease_epoch: i64,
}

/// Native Stop is an external action: claim before dispatch and never replay
/// an uncertain outcome. Concurrent same-operation calls cannot both deliver.
fn background_task_stop_recording(
    db: &Database,
    operation_id: &str,
    stop: impl FnOnce() -> Result<bool>,
) -> Result<Value> {
    if let Some(receipt) = db.operation(operation_id)? { return Ok(receipt); }
    if !db.claim_external_operation(operation_id)? {
        // The first call may have receipted between our read and failed claim.
        return db.operation(operation_id)?.ok_or_else(|| anyhow::anyhow!("operation_outcome_unknown"));
    }
    let result = json!({"accepted":stop()?});
    db.complete_operation(operation_id, "chat.backgroundTask.stop", &result)?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatBackgroundTaskStop {
    session_id: String,
    task_id: String,
    lease_epoch: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatApprove {
    session_id: String,
    turn_id: String,
    approval_id: String,
    choice_id: String,
    lease_epoch: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAnswer {
    session_id: String,
    turn_id: String,
    approval_id: String,
    lease_epoch: i64,
    operation_id: String,
    response: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatConnect {
    session_id: String,
    lease_epoch: i64,
    operation_id: String,
    #[serde(default)]
    resume: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRead {
    session_id: String,
}
/// `chat.read`: the newest `limit` items in chronological order. A remote peer
/// without a limit gets a bounded tail instead of the whole transcript.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatReadTranscript {
    session_id: String,
    limit: Option<u32>,
}
/// `chat.read` bounds: a caller may ask for at most this many items, and a
/// remote peer that asks for none gets a bounded tail instead of everything.
const CHAT_READ_MAX_ITEMS: u32 = 2000;
const CHAT_READ_REMOTE_ITEMS: u32 = 500;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatSnapshotRead {
    session_id: String,
    /// Continue with the page strictly older than this cursor.
    before: Option<String>,
    max_bytes: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatImageRead {
    session_id: String,
    item_id: String,
    part: usize,
    index: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatSubagentRead {
    session_id: String,
    key: String,
    after_rev: Option<i64>,
}

fn read_subagent_transcript(
    db: &Database,
    providers: &Providers,
    request: ChatSubagentRead,
) -> Result<Value> {
    let empty = |source: &str, error: Option<String>| {
        let mut value = json!({"items":[],"rev":0,"truncated":false,"source":source});
        if let Some(error) = error {
            value["error"] = json!(error);
        }
        value
    };
    let card = match db.subagent_card(&request.session_id, &request.key) {
        Ok(card) => card,
        Err(error) => return Ok(empty("none", Some(error.to_string()))),
    };
    let Some(card) = card else {
        return Ok(empty("none", None));
    };
    let Some(info) = card
        .parts
        .iter()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("subagent"))
        .and_then(|part| part.get("data"))
    else {
        return Ok(empty("none", None));
    };
    let source = info
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("none");
    match source {
        "live" => match db.subagent_items_after(
            &request.session_id,
            &request.key,
            request.after_rev.unwrap_or(0),
        ) {
            Ok((items, rev, truncated)) => Ok(json!({
                "items": items,
                "rev": rev,
                "truncated": truncated,
                "source": "live",
            })),
            Err(error) => Ok(empty("live", Some(error.to_string()))),
        },
        "native" => {
            let session = match db.session_by_id(&request.session_id) {
                Ok(Some(session)) => session,
                Ok(None) => return Ok(empty("native", Some("Session not found".into()))),
                Err(error) => return Ok(empty("native", Some(error.to_string()))),
            };
            let Some(native_id) = session.native_id else {
                return Ok(empty("native", Some("Native session id is unavailable".into())));
            };
            let cwd = match crate::session_configs::read(db, &request.session_id) {
                Ok(config) => config
                    .as_ref()
                    .map(|value| value.launch.cwd.clone())
                    .or(session.worktree_path),
                Err(error) => return Ok(empty("native", Some(error.to_string()))),
            };
            let Some(cwd) = cwd else {
                return Ok(empty("native", Some("Session working directory is unavailable".into())));
            };
            match providers.subagent_transcript(
                &session.provider,
                &NativeSessionRef { native_id, cwd },
                info,
            ) {
                Ok(items) => Ok(json!({
                    "items": items,
                    "rev": 0,
                    "truncated": false,
                    "source": "native",
                })),
                Err(error) => Ok(empty("native", Some(error.message))),
            }
        }
        "session" => match crate::code_review::read_session_transcript(db, &request.session_id, &request.key)
        {
            Ok(value) => Ok(value),
            Err(error) => Ok(empty("session", Some(error.to_string()))),
        },
        _ => Ok(empty("none", None)),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalRead {
    session_id: String,
    cursor: Option<i64>,
    limit: Option<u32>,
    #[serde(default)]
    tail: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPresent {
    session_id: String,
    placement: String,
    presentation: String,
    workspace_path: Option<String>,
    operation_id: String,
}
fn retry_runner(service: Weak<RuntimeService>, cursor: &mut i64) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let Some(service) = service.upgrade() else {
            return;
        };
        let events = match service.db.events_after(*cursor) {
            Ok(events) => events,
            Err(error) => {
                eprintln!("retry event poll failed: {error}");
                continue;
            }
        };
        for (seq, event, data) in events {
            *cursor = seq;
            if event == "session.status"
                && data.get("status").and_then(Value::as_str) == Some("exited")
                && data
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .is_some_and(|code| code != 0)
            {
                if let Some(session_id) = data.get("sessionId").and_then(Value::as_str) {
                    let _ = crate::retry_scheduler::schedule_failed_exit(&service.db, session_id);
                }
            }
        }
        let due = match crate::retry_scheduler::due_attempts(&service.db, chrono::Utc::now()) {
            Ok(due) => due,
            Err(error) => {
                eprintln!("retry due poll failed: {error}");
                continue;
            }
        };
        for attempt in due {
            if let Ok(Some(attempt)) =
                crate::retry_scheduler::claim_enabled(&service.db, &attempt.id)
            {
                service.dispatch_retry_attempt(&attempt);
            }
        }
    }
}

#[cfg(test)]
mod plugin_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand};

    fn shell_launch(executable: Option<&str>, args: &[&str]) -> SessionCreate {
        SessionCreate {
            project_id: None,
            cwd: None,
            title: None,
            provider: "shell".into(),
            mode: "terminal".into(),
            executable: executable.map(str::to_owned),
            args: args.iter().map(|arg| (*arg).into()).collect(),
            native_id: None,
            operation_id: "default-shell".into(),
            defer_launch: false,
        }
    }

    #[cfg(windows)]
    #[test]
    fn shell_default_is_resolved_once_and_pwsh_falls_back_to_windows_powershell() {
        let cmd = resolve_shell_launch_with_pwsh(&shell_launch(Some(""), &[]), &json!({"defaultShell":"cmd"}), None);
        assert_eq!(cmd.executable.as_deref(), Some("cmd.exe"));

        let powershell = resolve_shell_launch_with_pwsh(&shell_launch(None, &[]), &json!({"defaultShell":"powershell"}), None);
        assert_eq!(powershell.executable.as_deref(), Some("powershell.exe"));
        assert_eq!(powershell.args, ["-NoLogo"]);

        let found = resolve_shell_launch_with_pwsh(&shell_launch(None, &[]), &json!({"defaultShell":"pwsh"}), Some("C:/tools/pwsh.exe".into()));
        assert_eq!(found.executable.as_deref(), Some("C:/tools/pwsh.exe"));
        assert_eq!(found.args, ["-NoLogo"]);

        let retained = resolve_shell_launch_with_pwsh(&shell_launch(Some("C:/tools/pwsh.exe"), &["-NoLogo"]), &json!({}), None);
        assert_eq!(retained.executable.as_deref(), Some("C:/tools/pwsh.exe"));
        assert_eq!(retained.args, ["-NoLogo"]);

        let fallback = resolve_shell_launch_with_pwsh(&shell_launch(Some("pwsh.exe"), &["-NoLogo", "-NoExit", "-Command", "Write-Output \"$env:USERPROFILE\\\""]), &json!({}), None);
        assert_eq!(fallback.executable.as_deref(), Some("powershell.exe"));
        assert_eq!(fallback.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert_eq!(fallback.args.len(), 4);
        assert!(fallback.args[3].contains(PWSH_FALLBACK_NOTE));
        assert!(fallback.args[3].ends_with("; Write-Output \"$env:USERPROFILE\\\""));

        let interactive = resolve_shell_launch_with_pwsh(&shell_launch(None, &[]), &json!({"defaultShell":"pwsh"}), None);
        assert_eq!(interactive.executable.as_deref(), Some("powershell.exe"));
        assert_eq!(interactive.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert!(interactive.args[3].contains(PWSH_FALLBACK_NOTE));

        let legacy = crate::session_configs::LaunchSpec {
            provider: "shell".into(), mode: "terminal".into(), cwd: "C:/".into(), project_id: None,
            title: None, executable: None, args: vec![],
        };
        assert_eq!(rerun_executable(&legacy).as_deref(), Some("cmd.exe"));
        let empty_legacy = crate::session_configs::LaunchSpec { executable: Some(" ".into()), ..legacy };
        assert_eq!(rerun_executable(&empty_legacy).as_deref(), Some("cmd.exe"));
    }

    const OC_MODEL_A: &str = "{\"providerID\":\"provider/one\",\"modelID\":\"model/a\"}";
    const OC_MODEL_B: &str = "{\"providerID\":\"provider/one\",\"modelID\":\"model/b\"}";
    struct OpenCodeOptionFixture {
        removed: Arc<AtomicBool>,
        removed_variant: Arc<AtomicBool>,
        calls: Arc<Mutex<Vec<String>>>,
        catalogue_error: bool,
    }
    impl ProviderAdapter for OpenCodeOptionFixture {
        fn id(&self) -> &'static str { "opencode" }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source:"builtin",plugin_id:None,icon:None,sign_in:None,remote_sign_in:None,homepage:None,
                id:"opencode".into(),name:"OpenCode fixture".into(),installed:true,version:None,
                terminal:false,chat:true,history:false,resume:true,terminal_resume_capture:"none",reason:None,auth:"unknown".into(),
                setup: Default::default(),
            }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> { Err(ProviderError::new("unsupported", "fixture")) }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, session: &str, _: &str, native: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(OpenCodeOptionChatFixture {
                native:native.map(str::to_owned).unwrap_or_else(|| format!("oc-{session}")),
                removed:Arc::clone(&self.removed),removed_variant:Arc::clone(&self.removed_variant),calls:Arc::clone(&self.calls),
                catalogue_error:self.catalogue_error,
                model:String::new(),agent:String::new(),variant:String::new(),error:None,
            }))
        }
    }
    struct OpenCodeOptionChatFixture {
        native: String, removed: Arc<AtomicBool>, removed_variant: Arc<AtomicBool>, calls: Arc<Mutex<Vec<String>>>,
        model: String, agent: String, variant: String, error: Option<String>,
        catalogue_error: bool,
    }
    impl ChatSession for OpenCodeOptionChatFixture {
        fn native_id(&self) -> Option<String> { Some(self.native.clone()) }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
        fn ui_state(&self) -> Value {
            if self.catalogue_error { return json!({"options":[],"commands":[],"loadState":"error","error":{"code":"provider_disconnected","message":"Catalogue unavailable"}}); }
            let removed = self.removed.load(Ordering::SeqCst);
            let models = if removed { vec![""] } else { vec!["", OC_MODEL_A, OC_MODEL_B] };
            let agents = if removed { vec!["", "build"] } else { vec!["", "build", "plan"] };
            let choices = |values: Vec<&str>| values.into_iter().map(|value| json!({"value":value,"name":value})).collect::<Vec<_>>();
            let mut options = vec![json!({"id":"next-model","name":"Model","value":self.model,"choices":choices(models)}),json!({"id":"agent","name":"Agent","value":self.agent,"choices":choices(agents)})];
            if !self.model.is_empty() {
                let variants = if self.removed_variant.load(Ordering::SeqCst) { vec!["", "low"] } else { vec!["", "low", "high"] };
                options.push(json!({"id":"variant","name":"Variant","value":self.variant,"choices":choices(variants)}));
            }
            let mut state = json!({"options":options,"commands":[],"loadState":if self.error.is_some() {"error"} else {"ready"}});
            if let Some(message) = &self.error { state["error"] = json!({"code":"chat_option_invalid","message":message}); }
            state
        }
        fn set_option(&mut self, id: &str, value: &str) -> Result<Value, ProviderError> {
            let valid = self.ui_state()["options"].as_array().unwrap().iter().find(|option| option["id"] == id)
                .is_some_and(|option| option["choices"].as_array().unwrap().iter().any(|choice| choice["value"] == value));
            if !valid {
                self.error = Some(format!("Unavailable saved {id} choice was not applied"));
                return Err(ProviderError::new("chat_option_invalid", self.error.clone().unwrap()));
            }
            self.error = None;
            self.calls.lock().unwrap().push(format!("{id}={value}"));
            match id {
                "next-model" => { if self.model != value { self.variant.clear(); } self.model = value.to_owned(); }
                "agent" => self.agent = value.to_owned(),
                "variant" => self.variant = value.to_owned(),
                _ => unreachable!(),
            }
            Ok(self.ui_state())
        }
    }
    fn oc_option_service(root: &std::path::Path, db: Arc<Database>, removed: &Arc<AtomicBool>, removed_variant: &Arc<AtomicBool>, calls: &Arc<Mutex<Vec<String>>>) -> RuntimeService {
        let mut service = test_service(root, db);
        service.providers = Arc::new(Providers::for_test(vec![Arc::new(OpenCodeOptionFixture { removed:Arc::clone(removed),removed_variant:Arc::clone(removed_variant),calls:Arc::clone(calls),catalogue_error:false })]));
        service
    }
    fn oc_option_session(db: &Database, root: &std::path::Path) -> crate::domain::Session {
        crate::session_configs::initialize(db).unwrap();
        let session = db.create_session(CreateSession {project_id:None,title:None,provider:"opencode",mode:"chat",native_id:None,operation_id:"oc-prefs"}).unwrap();
        db.bind_session(&session.id, Some(root.to_str().unwrap()), None).unwrap();
        db.set_session_status(&session.id,"idle",None).unwrap();
        session
    }
    fn oc_option_value(state: &Value, id: &str) -> Option<String> {
        state["options"].as_array()?.iter().find(|row| row["id"] == id)?.get("value")?.as_str().map(str::to_owned)
    }
    #[test]
    fn opencode_options_restore_after_reconnect_and_new_runtime_instance() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("runtime.sqlite");
        let db = Arc::new(Database::open(&path).unwrap()); let session = oc_option_session(&db,root.path());
        let removed = Arc::new(AtomicBool::new(false)); let variants = Arc::new(AtomicBool::new(false)); let calls = Arc::new(Mutex::new(Vec::new()));
        let runtime = oc_option_service(root.path(),Arc::clone(&db),&removed,&variants,&calls);
        runtime.connect_chat(&session.id, false).unwrap();
        for (id,value) in [("next-model",OC_MODEL_A),("agent","plan"),("variant","high")] { set_chat_option(&db,&runtime.providers,&session.id,"opencode",id,value).unwrap(); }
        let saved = db.chat_option_selections(&session.id,"opencode").unwrap();
        runtime.providers.chat_stop(&session.id).unwrap(); calls.lock().unwrap().clear(); runtime.connect_chat(&session.id, false).unwrap();
        assert_eq!(selected_chat_options(&runtime.providers.chat_options(&session.id).unwrap()),saved);
        assert_eq!(calls.lock().unwrap()[0],format!("next-model={OC_MODEL_A}"));
        assert_eq!(calls.lock().unwrap()[2],"variant=high");
        runtime.providers.chat_stop(&session.id).unwrap(); drop(runtime); drop(db);
        let reopened = Arc::new(Database::open(&path).unwrap());
        let restarted = oc_option_service(root.path(),Arc::clone(&reopened),&removed,&variants,&calls);
        restarted.connect_chat(&session.id, false).unwrap();
        assert_eq!(selected_chat_options(&restarted.providers.chat_options(&session.id).unwrap()),saved);
    }
    #[test]
    fn opencode_options_drop_stale_model_agent_and_variant_with_notice() {
        let root = tempfile::tempdir().unwrap(); let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = oc_option_session(&db,root.path()); let removed = Arc::new(AtomicBool::new(false)); let variants = Arc::new(AtomicBool::new(false)); let calls = Arc::new(Mutex::new(Vec::new()));
        let runtime = oc_option_service(root.path(),Arc::clone(&db),&removed,&variants,&calls);
        runtime.connect_chat(&session.id, false).unwrap();
        for (id,value) in [("next-model",OC_MODEL_A),("agent","plan"),("variant","high")] { set_chat_option(&db,&runtime.providers,&session.id,"opencode",id,value).unwrap(); }
        runtime.providers.chat_stop(&session.id).unwrap(); variants.store(true,Ordering::SeqCst); runtime.connect_chat(&session.id, false).unwrap();
        let state = runtime.providers.chat_options(&session.id).unwrap();
        assert_eq!(oc_option_value(&state,"next-model").as_deref(),Some(OC_MODEL_A));
        assert_eq!(oc_option_value(&state,"variant").as_deref(),Some(""));
        assert_eq!(state["error"]["code"],"chat_option_invalid");
        runtime.providers.chat_stop(&session.id).unwrap(); removed.store(true,Ordering::SeqCst); calls.lock().unwrap().clear(); runtime.connect_chat(&session.id, false).unwrap();
        let state = runtime.providers.chat_options(&session.id).unwrap();
        assert_eq!(oc_option_value(&state,"next-model").as_deref(),Some("")); assert_eq!(oc_option_value(&state,"agent").as_deref(),Some(""));
        assert!(oc_option_value(&state,"variant").is_none()); assert_eq!(state["error"]["code"],"chat_option_invalid");
        assert!(calls.lock().unwrap().iter().all(|call| !call.contains(OC_MODEL_A) && !call.ends_with("plan") && !call.ends_with("high")));
        assert!(!db.chat_option_selections(&session.id,"opencode").unwrap().to_string().contains("model/a"));
    }
    #[test]
    fn opencode_pending_fork_options_override_restored_preferences_and_persist() {
        let root = tempfile::tempdir().unwrap(); let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = oc_option_session(&db,root.path()); let removed = Arc::new(AtomicBool::new(false)); let variants = Arc::new(AtomicBool::new(false)); let calls = Arc::new(Mutex::new(Vec::new()));
        let runtime = oc_option_service(root.path(),Arc::clone(&db),&removed,&variants,&calls);
        db.set_chat_option_selections(&session.id,"opencode",&json!([{"id":"next-model","value":OC_MODEL_B},{"id":"agent","value":"plan"},{"id":"variant","value":"low"}])).unwrap();
        db.transaction(|tx| { tx.execute("INSERT INTO session_fork_options(session_id,data) VALUES (?,?)",rusqlite::params![session.id,json!([{"id":"next-model","value":OC_MODEL_A},{"id":"variant","value":"high"}]).to_string()])?; Ok(()) }).unwrap();
        runtime.connect_chat(&session.id, false).unwrap();
        let state = runtime.providers.chat_options(&session.id).unwrap();
        assert_eq!(oc_option_value(&state,"next-model").as_deref(),Some(OC_MODEL_A)); assert_eq!(oc_option_value(&state,"variant").as_deref(),Some("high"));
        assert_eq!(db.pending_fork_options(&session.id).unwrap(),json!([]));
        assert_eq!(db.chat_option_selections(&session.id,"opencode").unwrap(),selected_chat_options(&state));
        runtime.providers.chat_stop(&session.id).unwrap(); runtime.connect_chat(&session.id, false).unwrap();
        assert_eq!(oc_option_value(&runtime.providers.chat_options(&session.id).unwrap(),"next-model").as_deref(),Some(OC_MODEL_A));
    }
    #[test]
    fn opencode_catalogue_failure_preserves_preferences_and_failed_selections_do_not_save() {
        let root = tempfile::tempdir().unwrap(); let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = oc_option_session(&db,root.path()); let removed = Arc::new(AtomicBool::new(false)); let variants = Arc::new(AtomicBool::new(false)); let calls = Arc::new(Mutex::new(Vec::new()));
        let saved = json!([{"id":"next-model","value":OC_MODEL_A},{"id":"agent","value":"plan"},{"id":"variant","value":"high"}]);
        db.set_chat_option_selections(&session.id,"opencode",&saved).unwrap();
        let failed = Providers::for_test(vec![Arc::new(OpenCodeOptionFixture {removed:Arc::clone(&removed),removed_variant:Arc::clone(&variants),calls:Arc::clone(&calls),catalogue_error:true})]);
        assert!(ensure_chat_session_open(&db,&failed,&session.id).unwrap_err().to_string().contains("Catalogue unavailable"));
        assert!(!failed.chat_is_open(&session.id)); assert!(calls.lock().unwrap().is_empty());
        assert_eq!(db.chat_option_selections(&session.id,"opencode").unwrap(),saved);
        let runtime = oc_option_service(root.path(),Arc::clone(&db),&removed,&variants,&calls);
        runtime.connect_chat(&session.id, false).unwrap();
        assert!(set_chat_option(&db,&runtime.providers,&session.id,"opencode","next-model","missing").is_err());
        assert_eq!(db.chat_option_selections(&session.id,"opencode").unwrap(),saved);
        set_chat_option(&db,&runtime.providers,&session.id,"opencode","agent","build").unwrap();
        assert!(runtime.providers.chat_options(&session.id).unwrap().get("error").is_none());
    }

    struct PiOptionAdapter {
        values: Arc<Mutex<Vec<String>>>,
        fail_set: Arc<AtomicBool>,
    }

    impl ProviderAdapter for PiOptionAdapter {
        fn id(&self) -> &'static str { "pi" }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source: "builtin", plugin_id: None, icon: None, sign_in: None, remote_sign_in: None, homepage: None,
                id: "pi".into(), name: "Pi fixture".into(), installed: true, version: None,
                terminal: false, chat: true, history: false, resume: false,
                terminal_resume_capture: "none", reason: None, auth: "unknown".into(),
                setup: Default::default(),
            }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "Pi fixture has no terminal"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(PiOptionChat { values: Arc::clone(&self.values), fail_set: Arc::clone(&self.fail_set) }))
        }
    }

    struct PiOptionChat {
        values: Arc<Mutex<Vec<String>>>,
        fail_set: Arc<AtomicBool>,
    }

    impl ChatSession for PiOptionChat {
        fn native_id(&self) -> Option<String> { Some("pi-native".into()) }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
        fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
            if self.fail_set.load(Ordering::SeqCst) {
                return Err(ProviderError::new("chat_option_failed", "fixture rejected option"));
            }
            self.values.lock().unwrap().push(format!("{option_id}={value}"));
            Ok(json!({"value":value}))
        }
    }

    fn pi_test_providers(values: Arc<Mutex<Vec<String>>>, fail_set: Arc<AtomicBool>) -> Providers {
        Providers::for_test(vec![Arc::new(PiOptionAdapter { values, fail_set })])
    }

    #[test]
    fn background_stop_receipts_and_uncertain_calls_never_dispatch_twice() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("stop.sqlite")).unwrap();
        let calls = std::cell::Cell::new(0);
        let stop = || { calls.set(calls.get()+1); Ok(true) };
        assert_eq!(background_task_stop_recording(&db,"once",stop).unwrap(),json!({"accepted":true}));
        assert_eq!(background_task_stop_recording(&db,"once",stop).unwrap(),json!({"accepted":true}));
        assert_eq!(calls.get(),1);
        let uncertain = || { calls.set(calls.get()+1); Err(anyhow::anyhow!("lost native response")) };
        assert!(background_task_stop_recording(&db,"uncertain",uncertain).is_err());
        assert_eq!(background_task_stop_recording(&db,"uncertain",stop).unwrap_err().to_string(),"operation_outcome_unknown");
        assert_eq!(calls.get(),2);
    }

    #[test]
    fn concurrent_background_stop_claims_deliver_one_native_action() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("stop.sqlite")).unwrap());
        let (entered_tx,entered_rx)=std::sync::mpsc::channel();
        let (release_tx,release_rx)=std::sync::mpsc::channel();
        let first_db=Arc::clone(&db);
        let first=std::thread::spawn(move || background_task_stop_recording(&first_db,"same",|| {
            entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); Ok(true)
        }));
        entered_rx.recv().unwrap();
        assert_eq!(background_task_stop_recording(&db,"same",|| panic!("duplicate native Stop")).unwrap_err().to_string(),"operation_outcome_unknown");
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap(),json!({"accepted":true}));
        assert_eq!(background_task_stop_recording(&db,"same",|| panic!("replayed native Stop")).unwrap(),json!({"accepted":true}));
    }

    fn test_service(root: &std::path::Path, db: Arc<Database>) -> RuntimeService {
        RuntimeService::new(
            RuntimeConfig {
                data_dir: root.to_owned(),
                database_path: root.join("runtime.sqlite"),
                credential_path: root.join("credential"),
                pipe_base: r"\\.\pipe\threadterm-v3-service-test".into(),
            },
            db,
        )
    }

    #[test]
    fn local_file_read_access_blocks_every_destructive_lifecycle_before_effects() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let mut service = test_service(root.path(), Arc::clone(&db));
        service.desktop_files = crate::desktop_files::DesktopFiles::with_live_process_for_test(7);
        let project = db
            .add_project(
                project_root.to_str().unwrap(),
                Some("Project"),
                "barrier-project-add",
            )
            .unwrap();
        let access_id = uuid::Uuid::new_v4().to_string();
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "barrier-access-begin".into(),
                    method: "desktop.files.access.begin".into(),
                    params: json!({"accessId":access_id,"pid":42,"write":false}),
                },
            )
            .unwrap();

        let lifecycle = [
            (
                "project.remove",
                json!({"id":project.id,"operationId":"barrier-project-remove"}),
                "barrier-project-remove",
            ),
            (
                "worktree.remove",
                json!({"id":"missing-worktree","operationId":"barrier-worktree-remove"}),
                "barrier-worktree-remove",
            ),
            (
                "worktree.relocate",
                json!({
                    "id":"missing-worktree",
                    "path":root.path().join("relocated-worktree").to_string_lossy(),
                    "operationId":"barrier-worktree-relocate",
                }),
                "barrier-worktree-relocate",
            ),
            (
                "data.relocation.prepare",
                json!({
                    "targetPath":root.path().join("relocated-data").to_string_lossy(),
                    "operationId":"barrier-data-relocate",
                }),
                "barrier-data-relocate",
            ),
            (
                "runtime.shutdown",
                json!({"operationId":"barrier-shutdown"}),
                "barrier-shutdown",
            ),
        ];
        for (method, params, operation_id) in lifecycle {
            let failure = service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: format!("request-{operation_id}"),
                        method: method.into(),
                        params,
                    },
                )
                .unwrap_err();
            assert_eq!(failure.code, "desktop_files_busy", "{method}: {failure:?}");
            assert_eq!(db.operation(operation_id).unwrap(), None, "{method}");
            let request_bound: bool = db
                .transaction(|tx| {
                    Ok(tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM operation_requests WHERE id=?)",
                        [operation_id],
                        |row| row.get(0),
                    )?)
                })
                .unwrap();
            assert!(!request_bound, "{method}");
        }
        assert!(!service.shutdown_pending.load(Ordering::Acquire));
        let context = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "barrier-context".into(),
                    method: "desktop.files.context".into(),
                    params: json!({"kind":"workspace","projectId":project.id}),
                },
            )
            .unwrap();
        assert_eq!(context["rootPath"], project_root.to_string_lossy().as_ref());

        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "barrier-access-release".into(),
                    method: "desktop.files.access.release".into(),
                    params: json!({"accessId":access_id}),
                },
            )
            .unwrap();
        assert_eq!(
            service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: "barrier-project-remove-retry".into(),
                        method: "project.remove".into(),
                        params: json!({
                            "id":project.id,
                            "operationId":"barrier-project-remove-retry",
                        }),
                    },
                )
                .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn main_write_lease_blocks_every_public_file_mutation_before_effects() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        std::fs::write(project_root.join("write.txt"), "original").unwrap();
        std::fs::write(project_root.join("rename.txt"), "rename").unwrap();
        std::fs::write(project_root.join("delete.txt"), "delete").unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let mut service = test_service(root.path(), Arc::clone(&db));
        service.desktop_files =
            crate::desktop_files::DesktopFiles::with_live_process_for_test(7);
        let project = db
            .add_project(
                project_root.to_str().unwrap(),
                Some("Project"),
                "writer-project-add",
            )
            .unwrap();
        let access_id = uuid::Uuid::new_v4().to_string();
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "writer-access-begin".into(),
                    method: "desktop.files.access.begin".into(),
                    params: json!({"accessId":access_id,"pid":42,"write":true}),
                },
            )
            .unwrap();

        let mutations = [
            (
                "filesystem.write",
                json!({
                    "projectId":project.id,
                    "path":"write.txt",
                    "content":"blocked",
                    "expectedFingerprint":crate::workspace_services::fingerprint(b"original"),
                    "operationId":"writer-block-write",
                }),
                "writer-block-write",
            ),
            (
                "filesystem.create",
                json!({
                    "projectId":project.id,
                    "path":"created.txt",
                    "kind":"file",
                    "operationId":"writer-block-create",
                }),
                "writer-block-create",
            ),
            (
                "filesystem.rename",
                json!({
                    "projectId":project.id,
                    "path":"rename.txt",
                    "newPath":"renamed.txt",
                    "operationId":"writer-block-rename",
                }),
                "writer-block-rename",
            ),
            (
                "filesystem.delete",
                json!({
                    "projectId":project.id,
                    "path":"delete.txt",
                    "permanent":true,
                    "operationId":"writer-block-delete",
                }),
                "writer-block-delete",
            ),
        ];
        for (method, params, operation_id) in mutations {
            let failure = service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: format!("request-{operation_id}"),
                        method: method.into(),
                        params,
                    },
                )
                .unwrap_err();
            assert_eq!(failure.code, "desktop_files_busy", "{method}: {failure:?}");
            assert_eq!(db.operation(operation_id).unwrap(), None, "{method}");
            let request_bound: bool = db
                .transaction(|tx| {
                    Ok(tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM operation_requests WHERE id=?)",
                        [operation_id],
                        |row| row.get(0),
                    )?)
                })
                .unwrap();
            assert!(!request_bound, "{method}");
        }
        assert_eq!(
            std::fs::read_to_string(project_root.join("write.txt")).unwrap(),
            "original"
        );
        assert!(!project_root.join("created.txt").exists());
        assert!(project_root.join("rename.txt").exists());
        assert!(!project_root.join("renamed.txt").exists());
        assert!(project_root.join("delete.txt").exists());

        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "writer-access-release".into(),
                    method: "desktop.files.access.release".into(),
                    params: json!({"accessId":access_id}),
                },
            )
            .unwrap();
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "writer-write-after-release".into(),
                    method: "filesystem.write".into(),
                    params: json!({
                        "projectId":project.id,
                        "path":"write.txt",
                        "content":"allowed",
                        "expectedFingerprint":crate::workspace_services::fingerprint(b"original"),
                        "operationId":"writer-write-after-release",
                    }),
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(project_root.join("write.txt")).unwrap(),
            "allowed"
        );
    }

    #[test]
    fn public_file_mutation_gate_orders_a_waiting_main_writer_after_the_effect() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        std::fs::write(project_root.join("ordered.txt"), "before").unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let mut service = test_service(root.path(), Arc::clone(&db));
        service.desktop_files = crate::desktop_files::DesktopFiles::with_live_process_for_test(7);
        let project = db
            .add_project(
                project_root.to_str().unwrap(),
                Some("Project"),
                "ordered-project-add",
            )
            .unwrap();
        let service = Arc::new(service);

        let public_gate = service.relocation_gate.write().unwrap();
        service.desktop_files.require_no_writer(&db).unwrap();
        let waiting_service = Arc::clone(&service);
        let waiting_access = uuid::Uuid::new_v4().to_string();
        let thread_access = waiting_access.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let waiting_begin = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = waiting_service.dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "ordered-access-begin".into(),
                    method: "desktop.files.access.begin".into(),
                    params: json!({"accessId":thread_access,"pid":42,"write":true}),
                },
            );
            finished_tx.send(()).unwrap();
            result
        });
        started_rx.recv().unwrap();
        assert!(finished_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());

        service
            .dispatch_under_gate(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "ordered-public-write".into(),
                    method: "filesystem.write".into(),
                    params: json!({
                        "projectId":project.id,
                        "path":"ordered.txt",
                        "content":"public first",
                        "expectedFingerprint":crate::workspace_services::fingerprint(b"before"),
                        "operationId":"ordered-public-write",
                    }),
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(project_root.join("ordered.txt")).unwrap(),
            "public first"
        );
        drop(public_gate);

        assert_eq!(
            waiting_begin.join().unwrap().unwrap(),
            json!({"accessId":waiting_access})
        );
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "ordered-access-release".into(),
                    method: "desktop.files.access.release".into(),
                    params: json!({"accessId":waiting_access}),
                },
            )
            .unwrap();
    }

    #[test]
    fn exclusive_lifecycle_gate_makes_waiting_begin_revalidate_authority() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let mut service = test_service(root.path(), Arc::clone(&db));
        service.desktop_files =
            crate::desktop_files::DesktopFiles::with_live_process_for_test(7);
        let service = Arc::new(service);
        let project = db
            .add_project(
                project_root.to_str().unwrap(),
                Some("Project"),
                "ordering-project-add",
            )
            .unwrap();

        let lifecycle_gate = service.relocation_gate.write().unwrap();
        let waiting_service = Arc::clone(&service);
        let waiting_project = project.id.clone();
        let waiting_access = uuid::Uuid::new_v4().to_string();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiting_begin = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiting_service.dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "ordering-access-begin".into(),
                    method: "desktop.files.access.begin".into(),
                    params: json!({"accessId":waiting_access,"pid":42,"write":true}),
                },
            )?;
            let result = waiting_service.dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "ordering-begin".into(),
                    method: "desktop.files.mutation.begin".into(),
                    params: json!({
                        "accessId":waiting_access,
                        "method":"filesystem.write",
                        "params":{
                            "projectId":waiting_project,
                            "path":"README.md",
                            "content":"body",
                            "expectedFingerprint":"0".repeat(64),
                            "operationId":"ordering-file-write",
                        }
                    }),
                },
            );
            waiting_service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: "ordering-access-release".into(),
                        method: "desktop.files.access.release".into(),
                        params: json!({"accessId":waiting_access}),
                    },
                )
                .unwrap();
            result
        });
        started_rx.recv().unwrap();

        // Simulate the lifecycle handler's authority mutation while its
        // exclusive gate is held. The waiting begin must validate only after
        // this change, never against the stale project row.
        db.remove_project(&project.id, "ordering-project-remove")
            .unwrap();
        drop(lifecycle_gate);

        let failure = waiting_begin.join().unwrap().unwrap_err();
        assert_eq!(failure.code, "project_missing");
        assert!(!db
            .external_operation_pending("ordering-file-write")
            .unwrap());
    }

    fn pi_session(db: &Database, cwd: &std::path::Path, operation_id: &str) -> crate::domain::Session {
        crate::session_configs::initialize(db).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "pi",
            mode: "chat",
            native_id: None,
            operation_id,
        }).unwrap();
        db.bind_session(&session.id, Some(cwd.to_str().unwrap()), None).unwrap();
        db.set_session_status(&session.id, "idle", None).unwrap();
        session
    }

    #[test]
    fn pi_auto_retry_setting_is_restored_after_provider_reopen_and_database_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.sqlite");
        let db = Arc::new(Database::open(&path).unwrap());
        let session = pi_session(&db, root.path(), "pi-auto-retry-reopen");
        let values = Arc::new(Mutex::new(Vec::new()));
        let providers = pi_test_providers(Arc::clone(&values), Arc::new(AtomicBool::new(false)));

        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        let result = set_chat_option(&db, &providers, &session.id, "pi", "auto-retry", "false").unwrap();
        assert_eq!(result["value"], "false");
        assert_eq!(db.pi_auto_retry(&session.id).unwrap(), Some(false));
        providers.chat_stop(&session.id).unwrap();
        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        assert_eq!(values.lock().unwrap().as_slice(), ["auto-retry=false", "auto-retry=false"]);
        providers.chat_stop(&session.id).unwrap();
        drop(db);

        let reopened = Arc::new(Database::open(&path).unwrap());
        let restarted_providers = pi_test_providers(Arc::clone(&values), Arc::new(AtomicBool::new(false)));
        connect_chat_session(&reopened, &restarted_providers, &session.id, false).unwrap();
        assert_eq!(reopened.pi_auto_retry(&session.id).unwrap(), Some(false));
        assert_eq!(
            values.lock().unwrap().as_slice(),
            ["auto-retry=false", "auto-retry=false", "auto-retry=false"],
            "the persisted choice is reapplied to a fresh provider worker",
        );
    }

    #[test]
    fn pi_auto_retry_is_saved_only_after_provider_success_and_restore_failure_stops_open() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = pi_session(&db, root.path(), "pi-auto-retry-failure");
        let values = Arc::new(Mutex::new(Vec::new()));
        let fail_set = Arc::new(AtomicBool::new(false));
        let providers = pi_test_providers(Arc::clone(&values), Arc::clone(&fail_set));
        connect_chat_session(&db, &providers, &session.id, false).unwrap();

        fail_set.store(true, Ordering::SeqCst);
        assert!(set_chat_option(&db, &providers, &session.id, "pi", "auto-retry", "false").is_err());
        assert_eq!(db.pi_auto_retry(&session.id).unwrap(), None);
        providers.chat_stop(&session.id).unwrap();

        db.set_pi_auto_retry(&session.id, false).unwrap();
        assert!(ensure_chat_session_open(&db, &providers, &session.id).is_err());
        assert!(!providers.chat_is_open(&session.id), "failed restore must stop the newly opened worker");
    }

    struct CodexPermissionAdapter {
        calls: Arc<Mutex<Vec<String>>>,
        fail_set: Arc<AtomicBool>,
    }

    impl ProviderAdapter for CodexPermissionAdapter {
        fn id(&self) -> &'static str { "codex" }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source: "builtin", plugin_id: None, icon: None, sign_in: None, remote_sign_in: None, homepage: None,
                id: "codex".into(), name: "Codex fixture".into(), installed: true, version: None,
                terminal: false, chat: true, history: false, resume: true,
                terminal_resume_capture: "none", reason: None, auth: "unknown".into(),
                setup: Default::default(),
            }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "Codex fixture has no terminal"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            // Restore the saved sandbox and reviewer over the worker's defaults.
            Ok(Box::new(CodexPermissionChat {
                mode: "never".into(),
                sandbox: "workspace-write".into(),
                reviewer: "auto_review".into(),
                calls: Arc::clone(&self.calls),
                fail_set: Arc::clone(&self.fail_set),
            }))
        }
    }

    struct CodexPermissionChat {
        mode: String,
        sandbox: String,
        reviewer: String,
        calls: Arc<Mutex<Vec<String>>>,
        fail_set: Arc<AtomicBool>,
    }

    impl ChatSession for CodexPermissionChat {
        fn native_id(&self) -> Option<String> { Some("codex-native".into()) }
        fn ui_state(&self) -> Value {
            json!({"options":[
                {"id":"model","value":"fixture-model"},
                {"id":"mode","value":self.mode},
                {"id":"sandbox","value":self.sandbox},
                {"id":"reviewer","value":self.reviewer},
            ]})
        }
        fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
            if let Some(value) = text.strip_prefix("/sandbox ") { self.sandbox = value.trim().into(); }
            Ok(json!({"turnId":operation_id}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
        fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
            if self.fail_set.load(Ordering::SeqCst) {
                return Err(ProviderError::new("provider_settings_unconfirmed", "fixture did not confirm"));
            }
            if value == "retired" {
                return Err(ProviderError::new("option_unknown", "fixture no longer offers this value"));
            }
            self.calls.lock().unwrap().push(format!("{option_id}={value}"));
            match option_id {
                "mode" => self.mode = value.into(),
                "sandbox" => self.sandbox = value.into(),
                "reviewer" => self.reviewer = value.into(),
                _ => {}
            }
            Ok(self.ui_state())
        }
    }

    fn codex_permission_fixture(root: &std::path::Path) -> (Arc<Database>, Providers, crate::domain::Session, Arc<Mutex<Vec<String>>>, Arc<AtomicBool>) {
        let db = Arc::new(Database::open(&root.join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: "codex-permissions",
        }).unwrap();
        db.bind_session(&session.id, Some(root.to_str().unwrap()), None).unwrap();
        db.set_session_status(&session.id, "idle", None).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_set = Arc::new(AtomicBool::new(false));
        let providers = Providers::for_test(vec![Arc::new(CodexPermissionAdapter { calls: Arc::clone(&calls), fail_set: Arc::clone(&fail_set) })]);
        (db, providers, session, calls, fail_set)
    }

    fn codex_sandbox(providers: &Providers, session_id: &str) -> String {
        let state = providers.chat_options(session_id).unwrap();
        state["options"].as_array().unwrap().iter()
            .find(|option| option["id"] == "sandbox").unwrap()["value"].as_str().unwrap().to_owned()
    }

    #[test]
    fn codex_full_access_survives_reconnect_and_runtime_restart() {
        let root = tempfile::tempdir().unwrap();
        let (db, providers, session, calls, _) = codex_permission_fixture(root.path());
        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        assert!(calls.lock().unwrap().is_empty(), "nothing is restored before the user chooses");

        set_chat_option(&db, &providers, &session.id, "codex", "model", "other-model").unwrap();
        assert_eq!(db.chat_option_selections(&session.id, "codex").unwrap(), json!([]), "only permission options are remembered");
        set_chat_option(&db, &providers, &session.id, "codex", "sandbox", "danger-full-access").unwrap();
        set_chat_option(&db, &providers, &session.id, "codex", "reviewer", "user").unwrap();
        assert_eq!(
            db.chat_option_selections(&session.id, "codex").unwrap(),
            json!([{"id":"mode","value":"never"},{"id":"sandbox","value":"danger-full-access"},{"id":"reviewer","value":"user"}]),
        );

        providers.chat_stop(&session.id).unwrap();
        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        assert_eq!(codex_sandbox(&providers, &session.id), "danger-full-access");
        providers.chat_stop(&session.id).unwrap();
        drop(db);

        let reopened = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let restarted = Providers::for_test(vec![Arc::new(CodexPermissionAdapter { calls: Arc::clone(&calls), fail_set: Arc::new(AtomicBool::new(false)) })]);
        connect_chat_session(&reopened, &restarted, &session.id, false).unwrap();
        assert_eq!(codex_sandbox(&restarted, &session.id), "danger-full-access");
        assert!(restarted.chat_options(&session.id).unwrap()["options"].as_array().unwrap()
            .iter().any(|option| option["id"] == "reviewer" && option["value"] == "user"));
        assert_eq!(
            calls.lock().unwrap().iter().filter(|call| call.as_str() == "sandbox=danger-full-access").count(),
            3,
            "set once by the user, then re-applied on each reopen",
        );
    }

    #[test]
    fn codex_sandbox_slash_command_is_remembered_and_restore_failures_are_explicit() {
        let root = tempfile::tempdir().unwrap();
        let (db, providers, session, calls, fail_set) = codex_permission_fixture(root.path());
        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        send_chat_message(&db, &providers, &session.id, "/sandbox status", &[], "status").unwrap();
        assert_eq!(db.chat_option_selections(&session.id, "codex").unwrap(), json!([]), "a status query saves nothing");
        send_chat_message(&db, &providers, &session.id, "/sandbox read-only", &[], "slash").unwrap();
        assert_eq!(
            db.chat_option_selections(&session.id, "codex").unwrap(),
            json!([{"id":"mode","value":"never"},{"id":"sandbox","value":"read-only"},{"id":"reviewer","value":"auto_review"}]),
        );
        providers.chat_stop(&session.id).unwrap();
        connect_chat_session(&db, &providers, &session.id, false).unwrap();
        assert_eq!(codex_sandbox(&providers, &session.id), "read-only", "a stricter choice must not widen on reconnect");
        providers.chat_stop(&session.id).unwrap();

        fail_set.store(true, Ordering::SeqCst);
        assert!(ensure_chat_session_open(&db, &providers, &session.id).is_err());
        assert!(!providers.chat_is_open(&session.id), "a failed restore stops the worker instead of running wider");
        fail_set.store(false, Ordering::SeqCst);

        db.set_chat_option_selections(&session.id, "codex", &json!([{"id":"sandbox","value":"retired"}])).unwrap();
        assert!(connect_chat_session(&db, &providers, &session.id, false).is_err());
        assert!(!providers.chat_is_open(&session.id), "an unknown permission value must not fall back to the native default");
        assert!(!calls.lock().unwrap().iter().any(|call| call == "sandbox=retired"));
    }

    #[test]
    fn pi_new_replacement_allows_following_context_and_fences_stale_or_foreign_identity() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "pi",
            mode: "chat",
            native_id: Some("pi-before-new"),
            operation_id: "pi-new-projection",
        }).unwrap();
        db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "pi",
            mode: "chat",
            native_id: Some("pi-owned-by-other"),
            operation_id: "pi-new-conflict-owner",
        }).unwrap();
        let providers = Providers::for_test(vec![]);
        providers.preview_test_worker(&session.id, Some("worker-current"));
        let replacement = ProviderEvent {
            provider: "pi".into(),
            session_id: session.id.clone(),
            native_id: Some("pi-after-new".into()),
            turn_id: None,
            kind: "chat.session.replaced".into(),
            data: json!({"previousNativeId":"pi-before-new"}),
            worker_token: Some("worker-current".into()),
        };
        assert!(project_provider_event(&db, &providers, &replacement));
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().native_id.as_deref(), Some("pi-after-new"));

        let context = ProviderEvent {
            provider: "pi".into(),
            session_id: session.id.clone(),
            native_id: Some("pi-after-new".into()),
            turn_id: None,
            kind: "chat.context".into(),
            data: json!({"usage":{"usedTokens":321,"windowTokens":1000,"percent":32.1}}),
            worker_token: Some("worker-current".into()),
        };
        assert!(project_provider_event(&db, &providers, &context));
        assert_eq!(db.chat_context(&session.id).unwrap().unwrap()["usedTokens"], 321);

        let stale = ProviderEvent {
            worker_token: Some("worker-old".into()),
            native_id: Some("pi-stale".into()),
            data: json!({"previousNativeId":"pi-after-new"}),
            ..replacement.clone()
        };
        assert!(!project_provider_event(&db, &providers, &stale));
        let conflict = ProviderEvent {
            native_id: Some("pi-owned-by-other".into()),
            data: json!({"previousNativeId":"pi-after-new"}),
            ..replacement
        };
        assert!(!project_provider_event(&db, &providers, &conflict));
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().native_id.as_deref(), Some("pi-after-new"));
        assert_eq!(db.chat_context(&session.id).unwrap().unwrap()["usedTokens"], 321);
    }

    #[test]
    fn current_chat_ui_replaces_the_code_review_catalog_and_ignores_stale_or_failed_refreshes() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::code_review::initialize(&db).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: Some("native"),
            operation_id: "catalog-projection",
        }).unwrap();
        let providers = Providers::for_test(vec![]);
        providers.preview_test_worker(&session.id, Some("worker-current"));
        crate::code_review::remember_provider_options(
            &db,
            "codex",
            &json!({"options":[{"id":"model","category":"model","recommended":"old","choices":[{"value":"old"}]}]}),
        ).unwrap();
        let catalog = || db.transaction(|tx| {
            tx.query_row(
                "SELECT options_json FROM provider_option_catalog WHERE provider='codex'",
                [],
                |row| row.get::<_, String>(0),
            ).map_err(Into::into)
        }).unwrap();

        let fresh = ProviderEvent {
            provider: "codex".into(),
            session_id: session.id.clone(),
            native_id: Some("native".into()),
            turn_id: None,
            kind: "chat.ui".into(),
            data: json!({"options":[{"id":"model","category":"model","recommended":"new","choices":[{"value":"new"}]}]}),
            worker_token: Some("worker-current".into()),
        };
        assert!(project_provider_event(&db, &providers, &fresh));
        assert!(catalog().contains("new"));
        assert!(!catalog().contains("old"));

        let stale = ProviderEvent {
            worker_token: Some("worker-old".into()),
            data: json!({"options":[{"id":"model","category":"model","recommended":"stale","choices":[{"value":"stale"}]}]}),
            ..fresh.clone()
        };
        assert!(!project_provider_event(&db, &providers, &stale));
        assert!(catalog().contains("new"));
        assert!(!catalog().contains("stale"));

        let failed = ProviderEvent {
            data: json!({"options":[{"id":"model","category":"model","recommended":"failed","choices":[{"value":"failed"}]}],"loadState":"error","error":{"code":"provider_timeout"}}),
            ..fresh.clone()
        };
        assert!(project_provider_event(&db, &providers, &failed));
        assert!(catalog().contains("new"));
        assert!(!catalog().contains("failed"));

        let unavailable_selection = ProviderEvent {
            data: json!({"options":[{"id":"model","category":"model","recommended":"listed","choices":[{"value":"listed"}]}],"loadState":"error","error":{"code":"chat_option_invalid"}}),
            ..fresh
        };
        assert!(project_provider_event(&db, &providers, &unavailable_selection));
        assert!(catalog().contains("listed"));
        assert!(!catalog().contains("new"));
    }

    #[test]
    fn chat_subagent_read_is_incremental_and_reports_native_errors() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: Some("native-session"),
                operation_id: "subagent-session",
            })
            .unwrap();
        db.bind_session(
            &session.id,
            Some(root.path().to_str().unwrap()),
            None,
        )
        .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.subagent",
            &json!({"key":"live","info":{"status":"running","transcript":"live"}}),
        )
        .unwrap();
        for (id, text) in [("one", "first"), ("two", "second")] {
            db.record_provider_event(
                &session.id,
                Some("turn"),
                "chat.subagent.item",
                &json!({"key":"live","item":{"id":id,"role":"assistant","parts":[{"type":"text","text":text}]}}),
            )
            .unwrap();
        }
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.subagent",
            &json!({"key":"native","info":{"status":"completed","transcript":"native"}}),
        )
        .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.subagent",
            &json!({"key":"none","info":{"status":"completed","transcript":"none"}}),
        )
        .unwrap();
        db.set_session_status(&session.id, "exited", Some(0)).unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let read = |key: &str, after_rev: Option<i64>| {
            service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: format!("subagent-{key}"),
                        method: "chat.subagent.read".into(),
                        params: json!({"sessionId":session.id,"key":key,"afterRev":after_rev}),
                    },
                )
                .unwrap()
        };
        let live = read("live", None);
        assert_eq!(live["source"], "live");
        assert_eq!(live["items"].as_array().unwrap().len(), 2);
        assert_eq!(live["rev"], 2);
        let after = read("live", Some(1));
        assert_eq!(after["items"].as_array().unwrap().len(), 1);
        assert_eq!(after["items"][0]["id"], "two");
        let native = read("native", None);
        assert_eq!(native["source"], "native");
        assert_eq!(native["items"], json!([]));
        assert_eq!(native["error"], "This agent does not expose subagent transcripts");
        let none = read("none", None);
        assert_eq!(none, json!({"items":[],"rev":0,"truncated":false,"source":"none"}));
    }

    #[test]
    fn terminal_read_tail_is_bounded_and_missing_sessions_are_errors() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "tail-session",
            })
            .unwrap();
        db.append_output(&session.id, 0, &vec![b'a'; 6_000])
            .unwrap();
        db.append_output(&session.id, 6_000, &vec![b'b'; 6_000])
            .unwrap();
        let service = test_service(root.path(), db);
        let read = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "tail-read".into(),
                    method: "terminal.read".into(),
                    params: json!({"sessionId":session.id,"tail":true,"limit":8192}),
                },
            )
            .unwrap();
        assert_eq!(read["fromCursor"], 3_808);
        assert_eq!(read["nextCursor"], 12_000);
        assert_eq!(read["truncated"], true);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read["data"].as_str().unwrap())
                .unwrap()
                .len(),
            8_192
        );
        for params in [
            json!({"sessionId":session.id,"tail":true,"cursor":0}),
            json!({"sessionId":session.id,"tail":true,"limit":8193}),
            json!({"sessionId":"missing","tail":true}),
        ] {
            assert!(service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: "invalid-tail-read".into(),
                        method: "terminal.read".into(),
                        params,
                    },
                )
                .is_err());
        }
    }

    #[test]
    fn terminal_read_restarts_a_pruned_cursor_at_the_oldest_retained_output() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "pruned-terminal-read",
            })
            .unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        db.append_output(&session.id, 0, &vec![b'x'; 4_096]).unwrap();
        db.append_output(&session.id, 4_096, b"retained output").unwrap();
        crate::retention::compact_active_for_test(&db, &session.id, 15, 1).unwrap();
        let service = test_service(root.path(), db);
        let read = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "read-pruned-output".into(),
                    method: "terminal.read".into(),
                    params: json!({"sessionId":session.id,"cursor":0,"limit":1024}),
                },
            )
            .unwrap();
        assert_eq!(read["fromCursor"], 4_096);
        assert_eq!(read["nextCursor"], 4_111);
        assert_eq!(read["truncated"], true);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read["data"].as_str().unwrap())
                .unwrap(),
            b"retained output"
        );
    }

    #[test]
    fn terminal_read_advances_past_a_fully_pruned_stream() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "fully-pruned-terminal-read",
            })
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO metadata(key,value) VALUES(?,?)",
                rusqlite::params![format!("terminal.outputEnd:{}", session.id), "8192"],
            )?;
            Ok(())
        })
        .unwrap();
        let service = test_service(root.path(), db);
        let read = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "read-fully-pruned-output".into(),
                    method: "terminal.read".into(),
                    params: json!({"sessionId":session.id,"cursor":0,"limit":1024}),
                },
            )
            .unwrap();
        assert_eq!(read["fromCursor"], 8_192);
        assert_eq!(read["nextCursor"], 8_192);
        assert_eq!(read["truncated"], true);
        assert_eq!(read["data"], "");
    }

    #[test]
    fn filesystem_resolve_is_a_session_scoped_read_only_rpc() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let cwd = root.join("nested");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(root.join("hello.rs"), "fn main() {}\n").unwrap();
        let db = Arc::new(Database::open(&temp.path().join("runtime.sqlite")).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let project = db
            .add_project(root.to_str().unwrap(), Some("repo"), "resolve-project")
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "resolve-session",
            })
            .unwrap();
        db.bind_session(&session.id, Some(root.to_str().unwrap()), None)
            .unwrap();
        crate::session_configs::save_new(
            &db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "codex".into(),
                mode: "chat".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                project_id: Some(project.id.clone()),
                title: None,
                executable: None,
                args: Vec::new(),
            },
            None,
        )
        .unwrap();
        let service = test_service(temp.path(), Arc::clone(&db));
        let resolved = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "resolve".into(),
                    method: "filesystem.resolve".into(),
                    params: json!({"sessionId":session.id,"path":"../hello.rs","line":4,"column":2}),
                },
            )
            .unwrap();
        assert_eq!(resolved["projectId"], project.id);
        assert_eq!(resolved["path"], "hello.rs");
        assert_eq!(resolved["kind"], "text");
        assert_eq!(resolved["line"], 4);
        assert_eq!(resolved["column"], 2);

        for (params, code) in [
            (
                json!({"sessionId":session.id,"path":"../missing.rs"}),
                "file_reference_not_found",
            ),
            (
                json!({"sessionId":session.id,"path":"../hello.rs","line":0}),
                "file_reference_invalid_position",
            ),
            (
                json!({"sessionId":session.id,"path":"../hello.rs","line":-1}),
                "invalid_request",
            ),
            (
                json!({"sessionId":session.id,"path":"../hello.rs","unexpected":true}),
                "invalid_request",
            ),
        ] {
            let failure = service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: format!("reject-{code}"),
                        method: "filesystem.resolve".into(),
                        params,
                    },
                )
                .unwrap_err();
            assert_eq!(failure.code, code);
        }
    }

    #[test]
    fn imported_read_only_session_denies_direct_terminal_and_chat_writes() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let transcript = [crate::domain::ChatItem {
            id: "message".into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":"saved"})],
            created_at: "2026-09-10T00:00:00Z".into(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        }];
        let (session, _) = db
            .import_history_session(crate::db::ImportHistorySession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                cwd: root.path().to_str().unwrap(),
                native_id: "read-only-native",
                operation_id: "read-only-import",
                transcript: &transcript,
            })
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let lease = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "claim".into(),
                    method: "session.claim".into(),
                    params: json!({"sessionId":session.id,"clientId":"ignored-at-authenticated-boundary"}),
                },
            )
            .unwrap()["leaseEpoch"]
            .as_i64()
            .unwrap();
        for (method, params) in [
            (
                "terminal.input",
                json!({"sessionId":session.id,"data":"unsafe","leaseEpoch":lease}),
            ),
            (
                "chat.send",
                json!({"sessionId":session.id,"text":"unsafe","leaseEpoch":lease,"operationId":"blocked-send"}),
            ),
        ] {
            let error = service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: format!("blocked-{method}"),
                        method: method.into(),
                        params,
                    },
                )
                .unwrap_err();
            assert!(error.message.contains("session_read_only_resume_required"));
        }
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "stop-read-only".into(),
                    method: "session.stop".into(),
                    params: json!({"sessionId":session.id,"force":true,"operationId":"stop-read-only"}),
                },
            )
            .unwrap();
        let after_stop = db.session_by_id(&session.id).unwrap().unwrap();
        assert!(after_stop.read_only);
        assert_eq!(after_stop.status, "idle");
        assert_eq!(db.chat_items(&session.id).unwrap().len(), 1);
        assert!(db.output_from(&session.id, 0, 1).unwrap().is_empty());
    }

    #[test]
    fn terminal_input_after_departed_takeover_fails_with_stale_lease_and_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        #[cfg(windows)]
        let (executable, args) = ("cmd.exe", json!(["/Q", "/K"]));
        #[cfg(not(windows))]
        let (executable, args) = ("/bin/sh", json!([]));
        let created = service
            .dispatch(
                "alice",
                RpcRequest {
                    v: 1,
                    id: "create-lease-input".into(),
                    method: "session.create".into(),
                    params: json!({
                        "cwd": root.path(),
                        "provider": "shell",
                        "mode": "terminal",
                        "executable": executable,
                        "args": args,
                        "operationId": "create-lease-input",
                    }),
                },
            )
            .unwrap();
        let session_id = created["id"].as_str().unwrap().to_owned();
        let alice = service.leases.connect("alice");
        let epoch_a = service
            .dispatch(
                "alice",
                RpcRequest {
                    v: 1,
                    id: "claim-a".into(),
                    method: "session.claim".into(),
                    params: json!({"sessionId": session_id}),
                },
            )
            .unwrap()["leaseEpoch"]
            .as_i64()
            .unwrap();
        drop(alice);
        let _bob = service.leases.connect("bob");
        let epoch_b = service
            .dispatch(
                "bob",
                RpcRequest {
                    v: 1,
                    id: "claim-b".into(),
                    method: "session.claim".into(),
                    params: json!({"sessionId": session_id}),
                },
            )
            .unwrap()["leaseEpoch"]
            .as_i64()
            .unwrap();
        assert_eq!(epoch_b, epoch_a + 1);
        let error = service
            .dispatch(
                "alice",
                RpcRequest {
                    v: 1,
                    id: "stale-input".into(),
                    method: "terminal.input".into(),
                    params: json!({"sessionId": session_id, "data": "echo should-not-land\r\n", "leaseEpoch": epoch_a}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "stale_lease");
        // cmd.exe echoes typed input, so the marker would show up in the output if it had reached the PTY. Its
        // prompt arrives asynchronously, which is why this checks the marker rather than the byte count.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let output: Vec<u8> = db.output_from(&session_id, 0, 1 << 20).unwrap().into_iter().flat_map(|(_, bytes)| bytes).collect();
        assert!(!String::from_utf8_lossy(&output).contains("should-not-land"), "stale input must not reach the PTY");
        let _ = service.dispatch(
            "bob",
            RpcRequest {
                v: 1,
                id: "stop-lease-input".into(),
                method: "session.stop".into(),
                params: json!({"sessionId": session_id, "force": true, "operationId": "stop-lease-input"}),
            },
        );
    }

    #[test]
    fn force_stop_of_an_ended_session_is_idempotent_and_records_the_operation() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "ended-session",
            })
            .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let request = RpcRequest {
            v: 1,
            id: "force-ended".into(),
            method: "session.stop".into(),
            params: json!({"sessionId":session.id,"force":true,"operationId":"force-ended"}),
        };
        assert_eq!(
            service.dispatch("desktop", request.clone()).unwrap(),
            Value::Null
        );
        assert_eq!(service.dispatch("desktop", request).unwrap(), Value::Null);
        assert_eq!(
            db.session_by_id(&session.id).unwrap().unwrap().status,
            "exited"
        );
        assert!(db.operation("force-ended").unwrap().is_some());
    }

    #[test]
    fn pi_project_trust_requires_a_lease_and_an_idle_open_pi_session() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let project = db
            .add_project(
                root.path().to_str().unwrap(),
                Some("Trust test"),
                "trust-project",
            )
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: None,
                provider: "pi",
                mode: "chat",
                native_id: None,
                operation_id: "trust-session",
            })
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let epoch = service.leases.claim(&db, &session.id, "desktop").unwrap();
        let params = json!({"sessionId":session.id,"decision":"trusted","leaseEpoch":epoch,"operationId":"trust-decision"});
        assert!(service
            .set_pi_project_trust("other-device", &params)
            .is_err());
        let mut invalid = params.clone();
        invalid["decision"] = json!("invalid");
        assert!(service.set_pi_project_trust("desktop", &invalid).is_err());
        let error = service
            .set_pi_project_trust("desktop", &params)
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::providers::ProviderError>()
                .unwrap()
                .code,
            "chat_not_open"
        );
        assert_eq!(
            crate::pi_project_trust::read(&db, &project.id).unwrap(),
            None
        );
        // A failed preflight did not reserve the side effect or change trust.
        assert!(db.claim_external_operation("trust-decision").unwrap());
    }

    #[test]
    fn pi_project_trust_replays_receipts_only_after_authorization() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let project = db
            .add_project(root.path().to_str().unwrap(), None, "trust-project")
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: None,
                provider: "pi",
                mode: "chat",
                native_id: None,
                operation_id: "trust-session",
            })
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let epoch = service.leases.claim(&db, &session.id, "desktop").unwrap();
        let params = json!({"sessionId":session.id,"decision":"declined","leaseEpoch":epoch,"operationId":"trust-receipt"});
        db.bind_operation(
            "trust-receipt",
            "chat.projectTrust.set",
            &json!({"sessionId":session.id,"decision":"declined"}),
        )
        .unwrap();
        let saved = json!({"options":[],"commands":[],"loadState":"ready"});
        db.complete_operation("trust-receipt", "chat.projectTrust.set", &saved)
            .unwrap();
        assert_eq!(
            service.set_pi_project_trust("desktop", &params).unwrap(),
            saved
        );
        assert!(service
            .set_pi_project_trust("other-device", &params)
            .is_err());
        assert!(service.set_pi_project_trust("desktop", &json!({"sessionId":session.id,"decision":"trusted","leaseEpoch":epoch,"operationId":"trust-receipt"})).is_err());
    }

    #[test]
    fn chat_options_do_not_pretend_empty_success_when_disconnected() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "kimi",
                mode: "chat",
                native_id: Some("native-keep"),
                operation_id: "chat-options-session",
            })
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let options = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "options".into(),
                    method: "chat.options".into(),
                    params: json!({"sessionId": session.id}),
                },
            )
            .unwrap();
        assert_eq!(options["loadState"], "unknown");
        assert_eq!(options["error"]["code"], "chat_not_open");
        let connection = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "connection".into(),
                    method: "chat.connection".into(),
                    params: json!({"sessionId": session.id}),
                },
            )
            .unwrap();
        assert_eq!(connection["phase"], "disconnected");
        assert_eq!(connection["nativeId"], "native-keep");
        assert_eq!(
            db.session_by_id(&session.id)
                .unwrap()
                .unwrap()
                .native_id
                .as_deref(),
            Some("native-keep")
        );
    }

    #[test]
    fn chat_connect_without_lease_does_not_start_a_worker() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "kimi",
                mode: "chat",
                native_id: Some("native-keep"),
                operation_id: "chat-connect-session",
            })
            .unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        assert!(service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "connect".into(),
                    method: "chat.connect".into(),
                    params: json!({
                        "sessionId": session.id,
                        "operationId": "connect-op"
                    }),
                },
            )
            .is_err());
        let connection = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "connection-after".into(),
                    method: "chat.connection".into(),
                    params: json!({"sessionId": session.id}),
                },
            )
            .unwrap();
        assert_eq!(connection["phase"], "disconnected");
        assert_eq!(
            db.session_by_id(&session.id)
                .unwrap()
                .unwrap()
                .native_id
                .as_deref(),
            Some("native-keep")
        );
    }

    #[test]
    fn resume_without_any_native_identity_fails_with_a_distinct_code() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "terminal",
                native_id: None,
                operation_id: "no-history",
            })
            .unwrap();
        crate::session_configs::save_new(
            &db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "codex".into(),
                mode: "terminal".into(),
                cwd: root.path().to_string_lossy().into_owned(),
                project_id: None,
                title: None,
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        // User/model/tool text is never identity evidence, even if it looks
        // exactly like the provider's old exit hint.
        db.append_output(&session.id, 0, b"Session ID: 11111111-2222-4333-8444-555555555555\r\ncodex resume 11111111-2222-4333-8444-555555555555\r\n").unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let error = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "resume".into(),
                    method: "session.resume".into(),
                    params: json!({"sessionId":session.id,"operationId":"resume-op"}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "session_has_no_native_history");
        let kept = db.session_by_id(&session.id).unwrap().unwrap();
        assert_eq!(kept.status, "exited");
        assert!(kept.native_id.is_none());
    }

    #[test]
    fn resume_of_an_active_session_is_rejected_before_any_launch() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "terminal",
                native_id: Some("01a0be7e-b463-7bd0-8d12-c184185b3a0f"),
                operation_id: "active",
            })
            .unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        let error = service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "resume-active".into(),
                    method: "session.resume".into(),
                    params: json!({"sessionId":session.id,"operationId":"resume-active-op"}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "session_already_active");
    }

    fn deferred_test_session(db: &Arc<Database>, operation_id: &str) -> String {
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "terminal",
                native_id: None,
                operation_id,
            })
            .unwrap();
        db.begin_deferred_codex_launch(&session.id).unwrap();
        session.id
    }

    #[test]
    fn deferred_launch_rejects_custom_codex_commands_before_creating_a_record() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let service = test_service(root.path(), Arc::clone(&db));
        for (operation, extra) in [
            ("custom-executable", json!({"executable":"cmd.exe"})),
            (
                "custom-args",
                json!({"args":["--dangerously-skip-permissions"]}),
            ),
        ] {
            let mut params = json!({"provider":"codex","mode":"terminal","cwd":root.path(),"deferLaunch":true,"operationId":operation});
            params
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let failure = service
                .dispatch(
                    "desktop",
                    RpcRequest {
                        v: 1,
                        id: operation.into(),
                        method: "session.create".into(),
                        params,
                    },
                )
                .unwrap_err();
            assert_eq!(failure.code, "deferred_launch_unsupported");
            assert!(db.operation(operation).unwrap().is_none());
        }
    }

    #[test]
    fn shutdown_racing_after_deferred_record_creation_keeps_a_failure_reason() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let service = test_service(root.path(), Arc::clone(&db));
        service.cancel_all_deferred_launches().unwrap();
        let failure = service.dispatch("desktop", RpcRequest {
            v: 1,
            id: "create-during-shutdown".into(),
            method: "session.create".into(),
            params: json!({"provider":"codex","mode":"terminal","cwd":root.path(),"deferLaunch":true,"operationId":"create-during-shutdown"}),
        }).unwrap_err();
        assert_eq!(failure.code, "runtime_stopping");
        assert_eq!(failure.message, "runtime_stopping");
        let id = db.operation("create-during-shutdown").unwrap().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(db.session_by_id(&id).unwrap().unwrap().status, "error");
        let launch = db.deferred_codex_launch(&id).unwrap().unwrap();
        assert_eq!(launch["phase"], "failed");
        assert_eq!(launch["error"]["code"], "runtime_stopping");
    }

    fn reproduce_output_loss(quit: bool, refuse_marker: bool) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.sqlite");
        let id = {
            let db = Arc::new(Database::open(&path).unwrap());
            let session = db.create_session(CreateSession {
                project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None,
                operation_id: "output-loss-reproduction",
            }).unwrap();
            db.set_session_status(&session.id, "running", None).unwrap();
            db.append_output(&session.id, 0, b"durable-prefix").unwrap();
            crate::output::refuse_output_writes(&db);
            db.refuse_terminal_marker.store(refuse_marker, std::sync::atomic::Ordering::Relaxed);
            let service = test_service(root.path(), Arc::clone(&db));
            // No retry worker owns the DB during the simulated hard kill.
            assert!(service.output.append(&db, &session.id, b"UNIQUE-REFUSED-TAIL").is_err());
            if quit { service.shutdown(); }
            if refuse_marker {
                let sidecar = root.path().join("terminal-output-loss").join(format!("{}.json", session.id));
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while !sidecar.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                assert!(sidecar.exists(), "failure record must be durable before the later hard kill");
            }
            session.id
        };
        let db = Arc::new(Database::open(&path).unwrap());
        db.mark_live_sessions_interrupted().unwrap();
        let sidecars = crate::output_loss::SidecarWriter::new(db.path());
        for id in db.recover_terminal_output_loss().unwrap() { sidecars.remove(&id); }
        let status = db.session_by_id(&id).unwrap().unwrap().status;
        let service = test_service(root.path(), db);
        let read = service.dispatch("desktop", RpcRequest {
            v: 1, id: "loss-read".into(), method: "terminal.read".into(),
            params: json!({"sessionId":id,"cursor":0}),
        }).unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(read["data"].as_str().unwrap()).unwrap(), b"durable-prefix");
        assert_eq!(status, "interrupted");
        assert_eq!(read["storageDegraded"]["reason"], crate::db::TERMINAL_OUTPUT_LOST);
        assert_eq!(read["storageDegraded"]["cursor"], 14, "the pending tail starts at the durable end");
        if refuse_marker { assert_eq!(read["storageDegraded"]["pendingBytes"], 19); }
    }

    #[test]
    fn output_loss_a_quit_with_refused_marker() { reproduce_output_loss(true, true); }
    #[test]
    fn output_loss_b_hard_kill_with_refused_marker() { reproduce_output_loss(false, true); }
    #[test]
    fn output_loss_c_hard_kill_with_durable_marker() { reproduce_output_loss(false, false); }

    #[test]
    fn output_loss_shutdown_is_bounded_even_before_the_drain_when_sqlite_is_blocked() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db.create_session(CreateSession {
            project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None,
            operation_id: "shutdown-blocked-sqlite",
        }).unwrap();
        crate::output::refuse_output_writes(&db);
        let service = test_service(root.path(), Arc::clone(&db));
        let (locked_tx, locked_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let blocked = db.clone();
        let holder = std::thread::spawn(move || blocked.transaction(|_| {
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        }).unwrap());
        locked_rx.recv().unwrap();
        let output = service.output.clone();
        let writer_db = db.clone();
        let id = session.id.clone();
        let writer = std::thread::spawn(move || output.append(&writer_db, &id, b"pending"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while service.output.pending_byte_count() == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let start = std::time::Instant::now();
        service.shutdown();
        let elapsed = start.elapsed();
        let exists = root.path().join("terminal-output-loss").join(format!("{}.json", session.id)).exists();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert!(writer.join().unwrap().is_err());
        // Let delayed helpers finish their observable DB work before dropping the fixture.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while db.terminal_storage_degraded(&session.id).unwrap().as_ref()
            .is_none_or(|marker| marker["reason"] != crate::db::TERMINAL_OUTPUT_LOST)
            && std::time::Instant::now() < deadline
        { std::thread::sleep(std::time::Duration::from_millis(10)); }
        assert!(elapsed < std::time::Duration::from_secs(5), "shutdown waited on SQLite: {elapsed:?}");
        assert!(exists, "shutdown must leave its independent loss record");
    }

    #[test]
    fn shutdown_bounds_a_pending_output_drain() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session = db.create_session(CreateSession {
            project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None,
            operation_id: "shutdown-pending-output",
        }).unwrap();
        crate::output::refuse_output_writes(&db);
        let service = test_service(root.path(), Arc::clone(&db));
        assert!(service.output.append_shared(&db, &session.id, b"pending").is_err());
        let started = std::time::Instant::now();
        service.shutdown();
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn deferred_codex_preparation_keeps_a_durable_starting_record_then_binds_before_launch() {
        use std::sync::{atomic::AtomicUsize, mpsc};
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let id = deferred_test_session(&db, "deferred-success");
        let gate = Arc::new(Mutex::new(DeferredLaunchGate::default()));
        gate.lock().unwrap().generations.insert(id.clone(), 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let launches = Arc::new(AtomicUsize::new(0));
        let worker = {
            let db = Arc::clone(&db);
            let gate = Arc::clone(&gate);
            let id = id.clone();
            let launches = Arc::clone(&launches);
            std::thread::spawn(move || {
                run_deferred_codex_launch(
                    &db,
                    &gate,
                    &id,
                    1,
                    || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok("native-deferred".into())
                    },
                    |native_id| {
                        assert_eq!(
                            db.session_by_id(&id)?.unwrap().native_id.as_deref(),
                            Some(native_id)
                        );
                        launches.fetch_add(1, Ordering::SeqCst);
                        db.set_session_status(&id, "running", None)?;
                        Ok(())
                    },
                );
            })
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(db.session_by_id(&id).unwrap().unwrap().status, "starting");
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "preparing"
        );
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "running"
        );
        assert_eq!(
            db.session_by_id(&id).unwrap().unwrap().native_id.as_deref(),
            Some("native-deferred")
        );
    }

    #[test]
    fn deferred_codex_failure_is_diagnostic_and_same_record_can_retry() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let id = deferred_test_session(&db, "deferred-failure");
        let gate = Arc::new(Mutex::new(DeferredLaunchGate::default()));
        gate.lock().unwrap().generations.insert(id.clone(), 1);
        run_deferred_codex_launch(
            &db,
            &gate,
            &id,
            1,
            || {
                Err(
                    crate::providers::ProviderError::new("auth_required", "Sign in to Codex")
                        .into(),
                )
            },
            |_| panic!("must not launch"),
        );
        assert_eq!(db.session_by_id(&id).unwrap().unwrap().status, "error");
        let failed = db.deferred_codex_launch(&id).unwrap().unwrap();
        assert_eq!(failed["phase"], "failed");
        assert_eq!(failed["error"]["code"], "auth_required");
        assert_eq!(failed["error"]["message"], "Sign in to Codex");
        db.set_session_status(&id, "starting", None).unwrap();
        db.begin_deferred_codex_launch(&id).unwrap();
        gate.lock().unwrap().generations.insert(id.clone(), 2);
        run_deferred_codex_launch(
            &db,
            &gate,
            &id,
            2,
            || Ok("native-retry".into()),
            |_| {
                db.set_session_status(&id, "running", None)?;
                Ok(())
            },
        );
        assert_eq!(
            db.session_by_id(&id).unwrap().unwrap().native_id.as_deref(),
            Some("native-retry")
        );
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "running"
        );
    }

    #[test]
    fn stop_during_codex_preparation_fences_the_old_worker() {
        use std::sync::{atomic::AtomicUsize, mpsc};
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let id = deferred_test_session(&db, "deferred-cancel");
        let service = test_service(root.path(), Arc::clone(&db));
        let gate = Arc::clone(&service.deferred_launch);
        gate.lock().unwrap().generations.insert(id.clone(), 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let launches = Arc::new(AtomicUsize::new(0));
        let worker = {
            let db = Arc::clone(&db);
            let gate = Arc::clone(&gate);
            let id = id.clone();
            let launches = Arc::clone(&launches);
            std::thread::spawn(move || {
                run_deferred_codex_launch(
                    &db,
                    &gate,
                    &id,
                    1,
                    || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok("native-too-late".into())
                    },
                    |_| {
                        launches.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
            })
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "stop-deferred".into(),
                    method: "session.stop".into(),
                    params: json!({"sessionId":id,"force":true,"operationId":"stop-deferred"}),
                },
            )
            .unwrap();
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 0);
        let session = db.session_by_id(&id).unwrap().unwrap();
        assert_eq!(session.status, "exited");
        assert!(session.native_id.is_none());
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "cancelled"
        );
    }

    #[test]
    fn runtime_shutdown_cancels_deferred_launch_before_a_late_prepare_returns() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let id = deferred_test_session(&db, "deferred-shutdown");
        let service = test_service(root.path(), Arc::clone(&db));
        let gate = Arc::clone(&service.deferred_launch);
        gate.lock().unwrap().generations.insert(id.clone(), 1);
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "shutdown-deferred".into(),
                    method: "runtime.shutdown".into(),
                    params: json!({"operationId":"shutdown-deferred"}),
                },
            )
            .unwrap();
        run_deferred_codex_launch(
            &db,
            &gate,
            &id,
            1,
            || Ok("native-after-shutdown".into()),
            |_| panic!("shutdown must fence launch"),
        );
        assert!(gate.lock().unwrap().stopping);
        let session = db.session_by_id(&id).unwrap().unwrap();
        assert_eq!(session.status, "exited");
        assert!(session.native_id.is_none());
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "cancelled"
        );
    }

    #[test]
    fn old_preparation_cannot_bind_over_a_new_retry_generation() {
        use std::sync::mpsc;
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let id = deferred_test_session(&db, "deferred-generations");
        let gate = Arc::new(Mutex::new(DeferredLaunchGate::default()));
        gate.lock().unwrap().generations.insert(id.clone(), 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let old = {
            let db = Arc::clone(&db);
            let gate = Arc::clone(&gate);
            let id = id.clone();
            std::thread::spawn(move || {
                run_deferred_codex_launch(
                    &db,
                    &gate,
                    &id,
                    1,
                    || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok("stale-native".into())
                    },
                    |_| panic!("stale generation must not launch"),
                );
            })
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        {
            let mut owner = gate.lock().unwrap();
            owner.generations.remove(&id);
            db.cancel_deferred_codex_launch(&id).unwrap();
            db.set_session_status(&id, "starting", None).unwrap();
            db.begin_deferred_codex_launch(&id).unwrap();
            owner.generations.insert(id.clone(), 2);
        }
        run_deferred_codex_launch(
            &db,
            &gate,
            &id,
            2,
            || Ok("current-native".into()),
            |_| {
                db.set_session_status(&id, "running", None)?;
                Ok(())
            },
        );
        release_tx.send(()).unwrap();
        old.join().unwrap();
        assert_eq!(
            db.session_by_id(&id).unwrap().unwrap().native_id.as_deref(),
            Some("current-native")
        );
        assert_eq!(
            db.deferred_codex_launch(&id).unwrap().unwrap()["phase"],
            "running"
        );
    }
}

#[cfg(test)]
mod chat_lifecycle_tests;
#[cfg(test)]
mod chat_tool_tests;
#[cfg(test)]
mod chat_run_tool_tests;
#[cfg(test)]
mod chat_fork_tests;
#[cfg(test)]
mod question_tests;
#[cfg(test)]
mod approval_durability_tests;
#[cfg(test)]
mod repair_tests;

#[cfg(test)]
mod projection_batch_tests {
    use super::*;

    #[test]
    fn fallback_overflow_reports_degradation_and_pauses_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("db.sqlite")).unwrap());
        crate::chat_queue::initialize(&db).unwrap();
        let session = db.create_session(crate::db::CreateSession {
            project_id: None, title: None, provider: "codex", mode: "chat",
            native_id: None, operation_id: "fallback-session",
        }).unwrap();
        db.record_provider_event(&session.id, Some("active-turn"), "message.user", &json!({"text":"work"})).unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        crate::chat_queue::mutate(&db, "chat.queue.add", &json!({
            "sessionId":session.id,"text":"do not send","operationId":"fallback-queued",
        })).unwrap();
        let queues = Arc::new(crate::chat_queue::ChatQueues::default());
        // A regular file as the spool directory forces the real I/O error path
        // on every platform, without permissions/environment mutation.
        let spool_dir = dir.path().join("not-a-directory");
        std::fs::write(&spool_dir, "owned test file").unwrap();
        let (sender, mut receiver) = crate::provider_events::channel(&spool_dir);
        let mut event = delta("x");
        event.session_id = session.id.clone();
        for _ in 0..(256 + 4096) {
            sender.send(event.clone()).unwrap();
        }
        assert!(sender.send(event.clone()).is_err());
        assert!(sender.send(event).is_err());
        let reason = match receiver.blocking_recv() {
            Err(crate::provider_events::RecvError::Failed(reason)) => reason,
            other => panic!("expected sticky ingress failure, got {other:?}"),
        };
        let providers = Arc::new(Providers::for_test(vec![]));
        report_projection_failure(&db, &providers, &queues, &reason);
        let warnings: Vec<_> = db.events_after(0).unwrap().into_iter()
            .filter(|(_, event, _)| event == "runtime.degraded").collect();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].2["area"], "chat");
        assert!(warnings[0].2["sessionId"].is_null());
        assert!(warnings[0].2["reason"].as_str().unwrap().contains("fallback exceeded"));
        let queue = crate::chat_queue::read(&db, &session.id).unwrap();
        assert_eq!(queue["paused"], true);
        assert_eq!(queue["pauseReason"], "failed");
        assert_eq!(queue["items"].as_array().unwrap().len(), 1);
        assert_eq!(queue["items"][0]["state"], "queued");
        // Transcript loss must preserve the native turn and its Stop target.
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().status, "running");
        let leases = LeaseManager::default();
        let epoch = leases.claim(&db, &session.id, "desktop").unwrap();
        let error = queues.dispatch(&db, &providers, &leases, "desktop", "chat.queue.resume", &json!({
            "sessionId":session.id,"leaseEpoch":epoch,"operationId":"fallback-resume",
        })).unwrap_err();
        assert!(error.to_string().contains("chat_queue_unavailable"));
    }

    fn delta(text: &str) -> ProviderEvent {
        ProviderEvent {
            provider: "codex".into(), session_id: "session".into(),
            native_id: Some("thread".into()), turn_id: Some("turn".into()),
            worker_token: Some("worker".into()), kind: "chat.delta".into(),
            data: json!({"part":{"type":"text","text":text},"raw":{"method":"item/agentMessage/delta","params":{"itemId":"item","delta":text}}}),
        }
    }

    #[test]
    fn adjacent_deltas_preserve_text_and_routing_boundaries() {
        let mut event = delta("one");
        assert!(merge_projection_delta(&mut event, &delta("two")));
        assert_eq!(event.data["part"]["text"], "onetwo");
        assert_eq!(event.data["raw"]["params"]["delta"], "onetwo");
        for boundary in ["worker", "session", "turn", "item", "part", "approval"] {
            let mut next = delta("three");
            match boundary {
                "worker" => next.worker_token = Some("new-worker".into()),
                "session" => next.session_id = "other".into(),
                "turn" => next.turn_id = Some("other".into()),
                "item" => next.data["raw"]["params"]["itemId"] = json!("other"),
                "part" => next.data["part"]["type"] = json!("thinking"),
                _ => next.kind = "chat.approval".into(),
            }
            assert!(!merge_projection_delta(&mut event, &next), "{boundary}");
        }
        assert!(!merge_projection_delta(&mut event, &delta(&"x".repeat(64 * 1024))));
        assert_eq!(event.data["part"]["text"], "onetwo");
    }
}

#[cfg(test)]
mod chat_image_tests {
    use super::*;

    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8YQAAAABJRU5ErkJggg==";

    #[test]
    fn validates_supported_images_and_limits() {
        assert!(validate_chat_images(&vec![PNG.to_owned(); 4]).is_ok());
        assert!(validate_chat_images(&vec![PNG.to_owned(); 5]).is_err());
        assert!(validate_chat_images(&["data:image/svg+xml;base64,PHN2Zy8+".to_owned()]).is_err());
        assert!(validate_chat_images(&["data:image/png;base64,%%%".to_owned()]).is_err());
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_CHAT_IMAGE_ENCODED_BYTES + 1)
        );
        assert!(validate_chat_images(&[oversized]).is_err());
    }
}

#[cfg(test)]
mod browser_eval_service_tests {
    use super::*;

    #[test]
    fn generic_approval_rejects_runtime_eval_before_provider_or_cached_operation() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("eval-service.sqlite")).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES('s','Fixture','codex','chat','running','t','t')", [])?;
            Ok(())
        }).unwrap();
        crate::chat_projection::record(&db, "s", Some("turn"), "chat.approval", &json!({
            "approvalId":"eval", "part":{"type":"approval","approvalId":"eval","status":"pending",
            "data":{"runtimeOwned":true,"requestType":"threadterm.browser_eval"}}
        })).unwrap();
        // No adapters are installed: forwarding would fail differently.
        let providers = Providers::for_test(vec![]);
        for operation in ["fresh", "already-completed"] {
            if operation == "already-completed" {
                db.complete_null_operation(operation, "chat.approve").unwrap();
            }
            for turn in ["turn", "stale-turn"] {
                let error = approve_chat_request(&db, &providers, "s", turn, "eval", "approve_once", operation).unwrap_err();
                assert_eq!(error.downcast_ref::<crate::providers::ProviderError>().unwrap().code, "browser_approval_required");
            }
        }
        assert!(db.operation("fresh").unwrap().is_none());
        assert!(!providers.chat_is_open("s"));
        let item = db.chat_items("s").unwrap().remove(0);
        assert_eq!(item.parts[0]["status"], "pending");
    }
}

#[cfg(test)]
mod oc2_checkpoint_tests {
    use super::*;
    use crate::providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand};
    use std::sync::atomic::AtomicUsize;

    struct CheckpointAdapter { db: Arc<Database>, root: std::path::PathBuf, handoffs: Arc<AtomicUsize> }
    struct CheckpointChat { db: Arc<Database>, root: std::path::PathBuf, session: String, handoffs: Arc<AtomicUsize> }
    fn checkpoints(db: &Database) -> i64 {
        db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM review_checkpoints", [], |row| row.get(0))?)).unwrap()
    }
    impl ProviderAdapter for CheckpointAdapter {
        fn id(&self) -> &str { "opencode" }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability { source:"test",plugin_id:None,icon:None,sign_in:None,remote_sign_in:None,homepage:None,id:"opencode".into(),name:"Checkpoint fixture".into(),installed:true,version:None,terminal:false,chat:true,history:false,resume:true,terminal_resume_capture:"none",reason:None,auth:"unknown".into(),setup:crate::providers::ProviderSetup::default() }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> { Err(ProviderError::new("unsupported", "fixture")) }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({"items":[]})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, session: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(CheckpointChat { db:Arc::clone(&self.db),root:self.root.clone(),session:session.into(),handoffs:Arc::clone(&self.handoffs) }))
        }
    }
    impl ChatSession for CheckpointChat {
        fn native_id(&self) -> Option<String> { Some("checkpoint-native".into()) }
        fn validate_send(&self, text: &str) -> Result<(), ProviderError> {
            assert_eq!(checkpoints(&self.db), 0, "admission must precede the review snapshot");
            if text == "/busy" { return Err(ProviderError::new("turn_in_progress", "fixture busy")); }
            if text == "/invalid" { return Err(ProviderError::new("command_arguments_invalid", "fixture rejected command")); }
            Ok(())
        }
        fn validate_send_with_images(&self, _: &str, images: &[String]) -> Result<(), ProviderError> {
            assert_eq!(checkpoints(&self.db), 0, "image capability checks must precede snapshots too");
            if images.is_empty() { Ok(()) } else { Err(ProviderError::new("images_unsupported", "fixture text-only model")) }
        }
        fn send(&mut self, _: &str, operation: &str) -> Result<Value, ProviderError> {
            assert_eq!(checkpoints(&self.db), 1, "checkpoint must exist before provider handoff");
            assert_eq!(self.db.chat_items(&self.session).unwrap().len(), 1);
            assert_eq!(std::fs::read_to_string(self.root.join("file.txt")).unwrap(), "before handoff");
            std::fs::write(self.root.join("file.txt"), "provider changed file").unwrap();
            self.handoffs.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"turnId":operation}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
        fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
    }
    fn fixture() -> (tempfile::TempDir, Arc<Database>, Providers, String, Arc<AtomicUsize>) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        // Minimal empty Git repository; no git init/add/commit or public index writes.
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(root.join(".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n").unwrap();
        std::fs::write(root.join("file.txt"), "before handoff").unwrap();
        let db = Arc::new(Database::open(&temp.path().join("runtime.sqlite")).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::review::initialize(&db).unwrap();
        let project = db.add_project(root.to_str().unwrap(), Some("Fixture"), "project").unwrap();
        let session = db.create_session(crate::db::CreateSession { project_id:Some(&project.id),title:None,provider:"opencode",mode:"chat",native_id:None,operation_id:"create" }).unwrap();
        db.bind_session(&session.id, Some(root.to_str().unwrap()), None).unwrap();
        db.set_session_status(&session.id, "idle", None).unwrap();
        let handoffs = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(CheckpointAdapter { db:Arc::clone(&db),root:root.clone(),handoffs:Arc::clone(&handoffs) })]);
        providers.chat_open(&session.id, "opencode", root.to_str().unwrap(), None).unwrap();
        (temp, db, providers, session.id, handoffs)
    }
    #[test]
    fn rejected_sends_leave_no_checkpoint_transcript_or_operation_claim() {
        for (text, images, expected) in [
            ("/busy", vec![], "turn_in_progress"),
            ("/invalid", vec![], "command_arguments_invalid"),
            ("inspect", vec!["data:image/png;base64,AA==".to_owned()], "images_unsupported"),
        ] {
            let (_temp, db, providers, session, handoffs) = fixture();
            let error = send_chat_message(&db, &providers, &session, text, &images, "rejected").unwrap_err();
            assert_eq!(error.downcast_ref::<ProviderError>().unwrap().code, expected);
            assert_eq!(checkpoints(&db), 0);
            assert!(db.chat_items(&session).unwrap().is_empty());
            assert!(db.operation("rejected").unwrap().is_none());
            assert!(db.claim_external_operation("rejected").unwrap(), "rejection did not reserve a native action");
            assert_eq!(handoffs.load(Ordering::SeqCst), 0);
        }
    }
    #[test]
    fn admitted_send_snapshots_once_before_handoff_and_replay_adds_no_work() {
        let (_temp, db, providers, session, handoffs) = fixture();
        let first = send_chat_message(&db, &providers, &session, "inspect", &[], "accepted").unwrap();
        assert_eq!(send_chat_message(&db, &providers, &session, "inspect", &[], "accepted").unwrap(), first);
        assert_eq!(checkpoints(&db), 1);
        assert_eq!(handoffs.load(Ordering::SeqCst), 1);
        db.transaction(|tx| {
            let (status, turn): (String, String) = tx.query_row("SELECT status,turn_id FROM review_checkpoints WHERE operation_id='accepted'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            assert_eq!(status, "ready"); assert_eq!(turn, "accepted"); Ok(())
        }).unwrap();
    }
}
