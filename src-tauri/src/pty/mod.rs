//! PTY session management.
//!
//! This module is split into:
//! - [`session`]: the `PtySession` struct, state-machine helpers and
//!   shared timing constants.
//! - [`registry`]: the global session map and lookup helpers.
//! - [`events`]: regex-based pattern matching, the background output
//!   reader and the idle-state watcher.
//! - [`shell`]: platform-specific shell selection and PATH plumbing.
//!
//! Only the items re-exported here form ThreadTerm's public PTY surface.

mod emulator;
mod events;
mod registry;
mod session;
mod shell;
mod shutdown;
mod startup;
mod utf8;
mod warmup;
#[cfg(target_os = "windows")]
mod warmup_windows;
mod writer;

pub use registry::list_live_sessions;
pub use session::{LivePtySessionSnapshot, PtyAttachSnapshot, SessionState};
pub use shutdown::{GracefulShutdownProfile, GracefulShutdownResult};
pub use startup::{
    validate_generation, AgentSessionProvider, PtyCreateDisposition, PtyCreateSessionV2Result,
    PtyDescriptorDisposition, PtyShellFamily, PtyStartupAction, PtyStartupCoordinator,
    PtyStartupIntent, PtyStartupSideEffectPlan, PtyStartupSnapshot, PtyStartupState,
    PtyStartupTrigger, STARTUP_DESCRIPTOR_CONFLICT, STARTUP_INVALID_GENERATION,
};

/// Snapshot a single live PTY session by id (used by the bridge to build a
/// `CardMeta` for incremental card-added broadcasts). Returns `None` when no
/// session is registered for `id`.
pub fn live_session_snapshot(id: &str) -> Option<LivePtySessionSnapshot> {
    registry::live_session_snapshot(id)
}

/// Build the process-wide startup side-effect dispatcher from the same managed
/// state store that backs the rest of the desktop bridge.
pub(crate) fn startup_side_effect_dispatcher(
    managed_state: crate::managed_state::ManagedStateStore,
) -> startup::StartupSideEffectDispatcher {
    startup::StartupSideEffectDispatcher::new(managed_state)
}

/// Feature-only bridge from the opaque harness sidecar into the live startup
/// coordinator. The sidecar has already released its mutex before this call;
/// only a bounded typed plan and private identity are accepted here.
#[cfg(feature = "terminal-startup-harness")]
pub(crate) fn drive_harness_startup(
    pty_id: &str,
    generation: &str,
    plan: HarnessPrepareCaseRequest,
    action: HarnessDriveAction,
) -> Result<bool, ()> {
    let session = registry::get(pty_id).ok_or(())?;
    if session.generation != generation || !registry::is_current(pty_id, &session) {
        return Err(());
    }
    startup::drive_harness_case(pty_id, &session, generation, plan.timing, action).map_err(|_| ())
}

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Instant;

use dashmap::DashMap;
use once_cell::sync::Lazy;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, Window};

use session::{
    clear_waiting_for_input, install_startup_side_effect_context, mark_killed,
    suppress_output_activity_for, PtyInputRequest, PtySession, StartupSideEffectContext,
    OUTPUT_BUFFER_MAX_BYTES, RESIZE_OUTPUT_ACTIVITY_SUPPRESS, SESSION_SCROLLBACK_LINES,
};

#[cfg(all(feature = "terminal-startup-harness", feature = "stats-proxy"))]
use crate::terminal_startup_harness::HarnessFixture;
#[cfg(all(feature = "terminal-startup-harness", test))]
use crate::terminal_startup_harness::HarnessShell;
#[cfg(feature = "terminal-startup-harness")]
use crate::terminal_startup_harness::{
    HarnessDriveAction, HarnessHookError, HarnessPrepareCaseRequest, HarnessShellReceipt,
    HarnessTiming,
};

enum CreateStartup {
    Legacy,
    Explicit {
        intent: PtyStartupIntent,
        dispatcher: startup::StartupSideEffectDispatcher,
    },
}

#[cfg(feature = "terminal-startup-harness")]
const HARNESS_CASE_BIND_FAILED: &str = "harness_case_bind_failed";

#[cfg(feature = "terminal-startup-harness")]
struct HarnessCreateClaim {
    handle: Option<crate::terminal_startup_harness::HarnessCaseHandle>,
    // Keep the complete typed plan in the local create scope. Timing control
    // is copied into the feature-only arm/output seams below.
    plan: HarnessPrepareCaseRequest,
    shell_receipt: Option<HarnessShellReceipt>,
}

#[cfg(feature = "terminal-startup-harness")]
impl HarnessCreateClaim {
    fn claim() -> Result<Option<Self>, HarnessHookError> {
        let Some(claimed) = crate::terminal_startup_harness::claim_next_ui_create_plan() else {
            return Ok(None);
        };
        let shell_receipt = match HarnessShellReceipt::from_environment(claimed.plan.shell) {
            Ok(receipt) => receipt,
            Err(error) => {
                let _ = crate::terminal_startup_harness::abandon_claimed_case(&claimed.handle);
                return Err(error);
            }
        };
        Ok(Some(Self {
            handle: Some(claimed.handle),
            plan: claimed.plan,
            shell_receipt,
        }))
    }

    fn forced_shell_path(&self) -> Option<&std::path::Path> {
        self.shell_receipt.as_ref().map(HarnessShellReceipt::path)
    }

    fn bind(&mut self, pty_id: &str, generation: &str) -> Result<(), HarnessHookError> {
        let handle = self.handle.as_ref().ok_or(HarnessHookError::InvalidState)?;
        crate::terminal_startup_harness::bind_claimed_case(handle, pty_id, generation)?;
        self.handle = None;
        Ok(())
    }
}

#[cfg(feature = "terminal-startup-harness")]
impl Drop for HarnessCreateClaim {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            // The sidecar exposes a single terminal abandon transition.  A
            // local Option makes this invocation exactly-once even if the
            // create path returns through several early-error branches.
            let _ = crate::terminal_startup_harness::abandon_claimed_case(&handle);
        }
    }
}

// Legacy unit fixture only. Runtime harness creation never consults these
// bare names; it requires a validated runner receipt above.
#[cfg(all(feature = "terminal-startup-harness", test))]
fn harness_shell_path(shell: HarnessShell) -> Option<&'static str> {
    match shell {
        HarnessShell::Auto => None,
        HarnessShell::Pwsh => Some("pwsh.exe"),
        HarnessShell::WindowsPowerShell => Some("powershell.exe"),
        HarnessShell::Cmd => Some("cmd.exe"),
    }
}

#[cfg(feature = "terminal-startup-harness")]
fn cleanup_failed_harness_session(id: &str, session: &Arc<PtySession>) {
    let session = registry::remove_if_same(id, session).unwrap_or_else(|| Arc::clone(session));
    mark_killed(&session);
    terminate_session_process(&session);
    let _ = session::close_master(&session, id);
}

struct CreateOutcome {
    id: String,
    disposition: PtyCreateDisposition,
    descriptor_disposition: PtyDescriptorDisposition,
    generation: String,
    shell_family: PtyShellFamily,
    startup: PtyStartupSnapshot,
}

fn spawn_writer_for_startup(
    writer: Box<dyn std::io::Write + Send>,
    provider_startup: bool,
) -> Result<writer::PtyWriter, std::io::Error> {
    if provider_startup {
        writer::spawn_blocked_for_startup(writer)
    } else {
        writer::spawn(writer)
    }
}

#[cfg(any(test, not(feature = "terminal-startup-harness")))]
fn startup_output_config(
    provider_startup: bool,
    shell_family: PtyShellFamily,
    one_shot: bool,
    policy: startup::StartupReadinessPolicy,
    powershell_utf8: bool,
    nonce: &str,
) -> startup::StartupOutputConfig {
    startup_output_config_with_suppression(
        provider_startup,
        shell_family,
        one_shot,
        policy,
        powershell_utf8,
        nonce,
        false,
    )
}

fn startup_output_config_with_suppression(
    provider_startup: bool,
    shell_family: PtyShellFamily,
    one_shot: bool,
    policy: startup::StartupReadinessPolicy,
    powershell_utf8: bool,
    nonce: &str,
    suppress_readiness: bool,
) -> startup::StartupOutputConfig {
    if provider_startup && matches!(policy, startup::StartupReadinessPolicy::Marker { .. }) {
        return startup::StartupOutputConfig::Marker {
            nonce: nonce.to_owned(),
            triggers_ready: !suppress_readiness,
        };
    }
    if !one_shot
        && matches!(
            shell_family,
            PtyShellFamily::Pwsh | PtyShellFamily::WindowsPowerShell
        )
        && powershell_utf8
    {
        return startup::StartupOutputConfig::Marker {
            nonce: nonce.to_owned(),
            triggers_ready: false,
        };
    }
    if provider_startup && matches!(policy, startup::StartupReadinessPolicy::FirstOutput { .. }) {
        return startup::StartupOutputConfig::FirstOutput {
            triggers_ready: !suppress_readiness,
        };
    }
    startup::StartupOutputConfig::Passthrough
}

/// Serializes PTY open+spawn so concurrent terminal creation can't race ConPTY
/// initialization — a known source of Windows blank/stall on rapid open/close
/// or multi-card spawn. Cheap and harmless elsewhere (spawns are infrequent).
#[cfg(target_os = "windows")]
static PTY_SPAWN_LOCK: Mutex<()> = Mutex::new(());
const PTY_LAUNCH_PHASE_EVENT: &str = "pty-launch-phase";

static PTY_CREATE_GATES: Lazy<DashMap<String, Arc<tokio::sync::Mutex<()>>>> =
    Lazy::new(DashMap::new);

struct PtyCreateGateLease {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

async fn acquire_pty_create_gate(id: &str) -> PtyCreateGateLease {
    let gate = PTY_CREATE_GATES
        .entry(id.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let guard = Arc::clone(&gate).lock_owned().await;
    PtyCreateGateLease { _guard: guard }
}

fn legacy_startup_coordinator(
    pty_id: &str,
    generation: &str,
    one_shot: bool,
) -> Result<PtyStartupCoordinator, String> {
    if one_shot {
        PtyStartupCoordinator::legacy_one_shot(pty_id, generation)
    } else {
        PtyStartupCoordinator::legacy_interactive(pty_id, generation)
    }
}

fn legacy_session_startup(
    pty_id: &str,
    generation: &str,
    one_shot: bool,
) -> Result<startup::SessionStartup, String> {
    legacy_startup_coordinator(pty_id, generation, one_shot).map(startup::SessionStartup::new)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyLaunchPhasePayload {
    launch_attempt_id: String,
    pty_id: String,
    phase: String,
    elapsed_ms: f64,
    domain: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
}

/// Optional process-at-creation launch descriptor. Missing descriptors retain
/// the historical interactive PTY contract and initial-command input path.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyLaunchDescriptor {
    execution_mode: Option<String>,
    command: Option<String>,
}

impl PtyLaunchDescriptor {
    fn one_shot_command(&self) -> Result<Option<String>, String> {
        match self.execution_mode.as_deref().unwrap_or("interactive") {
            "interactive" => Ok(None),
            "oneShot" => {
                let command = self
                    .command
                    .as_deref()
                    .map(str::trim)
                    .filter(|command| !command.is_empty())
                    .ok_or_else(|| "One-shot PTY launches require a command".to_string())?;
                Ok(Some(command.to_string()))
            }
            mode => Err(format!("Unsupported PTY execution mode: {mode}")),
        }
    }
}

fn emit_launch_phase(
    window: &Window,
    launch_attempt_id: Option<&str>,
    pty_id: &str,
    phase: &str,
    started_at: Instant,
    provider: Option<&str>,
) {
    let Some(launch_attempt_id) = launch_attempt_id else {
        return;
    };
    let _ = window.emit(
        PTY_LAUNCH_PHASE_EVENT,
        PtyLaunchPhasePayload {
            launch_attempt_id: launch_attempt_id.to_owned(),
            pty_id: pty_id.to_owned(),
            phase: phase.to_owned(),
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
            domain: "backend",
            provider: provider.map(str::to_owned),
        },
    );
}

/// Start the one-time, opt-in Windows ConPTY initialization. The worker is
/// process-scoped and never participates in the real PTY spawn lock.
pub fn prewarm_windows_conpty() {
    warmup::start_from_env();
}

const FLOAT_RENDERER_CONSUMER_PREFIX: &str = "renderer:float:";
static OUTPUT_CONSUMER_SCOPE_GATE: Mutex<()> = Mutex::new(());
static FLOAT_RENDERER_CONSUMERS_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// Prevent a closing float WebView from recreating a renderer lease through
/// an in-flight heartbeat, then remove every existing float-scoped renderer.
/// Main-window consumers use a different prefix and remain registered.
pub(crate) fn suspend_float_output_consumers() -> usize {
    let _scope_gate = OUTPUT_CONSUMER_SCOPE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    FLOAT_RENDERER_CONSUMERS_SUSPENDED.store(true, Ordering::SeqCst);
    registry::unregister_renderers_with_prefix(FLOAT_RENDERER_CONSUMER_PREFIX)
}

/// Re-enable float renderer registration before a float window is shown or
/// lazily recreated.
pub(crate) fn resume_float_output_consumers() {
    let _scope_gate = OUTPUT_CONSUMER_SCOPE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    FLOAT_RENDERER_CONSUMERS_SUSPENDED.store(false, Ordering::SeqCst);
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pty_graceful_shutdown(
    id: String,
    attempt_id: String,
    profile: GracefulShutdownProfile,
) -> Result<GracefulShutdownResult, String> {
    shutdown::graceful_shutdown(id, attempt_id, profile).await
}

#[tauri::command]
pub async fn pty_cancel_graceful_shutdown(id: String, attempt_id: String) -> Result<bool, String> {
    shutdown::cancel_graceful_shutdown(id, attempt_id).await
}

/// Create a new PTY session and begin streaming output.
// This Tauri IPC contract intentionally keeps the explicit launch, dimensions,
// and optional one-shot fields flat for backward-compatible frontend callers.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_create(
    id: String,
    working_dir: String,
    rows: u16,
    cols: u16,
    provider: Option<String>,
    launch_attempt_id: Option<String>,
    launch: Option<PtyLaunchDescriptor>,
    window: Window,
) -> Result<String, String> {
    create_session(
        id,
        working_dir,
        rows,
        cols,
        provider,
        launch_attempt_id,
        launch,
        CreateStartup::Legacy,
        window,
    )
    .await
    .map(|outcome| outcome.id)
}

/// Additive create/attach API. Explicit startup intent is registered while the
/// keyed create gate is held, before a new session becomes registry-visible.
#[tauri::command]
pub(crate) async fn pty_create_session_v2(
    request: startup::PtyCreateSessionV2Request,
    window: Window,
    dispatcher: State<'_, startup::StartupSideEffectDispatcher>,
) -> Result<PtyCreateSessionV2Result, String> {
    request.validate().map_err(str::to_owned)?;
    let provider = match &request.startup {
        PtyStartupIntent::Provider { provider, .. } => Some(provider.as_str().to_string()),
        _ => None,
    };
    let launch = match &request.startup {
        PtyStartupIntent::OneShot { descriptor } => Some(descriptor.clone()),
        _ => None,
    };
    let outcome = create_session(
        request.id,
        request.working_dir,
        request.rows,
        request.cols,
        provider,
        request.launch_attempt_id,
        launch,
        CreateStartup::Explicit {
            intent: request.startup,
            dispatcher: dispatcher.inner().clone(),
        },
        window,
    )
    .await?;
    Ok(PtyCreateSessionV2Result {
        pty_id: outcome.id,
        generation: outcome.generation,
        disposition: outcome.disposition,
        shell_family: outcome.shell_family,
        descriptor_disposition: outcome.descriptor_disposition,
        startup: outcome.startup,
    })
}

#[allow(clippy::too_many_arguments)]
async fn create_session(
    id: String,
    working_dir: String,
    rows: u16,
    cols: u16,
    provider: Option<String>,
    launch_attempt_id: Option<String>,
    launch: Option<PtyLaunchDescriptor>,
    startup_registration: CreateStartup,
    window: Window,
) -> Result<CreateOutcome, String> {
    #[cfg(feature = "terminal-startup-harness")]
    let harness_offline_attested =
        crate::terminal_startup_harness::offline_attestation().is_enabled();
    #[cfg(feature = "terminal-startup-harness")]
    if !harness_offline_attested {
        // The feature build is non-shipping and may only create a terminal
        // when the runner has explicitly attested its isolated/offline mode.
        return Err("terminal_startup_harness_offline_required".to_string());
    }

    let one_shot_command = launch
        .as_ref()
        .map(PtyLaunchDescriptor::one_shot_command)
        .transpose()?
        .flatten();
    // This is an intent-only signal. It never waits and is deliberately before
    // the same-id gate, registry lookup, shell discovery, or native spawn.
    warmup::notify_real_create();
    // Same-id attach/create calls (main window + float, reconnect races) now
    // share one async gate. Other pane ids remain independent and can proceed
    // concurrently; the Windows-only native spawn lock below still protects
    // ConPTY initialization globally.
    let _create_gate = acquire_pty_create_gate(&id).await;
    let launch_started_at = Instant::now();
    if let Some(session) = registry::get(&id) {
        let descriptor_disposition = match &startup_registration {
            CreateStartup::Legacy => PtyDescriptorDisposition::NotApplicable,
            CreateStartup::Explicit { intent, dispatcher } => {
                let disposition = session.startup.claim(intent.clone(), |snapshot| {
                    startup::emit_startup_state(&session.app_handle, snapshot);
                })?;
                if matches!(intent, PtyStartupIntent::Provider { .. }) {
                    install_startup_side_effect_context(
                        &session,
                        dispatcher.clone(),
                        session._working_dir.clone(),
                    )?;
                    let _ = startup::dispatch_if_ready(&id, &session)?;
                    startup::resubmit_sent_effects(&id, &session)?;
                }
                disposition
            }
        };
        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "ptyCreateReturned",
            launch_started_at,
            provider.as_deref(),
        );
        tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
        return Ok(CreateOutcome {
            id,
            disposition: PtyCreateDisposition::Attached,
            descriptor_disposition,
            generation: session.generation.clone(),
            shell_family: session.shell_family,
            startup: session.startup.snapshot()?,
        });
    }

    #[cfg(feature = "terminal-startup-harness")]
    let mut harness_claim =
        HarnessCreateClaim::claim().map_err(|_| HARNESS_CASE_BIND_FAILED.to_string())?;

    // A harness claim always carries an exact runner receipt (including the
    // harness Auto case), so it never enters production PATH discovery.
    #[cfg(feature = "terminal-startup-harness")]
    let shell_path = harness_claim
        .as_ref()
        .and_then(HarnessCreateClaim::forced_shell_path)
        .map(|path| {
            path.to_str()
                .map(str::to_owned)
                .ok_or_else(|| HARNESS_CASE_BIND_FAILED.to_string())
        })
        .transpose()?
        .unwrap_or_else(shell::default_shell);
    #[cfg(not(feature = "terminal-startup-harness"))]
    let shell_path = shell::default_shell();
    let provider_startup = matches!(
        &startup_registration,
        CreateStartup::Explicit {
            intent: PtyStartupIntent::Provider { .. },
            ..
        }
    );
    let (rejected_attach_intent, rejected_attach_dispatcher) = match &startup_registration {
        CreateStartup::Explicit { intent, dispatcher } => {
            (Some(intent.clone()), Some(dispatcher.clone()))
        }
        CreateStartup::Legacy => (None, None),
    };
    let generation = startup::mint_generation()?;
    let shell_family = startup::classify_shell_family(&shell_path);
    let startup_policy =
        startup::startup_readiness_policy(shell_family, startup::provider_shell_ready_enabled());
    let (startup_runtime, descriptor_disposition, startup_side_effects) = match startup_registration
    {
        CreateStartup::Legacy => (
            legacy_session_startup(&id, &generation, one_shot_command.is_some())?,
            PtyDescriptorDisposition::NotApplicable,
            None,
        ),
        CreateStartup::Explicit { intent, dispatcher } => {
            let startup_side_effects = matches!(&intent, PtyStartupIntent::Provider { .. })
                .then_some(StartupSideEffectContext {
                    dispatcher,
                    project_path: working_dir.clone(),
                });
            (
                startup::SessionStartup::new(PtyStartupCoordinator::explicit(
                    &id,
                    &generation,
                    intent,
                )?),
                PtyDescriptorDisposition::Accepted,
                startup_side_effects,
            )
        }
    };

    // Serialize ConPTY/PTY open+spawn across concurrent terminal creations
    // (Windows blank/stall mitigation; harmless on other platforms). The lock
    // is held only around open+spawn, then released before the rest of setup.
    #[cfg(all(feature = "terminal-startup-harness", feature = "stats-proxy"))]
    let offline_provider_env_skip = harness_offline_attested && provider.is_some();
    #[cfg(all(feature = "stats-proxy", not(feature = "terminal-startup-harness")))]
    let offline_provider_env_skip = false;
    #[cfg(feature = "stats-proxy")]
    if provider.is_some() && !offline_provider_env_skip {
        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "providerEnvStarted",
            launch_started_at,
            provider.as_deref(),
        );
    }
    #[cfg(feature = "stats-proxy")]
    let proxy_env = if offline_provider_env_skip {
        Vec::new()
    } else if let Some(provider) = provider.as_deref() {
        crate::stats::proxy::prepare_env(provider, Some(&working_dir)).await?
    } else {
        Vec::new()
    };
    #[cfg(not(feature = "stats-proxy"))]
    let proxy_env: Vec<(String, String)> = Vec::new();
    #[cfg(feature = "stats-proxy")]
    if provider.is_some() && !offline_provider_env_skip {
        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "providerEnvReady",
            launch_started_at,
            provider.as_deref(),
        );
    }

    let (pair, mut child) = {
        #[cfg(target_os = "windows")]
        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "spawnGateWaitStarted",
            launch_started_at,
            provider.as_deref(),
        );
        #[cfg(target_os = "windows")]
        let _spawn_guard = PTY_SPAWN_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        #[cfg(target_os = "windows")]
        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "spawnGateAcquired",
            launch_started_at,
            provider.as_deref(),
        );
        #[cfg(not(target_os = "windows"))]
        let _spawn_guard = ();

        emit_launch_phase(
            &window,
            launch_attempt_id.as_deref(),
            &id,
            "openPtyStarted",
            launch_started_at,
            provider.as_deref(),
        );

        let pty_system = NativePtySystem::default();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = match pty_system.openpty(size) {
            Ok(pair) => {
                emit_launch_phase(
                    &window,
                    launch_attempt_id.as_deref(),
                    &id,
                    "openPtyReady",
                    launch_started_at,
                    provider.as_deref(),
                );
                pair
            }
            Err(error) => return Err(format!("Failed to open PTY: {error}")),
        };

        let mut cmd = CommandBuilder::new(&shell_path);
        // Windows: normalize forward slashes so ConPTY resolves the cwd reliably.
        #[cfg(target_os = "windows")]
        cmd.cwd(shell::normalize_windows_cwd(&working_dir));
        #[cfg(not(target_os = "windows"))]
        cmd.cwd(&working_dir);
        if let Some(command) = one_shot_command.as_deref() {
            shell::configure_one_shot_command(&mut cmd, &shell_path, command);
        } else if matches!(
            shell_family,
            PtyShellFamily::Pwsh | PtyShellFamily::WindowsPowerShell
        ) && (provider_startup
            && matches!(
                startup_policy,
                startup::StartupReadinessPolicy::Marker { .. }
            )
            || shell::powershell_utf8_enabled())
        {
            shell::configure_powershell_ready_command(
                &mut cmd,
                &shell_path,
                &generation,
                shell::powershell_utf8_enabled(),
            )?;
        } else {
            // Preserve interactive shell startup exactly: callers still send
            // their optional initial command through pty_input after attach.
            shell::configure_interactive_shell_command(&mut cmd, &shell_path);
        }
        for (key, value) in &proxy_env {
            cmd.env(key, value);
        }

        let child = match pair.slave.spawn_command(cmd) {
            Ok(child) => {
                emit_launch_phase(
                    &window,
                    launch_attempt_id.as_deref(),
                    &id,
                    "childSpawned",
                    launch_started_at,
                    provider.as_deref(),
                );
                child
            }
            Err(error) => return Err(format!("Failed to spawn shell: {error}")),
        };
        (pair, child)
    };

    // Drop the slave so reads on master detect EOF when the child exits.
    drop(pair.slave);

    // Clone the reader before taking the writer or starting its thread. If
    // reader setup fails, the child is still owned here and can be killed
    // explicitly instead of leaving a live process behind an unusable PTY.
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("Failed to clone PTY reader: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("Failed to get PTY writer: {error}"));
        }
    };
    let pty_writer = match spawn_writer_for_startup(writer, provider_startup) {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("Failed to start PTY input writer: {error}"));
        }
    };
    let session = Arc::new(PtySession {
        input_tx: pty_writer.input_sender(),
        writer: pty_writer,
        generation,
        shell_family,
        startup: startup_runtime,
        startup_side_effects: Mutex::new(startup_side_effects),
        master: Mutex::new(Some(pair.master)),
        child: Mutex::new(child),
        _working_dir: working_dir.clone(),
        state: RwLock::new(SessionState::Idle),
        app_handle: window.app_handle().clone(),
        output_buffer: RwLock::new(String::with_capacity(OUTPUT_BUFFER_MAX_BYTES.min(8192))),
        output_commit: Mutex::new(()),
        output_seq: Mutex::new(0),
        flow_control: Mutex::new(session::OutputFlowControl::default()),
        flow_control_changed: Condvar::new(),
        snapshot: Mutex::new(emulator::TerminalSnapshot::new(
            rows,
            cols,
            SESSION_SCROLLBACK_LINES,
        )),
        last_output_at: Mutex::new(None),
        last_size: Mutex::new((rows, cols)),
        suppress_output_activity_until: Mutex::new(None),
        killed: AtomicBool::new(false),
    });

    #[cfg(feature = "terminal-startup-harness")]
    let suppress_harness_readiness = harness_claim
        .as_ref()
        .is_some_and(|claim| !matches!(claim.plan.timing, HarnessTiming::Natural));
    #[cfg(feature = "terminal-startup-harness")]
    let configured_output = startup_output_config_with_suppression(
        provider_startup,
        shell_family,
        one_shot_command.is_some(),
        startup_policy,
        shell::powershell_utf8_enabled(),
        &session.generation,
        suppress_harness_readiness,
    );
    #[cfg(not(feature = "terminal-startup-harness"))]
    let configured_output = startup_output_config(
        provider_startup,
        shell_family,
        one_shot_command.is_some(),
        startup_policy,
        shell::powershell_utf8_enabled(),
        &session.generation,
    );
    let startup_output_configured = session.startup.configure_output(configured_output);
    if let Err(error) = startup_output_configured {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        let _ = session::close_master(&session, &id);
        return Err(error);
    }

    if let Err(rejected) = registry::insert_if_absent(id.clone(), session.clone()) {
        // Idempotent: if a PTY with this id already exists (e.g. a
        // second webview — typically the floating-terminal overlay —
        // mounted xterm for the same card while the main window's
        // Shell was still alive), kill the redundant child we just
        // spawned (avoids a fork leak) and return Ok(id). The caller
        // attaches to the existing session's `pty-output` broadcast
        // via the listen API, so no state is lost.
        if let Ok(mut c) = rejected.child.lock() {
            let _ = c.kill();
        }
        tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
        return Ok(CreateOutcome {
            id: id.clone(),
            disposition: PtyCreateDisposition::Attached,
            descriptor_disposition: match rejected_attach_intent {
                None => PtyDescriptorDisposition::NotApplicable,
                Some(intent) => {
                    let disposition = rejected.startup.claim(intent.clone(), |snapshot| {
                        startup::emit_startup_state(&rejected.app_handle, snapshot);
                    })?;
                    if matches!(intent, PtyStartupIntent::Provider { .. }) {
                        let dispatcher = rejected_attach_dispatcher
                            .as_ref()
                            .expect("explicit intent has dispatcher")
                            .clone();
                        install_startup_side_effect_context(
                            &rejected,
                            dispatcher,
                            rejected._working_dir.clone(),
                        )?;
                        let _ = startup::dispatch_if_ready(&id, &rejected)?;
                        startup::resubmit_sent_effects(&id, &rejected)?;
                    }
                    disposition
                }
            },
            generation: rejected.generation.clone(),
            shell_family: rejected.shell_family,
            startup: rejected.startup.snapshot()?,
        });
    }

    #[cfg(feature = "terminal-startup-harness")]
    if let Some(claim) = harness_claim.as_mut() {
        if claim.bind(&id, &session.generation).is_err() {
            cleanup_failed_harness_session(&id, &session);
            return Err(HARNESS_CASE_BIND_FAILED.to_string());
        }
        #[cfg(all(feature = "terminal-startup-harness", feature = "stats-proxy"))]
        if offline_provider_env_skip
            && matches!(claim.plan.fixture, HarnessFixture::SyntheticProvider)
        {
            let _ = crate::terminal_startup_harness::record_provider_env_prepare_skipped(
                &id,
                &session.generation,
            );
        }
    }

    // The session is now in the registry. Tell connected mobile clients
    // about the new card so the desktop/mobile session lists stay in sync
    // without waiting for a reconnect snapshot. Pure addition: desktop
    // behaviour is unchanged.
    crate::bridge::broadcast_card_added(&id);

    // Spawn a background thread to read PTY output and emit events. The
    // session remains Idle until bytes actually flow from the PTY.
    events::spawn_output_idle_watcher(id.clone(), session.clone());
    let stream_id = id.clone();
    let stream_session = session.clone();
    let handle = window.app_handle().clone();
    std::thread::spawn(move || {
        events::stream_pty_output(stream_id, reader, stream_session, handle);
    });

    if provider_startup {
        #[cfg(feature = "terminal-startup-harness")]
        let arm_result = startup::arm_startup_with_harness(
            id.clone(),
            session.clone(),
            startup_policy,
            harness_claim
                .as_ref()
                .map(|claim| claim.plan.timing)
                .unwrap_or(HarnessTiming::Natural),
        );
        #[cfg(not(feature = "terminal-startup-harness"))]
        let arm_result = startup::arm_startup(id.clone(), session.clone(), startup_policy);
        if let Err(error) = arm_result {
            #[cfg(feature = "terminal-startup-harness")]
            if harness_claim.is_some() {
                let _ = crate::terminal_startup_harness::fail_bound_case(&id, &session.generation);
            }
            if let Some(removed) = registry::remove_if_same(&id, &session) {
                session::mark_killed(&removed);
                if let Ok(mut child) = removed.child.lock() {
                    let _ = child.kill();
                }
                let _ = session::close_master(&removed, &id);
            }
            return Err(error);
        }
    }

    tracing::info!(id = %id, shell = %shell_path, "PTY session created");
    Ok(CreateOutcome {
        id,
        disposition: PtyCreateDisposition::Created,
        descriptor_disposition,
        generation: session.generation.clone(),
        shell_family: session.shell_family,
        startup: session.startup.snapshot()?,
    })
}

/// Write data (keystrokes) to a PTY session.
#[tauri::command]
pub async fn pty_input(id: String, data: String) -> Result<(), String> {
    let session = registry::get(&id).ok_or_else(|| format!("PTY session '{}' not found", id))?;

    let _shutdown_input_permit = shutdown::prepare_for_user_input(&id).await?;

    // User input clears the waiting state; the session becomes Running only
    // once the PTY emits output again.
    clear_waiting_for_input(&session, &id);

    let (completion, completed) = tokio::sync::oneshot::channel();
    session
        .input_tx
        .send(PtyInputRequest {
            data: data.into_bytes(),
            completion,
        })
        .await
        .map_err(|_| format!("PTY input writer for '{id}' is unavailable"))?;
    let result = completed
        .await
        .map_err(|_| format!("PTY input writer for '{id}' stopped before completing the write"))?;
    if result.is_ok() {
        session::mark_input_activity(&session, &id);
    }
    result
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = registry::get(&id).ok_or_else(|| format!("PTY session '{}' not found", id))?;

    {
        let mut last_size = session
            .last_size
            .lock()
            .map_err(|e| format!("Failed to lock PTY size: {e}"))?;
        if *last_size == (rows, cols) {
            return Ok(());
        }
        *last_size = (rows, cols);
    }

    suppress_output_activity_for(&session, RESIZE_OUTPUT_ACTIVITY_SUPPRESS);

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Failed to lock PTY master: {e}"))?;
    let master = master
        .as_ref()
        .ok_or_else(|| format!("PTY session '{id}' is closing"))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))?;

    if let Ok(mut snapshot) = session.snapshot.lock() {
        snapshot.resize(rows, cols);
    }

    Ok(())
}

/// Kill a PTY session and clean up resources.
fn terminate_child_process(child: &mut (dyn portable_pty::Child + Send + Sync)) {
    // Windows: kill the whole process tree first so grandchildren
    // (sub-shells, node, git, …) don't orphan after close. `child.kill()`
    // alone only terminates the direct ConPTY child.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Some(pid) = child.process_id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
        }
    }
    let _ = child.kill();
}

fn terminate_session_process(session: &PtySession) {
    if let Ok(mut child) = session.child.lock() {
        terminate_child_process(child.as_mut());
    }
}

#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    let _create_gate = acquire_pty_create_gate(&id).await;
    shutdown::forget(&id);
    if let Some(observed) = registry::get(&id) {
        if !registry::is_current(&id, &observed) {
            return Err(format!("PTY session '{}' not found", id));
        }
        let _ = observed
            .startup
            .cancel(PtyStartupTrigger::Killed, |snapshot| {
                startup::emit_startup_state(&observed.app_handle, snapshot)
            });
        if let Some(session) = registry::remove_if_same(&id, &observed) {
            mark_killed(&session);
            // CardRemoved only needs identity/session metadata. Avoid serializing
            // the full emulator and raw replay buffer merely to remove a card on
            // mobile; the bridge prefers its existing raw CardMeta mirror and
            // falls back to a lightweight tombstone.
            let removed_state = session
                .state
                .read()
                .map(|state| state.clone())
                .unwrap_or(SessionState::Idle);
            let removed_working_dir = session._working_dir.clone();
            let removed_card =
                crate::bridge::prepare_card_removed(&id, removed_state, &removed_working_dir);

            // `taskkill /T` and portable-pty termination are synchronous OS work.
            // Keep them off Tauri/Tokio's async executor while preserving the
            // command's existing wait-until-kill-attempt-completes behavior.
            if let Err(error) = tokio::task::spawn_blocking(move || {
                terminate_session_process(&session);
                // Drop this Arc in the blocking worker. Once the reader thread
                // drops its clone too, the master fd closes and it observes EOF.
            })
            .await
            {
                tracing::warn!(id = %id, error = %error, "PTY kill worker failed");
            }
            // This explicit close path also covers the mobile close entry.
            // Natural process exit (events.rs) intentionally remains unchanged:
            // completed/failed cards stay visible, matching desktop behaviour.
            crate::bridge::broadcast_card_removed(removed_card);
            tracing::info!(id = %id, "PTY session killed");
            Ok(())
        } else {
            Err(format!("PTY session '{}' not found", id))
        }
    } else {
        Err(format!("PTY session '{}' not found", id))
    }
}

/// Get the current state of a PTY session.
#[tauri::command]
pub async fn pty_get_session_state(pty_id: String) -> Result<SessionState, String> {
    let session =
        registry::get(&pty_id).ok_or_else(|| format!("PTY session '{}' not found", pty_id))?;

    session
        .state
        .read()
        .map(|s| s.clone())
        .map_err(|e| format!("Failed to read session state: {e}"))
}

/// Read the privacy-safe startup projection for one PTY generation.
/// Missing sessions and stale generations intentionally converge to `None`.
#[tauri::command]
pub async fn pty_get_startup_state(
    pty_id: String,
    generation: String,
) -> Result<Option<PtyStartupSnapshot>, String> {
    validate_generation(&generation).map_err(str::to_owned)?;
    let Some(session) = registry::get(&pty_id) else {
        return Ok(None);
    };
    startup::snapshot_for_generation(&session.generation, &generation, || {
        session.startup.snapshot()
    })
}

/// Get the states of all live PTY sessions in a single call.
///
/// Audit P2-5: the frontend's cross-webview reconciliation poll used to call
/// `pty_get_session_state` once per card every cycle (N cards = N IPC
/// round-trips). This batch command returns `{ id → SessionState }` so the
/// poll costs one IPC regardless of card count; ids missing from the map
/// mean the PTY is no longer registered.
#[tauri::command]
pub async fn pty_get_all_session_states() -> Result<HashMap<String, SessionState>, String> {
    Ok(registry::all_session_states())
}

/// Read recent output for a live PTY session so a second webview can render
/// context immediately after attaching instead of looking like a fresh shell.
#[tauri::command]
pub async fn pty_get_recent_output(pty_id: String) -> Result<Option<String>, String> {
    Ok(get_recent_output(&pty_id))
}

#[tauri::command]
pub async fn pty_attach_snapshot(pty_id: String) -> Result<Option<PtyAttachSnapshot>, String> {
    let Some(session) = registry::get(&pty_id) else {
        return Ok(None);
    };
    let snapshot = session::attach_snapshot(&pty_id, &session);
    Ok(Some(snapshot))
}

pub fn attach_snapshot_for_bridge(pty_id: &str) -> Option<PtyAttachSnapshot> {
    let session = registry::get(pty_id)?;
    Some(session::attach_snapshot(pty_id, &session))
}

#[tauri::command]
pub async fn pty_register_output_consumer(id: String, consumer_id: String) -> Result<(), String> {
    if consumer_id.trim().is_empty() {
        return Err("Output consumer id cannot be empty".to_string());
    }
    let _scope_gate = OUTPUT_CONSUMER_SCOPE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if consumer_id.starts_with(FLOAT_RENDERER_CONSUMER_PREFIX)
        && FLOAT_RENDERER_CONSUMERS_SUSPENDED.load(Ordering::SeqCst)
    {
        return Ok(());
    }
    let Some(session) = registry::get(&id) else {
        return Ok(());
    };
    session::register_renderer(&session, consumer_id);
    Ok(())
}

#[tauri::command]
pub async fn pty_unregister_output_consumer(id: String, consumer_id: String) -> Result<(), String> {
    let Some(session) = registry::get(&id) else {
        return Ok(());
    };
    session::unregister_renderer(&session, &consumer_id);
    Ok(())
}

#[tauri::command]
pub async fn pty_ack(
    id: String,
    through_seq: u64,
    consumer_kind: String,
    consumer_id: Option<String>,
) -> Result<(), String> {
    let Some(session) = registry::get(&id) else {
        return Ok(());
    };
    match consumer_kind.as_str() {
        "background" => session::ack_background(&session, through_seq),
        "renderer" => {
            let consumer_id = consumer_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Renderer ACK requires a consumer id".to_string())?;
            session::ack_renderer(&session, &consumer_id, through_seq);
        }
        _ => return Err(format!("Unknown output consumer kind: {consumer_kind}")),
    }
    Ok(())
}

/// Read the recent output buffer for a PTY session.
pub fn get_recent_output(pty_id: &str) -> Option<String> {
    let session = registry::get(pty_id)?;
    let buf = session.output_buffer.read().ok()?;
    if buf.is_empty() {
        None
    } else {
        Some(buf.clone())
    }
}

// Tests preserved verbatim from the pre-split `pty.rs` live in
// `pty/tests.rs` so that `cargo test pty::tests` (ROADMAP baseline) keeps
// resolving to the same set of cases. Submodules carry their own
// additional tests.
#[cfg(test)]
mod tests;

#[cfg(test)]
mod create_gate_tests;

#[cfg(all(test, feature = "terminal-startup-harness"))]
mod harness_create_tests;
