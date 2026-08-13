//! Cooperative PTY shutdown for interactive terminals.
//!
//! Shutdown attempt state intentionally lives outside [`PtySession`] while the
//! session retains ownership of live PTY resources. The existing `pty_kill`
//! command remains the explicit force path; nothing in this module escalates
//! to it automatically.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::registry;
use super::session::{close_master, PtyInputRequest, PtySession};

const GRACEFUL_SHUTDOWN_WINDOW: Duration = Duration::from_secs(5);
const INTERRUPT_SETTLE_DELAY: Duration = Duration::from_millis(150);
const KIMI_EOF_DELAY: Duration = Duration::from_millis(100);
const PROVIDER_INPUT_DELAY: Duration = Duration::from_millis(100);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GracefulShutdownProfile {
    Claude,
    Codex,
    Opencode,
    Gemini,
    Kimi,
    Grok,
    Generic,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GracefulShutdownStage {
    Interrupt,
    AgentExit,
    ShellExit,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GracefulShutdownOutcome {
    Graceful,
    AlreadyExited,
    TimedOut,
    InProgress,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GracefulShutdownResult {
    pub attempt_id: String,
    pub outcome: GracefulShutdownOutcome,
    pub stage: GracefulShutdownStage,
}

#[derive(Debug)]
struct ShutdownAttempt {
    id: String,
    profile: GracefulShutdownProfile,
    interrupt_sent: bool,
    agent_exit_writes_sent: usize,
    shell_exit_sent: bool,
    timed_out: bool,
    tracked_descendants: HashSet<u32>,
}

impl ShutdownAttempt {
    fn new(id: String, profile: GracefulShutdownProfile) -> Self {
        Self {
            id,
            profile,
            interrupt_sent: false,
            agent_exit_writes_sent: 0,
            shell_exit_sent: false,
            timed_out: false,
            tracked_descendants: HashSet::new(),
        }
    }

    fn stage(&self) -> GracefulShutdownStage {
        if !self.interrupt_sent {
            GracefulShutdownStage::Interrupt
        } else if !self.shell_exit_sent {
            GracefulShutdownStage::AgentExit
        } else {
            GracefulShutdownStage::ShellExit
        }
    }

    fn result(&self, outcome: GracefulShutdownOutcome) -> GracefulShutdownResult {
        GracefulShutdownResult {
            attempt_id: self.id.clone(),
            outcome,
            stage: self.stage(),
        }
    }

    fn observe_agent_descendants(&mut self, current: &HashSet<u32>, exit_write_count: usize) {
        self.tracked_descendants.extend(current.iter().copied());
        if current.is_empty() {
            self.interrupt_sent = true;
            self.agent_exit_writes_sent = exit_write_count;
        }
    }
}

#[derive(Debug, Default)]
struct ShutdownSlot {
    operation: Arc<AsyncMutex<()>>,
    attempt: Mutex<Option<ShutdownAttempt>>,
}

static SHUTDOWN_SLOTS: Lazy<DashMap<String, Arc<ShutdownSlot>>> = Lazy::new(DashMap::new);

fn slot_for(id: &str) -> Arc<ShutdownSlot> {
    SHUTDOWN_SLOTS
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(ShutdownSlot::default()))
        .clone()
}

fn existing_slot(id: &str) -> Option<Arc<ShutdownSlot>> {
    SHUTDOWN_SLOTS.get(id).map(|entry| entry.value().clone())
}

pub(super) fn forget(id: &str) {
    SHUTDOWN_SLOTS.remove(id);
}

/// Ordinary input cancels a paused timeout attempt, but is rejected while a
/// shutdown window is actively running. The returned permit must be held until
/// the input writer acknowledges the bytes so a concurrent continuation cannot
/// interleave shutdown control input.
pub(super) async fn prepare_for_user_input(id: &str) -> Result<OwnedMutexGuard<()>, String> {
    let slot = slot_for(id);
    {
        let attempt = slot
            .attempt
            .lock()
            .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
        if matches!(attempt.as_ref(), Some(current) if !current.timed_out) {
            return Err(format!(
                "PTY '{id}' is ending gracefully; wait for the current attempt to finish"
            ));
        }
    }

    let permit = slot.operation.clone().lock_owned().await;
    let mut attempt = slot
        .attempt
        .lock()
        .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
    match attempt.as_ref() {
        Some(current) if !current.timed_out => Err(format!(
            "PTY '{id}' is ending gracefully; wait for the current attempt to finish"
        )),
        Some(_) => {
            *attempt = None;
            drop(attempt);
            Ok(permit)
        }
        None => {
            drop(attempt);
            Ok(permit)
        }
    }
}

pub(super) async fn cancel_graceful_shutdown(
    id: String,
    attempt_id: String,
) -> Result<bool, String> {
    let Some(slot) = existing_slot(&id) else {
        return Ok(false);
    };
    let _operation_guard = slot.operation.lock().await;
    let mut attempt = slot
        .attempt
        .lock()
        .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
    let Some(current) = attempt.as_ref() else {
        return Ok(false);
    };
    if current.id != attempt_id {
        return Ok(false);
    }
    if !current.timed_out {
        return Err(format!("PTY '{id}' shutdown attempt is still in progress"));
    }
    *attempt = None;
    Ok(true)
}

pub(super) async fn graceful_shutdown(
    id: String,
    attempt_id: String,
    profile: GracefulShutdownProfile,
) -> Result<GracefulShutdownResult, String> {
    let Some(session) = registry::get(&id) else {
        forget(&id);
        return Ok(GracefulShutdownResult {
            attempt_id,
            outcome: GracefulShutdownOutcome::AlreadyExited,
            stage: GracefulShutdownStage::ShellExit,
        });
    };

    let slot = slot_for(&id);
    let Ok(_operation_guard) = slot.operation.try_lock() else {
        let attempt = slot
            .attempt
            .lock()
            .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
        return Ok(attempt
            .as_ref()
            .map(|current| current.result(GracefulShutdownOutcome::InProgress))
            .unwrap_or(GracefulShutdownResult {
                attempt_id,
                outcome: GracefulShutdownOutcome::InProgress,
                stage: GracefulShutdownStage::Interrupt,
            }));
    };

    if !registry::contains(&id) {
        forget(&id);
        return Ok(GracefulShutdownResult {
            attempt_id,
            outcome: GracefulShutdownOutcome::AlreadyExited,
            stage: GracefulShutdownStage::ShellExit,
        });
    }

    {
        let mut attempt = slot
            .attempt
            .lock()
            .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
        match attempt.as_mut() {
            Some(current) => {
                // A repeated close from another device joins the authoritative
                // in-memory attempt instead of injecting a second sequence.
                if current.profile != profile {
                    tracing::debug!(
                        id = %id,
                        requested_profile = ?profile,
                        active_profile = ?current.profile,
                        "graceful shutdown reused the active profile"
                    );
                }
                current.timed_out = false;
            }
            None => *attempt = Some(ShutdownAttempt::new(attempt_id, profile)),
        }
    }

    let deadline = Instant::now() + GRACEFUL_SHUTDOWN_WINDOW;
    let root_pid = session
        .child
        .lock()
        .map_err(|error| format!("Failed to lock PTY child for '{id}': {error}"))?
        .process_id();
    let profile = read_attempt(&slot, &id, |attempt| attempt.profile)?;
    let writes = provider_exit_writes(profile);

    let agent_already_exited = if let Some(root_pid) = root_pid {
        let current_descendants = inspect_descendants(root_pid, &id).await?;
        update_attempt(&slot, &id, |attempt| {
            attempt.observe_agent_descendants(&current_descendants, writes.len());
        })?;
        current_descendants.is_empty()
    } else {
        false
    };

    if !agent_already_exited {
        if !read_attempt(&slot, &id, |attempt| attempt.interrupt_sent)? {
            write_control(&session, &id, vec![0x03]).await?;
            update_attempt(&slot, &id, |attempt| attempt.interrupt_sent = true)?;
            sleep_until_or_deadline(INTERRUPT_SETTLE_DELAY, deadline).await;
        }

        loop {
            let sent = read_attempt(&slot, &id, |attempt| attempt.agent_exit_writes_sent)?;
            let Some(write) = writes.get(sent) else {
                break;
            };
            if let Some(root_pid) = root_pid {
                let current_descendants = inspect_descendants(root_pid, &id).await?;
                update_attempt(&slot, &id, |attempt| {
                    attempt.observe_agent_descendants(&current_descendants, writes.len());
                })?;
                if current_descendants.is_empty() {
                    break;
                }
            }
            write_control(&session, &id, write.to_vec()).await?;
            update_attempt(&slot, &id, |attempt| attempt.agent_exit_writes_sent += 1)?;
            if sent + 1 < writes.len() {
                let delay = if matches!(
                    profile,
                    GracefulShutdownProfile::Kimi | GracefulShutdownProfile::Generic
                ) {
                    KIMI_EOF_DELAY
                } else {
                    PROVIDER_INPUT_DELAY
                };
                sleep_until_or_deadline(delay, deadline).await;
            }
        }
    }

    let Some(root_pid) = root_pid else {
        // Without the direct shell pid we cannot prove that the foreground
        // Agent has left. Keep the PTY intact and return a timeout instead of
        // risking `exit` being delivered as Agent input.
        sleep_until_or_deadline(GRACEFUL_SHUTDOWN_WINDOW, deadline).await;
        return timeout_result(&slot, &id);
    };

    if !registry::contains(&id) {
        let result = read_attempt(&slot, &id, |attempt| {
            attempt.result(GracefulShutdownOutcome::Graceful)
        })?;
        forget(&id);
        return Ok(result);
    }

    let tracked = read_attempt(&slot, &id, |attempt| attempt.tracked_descendants.clone())?;
    let id_for_wait = id.clone();
    let tree_wait = tokio::task::spawn_blocking(move || {
        wait_for_descendants(&id_for_wait, root_pid, tracked, deadline)
    })
    .await
    .map_err(|error| format!("Failed to wait for PTY process tree for '{id}': {error}"))?;
    update_attempt(&slot, &id, |attempt| {
        attempt.tracked_descendants = tree_wait.tracked;
    })?;
    if tree_wait.timed_out {
        return timeout_result(&slot, &id);
    }

    if !registry::contains(&id) {
        let result = read_attempt(&slot, &id, |attempt| {
            attempt.result(GracefulShutdownOutcome::Graceful)
        })?;
        forget(&id);
        return Ok(result);
    }

    if shell_has_exited(&session, &id)? {
        update_attempt(&slot, &id, |attempt| attempt.shell_exit_sent = true)?;
        if close_master(&session, &id)? {
            tracing::debug!(id = %id, "released PTY master after observed shell exit");
        }
    } else if !read_attempt(&slot, &id, |attempt| attempt.shell_exit_sent)? {
        let write_result = write_control(&session, &id, b"exit\r".to_vec()).await;
        // A failed write can still be partial, and the dedicated writer exits
        // after any I/O error. Never inject a second shell command on a
        // continuation; the child observation below remains authoritative.
        update_attempt(&slot, &id, |attempt| attempt.shell_exit_sent = true)?;
        if let Err(error) = write_result {
            tracing::debug!(
                id = %id,
                error = %error,
                "shell exit write failed; observing the child for a concurrent exit"
            );
        }
    }

    while Instant::now() < deadline {
        if !registry::contains(&id) {
            let result = read_attempt(&slot, &id, |attempt| {
                attempt.result(GracefulShutdownOutcome::Graceful)
            })?;
            forget(&id);
            return Ok(result);
        }

        if shell_has_exited(&session, &id)? {
            update_attempt(&slot, &id, |attempt| attempt.shell_exit_sent = true)?;
            if close_master(&session, &id)? {
                tracing::debug!(id = %id, "released PTY master after shell exit");
            }
        }

        tokio::time::sleep(
            PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }

    timeout_result(&slot, &id)
}

async fn inspect_descendants(root_pid: u32, id: &str) -> Result<HashSet<u32>, String> {
    tokio::task::spawn_blocking(move || {
        let mut system = System::new_all();
        system.refresh_processes();
        descendant_pids(root_pid, &process_parent_map(&system))
    })
    .await
    .map_err(|error| format!("Failed to inspect PTY process tree for '{id}': {error}"))
}

fn shell_has_exited(session: &PtySession, id: &str) -> Result<bool, String> {
    session
        .child
        .lock()
        .map_err(|error| format!("Failed to lock PTY child for '{id}': {error}"))?
        .try_wait()
        .map(|status| status.is_some())
        .map_err(|error| format!("Failed to poll PTY child for '{id}': {error}"))
}

fn timeout_result(slot: &ShutdownSlot, id: &str) -> Result<GracefulShutdownResult, String> {
    update_attempt(slot, id, |attempt| attempt.timed_out = true)?;
    read_attempt(slot, id, |attempt| {
        attempt.result(GracefulShutdownOutcome::TimedOut)
    })
}

fn read_attempt<T>(
    slot: &ShutdownSlot,
    id: &str,
    read: impl FnOnce(&ShutdownAttempt) -> T,
) -> Result<T, String> {
    let attempt = slot
        .attempt
        .lock()
        .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
    attempt
        .as_ref()
        .map(read)
        .ok_or_else(|| format!("PTY '{id}' shutdown attempt was cancelled"))
}

fn update_attempt(
    slot: &ShutdownSlot,
    id: &str,
    update: impl FnOnce(&mut ShutdownAttempt),
) -> Result<(), String> {
    let mut attempt = slot
        .attempt
        .lock()
        .map_err(|error| format!("Failed to lock shutdown state for '{id}': {error}"))?;
    let attempt = attempt
        .as_mut()
        .ok_or_else(|| format!("PTY '{id}' shutdown attempt was cancelled"))?;
    update(attempt);
    Ok(())
}

async fn write_control(session: &PtySession, id: &str, data: Vec<u8>) -> Result<(), String> {
    let (completion, completed) = tokio::sync::oneshot::channel();
    session
        .input_tx
        .send(PtyInputRequest { data, completion })
        .await
        .map_err(|_| format!("PTY input writer for '{id}' is unavailable"))?;
    completed.await.map_err(|_| {
        format!("PTY input writer for '{id}' stopped before shutdown input completed")
    })?
}

async fn sleep_until_or_deadline(duration: Duration, deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        tokio::time::sleep(duration.min(remaining)).await;
    }
}

fn provider_exit_writes(profile: GracefulShutdownProfile) -> &'static [&'static [u8]] {
    const EXIT: &[u8] = b"/exit";
    const QUIT: &[u8] = b"/quit";
    const ENTER: &[u8] = b"\r";
    const EOF: &[u8] = &[0x04];
    match profile {
        GracefulShutdownProfile::Gemini => &[QUIT, ENTER],
        GracefulShutdownProfile::Kimi => &[EOF, EOF],
        // Generic sessions cannot assume a Provider slash command. Two EOFs
        // cover CLIs such as Kimi that require confirmation; the process-tree
        // refresh before every write prevents the second EOF from leaking into
        // the shell when the foreground process exits after the first one.
        GracefulShutdownProfile::Generic => &[EOF, EOF],
        GracefulShutdownProfile::Claude
        | GracefulShutdownProfile::Codex
        | GracefulShutdownProfile::Opencode
        | GracefulShutdownProfile::Grok => &[EXIT, ENTER],
    }
}

fn process_parent_map(system: &System) -> HashMap<u32, u32> {
    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .parent()
                .map(|parent| (pid.as_u32(), parent.as_u32()))
        })
        .collect()
}

fn descendant_pids(root_pid: u32, parents: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut descendants = HashSet::new();
    loop {
        let before = descendants.len();
        for (&pid, &parent) in parents {
            if parent == root_pid || descendants.contains(&parent) {
                descendants.insert(pid);
            }
        }
        if descendants.len() == before {
            return descendants;
        }
    }
}

struct ProcessTreeWait {
    tracked: HashSet<u32>,
    timed_out: bool,
}

fn wait_for_descendants(
    id: &str,
    root_pid: u32,
    mut tracked: HashSet<u32>,
    deadline: Instant,
) -> ProcessTreeWait {
    let mut system = System::new_all();
    loop {
        if !registry::contains(id) {
            return ProcessTreeWait {
                tracked,
                timed_out: false,
            };
        }
        system.refresh_processes();
        let parents = process_parent_map(&system);
        let alive = system
            .processes()
            .keys()
            .map(|pid| pid.as_u32())
            .collect::<HashSet<_>>();
        tracked.extend(descendant_pids(root_pid, &parents));
        tracked.retain(|pid| alive.contains(pid));
        if !alive.contains(&root_pid) || tracked.is_empty() {
            return ProcessTreeWait {
                tracked,
                timed_out: false,
            };
        }
        if Instant::now() >= deadline {
            return ProcessTreeWait {
                tracked,
                timed_out: true,
            };
        }
        std::thread::sleep(
            PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;

    const REAL_SMOKE_PROVIDER_ENV: &str = "THREADTERM_GRACEFUL_SHUTDOWN_SMOKE_PROVIDER";
    const REAL_SMOKE_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
    const REAL_SMOKE_READY_TIMEOUT: Duration = Duration::from_secs(30);
    const REAL_SMOKE_OUTPUT_TAIL_BYTES: usize = 4_096;
    const REAL_SMOKE_MAX_SHUTDOWN_WINDOWS: u8 = 6;

    struct RealSmokeChild {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        root_pid: u32,
        armed: bool,
    }

    impl RealSmokeChild {
        fn new(child: Box<dyn portable_pty::Child + Send + Sync>, root_pid: u32) -> Self {
            Self {
                child,
                root_pid,
                armed: true,
            }
        }

        fn disarm(&mut self) {
            self.armed = false;
        }
    }

    impl Drop for RealSmokeChild {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }

            let mut system = System::new_all();
            system.refresh_processes();
            let parents = process_parent_map(&system);
            for pid in descendant_pids(self.root_pid, &parents) {
                if let Some(process) = system.process(sysinfo::Pid::from_u32(pid)) {
                    let _ = process.kill();
                }
            }
            let _ = self.child.kill();
        }
    }

    fn real_smoke_provider() -> Result<(GracefulShutdownProfile, &'static str), String> {
        let provider = std::env::var(REAL_SMOKE_PROVIDER_ENV).map_err(|_| {
            format!(
                "set {REAL_SMOKE_PROVIDER_ENV} to claude, codex, opencode, gemini, kimi, generic-kimi, or grok"
            )
        })?;
        match provider.trim().to_ascii_lowercase().as_str() {
            "claude" => Ok((GracefulShutdownProfile::Claude, "claude")),
            "codex" => Ok((GracefulShutdownProfile::Codex, "codex")),
            "opencode" => Ok((GracefulShutdownProfile::Opencode, "opencode")),
            "gemini" => Ok((GracefulShutdownProfile::Gemini, "gemini")),
            "kimi" => Ok((GracefulShutdownProfile::Kimi, "kimi")),
            // Exercises a Provider launched from a shell/custom-command card,
            // where the frontend must deliberately use the generic profile.
            "generic-kimi" => Ok((GracefulShutdownProfile::Generic, "kimi")),
            "grok" => Ok((GracefulShutdownProfile::Grok, "grok")),
            unsupported => Err(format!(
                "unsupported {REAL_SMOKE_PROVIDER_ENV} value '{unsupported}'"
            )),
        }
    }

    fn current_descendants(root_pid: u32) -> HashSet<u32> {
        let mut system = System::new_all();
        system.refresh_processes();
        descendant_pids(root_pid, &process_parent_map(&system))
    }

    fn alive_pids(pids: &HashSet<u32>) -> HashSet<u32> {
        let mut system = System::new_all();
        system.refresh_processes();
        pids.iter()
            .copied()
            .filter(|pid| system.process(sysinfo::Pid::from_u32(*pid)).is_some())
            .collect()
    }

    fn describe_pids(pids: &HashSet<u32>) -> Vec<String> {
        let mut system = System::new_all();
        system.refresh_processes();
        let mut descriptions = pids
            .iter()
            .filter_map(|pid| {
                system.process(sysinfo::Pid::from_u32(*pid)).map(|process| {
                    format!(
                        "{pid}: name={:?} parent={:?} status={:?} exe={:?} cmd={:?}",
                        process.name(),
                        process.parent().map(|parent| parent.as_u32()),
                        process.status(),
                        process.exe(),
                        process.cmd()
                    )
                })
            })
            .collect::<Vec<_>>();
        descriptions.sort();
        descriptions
    }

    fn output_tail(output: &Arc<Mutex<Vec<u8>>>) -> String {
        let output = output.lock().expect("lock real smoke output");
        let start = output.len().saturating_sub(REAL_SMOKE_OUTPUT_TAIL_BYTES);
        String::from_utf8_lossy(&output[start..]).into_owned()
    }

    fn wait_for_output(output: &Arc<Mutex<Vec<u8>>>, needle: &[u8], deadline: Instant) -> bool {
        while Instant::now() < deadline {
            let found = output
                .lock()
                .expect("lock real smoke output")
                .windows(needle.len())
                .any(|window| window == needle);
            if found {
                return true;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        false
    }

    fn wait_for_provider_process(
        root_pid: u32,
        baseline: &HashSet<u32>,
        deadline: Instant,
    ) -> HashSet<u32> {
        let mut observed = HashSet::new();
        while Instant::now() < deadline {
            let current = current_descendants(root_pid);
            observed.extend(current.difference(baseline).copied());
            if !observed.is_empty() {
                return observed;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        observed
    }

    fn run_real_provider_smoke() -> Result<(), String> {
        let (profile, command) = real_smoke_provider()?;
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("open real smoke PTY: {error}"))?;

        let shell = super::super::shell::default_shell();
        let mut shell_command = CommandBuilder::new(&shell);
        let working_dir = std::env::current_dir()
            .map_err(|error| format!("resolve real smoke working directory: {error}"))?;
        #[cfg(target_os = "windows")]
        shell_command.cwd(super::super::shell::normalize_windows_cwd(
            &working_dir.to_string_lossy(),
        ));
        #[cfg(not(target_os = "windows"))]
        shell_command.cwd(&working_dir);
        super::super::shell::configure_shell_command(&mut shell_command, &shell);
        if profile == GracefulShutdownProfile::Opencode {
            // Keep the smoke deterministic without changing user settings or
            // starting configured third-party MCP daemons. Provider-core PTY
            // lifecycle is the acceptance boundary; plugin persistence keeps
            // the normal timeout/explicit-force behavior.
            shell_command.env("OPENCODE_DISABLE_AUTOUPDATE", "1");
            shell_command.env("OPENCODE_PURE", "1");
        }

        let child = pair
            .slave
            .spawn_command(shell_command)
            .map_err(|error| format!("spawn real smoke shell '{shell}': {error}"))?;
        let root_pid = child
            .process_id()
            .ok_or_else(|| "real smoke shell did not expose a process id".to_string())?;
        let mut child = RealSmokeChild::new(child, root_pid);
        drop(pair.slave);

        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("open real smoke PTY writer: {error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("open real smoke PTY reader: {error}"))?;
        let master = pair.master;

        let output = Arc::new(Mutex::new(Vec::new()));
        let output_for_reader = output.clone();
        let (reader_finished_tx, reader_finished_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buffer = [0_u8; 8_192];
            let result = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break Ok(()),
                    Ok(read) => {
                        let mut output = output_for_reader
                            .lock()
                            .expect("lock real smoke reader output");
                        output.extend_from_slice(&buffer[..read]);
                        if output.len() > REAL_SMOKE_OUTPUT_TAIL_BYTES * 2 {
                            let drain = output.len() - REAL_SMOKE_OUTPUT_TAIL_BYTES;
                            output.drain(..drain);
                        }
                    }
                    Err(error) => break Err(error.to_string()),
                }
            };
            let _ = reader_finished_tx.send(result);
        });

        thread::sleep(Duration::from_millis(750));
        let baseline = current_descendants(root_pid);
        writer
            .write_all(format!("{command}\r").as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("start real smoke provider '{command}': {error}"))?;

        let provider_pids = wait_for_provider_process(
            root_pid,
            &baseline,
            Instant::now() + REAL_SMOKE_STARTUP_TIMEOUT,
        );
        if provider_pids.is_empty() {
            return Err(format!(
                "provider '{command}' did not start a child process within {:?}; output tail:\n{}",
                REAL_SMOKE_STARTUP_TIMEOUT,
                output_tail(&output)
            ));
        }

        // Let the interactive CLI finish drawing its first prompt. OpenCode
        // starts configured MCP servers after its process appears, so its
        // visible prompt is the reliable readiness boundary. No model request
        // is sent; the only following bytes are the production exit protocol
        // and the shell's normal `exit` command.
        if profile == GracefulShutdownProfile::Opencode
            && !wait_for_output(
                &output,
                b"Ask anything",
                Instant::now() + REAL_SMOKE_READY_TIMEOUT,
            )
        {
            return Err(format!(
                "provider '{command}' did not reach its interactive prompt within {:?}; output tail:\n{}",
                REAL_SMOKE_READY_TIMEOUT,
                output_tail(&output)
            ));
        }
        thread::sleep(Duration::from_secs(2));
        let shutdown_started = Instant::now();
        let mut shutdown_deadline = shutdown_started + GRACEFUL_SHUTDOWN_WINDOW;
        let mut shutdown_windows = 1_u8;
        let mut tracked = current_descendants(root_pid);

        if !tracked.is_empty() {
            writer
                .write_all(&[0x03])
                .and_then(|_| writer.flush())
                .map_err(|error| format!("interrupt real smoke provider '{command}': {error}"))?;
            thread::sleep(INTERRUPT_SETTLE_DELAY);
            for (index, write) in provider_exit_writes(profile).iter().enumerate() {
                let current = current_descendants(root_pid);
                tracked.extend(current.iter().copied());
                if current.is_empty() {
                    break;
                }
                writer
                    .write_all(write)
                    .and_then(|_| writer.flush())
                    .map_err(|error| format!("send exit protocol to '{command}': {error}"))?;
                if index + 1 < provider_exit_writes(profile).len() {
                    let delay = if matches!(
                        profile,
                        GracefulShutdownProfile::Kimi | GracefulShutdownProfile::Generic
                    ) {
                        KIMI_EOF_DELAY
                    } else {
                        PROVIDER_INPUT_DELAY
                    };
                    thread::sleep(delay);
                }
            }
        }

        loop {
            while Instant::now() < shutdown_deadline {
                tracked.extend(current_descendants(root_pid));
                tracked = alive_pids(&tracked);
                if tracked.is_empty() {
                    break;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            if tracked.is_empty() || shutdown_windows == REAL_SMOKE_MAX_SHUTDOWN_WINDOWS {
                break;
            }

            // Mirrors the timeout dialog's "wait another 5 seconds" action:
            // the authoritative attempt gets a fresh window without sending
            // Ctrl+C or the Provider exit sequence a second time.
            shutdown_windows += 1;
            shutdown_deadline = Instant::now() + GRACEFUL_SHUTDOWN_WINDOW;
        }
        if !tracked.is_empty() {
            return Err(format!(
                "provider '{command}' left descendants {tracked:?} after {shutdown_windows} shutdown windows: {:?}; output tail:\n{}",
                describe_pids(&tracked),
                output_tail(&output)
            ));
        }

        let mut exit_status = child
            .child
            .try_wait()
            .map_err(|error| format!("poll real smoke shell '{shell}': {error}"))?;
        let exit_write_error = if exit_status.is_none() {
            writer
                .write_all(b"exit\r")
                .and_then(|_| writer.flush())
                .err()
        } else {
            None
        };
        let writer_guard = if exit_write_error.is_some() {
            drop(writer);
            None
        } else {
            Some(writer)
        };

        loop {
            while Instant::now() < shutdown_deadline {
                exit_status = child
                    .child
                    .try_wait()
                    .map_err(|error| format!("poll real smoke shell '{shell}': {error}"))?;
                if exit_status.is_some() {
                    break;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            if exit_status.is_some() || shutdown_windows == REAL_SMOKE_MAX_SHUTDOWN_WINDOWS {
                break;
            }

            // Continue the same authoritative attempt without replaying the
            // shell exit write. This mirrors the timeout dialog's wait action.
            shutdown_windows += 1;
            shutdown_deadline = Instant::now() + GRACEFUL_SHUTDOWN_WINDOW;
        }
        let Some(exit_status) = exit_status else {
            if let Some(error) = exit_write_error {
                return Err(format!(
                    "exit real smoke shell '{shell}' failed before the shell remained alive: {error}; output tail:\n{}",
                    output_tail(&output)
                ));
            }
            return Err(format!(
                "shell '{shell}' did not exit inside the shared {:?} shutdown window; output tail:\n{}",
                GRACEFUL_SHUTDOWN_WINDOW,
                output_tail(&output)
            ));
        };

        drop(master);
        let reader_result = loop {
            let remaining = shutdown_deadline.saturating_duration_since(Instant::now());
            match reader_finished_rx.recv_timeout(remaining) {
                Ok(result) => break result,
                Err(mpsc::RecvTimeoutError::Timeout)
                    if shutdown_windows < REAL_SMOKE_MAX_SHUTDOWN_WINDOWS =>
                {
                    shutdown_windows += 1;
                    shutdown_deadline = Instant::now() + GRACEFUL_SHUTDOWN_WINDOW;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "PTY reader did not observe EOF after {shutdown_windows} shutdown windows"
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("real smoke PTY reader completion channel closed".to_string());
                }
            }
        };
        drop(writer_guard);
        reader_result.map_err(|error| format!("real smoke PTY reader failed: {error}"))?;
        let remaining = alive_pids(&provider_pids);
        if !remaining.is_empty() {
            return Err(format!(
                "provider '{command}' left observed processes alive after PTY EOF: {remaining:?}"
            ));
        }

        child.disarm();
        println!(
            "real graceful shutdown smoke passed: provider={command} profile={profile:?} root_pid={root_pid} provider_pids={provider_pids:?} shell_status={exit_status} windows={shutdown_windows} elapsed={:?}",
            shutdown_started.elapsed()
        );
        Ok(())
    }

    #[test]
    fn provider_profiles_use_documented_exit_sequences() {
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Claude),
            &[b"/exit".as_slice(), b"\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Codex),
            &[b"/exit".as_slice(), b"\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Opencode),
            &[b"/exit".as_slice(), b"\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Gemini),
            &[b"/quit".as_slice(), b"\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Kimi),
            &[&[0x04], &[0x04]]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Grok),
            &[b"/exit".as_slice(), b"\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Generic),
            &[&[0x04], &[0x04]]
        );
    }

    #[test]
    fn descendant_collection_follows_multiple_generations() {
        let parents = HashMap::from([(11, 10), (12, 11), (13, 12), (99, 1)]);
        assert_eq!(descendant_pids(10, &parents), HashSet::from([11, 12, 13]));
    }

    #[test]
    fn shutdown_stage_never_regresses_after_control_writes() {
        let mut attempt =
            ShutdownAttempt::new("attempt-1".to_string(), GracefulShutdownProfile::Codex);
        assert_eq!(attempt.stage(), GracefulShutdownStage::Interrupt);
        attempt.interrupt_sent = true;
        assert_eq!(attempt.stage(), GracefulShutdownStage::AgentExit);
        attempt.agent_exit_writes_sent = 1;
        assert_eq!(attempt.stage(), GracefulShutdownStage::AgentExit);
        attempt.shell_exit_sent = true;
        assert_eq!(attempt.stage(), GracefulShutdownStage::ShellExit);
    }

    #[test]
    fn empty_agent_snapshot_skips_every_remaining_provider_write() {
        let mut attempt =
            ShutdownAttempt::new("attempt-1".to_string(), GracefulShutdownProfile::Kimi);
        let write_count = provider_exit_writes(attempt.profile).len();

        attempt.observe_agent_descendants(&HashSet::new(), write_count);

        assert!(attempt.interrupt_sent);
        assert_eq!(attempt.agent_exit_writes_sent, write_count);
        assert_eq!(attempt.stage(), GracefulShutdownStage::AgentExit);
    }

    #[test]
    fn live_agent_snapshot_tracks_process_without_advancing_shutdown() {
        let mut attempt =
            ShutdownAttempt::new("attempt-1".to_string(), GracefulShutdownProfile::Kimi);
        let current = HashSet::from([41, 42]);
        let write_count = provider_exit_writes(attempt.profile).len();

        attempt.observe_agent_descendants(&current, write_count);

        assert_eq!(attempt.tracked_descendants, current);
        assert!(!attempt.interrupt_sent);
        assert_eq!(attempt.agent_exit_writes_sent, 0);
        assert_eq!(attempt.stage(), GracefulShutdownStage::Interrupt);
    }

    #[test]
    fn timeout_does_not_mark_force_or_completion() {
        let mut attempt =
            ShutdownAttempt::new("attempt-1".to_string(), GracefulShutdownProfile::Generic);
        attempt.interrupt_sent = true;
        attempt.agent_exit_writes_sent = 1;
        attempt.timed_out = true;
        let result = attempt.result(GracefulShutdownOutcome::TimedOut);
        assert_eq!(result.outcome, GracefulShutdownOutcome::TimedOut);
        assert_eq!(result.stage, GracefulShutdownStage::AgentExit);
        assert!(!attempt.shell_exit_sent);
    }

    #[tokio::test]
    async fn ordinary_input_is_rejected_during_an_active_shutdown() {
        let id = "test-active-input";
        let slot = slot_for(id);
        *slot.attempt.lock().expect("lock attempt") = Some(ShutdownAttempt::new(
            "attempt-active".to_string(),
            GracefulShutdownProfile::Codex,
        ));

        let error = prepare_for_user_input(id)
            .await
            .expect_err("active shutdown must own PTY input");
        assert!(error.contains("ending gracefully"));
        assert!(existing_slot(id).is_some());
        forget(id);
    }

    #[tokio::test]
    async fn ordinary_input_cancels_a_paused_timeout_attempt() {
        let id = "test-timeout-input";
        let slot = slot_for(id);
        let mut attempt = ShutdownAttempt::new(
            "attempt-timeout".to_string(),
            GracefulShutdownProfile::Generic,
        );
        attempt.timed_out = true;
        *slot.attempt.lock().expect("lock attempt") = Some(attempt);

        let permit = prepare_for_user_input(id)
            .await
            .expect("timed-out attempt should yield to user input");
        assert!(slot.attempt.lock().expect("lock attempt").is_none());
        assert!(slot.operation.try_lock().is_err());
        drop(permit);
        assert!(slot.operation.try_lock().is_ok());
        forget(id);
    }

    #[tokio::test]
    async fn cancellation_requires_the_authoritative_attempt_id() {
        let id = "test-cancel-attempt";
        let slot = slot_for(id);
        let mut attempt = ShutdownAttempt::new(
            "attempt-authoritative".to_string(),
            GracefulShutdownProfile::Gemini,
        );
        attempt.timed_out = true;
        *slot.attempt.lock().expect("lock attempt") = Some(attempt);

        assert!(
            !cancel_graceful_shutdown(id.to_string(), "attempt-other".to_string())
                .await
                .expect("wrong attempt should be ignored")
        );
        assert!(existing_slot(id).is_some());
        assert!(
            cancel_graceful_shutdown(id.to_string(), "attempt-authoritative".to_string())
                .await
                .expect("authoritative cancellation should succeed")
        );
        assert!(slot.attempt.lock().expect("lock attempt").is_none());
        forget(id);
    }

    #[test]
    #[ignore = "requires an installed, authenticated interactive Provider CLI"]
    fn real_provider_exits_before_shell_and_pty_eof() {
        run_real_provider_smoke().expect("real Provider graceful shutdown smoke");
    }
}
