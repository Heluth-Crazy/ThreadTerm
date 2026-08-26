use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use terminal_host_protocol::{
    ExitBehavior, Placement, Presentation, SessionAckRequest, SessionAttachResponse,
    SessionDetachRequest, SessionInputRequest, SessionPresentRequest, SessionResizeRequest,
    SessionResyncRequest, SessionState, SurfaceHiddenRequest, SurfacePresentRequestedEvent,
    SurfaceReadyRequest, TerminalSnapshot,
};
use tokio::sync::{mpsc, Notify, RwLock};

use crate::terminal_host_client::{
    DaemonClientConfig, DaemonClientHandle, DaemonEvent, DaemonEventSink, ReconcileSnapshot,
};

const EVENT_QUEUE_CAPACITY: usize = 512;
const MAIN_LABEL: &str = "main";
const BOOTSTRAP_EVENT: &str = "terminal-host-bootstrap";
const READY_CONFIRMED_EVENT: &str = "terminal-host-ready-confirmed";
const OUTPUT_EVENT: &str = "terminal-host-output";
const STATE_EVENT: &str = "terminal-host-state";
const EXIT_EVENT: &str = "terminal-host-exit";
const RESYNC_EVENT: &str = "terminal-host-resync-required";
const SURFACE_CHANGED_EVENT: &str = "terminal-host-surface-changed";
const DISCONNECTED_EVENT: &str = "terminal-host-disconnected";
const WORKSPACE_PRESENT_EVENT: &str = "terminal-host-workspace-present";
const WORKSPACE_RETIRED_EVENT: &str = "terminal-host-workspace-retired";
const WORKSPACE_CLEARED_EVENT: &str = "terminal-host-workspace-cleared";

#[derive(Clone)]
pub struct TerminalHostWindowRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    client: RwLock<Option<DaemonClientHandle>>,
    surfaces: Mutex<SurfaceRegistry>,
    closing: Mutex<HashSet<String>>,
    event_tx: mpsc::Sender<DaemonEvent>,
    event_rx: Mutex<Option<mpsc::Receiver<DaemonEvent>>>,
    output_overflow: Mutex<HashSet<AttachmentIdentity>>,
    fatal_overflow: AtomicBool,
    overflow_notify: Notify,
    next_window: AtomicU64,
    shutting_down: AtomicBool,
}

#[derive(Default)]
struct SurfaceRegistry {
    by_label: HashMap<String, SurfaceContext>,
    label_by_handle: HashMap<String, String>,
    /// Workspace-placement surfaces are rendered as runtime-only cards inside
    /// the main window, so many of them share a single webview label.
    workspaces: HashMap<String, SurfaceContext>,
}

#[derive(Clone)]
struct SurfaceContext {
    request: SurfacePresentRequestedEvent,
    attach: SessionAttachResponse,
    ready: bool,
    pending_output: Vec<OutputPayload>,
    pending_exit: Option<ExitPayload>,
    needs_resync: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AttachmentIdentity {
    runtime_id: String,
    handle: String,
    stream_id: String,
    attach_id: String,
}

impl TerminalHostWindowRuntime {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        Self {
            inner: Arc::new(RuntimeInner {
                client: RwLock::new(None),
                surfaces: Mutex::new(SurfaceRegistry::default()),
                closing: Mutex::new(HashSet::new()),
                event_tx,
                event_rx: Mutex::new(Some(event_rx)),
                output_overflow: Mutex::new(HashSet::new()),
                fatal_overflow: AtomicBool::new(false),
                overflow_notify: Notify::new(),
                next_window: AtomicU64::new(1),
                shutting_down: AtomicBool::new(false),
            }),
        }
    }

    pub fn start(&self, app: tauri::AppHandle, profile_dir: PathBuf, daemon_exe: Option<PathBuf>) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut config = DaemonClientConfig::new(profile_dir);
            config.daemon_exe = daemon_exe;
            // Presentation requests may wait for the renderer-ready handshake.
            config.request_timeout = Duration::from_secs(20);
            let sink: Arc<dyn DaemonEventSink> = Arc::new(WindowEventSink {
                runtime: runtime.clone(),
            });
            let client = match DaemonClientHandle::start(config, sink).await {
                Ok(client) => client,
                Err(error) => {
                    tracing::warn!(
                        code = error.code(),
                        "terminal-host desktop client unavailable"
                    );
                    return;
                }
            };
            *runtime.inner.client.write().await = Some(client);
            runtime.run_events(app).await;
        });
    }

    pub fn mark_shutting_down(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
    }

    fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::Acquire)
    }

    async fn client(&self) -> Result<DaemonClientHandle, String> {
        self.inner
            .client
            .read()
            .await
            .clone()
            .ok_or_else(|| "app_unavailable".to_string())
    }

    async fn run_events(&self, app: tauri::AppHandle) {
        let mut receiver = match self.inner.event_rx.lock() {
            Ok(mut receiver) => receiver.take(),
            Err(_) => None,
        };
        let Some(mut receiver) = receiver.take() else {
            tracing::error!("terminal-host event dispatcher was already started");
            return;
        };
        loop {
            tokio::select! {
                biased;
                _ = self.inner.overflow_notify.notified() => {
                    self.recover_overflow(&app).await;
                }
                event = receiver.recv() => {
                    let Some(event) = event else { break; };
                    self.handle_event(&app, event).await;
                }
            }
        }
    }

    async fn recover_overflow(&self, app: &tauri::AppHandle) {
        if self.inner.fatal_overflow.swap(false, Ordering::AcqRel) {
            self.emit_to_all(
                app,
                DISCONNECTED_EVENT,
                &DisconnectedPayload {
                    reason: "event_overflow",
                },
            );
        }
        let overflowed = self
            .inner
            .output_overflow
            .lock()
            .map(|mut overflowed| overflowed.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for identity in overflowed {
            let _ = self.resync_identity(app, &identity).await;
        }
    }

    async fn handle_event(&self, app: &tauri::AppHandle, event: DaemonEvent) {
        match event {
            DaemonEvent::SurfacePresentRequested(request) => {
                let result = match request.placement {
                    Placement::Window => self.present_window(app, request).await,
                    Placement::Workspace => self.present_workspace(app, request).await,
                };
                if let Err(error) = result {
                    tracing::warn!(code = %error, "terminal-host surface presentation failed");
                }
            }
            DaemonEvent::SessionOutput(output) => {
                let payload = OutputPayload {
                    runtime_id: output.runtime_id,
                    handle: output.handle,
                    stream_id: output.stream_id,
                    attach_id: output.attach_id,
                    seq: output.seq,
                    data_base64: output.data_base64,
                };
                if let Some((label, ready)) = self.queue_or_route_output(payload.clone()) {
                    if ready {
                        let _ = app.emit_to(label, OUTPUT_EVENT, payload);
                    }
                }
            }
            DaemonEvent::SessionState(state) => {
                if let Some(label) = self.label_for_handle_stream(&state.handle, &state.stream_id) {
                    let _ = app.emit_to(
                        label,
                        STATE_EVENT,
                        StatePayload {
                            runtime_id: state.runtime_id,
                            handle: state.handle,
                            stream_id: state.stream_id,
                            state: state.state,
                            revision: state.revision,
                        },
                    );
                }
            }
            DaemonEvent::SessionExit(exit) => {
                let attach_id = self
                    .label_and_attach(&exit.handle, &exit.stream_id)
                    .map(|(_, attach_id)| attach_id);
                if let Some(attach_id) = attach_id {
                    let payload = ExitPayload {
                        runtime_id: exit.runtime_id,
                        handle: exit.handle,
                        stream_id: exit.stream_id,
                        attach_id,
                        revision: exit.revision,
                        code: exit.exit_code,
                        exit_behavior: exit.exit_behavior,
                    };
                    if let Some((label, ready)) = self.queue_or_route_exit(payload.clone()) {
                        if ready {
                            let _ = app.emit_to(label, EXIT_EVENT, payload);
                        }
                    }
                }
            }
            DaemonEvent::SessionResyncRequired(required) => {
                let identity = AttachmentIdentity {
                    runtime_id: required.runtime_id,
                    handle: required.handle,
                    stream_id: required.stream_id,
                    attach_id: required.attach_id,
                };
                if let Some((label, ready)) = self.mark_resync_required(&identity) {
                    if ready {
                        let _ = app.emit_to(label, RESYNC_EVENT, IdentityPayload::from(&identity));
                    }
                }
            }
            DaemonEvent::Reconcile(snapshot) => self.reconcile(app, snapshot),
            DaemonEvent::Disconnected => {
                self.emit_to_all(
                    app,
                    DISCONNECTED_EVENT,
                    &DisconnectedPayload {
                        reason: "disconnected",
                    },
                );
            }
        }
    }

    fn mark_resync_required(&self, identity: &AttachmentIdentity) -> Option<(String, bool)> {
        self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            if let Some(label) = surfaces.label_by_handle.get(&identity.handle).cloned() {
                let surface = surfaces.by_label.get_mut(&label)?;
                if !attachment_matches_identity(surface, identity) {
                    return None;
                }
                if !surface.ready {
                    surface.needs_resync = true;
                    surface.pending_output.clear();
                }
                return Some((label, surface.ready));
            }
            let surface = surfaces.workspaces.get_mut(&identity.handle)?;
            if !attachment_matches_identity(surface, identity) {
                return None;
            }
            if !surface.ready {
                surface.needs_resync = true;
                surface.pending_output.clear();
            }
            Some((MAIN_LABEL.to_owned(), surface.ready))
        })
    }

    fn queue_or_route_exit(&self, payload: ExitPayload) -> Option<(String, bool)> {
        self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            // The exit transition itself bumps the catalog revision, so the
            // exit event legitimately carries a newer revision than the
            // presented surface. Only strictly older revisions are stale; the
            // remaining fields pin the event to this exact attachment.
            let accept = |surface: &SurfaceContext| -> bool {
                surface.attach.runtime_id == payload.runtime_id
                    && surface.attach.stream_id == payload.stream_id
                    && surface.attach.attach_id == payload.attach_id
                    && payload.revision >= surface.request.revision
            };
            if let Some(label) = surfaces.label_by_handle.get(&payload.handle).cloned() {
                let surface = surfaces.by_label.get_mut(&label)?;
                if !accept(surface) {
                    return None;
                }
                if !surface.ready {
                    surface.pending_exit = Some(payload);
                }
                return Some((label, surface.ready));
            }
            let surface = surfaces.workspaces.get_mut(&payload.handle)?;
            if !accept(surface) {
                return None;
            }
            if !surface.ready {
                surface.pending_exit = Some(payload);
            }
            Some((MAIN_LABEL.to_owned(), surface.ready))
        })
    }

    fn reconcile(&self, app: &tauri::AppHandle, snapshot: ReconcileSnapshot) {
        if snapshot
            .previous_runtime_id
            .as_ref()
            .is_some_and(|previous| previous != &snapshot.runtime_id)
        {
            self.destroy_all_surfaces(app);
        }
        let runtime = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let client = match runtime.client().await {
                Ok(client) => client,
                Err(_) => return,
            };
            for session in snapshot.catalog.sessions {
                if session.runtime_id != snapshot.runtime_id
                    || session.surface_hidden
                    || !matches!(
                        session.state,
                        SessionState::Creating | SessionState::Running
                    )
                {
                    continue;
                }
                let request = SessionPresentRequest {
                    handle: session.handle,
                    placement: session.placement,
                    workspace_target: session.workspace_target,
                    presentation: session.presentation,
                };
                if let Err(error) = client.present(request).await {
                    tracing::warn!(
                        code = error.code(),
                        "terminal-host desired surface restore deferred"
                    );
                    let _ = app.emit(
                        DISCONNECTED_EVENT,
                        DisconnectedPayload {
                            reason: "restore_deferred",
                        },
                    );
                }
            }
        });
    }

    async fn present_window(
        &self,
        app: &tauri::AppHandle,
        request: SurfacePresentRequestedEvent,
    ) -> Result<(), String> {
        if request.placement != Placement::Window {
            return Err("unsupported_placement".into());
        }
        let client = self.client().await?;
        let attach = client
            .attach(request.handle.clone())
            .await
            .map_err(|error| error.code().to_string())?;
        // Lease transfer: a workspace card bound to this handle is retired in
        // favor of the dedicated window. The daemon has already detached the
        // former attachment, so the card can no longer receive output.
        if self.retire_workspace_surface(&request.handle) {
            let _ = app.emit_to(
                MAIN_LABEL,
                WORKSPACE_RETIRED_EVENT,
                WorkspaceRetiredPayload {
                    handle: request.handle.clone(),
                },
            );
        }
        let (label, existed) = self.install_surface(request.clone(), attach.clone())?;
        let (window, needs_reveal) = if let Some(window) = app.get_webview_window(&label) {
            let _ = window.hide();
            (window, true)
        } else {
            match build_terminal_window(app, &label) {
                Ok(window) => {
                    configure_window_close(&window, self.clone());
                    (window, false)
                }
                Err(error) => {
                    self.remove_surface(&label);
                    let _ = client
                        .detach(SessionDetachRequest {
                            attach_id: attach.attach_id,
                            stream_id: attach.stream_id,
                        })
                        .await;
                    return Err(error);
                }
            }
        };
        // The renderer cannot acknowledge readiness until xterm has non-zero
        // geometry. Reveal both presentation modes without activation first;
        // a focused request receives focus only after surface.ready.
        if needs_reveal && show_without_activation(&window).is_err() {
            self.remove_surface(&label);
            let _ = client
                .detach(SessionDetachRequest {
                    attach_id: attach.attach_id,
                    stream_id: attach.stream_id,
                })
                .await;
            let _ = window.destroy();
            return Err("surface_window_failed".to_string());
        }
        if existed
            && app
                .emit_to(
                    &label,
                    SURFACE_CHANGED_EVENT,
                    SurfaceChangedPayload {
                        handle: request.handle.clone(),
                        revision: request.revision,
                    },
                )
                .is_err()
        {
            self.remove_surface(&label);
            let _ = client
                .detach(SessionDetachRequest {
                    attach_id: attach.attach_id,
                    stream_id: attach.stream_id,
                })
                .await;
            let _ = window.destroy();
            return Err("surface_event_failed".to_string());
        }
        Ok(())
    }

    /// Presents a session as a runtime-only card inside the main window.
    async fn present_workspace(
        &self,
        app: &tauri::AppHandle,
        request: SurfacePresentRequestedEvent,
    ) -> Result<(), String> {
        if request.placement != Placement::Workspace {
            return Err("unsupported_placement".into());
        }
        let client = self.client().await?;
        let attach = client
            .attach(request.handle.clone())
            .await
            .map_err(|error| error.code().to_string())?;
        // Lease transfer: retire the dedicated window bound to this handle.
        // The daemon already detached its attachment before re-presenting.
        if let Some(old_label) = self.retire_window_surface(&request.handle) {
            if let Some(old_window) = app.get_webview_window(&old_label) {
                let _ = old_window.destroy();
            }
        }
        if let Err(error) = self.install_workspace_surface(request.clone(), attach.clone()) {
            let _ = client
                .detach(SessionDetachRequest {
                    attach_id: attach.attach_id,
                    stream_id: attach.stream_id,
                })
                .await;
            return Err(error);
        }
        // Ask the main-window renderer to create or reveal the card. The card
        // completes readiness by invoking `terminal_host_surface_bootstrap`
        // and then `terminal_host_surface_ready` with this handle.
        if app
            .emit_to(
                MAIN_LABEL,
                WORKSPACE_PRESENT_EVENT,
                WorkspacePresentPayload {
                    handle: request.handle.clone(),
                    revision: request.revision,
                    workspace_path: request.workspace_target.clone(),
                    presentation: request.presentation.clone(),
                },
            )
            .is_ok()
        {
            tracing::info!(
                handle = %request.handle,
                revision = request.revision,
                "terminal-host workspace present event emitted"
            );
            Ok(())
        } else {
            self.retire_workspace_surface(&request.handle);
            let _ = client
                .detach(SessionDetachRequest {
                    attach_id: attach.attach_id,
                    stream_id: attach.stream_id,
                })
                .await;
            Err("surface_event_failed".to_string())
        }
    }

    fn install_workspace_surface(
        &self,
        request: SurfacePresentRequestedEvent,
        attach: SessionAttachResponse,
    ) -> Result<(), String> {
        let mut surfaces = self
            .inner
            .surfaces
            .lock()
            .map_err(|_| "internal_error".to_string())?;
        surfaces.workspaces.insert(
            request.handle.clone(),
            SurfaceContext {
                request,
                attach,
                ready: false,
                pending_output: Vec::new(),
                pending_exit: None,
                needs_resync: false,
            },
        );
        Ok(())
    }

    /// Drops the workspace surface for a handle; returns whether one existed.
    fn retire_workspace_surface(&self, handle: &str) -> bool {
        let removed = self
            .inner
            .surfaces
            .lock()
            .ok()
            .and_then(|mut surfaces| surfaces.workspaces.remove(handle))
            .is_some();
        if removed {
            self.end_close(&format!("workspace:{handle}"));
        }
        removed
    }

    /// Drops the window surface for a handle (transfer to workspace); returns
    /// the retired webview label when one existed.
    fn retire_window_surface(&self, handle: &str) -> Option<String> {
        let label = self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            let label = surfaces.label_by_handle.remove(handle)?;
            surfaces.by_label.remove(&label);
            Some(label)
        });
        if label.is_some() {
            self.end_close(handle);
        }
        label
    }

    fn install_surface(
        &self,
        request: SurfacePresentRequestedEvent,
        attach: SessionAttachResponse,
    ) -> Result<(String, bool), String> {
        let mut surfaces = self
            .inner
            .surfaces
            .lock()
            .map_err(|_| "internal_error".to_string())?;
        let existing = surfaces.label_by_handle.get(&request.handle).cloned();
        let existed = existing.is_some();
        let label = existing.unwrap_or_else(|| {
            let id = self.inner.next_window.fetch_add(1, Ordering::Relaxed);
            format!("terminal-host-{id}")
        });
        surfaces
            .label_by_handle
            .insert(request.handle.clone(), label.clone());
        surfaces.by_label.insert(
            label.clone(),
            SurfaceContext {
                request,
                attach,
                ready: false,
                pending_output: Vec::new(),
                pending_exit: None,
                needs_resync: false,
            },
        );
        Ok((label, existed))
    }

    fn remove_surface(&self, label: &str) -> Option<SurfaceContext> {
        let removed = self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            let removed = surfaces.by_label.remove(label)?;
            if surfaces
                .label_by_handle
                .get(&removed.request.handle)
                .is_some_and(|current| current == label)
            {
                surfaces.label_by_handle.remove(&removed.request.handle);
            }
            Some(removed)
        });
        if let Ok(mut closing) = self.inner.closing.lock() {
            closing.remove(label);
        }
        removed
    }

    fn begin_close(&self, label: &str) -> bool {
        self.inner
            .closing
            .lock()
            .is_ok_and(|mut closing| closing.insert(label.to_owned()))
    }

    fn end_close(&self, label: &str) {
        if let Ok(mut closing) = self.inner.closing.lock() {
            closing.remove(label);
        }
    }

    async fn hide_surface(&self, label: &str, expected: &SurfaceRequest) -> bool {
        let context = match self.validate_surface(label, expected) {
            Ok(context) => context,
            Err(_) => return false,
        };
        if let Ok(client) = self.client().await {
            let _ = client
                .surface_hidden(SurfaceHiddenRequest {
                    handle: context.request.handle,
                    revision: context.request.revision,
                    attach_id: context.attach.attach_id,
                    stream_id: context.attach.stream_id,
                })
                .await;
        }
        self.remove_surface_if_current(label, expected).is_some()
    }

    fn surface_for_label(&self, label: &str) -> Option<SurfaceContext> {
        self.inner
            .surfaces
            .lock()
            .ok()
            .and_then(|surfaces| surfaces.by_label.get(label).cloned())
    }

    fn validate_surface(
        &self,
        label: &str,
        request: &SurfaceRequest,
    ) -> Result<SurfaceContext, String> {
        let matches = |context: &SurfaceContext| -> bool {
            context.request.handle == request.handle
                && context.request.revision == request.revision
                && context.attach.runtime_id == request.runtime_id
                && context.attach.attach_id == request.attach_id
                && context.attach.stream_id == request.stream_id
        };
        self.inner
            .surfaces
            .lock()
            .ok()
            .and_then(|surfaces| {
                if let Some(context) = surfaces.by_label.get(label) {
                    return matches(context).then(|| context.clone());
                }
                // Workspace cards all live in the main window and are
                // addressed by handle instead of by webview label.
                if label == MAIN_LABEL {
                    if let Some(context) = surfaces.workspaces.get(&request.handle) {
                        return matches(context).then(|| context.clone());
                    }
                }
                None
            })
            .ok_or_else(|| "stale_presentation".to_string())
    }

    fn remove_surface_if_current(
        &self,
        label: &str,
        expected: &SurfaceRequest,
    ) -> Option<SurfaceContext> {
        let identity_matches = |current: &SurfaceContext, expected: &SurfaceRequest| -> bool {
            current.request.handle == expected.handle
                && current.request.revision == expected.revision
                && current.attach.runtime_id == expected.runtime_id
                && current.attach.attach_id == expected.attach_id
                && current.attach.stream_id == expected.stream_id
        };
        let removed = self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            let current = surfaces.by_label.get(label)?;
            if !identity_matches(current, expected) {
                return None;
            }
            let removed = surfaces.by_label.remove(label)?;
            if surfaces
                .label_by_handle
                .get(&removed.request.handle)
                .is_some_and(|current| current == label)
            {
                surfaces.label_by_handle.remove(&removed.request.handle);
            }
            Some((label.to_owned(), removed))
        });
        match removed {
            Some((closed_label, context)) => {
                self.end_close(&closed_label);
                Some(context)
            }
            None => {
                if label != MAIN_LABEL {
                    return None;
                }
                let close_key = format!("workspace:{}", expected.handle);
                let removed = self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
                    let current = surfaces.workspaces.get(&expected.handle)?;
                    if !identity_matches(current, expected) {
                        return None;
                    }
                    surfaces.workspaces.remove(&expected.handle)
                });
                if removed.is_some() {
                    self.end_close(&close_key);
                }
                removed
            }
        }
    }

    async fn resync_identity(
        &self,
        app: &tauri::AppHandle,
        identity: &AttachmentIdentity,
    ) -> Result<SurfaceBootstrapPayload, String> {
        let label = self
            .label_for_attachment(
                &identity.runtime_id,
                &identity.handle,
                &identity.stream_id,
                &identity.attach_id,
            )
            .ok_or_else(|| "stale_presentation".to_string())?;
        let context = if label == MAIN_LABEL {
            self.inner
                .surfaces
                .lock()
                .ok()
                .and_then(|surfaces| surfaces.workspaces.get(&identity.handle).cloned())
        } else {
            self.surface_for_label(&label)
        }
        .ok_or_else(|| "stale_presentation".to_string())?;
        let client = self.client().await?;
        let attach = client
            .resync(SessionResyncRequest {
                attach_id: identity.attach_id.clone(),
                stream_id: identity.stream_id.clone(),
            })
            .await
            .map_err(|error| error.code().to_string())?;
        self.replace_attach(&label, &context, attach.clone())?;
        let payload = bootstrap_payload(&context.request, &attach);
        let _ = app.emit_to(
            label,
            SURFACE_CHANGED_EVENT,
            SurfaceChangedPayload {
                handle: identity.handle.clone(),
                revision: context.request.revision,
            },
        );
        Ok(payload)
    }

    fn replace_attach(
        &self,
        label: &str,
        expected: &SurfaceContext,
        attach: SessionAttachResponse,
    ) -> Result<(), String> {
        let mut surfaces = self
            .inner
            .surfaces
            .lock()
            .map_err(|_| "internal_error".to_string())?;
        let current = if label == MAIN_LABEL {
            surfaces
                .workspaces
                .get_mut(&expected.request.handle)
                .ok_or_else(|| "stale_presentation".to_string())?
        } else {
            surfaces
                .by_label
                .get_mut(label)
                .ok_or_else(|| "stale_presentation".to_string())?
        };
        if current.request.handle != expected.request.handle
            || current.request.revision != expected.request.revision
            || current.attach.attach_id != expected.attach.attach_id
        {
            return Err("stale_presentation".into());
        }
        current.attach = attach;
        current.ready = false;
        current.pending_output.clear();
        current.pending_exit = None;
        current.needs_resync = false;
        Ok(())
    }

    fn queue_or_route_output(&self, payload: OutputPayload) -> Option<(String, bool)> {
        self.inner.surfaces.lock().ok().and_then(|mut surfaces| {
            let accept = |surface: &SurfaceContext| -> bool {
                surface.attach.runtime_id == payload.runtime_id
                    && surface.attach.stream_id == payload.stream_id
                    && surface.attach.attach_id == payload.attach_id
            };
            if let Some(label) = surfaces.label_by_handle.get(&payload.handle).cloned() {
                let surface = surfaces.by_label.get_mut(&label)?;
                if !accept(surface) {
                    return None;
                }
                return Some((label, buffer_or_ready(surface, payload)));
            }
            let surface = surfaces.workspaces.get_mut(&payload.handle)?;
            if !accept(surface) {
                return None;
            }
            Some((MAIN_LABEL.to_owned(), buffer_or_ready(surface, payload)))
        })
    }

    fn activate_surface(
        &self,
        app: &tauri::AppHandle,
        label: &str,
        workspace_handle: Option<&str>,
    ) -> Result<bool, String> {
        let mut surfaces = self
            .inner
            .surfaces
            .lock()
            .map_err(|_| "internal_error".to_string())?;
        let (label, surface) = if let Some(handle) = workspace_handle {
            (
                MAIN_LABEL.to_owned(),
                surfaces
                    .workspaces
                    .get_mut(handle)
                    .ok_or_else(|| "stale_presentation".to_string())?,
            )
        } else {
            match surfaces.by_label.get_mut(label) {
                Some(surface) => (label.to_owned(), surface),
                None => return Err("stale_presentation".into()),
            }
        };
        if surface.needs_resync {
            surface.pending_output.clear();
            return Ok(true);
        }
        for output in surface.pending_output.drain(..) {
            if app.emit_to(&label, OUTPUT_EVENT, output).is_err() {
                surface.needs_resync = true;
                return Ok(true);
            }
        }
        if let Some(exit) = surface.pending_exit.take() {
            if app.emit_to(&label, EXIT_EVENT, exit).is_err() {
                surface.needs_resync = true;
                return Ok(true);
            }
        }
        surface.ready = true;
        Ok(false)
    }

    fn label_for_attachment(
        &self,
        runtime_id: &str,
        handle: &str,
        stream_id: &str,
        attach_id: &str,
    ) -> Option<String> {
        self.inner.surfaces.lock().ok().and_then(|surfaces| {
            if let Some(label) = surfaces.label_by_handle.get(handle) {
                if let Some(surface) = surfaces.by_label.get(label) {
                    return (surface.attach.runtime_id == runtime_id
                        && surface.attach.stream_id == stream_id
                        && surface.attach.attach_id == attach_id)
                        .then(|| label.clone());
                }
            }
            surfaces.workspaces.get(handle).and_then(|surface| {
                (surface.attach.runtime_id == runtime_id
                    && surface.attach.stream_id == stream_id
                    && surface.attach.attach_id == attach_id)
                    .then(|| MAIN_LABEL.to_owned())
            })
        })
    }

    fn label_for_handle_stream(&self, handle: &str, stream_id: &str) -> Option<String> {
        self.inner.surfaces.lock().ok().and_then(|surfaces| {
            if let Some(label) = surfaces.label_by_handle.get(handle) {
                if let Some(surface) = surfaces.by_label.get(label) {
                    return (surface.attach.stream_id == stream_id).then(|| label.clone());
                }
            }
            surfaces.workspaces.get(handle).and_then(|surface| {
                (surface.attach.stream_id == stream_id).then(|| MAIN_LABEL.to_owned())
            })
        })
    }

    fn label_and_attach(&self, handle: &str, stream_id: &str) -> Option<(String, String)> {
        self.inner.surfaces.lock().ok().and_then(|surfaces| {
            if let Some(label) = surfaces.label_by_handle.get(handle) {
                if let Some(surface) = surfaces.by_label.get(label) {
                    return (surface.attach.stream_id == stream_id)
                        .then(|| (label.clone(), surface.attach.attach_id.clone()));
                }
            }
            surfaces.workspaces.get(handle).and_then(|surface| {
                (surface.attach.stream_id == stream_id)
                    .then(|| (MAIN_LABEL.to_owned(), surface.attach.attach_id.clone()))
            })
        })
    }

    fn emit_to_all<T: Serialize + Clone>(&self, app: &tauri::AppHandle, event: &str, payload: &T) {
        let labels = self
            .inner
            .surfaces
            .lock()
            .map(|surfaces| {
                surfaces
                    .by_label
                    .keys()
                    .cloned()
                    .chain(std::iter::once(MAIN_LABEL.to_owned()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|_| vec![MAIN_LABEL.to_owned()]);
        for label in labels {
            let _ = app.emit_to(label, event, payload.clone());
        }
    }

    fn destroy_all_surfaces(&self, app: &tauri::AppHandle) {
        let labels = self
            .inner
            .surfaces
            .lock()
            .map(|mut surfaces| {
                let labels = surfaces.by_label.keys().cloned().collect::<Vec<_>>();
                surfaces.by_label.clear();
                surfaces.label_by_handle.clear();
                surfaces.workspaces.clear();
                labels
            })
            .unwrap_or_default();
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        // Workspace cards are renderer-side state; tell the main window that
        // every daemon surface is gone (runtime identity changed).
        let _ = app.emit_to(
            MAIN_LABEL,
            WORKSPACE_CLEARED_EVENT,
            WorkspaceRetiredPayload {
                handle: String::new(),
            },
        );
    }
}

fn attachment_matches_identity(surface: &SurfaceContext, identity: &AttachmentIdentity) -> bool {
    surface.attach.runtime_id == identity.runtime_id
        && surface.attach.stream_id == identity.stream_id
        && surface.attach.attach_id == identity.attach_id
}

/// Buffers one pre-ready output delta; returns whether it may be routed now.
fn buffer_or_ready(surface: &mut SurfaceContext, payload: OutputPayload) -> bool {
    const PENDING_OUTPUT_LIMIT: usize = 256;
    if surface.ready {
        return true;
    }
    if surface.needs_resync {
        return false;
    }
    if surface.pending_output.len() >= PENDING_OUTPUT_LIMIT {
        surface.pending_output.clear();
        surface.needs_resync = true;
    } else {
        surface.pending_output.push(payload);
    }
    false
}

pub fn development_daemon_executable() -> Option<PathBuf> {
    let configured = std::env::var_os("THREADTERM_TERMINAL_HOST_BIN").map(PathBuf::from);
    if configured
        .as_ref()
        .is_some_and(|path| path.is_absolute() && path.is_file())
    {
        return configured;
    }
    let executable_name = if cfg!(windows) {
        "threadterm-terminal-host.exe"
    } else {
        "threadterm-terminal-host"
    };
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(executable_name)))
        .filter(|path| path.is_file())
}

struct WindowEventSink {
    runtime: TerminalHostWindowRuntime,
}

impl DaemonEventSink for WindowEventSink {
    fn on_event(&self, event: DaemonEvent) {
        if let DaemonEvent::SessionOutput(output) = &event {
            if self.runtime.inner.event_tx.try_send(event.clone()).is_err() {
                if let Ok(mut overflowed) = self.runtime.inner.output_overflow.lock() {
                    overflowed.insert(AttachmentIdentity {
                        runtime_id: output.runtime_id.clone(),
                        handle: output.handle.clone(),
                        stream_id: output.stream_id.clone(),
                        attach_id: output.attach_id.clone(),
                    });
                }
                self.runtime.inner.overflow_notify.notify_one();
            }
            return;
        }
        if self.runtime.inner.event_tx.try_send(event).is_err() {
            self.runtime
                .inner
                .fatal_overflow
                .store(true, Ordering::Release);
            self.runtime.inner.overflow_notify.notify_one();
        }
    }
}

fn build_terminal_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("terminal-host.html".into()))
        .title("ThreadTerm · Terminal")
        .inner_size(960.0, 620.0)
        .min_inner_size(480.0, 320.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        // A hidden WebView2 renderer can suspend its task queue after the
        // first IPC. Tao pairs this with `focused(false)` using
        // SW_SHOWNOACTIVATE for the initial visible transition.
        .visible(true)
        .focused(false)
        .skip_taskbar(false)
        .build()
        .map_err(|_| "surface_window_failed".to_string())
}

fn configure_window_close(window: &tauri::WebviewWindow, runtime: TerminalHostWindowRuntime) {
    let label = window.label().to_owned();
    let window = window.clone();
    window.clone().on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if runtime.is_shutting_down() {
                return;
            }
            api.prevent_close();
            if !runtime.begin_close(&label) {
                return;
            }
            let expected = runtime
                .surface_for_label(&label)
                .map(|context| SurfaceRequest::from(&context));
            let Some(expected) = expected else {
                runtime.end_close(&label);
                return;
            };
            let runtime = runtime.clone();
            let label = label.clone();
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                if runtime.hide_surface(&label, &expected).await {
                    let _ = window.destroy();
                } else {
                    runtime.end_close(&label);
                }
            });
        }
    });
}

fn show_ready_window(
    window: &tauri::WebviewWindow,
    presentation: &Presentation,
) -> Result<(), String> {
    match presentation {
        Presentation::Background => show_without_activation(window),
        Presentation::Focused => {
            window
                .show()
                .map_err(|_| "surface_window_failed".to_string())?;
            let _ = window.unminimize();
            window
                .set_focus()
                .map_err(|_| "surface_focus_failed".to_string())
        }
    }
}

/// Focuses the main window for a focused workspace presentation after the
/// renderer has acknowledged readiness.
fn focus_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return Err("surface_window_failed".to_string());
    };
    window
        .show()
        .map_err(|_| "surface_window_failed".to_string())?;
    let _ = window.unminimize();
    window
        .set_focus()
        .map_err(|_| "surface_focus_failed".to_string())
}

#[cfg(windows)]
fn show_without_activation(window: &tauri::WebviewWindow) -> Result<(), String> {
    // `focused(false)` marks the first Tao show as `SW_SHOWNOACTIVATE`.
    // Going through Tauri is load-bearing: a raw Win32 `ShowWindow` makes the
    // HWND visible without updating Tao's visibility state, leaving WebView2
    // logically hidden and its xterm/ResizeObserver work unable to progress.
    window
        .show()
        .map_err(|_| "surface_window_failed".to_string())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRequest {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
}

impl From<&SurfaceContext> for SurfaceRequest {
    fn from(context: &SurfaceContext) -> Self {
        Self {
            runtime_id: context.attach.runtime_id.clone(),
            handle: context.request.handle.clone(),
            revision: context.request.revision,
            attach_id: context.attach.attach_id.clone(),
            stream_id: context.attach.stream_id.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRequest {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeRequest {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AckRequest {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
    through_seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceReadyCommandRequest {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
    rows: u16,
    cols: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceBootstrapPayload {
    runtime_id: String,
    handle: String,
    revision: u64,
    placement: Placement,
    presentation: Presentation,
    attach_id: String,
    stream_id: String,
    barrier_seq: u64,
    snapshot: SnapshotPayload,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    content_base64: String,
    history_base64: Option<String>,
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapEventPayload {
    surface: SurfaceBootstrapPayload,
    notify_ready: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyConfirmedPayload {
    runtime_id: String,
    handle: String,
    revision: u64,
    attach_id: String,
    stream_id: String,
}

fn bootstrap_payload(
    request: &SurfacePresentRequestedEvent,
    attach: &SessionAttachResponse,
) -> SurfaceBootstrapPayload {
    SurfaceBootstrapPayload {
        runtime_id: attach.runtime_id.clone(),
        handle: attach.handle.clone(),
        revision: request.revision,
        placement: request.placement.clone(),
        presentation: request.presentation.clone(),
        attach_id: attach.attach_id.clone(),
        stream_id: attach.stream_id.clone(),
        barrier_seq: attach.barrier_seq,
        snapshot: SnapshotPayload::from(attach.snapshot.clone()),
    }
}

impl From<TerminalSnapshot> for SnapshotPayload {
    fn from(snapshot: TerminalSnapshot) -> Self {
        Self {
            content_base64: snapshot.content_base64,
            history_base64: snapshot.history_base64,
            rows: snapshot.rows,
            cols: snapshot.cols,
            cursor_row: snapshot.cursor_row,
            cursor_col: snapshot.cursor_col,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    runtime_id: String,
    handle: String,
    stream_id: String,
    attach_id: String,
    seq: u64,
    data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    runtime_id: String,
    handle: String,
    stream_id: String,
    state: SessionState,
    revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    runtime_id: String,
    handle: String,
    stream_id: String,
    attach_id: String,
    revision: u64,
    code: Option<i32>,
    exit_behavior: ExitBehavior,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityPayload {
    runtime_id: String,
    handle: String,
    stream_id: String,
    attach_id: String,
}

impl From<&AttachmentIdentity> for IdentityPayload {
    fn from(identity: &AttachmentIdentity) -> Self {
        Self {
            runtime_id: identity.runtime_id.clone(),
            handle: identity.handle.clone(),
            stream_id: identity.stream_id.clone(),
            attach_id: identity.attach_id.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceChangedPayload {
    handle: String,
    revision: u64,
}

#[derive(Clone, Serialize)]
struct DisconnectedPayload {
    reason: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePresentPayload {
    handle: String,
    revision: u64,
    workspace_path: Option<String>,
    presentation: Presentation,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRetiredPayload {
    handle: String,
}

#[tauri::command]
pub async fn terminal_host_surface_bootstrap(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    handle: Option<String>,
) -> Result<SurfaceBootstrapPayload, String> {
    let label = window.label();
    let context = match handle.as_deref() {
        // Workspace cards share the main webview and address their surface by
        // session handle.
        Some(handle) if label == MAIN_LABEL => runtime
            .inner
            .surfaces
            .lock()
            .ok()
            .and_then(|surfaces| surfaces.workspaces.get(handle).cloned()),
        _ => runtime.surface_for_label(label),
    };
    let Some(context) = context else {
        tracing::warn!(label, "terminal-host bootstrap: no surface context");
        return Err("stale_presentation".to_string());
    };
    if handle.is_some() {
        tracing::info!(
            label,
            handle = %context.request.handle,
            "terminal-host workspace bootstrap pulled"
        );
    }
    let surface = bootstrap_payload(&context.request, &context.attach);
    // The renderer primarily consumes the scoped event; the typed return value
    // lets main-window cards (which multiplex many surfaces) resolve the
    // payload directly. `emit_to` is required: `window.emit` would broadcast
    // the bootstrap to every terminal webview.
    if app
        .emit_to(
            label,
            BOOTSTRAP_EVENT,
            BootstrapEventPayload {
                surface: surface.clone(),
                notify_ready: !context.ready,
            },
        )
        .is_err()
    {
        tracing::warn!(label, "terminal-host bootstrap emit failed");
        return Err("surface_event_failed".to_string());
    }
    Ok(surface)
}

#[tauri::command]
pub async fn terminal_host_input(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: InputRequest,
) -> Result<(), String> {
    let surface = SurfaceRequest {
        runtime_id: request.runtime_id,
        handle: request.handle,
        revision: request.revision,
        attach_id: request.attach_id,
        stream_id: request.stream_id,
    };
    runtime.validate_surface(window.label(), &surface)?;
    runtime
        .client()
        .await?
        .input(SessionInputRequest {
            attach_id: surface.attach_id,
            stream_id: surface.stream_id,
            data_base64: request.data_base64,
        })
        .await
        .map_err(|error| {
            tracing::warn!(label = window.label(), code = %error, "terminal-host input failed");
            error.code().to_string()
        })
}

#[tauri::command]
pub async fn terminal_host_resize(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: ResizeRequest,
) -> Result<(), String> {
    let surface = SurfaceRequest {
        runtime_id: request.runtime_id,
        handle: request.handle,
        revision: request.revision,
        attach_id: request.attach_id,
        stream_id: request.stream_id,
    };
    runtime.validate_surface(window.label(), &surface)?;
    runtime
        .client()
        .await?
        .resize(SessionResizeRequest {
            attach_id: surface.attach_id,
            stream_id: surface.stream_id,
            rows: request.rows,
            cols: request.cols,
        })
        .await
        .map_err(|error| {
            tracing::warn!(label = window.label(), code = %error, "terminal-host resize failed");
            error.code().to_string()
        })
}

#[tauri::command]
pub async fn terminal_host_ack(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: AckRequest,
) -> Result<(), String> {
    let surface = SurfaceRequest {
        runtime_id: request.runtime_id,
        handle: request.handle,
        revision: request.revision,
        attach_id: request.attach_id,
        stream_id: request.stream_id,
    };
    runtime.validate_surface(window.label(), &surface)?;
    runtime
        .client()
        .await?
        .ack(SessionAckRequest {
            attach_id: surface.attach_id,
            stream_id: surface.stream_id,
            through_seq: request.through_seq,
        })
        .await
        .map_err(|error| {
            tracing::warn!(label = window.label(), code = %error, "terminal-host ack failed");
            error.code().to_string()
        })
}

#[tauri::command]
pub async fn terminal_host_resync(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: SurfaceRequest,
) -> Result<(), String> {
    let context = runtime.validate_surface(window.label(), &request)?;
    let surface = runtime
        .resync_identity(
            &app,
            &AttachmentIdentity {
                runtime_id: context.attach.runtime_id,
                handle: context.attach.handle,
                stream_id: request.stream_id,
                attach_id: request.attach_id,
            },
        )
        .await?;
    app.emit_to(
        window.label(),
        BOOTSTRAP_EVENT,
        BootstrapEventPayload {
            surface,
            notify_ready: false,
        },
    )
    .map_err(|_| "surface_event_failed".to_string())
}

#[tauri::command]
pub async fn terminal_host_surface_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: SurfaceReadyCommandRequest,
) -> Result<(), String> {
    let label = window.label();
    let handle = request.handle.clone();
    let surface = SurfaceRequest {
        runtime_id: request.runtime_id,
        handle: request.handle,
        revision: request.revision,
        attach_id: request.attach_id,
        stream_id: request.stream_id,
    };
    let confirmation = ReadyConfirmedPayload {
        runtime_id: surface.runtime_id.clone(),
        handle: surface.handle.clone(),
        revision: surface.revision,
        attach_id: surface.attach_id.clone(),
        stream_id: surface.stream_id.clone(),
    };
    let context = match runtime.validate_surface(label, &surface) {
        Ok(context) => context,
        Err(error) => {
            tracing::warn!(label, code = %error, "terminal-host surface_ready validate failed");
            return Err(error);
        }
    };
    let client = match runtime.client().await {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(code = %error, "terminal-host surface_ready client unavailable");
            return Err(error);
        }
    };
    if let Err(error) = client
        .resize(SessionResizeRequest {
            attach_id: surface.attach_id.clone(),
            stream_id: surface.stream_id.clone(),
            rows: request.rows,
            cols: request.cols,
        })
        .await
    {
        tracing::warn!(label, code = %error, "terminal-host surface_ready resize failed");
        return Err(error.code().to_string());
    }
    if let Err(error) = client
        .surface_ready(SurfaceReadyRequest {
            handle: surface.handle,
            revision: context.request.revision,
            attach_id: surface.attach_id,
            stream_id: surface.stream_id,
        })
        .await
    {
        tracing::warn!(label, code = %error, "terminal-host surface_ready daemon call failed");
        return Err(error.code().to_string());
    }
    if runtime.activate_surface(
        &app,
        label,
        (context.request.placement == Placement::Workspace).then_some(handle.as_str()),
    )? {
        runtime
            .resync_identity(
                &app,
                &AttachmentIdentity {
                    runtime_id: context.attach.runtime_id.clone(),
                    handle: context.attach.handle.clone(),
                    stream_id: context.attach.stream_id.clone(),
                    attach_id: context.attach.attach_id.clone(),
                },
            )
            .await?;
        return Ok(());
    }
    if context.request.placement == Placement::Workspace {
        // The card lives in the main window; only a focused presentation may
        // bring that window forward, and never before readiness.
        if context.request.presentation == Presentation::Focused {
            focus_main_window(&app)?;
        }
    } else {
        show_ready_window(&window, &context.request.presentation)?;
    }
    app.emit_to(window.label(), READY_CONFIRMED_EVENT, confirmation)
        .map_err(|_| "surface_event_failed".to_string())
}

#[tauri::command]
pub async fn terminal_host_surface_hidden(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, TerminalHostWindowRuntime>,
    request: SurfaceRequest,
) -> Result<(), String> {
    let label = window.label();
    let context = runtime.validate_surface(label, &request)?;
    let workspace = context.request.placement == Placement::Workspace;
    let close_key = if workspace {
        format!("workspace:{}", request.handle)
    } else {
        label.to_owned()
    };
    if !runtime.begin_close(&close_key) {
        return Ok(());
    }
    if runtime.hide_surface(label, &request).await {
        if workspace {
            // The main window stays; the renderer removes the card itself.
            Ok(())
        } else {
            window
                .destroy()
                .map_err(|_| "surface_window_failed".to_string())
        }
    } else {
        runtime.end_close(&close_key);
        Err("stale_presentation".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(revision: u64) -> SurfacePresentRequestedEvent {
        SurfacePresentRequestedEvent {
            handle: "handle-a".into(),
            revision,
            placement: Placement::Window,
            workspace_target: None,
            presentation: Presentation::Background,
        }
    }

    fn attach(suffix: &str, barrier_seq: u64) -> SessionAttachResponse {
        SessionAttachResponse {
            runtime_id: "runtime-a".into(),
            handle: "handle-a".into(),
            stream_id: format!("stream-{suffix}"),
            attach_id: format!("attach-{suffix}"),
            barrier_seq,
            snapshot: TerminalSnapshot {
                content_base64: String::new(),
                rows: 24,
                cols: 80,
                cursor_row: 0,
                cursor_col: 0,
                history_base64: None,
            },
        }
    }

    #[test]
    fn bootstrap_event_serializes_the_typed_surface_envelope() {
        let payload = BootstrapEventPayload {
            surface: bootstrap_payload(&request(2), &attach("a", 4)),
            notify_ready: true,
        };
        let value = serde_json::to_value(payload).expect("bootstrap event JSON");
        assert_eq!(value["notifyReady"], true);
        assert_eq!(value["surface"]["revision"], 2);
        assert_eq!(value["surface"]["barrierSeq"], 4);
        assert_eq!(value["surface"]["snapshot"]["rows"], 24);
        assert_eq!(value["surface"]["snapshot"]["cols"], 80);
    }

    #[test]
    fn surface_ready_command_accepts_geometry_in_the_same_request() {
        let request: SurfaceReadyCommandRequest = serde_json::from_value(serde_json::json!({
            "runtimeId": "runtime-a",
            "handle": "handle-a",
            "revision": 2,
            "attachId": "attach-a",
            "streamId": "stream-a",
            "rows": 31,
            "cols": 97
        }))
        .expect("surface ready command JSON");
        assert_eq!(request.rows, 31);
        assert_eq!(request.cols, 97);
    }

    #[test]
    fn ready_confirmation_serializes_complete_surface_identity() {
        let value = serde_json::to_value(ReadyConfirmedPayload {
            runtime_id: "runtime-a".into(),
            handle: "handle-a".into(),
            revision: 2,
            attach_id: "attach-a".into(),
            stream_id: "stream-a".into(),
        })
        .expect("ready confirmation JSON");
        assert_eq!(value["runtimeId"], "runtime-a");
        assert_eq!(value["handle"], "handle-a");
        assert_eq!(value["revision"], 2);
        assert_eq!(value["attachId"], "attach-a");
        assert_eq!(value["streamId"], "stream-a");
    }

    #[test]
    fn same_handle_transfer_reuses_one_window_and_replaces_epoch() {
        let runtime = TerminalHostWindowRuntime::new();
        let (first, existed) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("first surface");
        assert!(!existed);
        let (second, existed) = runtime
            .install_surface(request(2), attach("b", 9))
            .expect("replacement surface");
        assert!(existed);
        assert_eq!(first, second);
        let current = runtime.surface_for_label(&first).expect("current surface");
        assert_eq!(current.request.revision, 2);
        assert_eq!(current.attach.attach_id, "attach-b");
    }

    #[test]
    fn output_is_buffered_until_renderer_ready_and_stale_identity_is_rejected() {
        let runtime = TerminalHostWindowRuntime::new();
        let (label, _) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("surface");
        let payload = OutputPayload {
            runtime_id: "runtime-a".into(),
            handle: "handle-a".into(),
            stream_id: "stream-a".into(),
            attach_id: "attach-a".into(),
            seq: 5,
            data_base64: "YQ==".into(),
        };
        assert_eq!(
            runtime.queue_or_route_output(payload),
            Some((label.clone(), false))
        );
        assert_eq!(
            runtime
                .surface_for_label(&label)
                .expect("surface")
                .pending_output
                .len(),
            1
        );
        assert_eq!(
            runtime
                .validate_surface(
                    &label,
                    &SurfaceRequest {
                        runtime_id: "runtime-a".into(),
                        handle: "handle-a".into(),
                        revision: 1,
                        attach_id: "stale".into(),
                        stream_id: "stream-a".into(),
                    },
                )
                .err()
                .as_deref(),
            Some("stale_presentation")
        );
    }

    #[test]
    fn pre_ready_resync_is_retained_instead_of_being_lost() {
        let runtime = TerminalHostWindowRuntime::new();
        let (label, _) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("surface");
        assert_eq!(
            runtime.mark_resync_required(&AttachmentIdentity {
                runtime_id: "runtime-a".into(),
                handle: "handle-a".into(),
                stream_id: "stream-a".into(),
                attach_id: "attach-a".into(),
            }),
            Some((label.clone(), false))
        );
        assert!(
            runtime
                .surface_for_label(&label)
                .expect("surface")
                .needs_resync
        );
    }

    #[test]
    fn failed_reused_surface_install_can_be_discarded_without_leaving_stale_context() {
        let runtime = TerminalHostWindowRuntime::new();
        let (label, _) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("first surface");
        let (replacement_label, existed) = runtime
            .install_surface(request(2), attach("b", 9))
            .expect("replacement surface");
        assert!(existed);
        assert_eq!(replacement_label, label);

        let discarded = runtime.remove_surface(&label).expect("discarded surface");
        assert_eq!(discarded.attach.attach_id, "attach-b");
        assert!(runtime.surface_for_label(&label).is_none());
        assert!(!runtime
            .inner
            .surfaces
            .lock()
            .expect("surface registry")
            .label_by_handle
            .contains_key("handle-a"));
    }

    #[test]
    fn stale_exit_revision_cannot_remove_or_close_replacement_surface() {
        let runtime = TerminalHostWindowRuntime::new();
        let (label, _) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("first surface");
        let stale = SurfaceRequest::from(
            &runtime
                .surface_for_label(&label)
                .expect("first surface context"),
        );
        runtime
            .install_surface(request(2), attach("b", 9))
            .expect("replacement surface");

        assert!(runtime.remove_surface_if_current(&label, &stale).is_none());
        let current = runtime
            .surface_for_label(&label)
            .expect("replacement remains installed");
        assert_eq!(current.request.revision, 2);
        assert_eq!(current.attach.attach_id, "attach-b");
    }

    #[test]
    fn exit_routing_rejects_stale_revision_and_accepts_the_exit_bump() {
        let runtime = TerminalHostWindowRuntime::new();
        let (label, _) = runtime
            .install_surface(request(2), attach("b", 9))
            .expect("surface");
        let stale = ExitPayload {
            runtime_id: "runtime-a".into(),
            handle: "handle-a".into(),
            stream_id: "stream-b".into(),
            attach_id: "attach-b".into(),
            revision: 1,
            code: Some(0),
            exit_behavior: ExitBehavior::CloseOnSuccess,
        };
        assert_eq!(runtime.queue_or_route_exit(stale.clone()), None);

        // The exit transition itself bumps the catalog revision, so the exit
        // event arrives with a newer revision than the presented surface.
        let bumped = ExitPayload {
            revision: 3,
            ..stale
        };
        assert_eq!(
            runtime.queue_or_route_exit(bumped.clone()),
            Some((label.clone(), false))
        );
        let pending = runtime
            .surface_for_label(&label)
            .expect("surface")
            .pending_exit
            .expect("pending exit");
        assert_eq!(pending.revision, 3);
        assert_eq!(pending.exit_behavior, ExitBehavior::CloseOnSuccess);
    }

    fn workspace_request(revision: u64) -> SurfacePresentRequestedEvent {
        SurfacePresentRequestedEvent {
            handle: "handle-w".into(),
            revision,
            placement: Placement::Workspace,
            workspace_target: Some("D:/repo".into()),
            presentation: Presentation::Background,
        }
    }

    fn workspace_attach(suffix: &str, barrier_seq: u64) -> SessionAttachResponse {
        SessionAttachResponse {
            runtime_id: "runtime-a".into(),
            handle: "handle-w".into(),
            stream_id: format!("wstream-{suffix}"),
            attach_id: format!("wattach-{suffix}"),
            barrier_seq,
            snapshot: TerminalSnapshot {
                content_base64: String::new(),
                rows: 24,
                cols: 80,
                cursor_row: 0,
                cursor_col: 0,
                history_base64: None,
            },
        }
    }

    fn workspace_request_for(revision: u64, suffix: &str) -> SurfaceRequest {
        SurfaceRequest {
            runtime_id: "runtime-a".into(),
            handle: "handle-w".into(),
            revision,
            attach_id: format!("wattach-{suffix}"),
            stream_id: format!("wstream-{suffix}"),
        }
    }

    #[test]
    fn workspace_surface_installs_validates_and_removes_by_handle() {
        let runtime = TerminalHostWindowRuntime::new();
        runtime
            .install_workspace_surface(workspace_request(1), workspace_attach("a", 4))
            .expect("install workspace surface");

        // The main window validates the card by handle.
        let expected = workspace_request_for(1, "a");
        assert!(runtime.validate_surface(MAIN_LABEL, &expected).is_ok());
        // A dedicated terminal-host window cannot address a workspace card.
        assert!(runtime
            .validate_surface("terminal-host-1", &expected)
            .is_err());
        // Identity mismatches stay rejected.
        assert!(runtime
            .validate_surface(MAIN_LABEL, &workspace_request_for(2, "a"))
            .is_err());

        // Pre-ready output is buffered for the main-window route.
        let routed = runtime.queue_or_route_output(OutputPayload {
            runtime_id: "runtime-a".into(),
            handle: "handle-w".into(),
            stream_id: "wstream-a".into(),
            attach_id: "wattach-a".into(),
            seq: 1,
            data_base64: "YQ==".into(),
        });
        assert_eq!(routed, Some((MAIN_LABEL.to_owned(), false)));

        // Removal honors the exact attachment identity.
        assert!(runtime
            .remove_surface_if_current(MAIN_LABEL, &expected)
            .is_some());
        assert!(runtime
            .inner
            .surfaces
            .lock()
            .expect("registry")
            .workspaces
            .is_empty());
    }

    #[test]
    fn transferring_a_handle_between_placements_retires_the_other_surface() {
        let runtime = TerminalHostWindowRuntime::new();
        let (window_label, _) = runtime
            .install_surface(request(1), attach("a", 4))
            .expect("window surface");

        // Window → workspace transfer drops the window registry entry.
        if let Some(retired) = runtime.retire_window_surface("handle-a") {
            assert_eq!(retired, window_label);
        } else {
            panic!("expected the window surface to be retired");
        }
        assert!(runtime.surface_for_label(&window_label).is_none());

        runtime
            .install_workspace_surface(workspace_request(1), workspace_attach("b", 9))
            .expect("workspace install");
        // Workspace → window transfer drops the card context.
        assert!(runtime.retire_workspace_surface("handle-w"));
        assert!(runtime
            .inner
            .surfaces
            .lock()
            .expect("registry")
            .workspaces
            .is_empty());
    }
}
