use crate::{
    config::RuntimeConfig,
    db::{CreateSession, Database},
    domain::{RpcError, RpcRequest},
    leases::LeaseManager,
    output::OutputStore,
    providers::{ProviderEvent, ProviderRuntime, Providers, TerminalCapture},
    pty::PtyManager,
    RUNTIME_VERSION,
};
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
    leases: LeaseManager,
    output: Arc<OutputStore>,
    providers: Arc<Providers>,
    pty: Arc<PtyManager>,
    deferred_launch: Arc<Mutex<DeferredLaunchGate>>,
    shutdown_requested: AtomicBool,
    shutdown_pending: AtomicBool,
    relocation_gate: RwLock<()>,
    retry_gate: Mutex<()>,
    settings_apply_gate: Mutex<()>,
    remote: OnceLock<Arc<crate::remote_access::RemoteAccess>>,
}

fn project_provider_event(db: &Database, providers: &Providers, event: &ProviderEvent) {
    let accepted = providers.with_current_event(event, || {
        if let Err(error) = db.bind_session(&event.session_id, None, event.native_id.as_deref()) {
            eprintln!("chat bind failed for {}: {error}", event.session_id);
            return false;
        }
        if let Err(error) = db.record_provider_event(
            &event.session_id,
            event.turn_id.as_deref(),
            &event.kind,
            &event.data,
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
        }
        true
    });
    if accepted == Some(true) && event.kind == "session.closed" {
        providers.note_session_closed_scoped(&event.session_id, event.worker_token.as_deref());
    }
}

impl RuntimeService {
    pub fn new(config: RuntimeConfig, db: Arc<Database>) -> Self {
        let output = Arc::new(OutputStore::default());
        let providers = Arc::new(Providers::new());
        match db.settings_value() {
            Ok(settings) => {
                if let Err(error) = providers.configure_network(&settings) {
                    eprintln!("provider network settings could not be loaded: {error}");
                }
            }
            Err(error) => eprintln!("provider network settings could not be read: {error}"),
        }
        let mut events = providers.subscribe();
        let event_db = Arc::clone(&db);
        let event_providers = Arc::clone(&providers);
        std::thread::spawn(move || loop {
            match events.blocking_recv() {
                Ok(event) => {
                    project_provider_event(&event_db, &event_providers, &event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    eprintln!("chat projection lost {count} provider updates");
                    if let Err(error)=event_db.mark_chat_degraded(None,"Chat update buffer overflowed; reload native history to verify the transcript") { eprintln!("could not persist degraded state: {error}"); }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        });
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
            relocation_gate: RwLock::new(()),
            retry_gate: Mutex::new(()),
            settings_apply_gate: Mutex::new(()),
            remote: OnceLock::new(),
        }
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
        if let Err(error) = self.cancel_all_deferred_launches() {
            eprintln!("deferred terminal shutdown failed: {error}");
        }
        let _ = crate::retry_scheduler::cancel_all(&self.db);
        if let Some(remote) = self.remote.get() {
            remote.shutdown();
        }
        self.pty.terminate_all(&self.db);
        let _ = crate::settings_services::release_relocation(&self.config);
    }
    fn cancel_all_deferred_launches(&self) -> Result<()> {
        let mut gate = self
            .deferred_launch
            .lock()
            .map_err(|_| anyhow::anyhow!("deferred launch gate poisoned"))?;
        gate.stopping = true;
        for session_id in gate.generations.keys() {
            self.db.cancel_deferred_codex_launch(session_id)?;
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
        }
    }
    pub fn output_notified(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.output.notified()
    }
    pub fn dispatch(
        &self,
        principal: &str,
        request: RpcRequest,
    ) -> std::result::Result<Value, RpcError> {
        let exclusive = matches!(
            request.method.as_str(),
            "data.relocation.prepare"
                | "data.relocation.cancel"
                | "worktree.relocate"
                | "worktree.remove"
                | "session.resume"
        );
        if exclusive {
            let _gate = self
                .relocation_gate
                .write()
                .map_err(|_| error("runtime_error", "relocation lock poisoned"))?;
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
            return crate::workspace_services::resolve_file_reference(
                &self.db,
                &p.session_id,
                &p.path,
                p.line,
                p.column,
            )
            .map_err(file_reference_rpc_error);
        }
        let outcome = (|| -> Result<Value> {
            if request.method == "data.relocation.prepare"
                && self.remote.get().is_some_and(|remote| remote.is_enabled())
            {
                return Err(anyhow::anyhow!(
                    "Disable device access before relocating data"
                ));
            }
            // lookup references an existing operation; it does not reserve one.
            if request.method != "session.lookup" {
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
            if let Some(result) =
                crate::retry_scheduler::dispatch(&self.db, &request.method, &request.params)?
            {
                return Ok(result);
            }
            if let Some(result) =
                crate::session_configs::dispatch(&self.db, &request.method, &request.params)?
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
                "runtime.snapshot" => {
                    let mut snapshot = self.db.snapshot()?;
                    snapshot.providers = self.providers.capabilities();
                    Ok(serde_json::to_value(snapshot)?)
                }
                "runtime.shutdown" => {
                    let p: OperationOnly = parse(&request.params)?;
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
                        &p.session_id,
                        p.cursor,
                        p.tail,
                        limit as usize,
                    )?;
                    Ok(
                        json!({"sessionId":p.session_id,"fromCursor":from,"nextCursor":next,"truncated":truncated,"encoding":"base64","data":base64::engine::general_purpose::STANDARD.encode(data)}),
                    )
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
                    self.create_session(&p, None)
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
                    if session.read_only {
                        self.record_null(&p.operation_id, "session.stop")?;
                        return Ok(Value::Null);
                    }
                    crate::retry_scheduler::cancel_session(&self.db, &p.session_id)?;
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
                            self.db.set_session_status(&p.session_id, "exited", None)?;
                        } else {
                            self.pty.stop(&self.db, &p.session_id, p.force)?;
                        }
                    }
                    self.record_null(&p.operation_id, "session.stop")?;
                    Ok(Value::Null)
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
                "session.resume" => self.resume_native(&request.params),
                "session.claim" => {
                    let p: SessionClaim = parse(&request.params)?;
                    let epoch = self.leases.claim(&self.db, &p.session_id, principal)?;
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
                    Ok(json!({"leaseEpoch": epoch}))
                }
                "terminal.input" => {
                    let p: TerminalInput = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    self.pty.input(&p.session_id, p.data.as_bytes())?;
                    Ok(Value::Null)
                }
                "terminal.resize" => {
                    let p: TerminalResize = parse(&request.params)?;
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
                    self.providers.configure_network(&settings.value)?;
                    Ok(serde_json::to_value(settings)?)
                }
                "provider.list" => Ok(Value::Array(self.providers.capabilities())),
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
                "chat.send" => {
                    let p: ChatSend = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    if !self.providers.chat_is_open(&p.session_id) {
                        return Err(anyhow::anyhow!("chat_not_open"));
                    }
                    if p.text.trim().is_empty() || p.text.len() > 1024 * 1024 {
                        return Err(anyhow::anyhow!("invalid_message"));
                    }
                    if let Some(result) = self.db.operation(&p.operation_id)? {
                        return Ok(result);
                    }
                    // Review checkpoint before the provider can edit files; a
                    // failed or unavailable snapshot never blocks the send.
                    let checkpoint = crate::review::capture_before_turn(
                        &self.db,
                        &p.session_id,
                        &p.operation_id,
                        &p.text,
                    );
                    let result = self
                        .providers
                        .chat_send_recording(&p.session_id, &p.text, &p.operation_id, || {
                            use crate::providers::ProviderError;
                            if !self.db.claim_external_operation(&p.operation_id).map_err(
                                |error| ProviderError::new("chat_persistence", error.to_string()),
                            )? {
                                return Err(ProviderError::new(
                                    "operation_outcome_unknown",
                                    "operation_outcome_unknown",
                                ));
                            }
                            self.db
                                .record_provider_event(
                                    &p.session_id,
                                    Some(&p.operation_id),
                                    "message.user",
                                    &json!({"text":p.text,"operationId":p.operation_id}),
                                )
                                .map_err(|error| {
                                    ProviderError::new("chat_persistence", error.to_string())
                                })
                        })
                        .map_err(anyhow::Error::from)?;
                    if let Some(checkpoint) = &checkpoint {
                        crate::review::attach_turn(
                            &self.db,
                            checkpoint,
                            result.get("turnId").and_then(Value::as_str),
                        );
                    }
                    self.db
                        .complete_operation(&p.operation_id, "chat.send", &result)?;
                    Ok(result)
                }
                "chat.read" => {
                    let p: ChatRead = parse(&request.params)?;
                    Ok(serde_json::to_value(self.db.chat_items(&p.session_id)?)?)
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
                "chat.snapshot" => {
                    let p: ChatRead = parse(&request.params)?;
                    self.db.acknowledge_session_replies(&p.session_id)?;
                    let (items, revision) = self.db.chat_snapshot(&p.session_id)?;
                    Ok(json!({"items":items,"revision":revision}))
                }
                "chat.cancel" => {
                    let p: ChatCancel = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.providers
                        .chat_cancel(&p.session_id, &p.turn_id)
                        .map_err(anyhow::Error::from)?;
                    Ok(Value::Null)
                }
                "chat.approve" => {
                    let p: ChatApprove = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    if let Some(result) = self.db.operation(&p.operation_id)? {
                        return Ok(result);
                    }
                    if !self.db.claim_external_operation(&p.operation_id)? {
                        return Err(anyhow::anyhow!("operation_outcome_unknown"));
                    }
                    match self.providers.chat_approve(
                        &p.session_id,
                        &p.turn_id,
                        &p.approval_id,
                        &p.choice_id,
                        &p.operation_id,
                    ) {
                        Ok(()) => {
                            self.record_null(&p.operation_id, "chat.approve")?;
                            Ok(Value::Null)
                        }
                        Err(error) if error.code == "approval_outcome_unknown" => Err(error.into()),
                        Err(error) => Err(error.into()),
                    }
                }
                "chat.options" => {
                    let p: ChatRead = parse(&request.params)?;
                    self.providers
                        .chat_options(&p.session_id)
                        .map_err(anyhow::Error::from)
                }
                "chat.connection" => {
                    let p: ChatRead = parse(&request.params)?;
                    Ok(self.connection_state(&p.session_id)?)
                }
                "chat.connect" => {
                    let p: ChatConnect = parse(&request.params)?;
                    self.leases
                        .require(&self.db, &p.session_id, principal, p.lease_epoch)?;
                    self.db.require_interactive(&p.session_id)?;
                    if let Some(result) = self.db.operation(&p.operation_id)? {
                        return Ok(result);
                    }
                    self.connect_chat(&p.session_id)?;
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
                    if !self.providers.chat_is_open(&p.session_id) {
                        return Err(anyhow::anyhow!("chat_not_open"));
                    }
                    self.providers
                        .chat_set_option(&p.session_id, &p.option_id, &p.value)
                        .map_err(anyhow::Error::from)
                }
                _ => Err(anyhow::anyhow!("unknown_method")),
            }
        })();
        outcome.map_err(|e| {
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
    fn create_session(&self, p: &SessionCreate, source_session_id: Option<&str>) -> Result<Value> {
        validate_provider(&p.provider)?;
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
            if !crate::providers::SUPPORTED_PROVIDERS.contains(&p.provider.as_str()) {
                return Err(anyhow::anyhow!("provider_has_no_native_history"));
            }
            if let Some(owner) = self.db.native_owner(&p.provider, native_id)? {
                return Err(anyhow::anyhow!("native_session_exists:{}", owner.id));
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
        let spec = crate::session_configs::LaunchSpec {
            provider: p.provider.clone(),
            mode: p.mode.clone(),
            cwd: cwd.to_owned(),
            project_id: p.project_id.clone(),
            title: p.title.clone(),
            executable: p.executable.clone(),
            args: p.args.clone(),
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
        let result = self.launch_session(&session.id, p, cwd);
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
                match providers.chat_open(session_id, &p.provider, cwd, p.native_id.as_deref()) {
                    Ok(value) => value,
                    Err(error) => {
                        db.set_session_status(session_id, "error", None)?;
                        return Err(error.into());
                    }
                };
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
            || ((session.read_only || session.status == "exited")
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
    fn connect_chat(&self, session_id: &str) -> Result<()> {
        let session = self
            .db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if session.mode != "chat" {
            return Err(anyhow::anyhow!("chat_unavailable"));
        }
        if session.read_only || session.status == "exited" {
            return Err(anyhow::anyhow!("session_read_only_resume_required"));
        }
        let connected = self.ensure_chat_open(session_id);
        if connected.is_err() {
            // Preserve the previous synchronous-create failure contract in
            // durable session state. The provider connection snapshot carries
            // the structured error used by the overlay, while this transition
            // prevents a failed initial launch or explicit retry from remaining
            // "starting" forever. The conditional database update preserves a
            // concurrent stop or another provider-owned lifecycle transition.
            self.db.fail_starting_session(session_id)?;
        }
        connected
    }
    fn ensure_chat_open(&self, session_id: &str) -> Result<()> {
        if self.providers.chat_is_open(session_id) {
            return Ok(());
        }
        let session = self
            .db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if session.mode != "chat" {
            return Ok(());
        }
        if session.read_only || session.status == "exited" {
            return Err(anyhow::anyhow!("session_read_only_resume_required"));
        }
        let config = crate::session_configs::read(&self.db, session_id)?;
        let cwd = config
            .as_ref()
            .map(|value| value.launch.cwd.as_str())
            .or(session.worktree_path.as_deref())
            .ok_or_else(|| anyhow::anyhow!("cwd_required"))?;
        let cwd_path = std::path::Path::new(cwd);
        if !cwd_path.is_absolute() || !cwd_path.is_dir() {
            return Err(anyhow::anyhow!("cwd_missing_choose_relocation"));
        }
        if !self.db.begin_chat_connection(session_id)? {
            return Err(anyhow::anyhow!("session_read_only_resume_required"));
        }
        let opened = self
            .providers
            .chat_open(
                session_id,
                &session.provider,
                cwd,
                session.native_id.as_deref(),
            )
            .map_err(anyhow::Error::from)?;
        let accepted = self
            .db
            .accept_chat_connection(session_id, opened.get("nativeId").and_then(Value::as_str));
        if !matches!(accepted, Ok(true)) {
            let _ = self.providers.chat_stop(session_id);
        }
        match accepted {
            Ok(true) => {}
            Ok(false) => return Err(anyhow::anyhow!("chat_connect_superseded")),
            Err(error) => return Err(error),
        }
        let _ = crate::chat_projection::expire_pending_approvals(&self.db, session_id);
        Ok(())
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
        validate_provider(&p.provider)?;
        validate_mode(&p.mode)?;
        if !crate::providers::SUPPORTED_PROVIDERS.contains(&p.provider.as_str()) {
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
        if let Some(project_id) = p.project_id.as_deref() {
            crate::workspace_services::workspace_root_for_cwd(&self.db, project_id, &p.cwd)?;
        }
        // Read the provider-owned record before creating a local owner. This does
        // not start a PTY or provider turn; the stored card remains read-only.
        let transcript: Vec<crate::domain::ChatItem> =
            serde_json::from_value(self.providers.history_read(&p.provider, &p.native_id)?)?;
        let (session, _) = self
            .db
            .import_history_session(crate::db::ImportHistorySession {
                project_id: p.project_id.as_deref(),
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
        }
        let p: Resume = parse(params)?;
        let existing = self
            .db
            .session_by_id(&p.session_id)?
            .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
        if self.db.operation(&p.operation_id)?.is_some() {
            return Ok(serde_json::to_value(existing)?);
        }
        if !existing.read_only
            && !matches!(existing.status.as_str(), "exited" | "error" | "interrupted")
        {
            return Err(anyhow::anyhow!("session_already_active"));
        }
        if !crate::providers::SUPPORTED_PROVIDERS.contains(&existing.provider.as_str()) {
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
        if existing.mode == "terminal" {
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
        let create = SessionCreate {
            project_id: config.launch.project_id,
            cwd: Some(config.launch.cwd),
            title: config.launch.title,
            provider: config.launch.provider,
            mode: config.launch.mode,
            executable: config.launch.executable,
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

fn validate_provider(p: &str) -> Result<()> {
    if matches!(
        p,
        "codex" | "claude" | "kimi" | "gemini" | "opencode" | "shell" | "grok" | "custom"
    ) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid_provider"))
    }
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
        value if value.starts_with("operation_conflict:") => "operation_conflict",
        value if value.starts_with("native_session_exists:") => "native_session_exists",
        "lease_held" => "lease_held",
        "lease_missing" | "stale_lease" => "stale_lease",
        "revision_conflict" => "revision_conflict",
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
        "operation_outcome_unknown" => "operation_outcome_unknown",
        _ => "invalid_request",
    };
    error(code, message)
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
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRelease {
    session_id: String,
    lease_epoch: i64,
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
    operation_id: String,
    lease_epoch: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCancel {
    session_id: String,
    turn_id: String,
    lease_epoch: i64,
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
#[serde(rename_all = "camelCase")]
struct ChatConnect {
    session_id: String,
    lease_epoch: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRead {
    session_id: String,
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
mod tests {
    use super::*;

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
