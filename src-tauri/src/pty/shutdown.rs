//! Cooperative PTY shutdown for interactive terminals.
//!
//! Shutdown state intentionally lives outside [`PtySession`]. That keeps the
//! hot PTY object and its lock graph unchanged while still serializing control
//! input for each PTY id. The existing `pty_kill` command remains the explicit
//! force path; nothing in this module escalates to it automatically.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::registry;
use super::session::{PtyInputRequest, PtySession};

const GRACEFUL_SHUTDOWN_WINDOW: Duration = Duration::from_secs(5);
const INTERRUPT_SETTLE_DELAY: Duration = Duration::from_millis(150);
const KIMI_EOF_DELAY: Duration = Duration::from_millis(100);
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

    if let Some(root_pid) = root_pid {
        let current_descendants = tokio::task::spawn_blocking(move || {
            let mut system = System::new_all();
            system.refresh_processes();
            descendant_pids(root_pid, &process_parent_map(&system))
        })
        .await
        .map_err(|error| format!("Failed to inspect PTY process tree for '{id}': {error}"))?;
        update_attempt(&slot, &id, |attempt| {
            attempt.tracked_descendants.extend(current_descendants);
        })?;
    }

    if !read_attempt(&slot, &id, |attempt| attempt.interrupt_sent)? {
        write_control(&session, &id, vec![0x03]).await?;
        update_attempt(&slot, &id, |attempt| attempt.interrupt_sent = true)?;
        sleep_until_or_deadline(INTERRUPT_SETTLE_DELAY, deadline).await;
    }

    let profile = read_attempt(&slot, &id, |attempt| attempt.profile)?;
    let writes = provider_exit_writes(profile);
    loop {
        let sent = read_attempt(&slot, &id, |attempt| attempt.agent_exit_writes_sent)?;
        let Some(write) = writes.get(sent) else {
            break;
        };
        write_control(&session, &id, write.to_vec()).await?;
        update_attempt(&slot, &id, |attempt| attempt.agent_exit_writes_sent += 1)?;
        if profile == GracefulShutdownProfile::Kimi && sent + 1 < writes.len() {
            sleep_until_or_deadline(KIMI_EOF_DELAY, deadline).await;
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

    if !read_attempt(&slot, &id, |attempt| attempt.shell_exit_sent)? {
        write_control(&session, &id, b"exit\r".to_vec()).await?;
        update_attempt(&slot, &id, |attempt| attempt.shell_exit_sent = true)?;
    }

    while Instant::now() < deadline {
        if !registry::contains(&id) {
            let result = read_attempt(&slot, &id, |attempt| {
                attempt.result(GracefulShutdownOutcome::Graceful)
            })?;
            forget(&id);
            return Ok(result);
        }
        tokio::time::sleep(
            PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }

    timeout_result(&slot, &id)
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
    const EXIT: &[u8] = b"/exit\r";
    const QUIT: &[u8] = b"/quit\r";
    const EOF: &[u8] = &[0x04];
    match profile {
        GracefulShutdownProfile::Gemini => &[QUIT],
        GracefulShutdownProfile::Kimi => &[EOF, EOF],
        GracefulShutdownProfile::Generic => &[EOF],
        GracefulShutdownProfile::Claude
        | GracefulShutdownProfile::Codex
        | GracefulShutdownProfile::Opencode
        | GracefulShutdownProfile::Grok => &[EXIT],
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

    #[test]
    fn provider_profiles_use_documented_exit_sequences() {
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Claude),
            &[b"/exit\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Codex),
            &[b"/exit\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Opencode),
            &[b"/exit\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Gemini),
            &[b"/quit\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Kimi),
            &[&[0x04], &[0x04]]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Grok),
            &[b"/exit\r".as_slice()]
        );
        assert_eq!(
            provider_exit_writes(GracefulShutdownProfile::Generic),
            &[&[0x04]]
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
}
