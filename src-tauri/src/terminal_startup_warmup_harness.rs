//! Feature-only, privacy-safe observability for real ConPTY warmup fixtures.
//!
//! The production warmup remains in `pty::warmup`.  This module owns only a
//! closed scenario selector, process-local lifecycle state, and read-only
//! count/status projections for the non-shipping Windows WebDriver build.

use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const SCENARIO_ENV: &str = "THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO";
const HOLD_LIMIT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WarmupScenario {
    Disabled,
    Normal,
    SpawnFailure,
    NeverExit,
    HoldBeforeGrace,
    HoldBeforeNativeSpawn,
}

impl WarmupScenario {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("disabled") => Self::Disabled,
            Some("normal") => Self::Normal,
            Some("spawnFailure") => Self::SpawnFailure,
            Some("neverExit") => Self::NeverExit,
            Some("holdBeforeGrace") => Self::HoldBeforeGrace,
            Some("holdBeforeNativeSpawn") => Self::HoldBeforeNativeSpawn,
            // Missing, empty, non-UTF-8, and unknown values all fail closed.
            _ => Self::Disabled,
        }
    }

    fn from_process_env() -> Self {
        Self::parse(std::env::var(SCENARIO_ENV).ok().as_deref())
    }

    fn is_enabled(self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WarmupHarnessStatus {
    Disabled,
    Spawning,
    Waiting,
    Completed,
    Failed,
    TimedOut,
    SkippedForRealCreate,
    HoldEntered,
    HoldReleased,
    HoldBeforeGraceEntered,
    HoldBeforeGraceReleased,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmupHarnessCounters {
    pub(crate) starts: u32,
    pub(crate) real_create_seen: u32,
    pub(crate) native_spawn_attempted: u32,
    pub(crate) child_spawned: u32,
    pub(crate) skipped_for_real_create: u32,
    pub(crate) hold_wait_timed_out: u32,
    pub(crate) hold_before_grace_wait_timed_out: u32,
    pub(crate) kill_attempted: u32,
    pub(crate) reap_confirmed: u32,
    pub(crate) reap_timed_out: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmupHarnessSnapshot {
    pub(crate) enabled: bool,
    pub(crate) scenario: WarmupScenario,
    pub(crate) status: WarmupHarnessStatus,
    pub(crate) hold_entered: bool,
    pub(crate) hold_released: bool,
    pub(crate) hold_timed_out: bool,
    pub(crate) hold_before_grace_entered: bool,
    pub(crate) hold_before_grace_released: bool,
    pub(crate) hold_before_grace_timed_out: bool,
    pub(crate) real_create_seen: bool,
    pub(crate) counters: WarmupHarnessCounters,
}

#[derive(Debug)]
struct WarmupHarnessState {
    scenario: WarmupScenario,
    status: WarmupHarnessStatus,
    started: bool,
    hold_entered: bool,
    hold_released: bool,
    hold_timed_out: bool,
    hold_before_grace_entered: bool,
    hold_before_grace_released: bool,
    hold_before_grace_timed_out: bool,
    real_create_seen: bool,
    counters: WarmupHarnessCounters,
}

impl WarmupHarnessState {
    fn new(scenario: WarmupScenario) -> Self {
        let enabled = cfg!(target_os = "windows") && scenario.is_enabled();
        Self {
            scenario,
            status: if enabled {
                WarmupHarnessStatus::Waiting
            } else {
                WarmupHarnessStatus::Disabled
            },
            started: false,
            hold_entered: false,
            hold_released: false,
            hold_timed_out: false,
            hold_before_grace_entered: false,
            hold_before_grace_released: false,
            hold_before_grace_timed_out: false,
            real_create_seen: false,
            counters: WarmupHarnessCounters::default(),
        }
    }

    fn enabled(&self) -> bool {
        cfg!(target_os = "windows") && self.scenario.is_enabled()
    }

    fn snapshot(&self) -> WarmupHarnessSnapshot {
        WarmupHarnessSnapshot {
            enabled: self.enabled(),
            scenario: self.scenario,
            status: self.status,
            hold_entered: self.hold_entered,
            hold_released: self.hold_released,
            hold_timed_out: self.hold_timed_out,
            hold_before_grace_entered: self.hold_before_grace_entered,
            hold_before_grace_released: self.hold_before_grace_released,
            hold_before_grace_timed_out: self.hold_before_grace_timed_out,
            real_create_seen: self.real_create_seen,
            counters: self.counters,
        }
    }
}

struct WarmupHarnessCoordinator {
    state: Mutex<WarmupHarnessState>,
    wake: Condvar,
}

impl WarmupHarnessCoordinator {
    fn new(scenario: WarmupScenario) -> Self {
        Self {
            state: Mutex::new(WarmupHarnessState::new(scenario)),
            wake: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WarmupHarnessState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn wait_for_hold_release_until(&self, deadline: Instant) -> bool {
        let mut state = self.lock();
        while state.hold_entered && !state.hold_released {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.hold_timed_out = true;
                state.status = WarmupHarnessStatus::TimedOut;
                state.counters.hold_wait_timed_out =
                    state.counters.hold_wait_timed_out.saturating_add(1);
                self.wake.notify_all();
                return false;
            }
            let (next, timeout) = self
                .wake
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if timeout.timed_out() && state.hold_entered && !state.hold_released {
                state.hold_timed_out = true;
                state.status = WarmupHarnessStatus::TimedOut;
                state.counters.hold_wait_timed_out =
                    state.counters.hold_wait_timed_out.saturating_add(1);
                self.wake.notify_all();
                return false;
            }
        }
        state.hold_released
    }

    fn wait_for_hold_before_grace_release_until(&self, deadline: Instant) -> bool {
        let mut state = self.lock();
        while state.hold_before_grace_entered && !state.hold_before_grace_released {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.hold_before_grace_timed_out = true;
                state.status = WarmupHarnessStatus::TimedOut;
                state.counters.hold_before_grace_wait_timed_out = state
                    .counters
                    .hold_before_grace_wait_timed_out
                    .saturating_add(1);
                self.wake.notify_all();
                return false;
            }
            let (next, timeout) = self
                .wake
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if timeout.timed_out()
                && state.hold_before_grace_entered
                && !state.hold_before_grace_released
            {
                state.hold_before_grace_timed_out = true;
                state.status = WarmupHarnessStatus::TimedOut;
                state.counters.hold_before_grace_wait_timed_out = state
                    .counters
                    .hold_before_grace_wait_timed_out
                    .saturating_add(1);
                self.wake.notify_all();
                return false;
            }
        }
        state.hold_before_grace_released
    }
}

static SCENARIO: OnceLock<WarmupScenario> = OnceLock::new();
static COORDINATOR: OnceLock<Arc<WarmupHarnessCoordinator>> = OnceLock::new();

fn coordinator() -> Arc<WarmupHarnessCoordinator> {
    COORDINATOR
        .get_or_init(|| Arc::new(WarmupHarnessCoordinator::new(configured_scenario())))
        .clone()
}

pub(crate) fn configured_scenario() -> WarmupScenario {
    *SCENARIO.get_or_init(WarmupScenario::from_process_env)
}

/// Whether the feature-only scenario should implicitly start the production
/// warmup worker.  Feature-off builds never compile this module.
pub(crate) fn scenario_enables_warmup() -> bool {
    cfg!(target_os = "windows") && configured_scenario().is_enabled()
}

/// Mark the one-shot warmup worker as started.  The caller still owns thread
/// creation; `false` means a repeated start request must be ignored.
pub(crate) fn begin() -> bool {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled() || state.started {
        return false;
    }
    state.started = true;
    state.counters.starts = state.counters.starts.saturating_add(1);
    true
}

pub(crate) fn snapshot() -> WarmupHarnessSnapshot {
    coordinator().lock().snapshot()
}

pub(crate) fn record_real_create_seen() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled() {
        return;
    }
    if !state.real_create_seen {
        state.real_create_seen = true;
        state.counters.real_create_seen = state.counters.real_create_seen.saturating_add(1);
    }
    coordinator.wake.notify_all();
}

pub(crate) fn record_worker_spawn_failure() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if state.enabled() {
        state.status = WarmupHarnessStatus::Failed;
        coordinator.wake.notify_all();
    }
}

pub(crate) fn record_skipped_for_real_create() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if state.enabled() {
        state.status = WarmupHarnessStatus::SkippedForRealCreate;
        state.counters.skipped_for_real_create =
            state.counters.skipped_for_real_create.saturating_add(1);
        coordinator.wake.notify_all();
    }
}

pub(crate) fn record_native_spawn_attempt() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if state.enabled() {
        state.status = WarmupHarnessStatus::Spawning;
        state.counters.native_spawn_attempted =
            state.counters.native_spawn_attempted.saturating_add(1);
    }
}

pub(crate) fn record_child_spawned() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if state.enabled() {
        state.status = WarmupHarnessStatus::Waiting;
        state.counters.child_spawned = state.counters.child_spawned.saturating_add(1);
    }
}

pub(crate) fn record_reap(
    status: WarmupHarnessStatus,
    kill_attempted: bool,
    reap_confirmed: bool,
    reap_timed_out: bool,
) {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled() {
        return;
    }
    state.status = apply_reap_evidence(
        &mut state.counters,
        status,
        kill_attempted,
        reap_confirmed,
        reap_timed_out,
    );
    coordinator.wake.notify_all();
}

fn apply_reap_evidence(
    counters: &mut WarmupHarnessCounters,
    status: WarmupHarnessStatus,
    kill_attempted: bool,
    reap_confirmed: bool,
    reap_timed_out: bool,
) -> WarmupHarnessStatus {
    if kill_attempted {
        counters.kill_attempted = counters.kill_attempted.saturating_add(1);
    }
    if reap_confirmed {
        counters.reap_confirmed = counters.reap_confirmed.saturating_add(1);
    }
    if reap_timed_out {
        counters.reap_timed_out = counters.reap_timed_out.saturating_add(1);
    }
    status
}

pub(crate) fn record_native_spawn_failure() {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if state.enabled() {
        state.status = WarmupHarnessStatus::Failed;
        coordinator.wake.notify_all();
    }
}

pub(crate) fn should_fail_spawn() -> bool {
    matches!(configured_scenario(), WarmupScenario::SpawnFailure)
}

pub(crate) fn should_never_exit() -> bool {
    matches!(configured_scenario(), WarmupScenario::NeverExit)
}

pub(crate) fn should_hold_before_native_spawn() -> bool {
    matches!(configured_scenario(), WarmupScenario::HoldBeforeNativeSpawn)
}

pub(crate) fn should_hold_before_grace() -> bool {
    matches!(configured_scenario(), WarmupScenario::HoldBeforeGrace)
}

/// Enter a distinct hold point before the production 250 ms grace begins.
/// This is intentionally separate from the native-spawn hold so snapshots
/// cannot conflate the two race windows.
pub(crate) fn enter_hold_before_grace() -> bool {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled()
        || !matches!(state.scenario, WarmupScenario::HoldBeforeGrace)
        || state.hold_before_grace_entered
        || state.hold_before_grace_released
    {
        return false;
    }
    state.hold_before_grace_entered = true;
    state.status = WarmupHarnessStatus::HoldBeforeGraceEntered;
    coordinator.wake.notify_all();
    true
}

pub(crate) fn wait_for_hold_before_grace_release() -> bool {
    let coordinator = coordinator();
    coordinator.wait_for_hold_before_grace_release_until(Instant::now() + HOLD_LIMIT)
}

/// Enter the hold point after the idle grace and before `openpty`/native
/// spawn.  This function never touches the production PTY spawn lock.
pub(crate) fn enter_hold() -> bool {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled()
        || !matches!(state.scenario, WarmupScenario::HoldBeforeNativeSpawn)
        || state.hold_entered
        || state.hold_released
    {
        return false;
    }
    state.hold_entered = true;
    state.status = WarmupHarnessStatus::HoldEntered;
    coordinator.wake.notify_all();
    true
}

pub(crate) fn wait_for_hold_release() -> bool {
    let coordinator = coordinator();
    coordinator.wait_for_hold_release_until(Instant::now() + HOLD_LIMIT)
}

fn release_hold() -> Result<WarmupHarnessSnapshot, WarmupHarnessError> {
    let coordinator = coordinator();
    let mut state = coordinator.lock();
    if !state.enabled() {
        return Err(WarmupHarnessError::new(
            WarmupHarnessErrorCode::NotHoldScenario,
        ));
    }
    match state.scenario {
        WarmupScenario::HoldBeforeGrace => {
            if !state.hold_before_grace_entered {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::HoldBeforeGraceNotEntered,
                ));
            }
            if state.hold_before_grace_timed_out {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::HoldBeforeGraceTimedOut,
                ));
            }
            if state.hold_before_grace_released {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::HoldBeforeGraceAlreadyReleased,
                ));
            }
            state.hold_before_grace_released = true;
            state.status = WarmupHarnessStatus::HoldBeforeGraceReleased;
        }
        WarmupScenario::HoldBeforeNativeSpawn => {
            if !state.hold_entered {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::HoldNotEntered,
                ));
            }
            if state.hold_timed_out {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::HoldTimedOut,
                ));
            }
            if state.hold_released {
                return Err(WarmupHarnessError::new(
                    WarmupHarnessErrorCode::AlreadyReleased,
                ));
            }
            state.hold_released = true;
            state.status = WarmupHarnessStatus::HoldReleased;
        }
        _ => {
            return Err(WarmupHarnessError::new(
                WarmupHarnessErrorCode::NotHoldScenario,
            ));
        }
    }
    let snapshot = state.snapshot();
    coordinator.wake.notify_all();
    Ok(snapshot)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WarmupHarnessErrorCode {
    NotHoldScenario,
    HoldNotEntered,
    HoldTimedOut,
    AlreadyReleased,
    HoldBeforeGraceNotEntered,
    HoldBeforeGraceTimedOut,
    HoldBeforeGraceAlreadyReleased,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmupHarnessError {
    pub(crate) code: WarmupHarnessErrorCode,
}

impl WarmupHarnessError {
    const fn new(code: WarmupHarnessErrorCode) -> Self {
        Self { code }
    }
}

#[tauri::command]
pub(crate) fn terminal_startup_harness_warmup_snapshot() -> WarmupHarnessSnapshot {
    snapshot()
}

#[tauri::command]
pub(crate) fn terminal_startup_harness_warmup_release(
) -> Result<WarmupHarnessSnapshot, WarmupHarnessError> {
    release_hold()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_parser_is_closed_and_missing_values_fail_closed() {
        assert_eq!(WarmupScenario::parse(None), WarmupScenario::Disabled);
        assert_eq!(WarmupScenario::parse(Some("")), WarmupScenario::Disabled);
        assert_eq!(
            WarmupScenario::parse(Some("normal")),
            WarmupScenario::Normal
        );
        assert_eq!(
            WarmupScenario::parse(Some("spawnFailure")),
            WarmupScenario::SpawnFailure
        );
        assert_eq!(
            WarmupScenario::parse(Some("neverExit")),
            WarmupScenario::NeverExit
        );
        assert_eq!(
            WarmupScenario::parse(Some("holdBeforeGrace")),
            WarmupScenario::HoldBeforeGrace
        );
        assert_eq!(
            WarmupScenario::parse(Some("holdBeforeNativeSpawn")),
            WarmupScenario::HoldBeforeNativeSpawn
        );
        for value in ["Normal", "spawnfailure", "true", "normal ", "unknown"] {
            assert_eq!(WarmupScenario::parse(Some(value)), WarmupScenario::Disabled);
        }
    }

    #[test]
    fn snapshot_contains_only_safe_status_and_counts() {
        let state = WarmupHarnessState::new(WarmupScenario::NeverExit);
        let value = serde_json::to_value(state.snapshot()).unwrap();
        assert_eq!(value["scenario"], "neverExit");
        assert_eq!(
            value["status"],
            if cfg!(target_os = "windows") {
                "waiting"
            } else {
                "disabled"
            }
        );
        let encoded = serde_json::to_string(&value).unwrap();
        for forbidden in ["path", "command", "pid", "pty", "cwd", "identity"] {
            assert!(!encoded.to_ascii_lowercase().contains(forbidden));
        }
    }

    #[test]
    fn never_exit_evidence_distinguishes_kill_reap_and_reap_timeout() {
        let mut counters = WarmupHarnessCounters::default();
        let confirmed = apply_reap_evidence(
            &mut counters,
            WarmupHarnessStatus::TimedOut,
            true,
            true,
            false,
        );
        assert_eq!(confirmed, WarmupHarnessStatus::TimedOut);
        assert_eq!(counters.kill_attempted, 1);
        assert_eq!(counters.reap_confirmed, 1);
        assert_eq!(counters.reap_timed_out, 0);

        let deadline = apply_reap_evidence(
            &mut counters,
            WarmupHarnessStatus::TimedOut,
            true,
            false,
            true,
        );
        assert_eq!(deadline, WarmupHarnessStatus::TimedOut);
        assert_eq!(counters.kill_attempted, 2);
        assert_eq!(counters.reap_confirmed, 1);
        assert_eq!(counters.reap_timed_out, 1);
    }

    #[test]
    fn hold_deadline_is_terminal_and_never_reaches_native_spawn() {
        let coordinator = WarmupHarnessCoordinator::new(WarmupScenario::HoldBeforeNativeSpawn);
        {
            let mut state = coordinator.lock();
            state.hold_entered = true;
            state.status = WarmupHarnessStatus::HoldEntered;
        }

        assert!(!coordinator.wait_for_hold_release_until(Instant::now()));
        let snapshot = coordinator.lock().snapshot();
        assert_eq!(snapshot.status, WarmupHarnessStatus::TimedOut);
        assert!(snapshot.hold_timed_out);
        assert_eq!(snapshot.counters.hold_wait_timed_out, 1);
        assert!(!snapshot.hold_released);
    }

    #[test]
    fn before_grace_hold_has_distinct_timeout_state_and_counter() {
        let coordinator = WarmupHarnessCoordinator::new(WarmupScenario::HoldBeforeGrace);
        {
            let mut state = coordinator.lock();
            state.hold_before_grace_entered = true;
            state.status = WarmupHarnessStatus::HoldBeforeGraceEntered;
        }

        assert!(!coordinator.wait_for_hold_before_grace_release_until(Instant::now()));
        let snapshot = coordinator.lock().snapshot();
        assert_eq!(snapshot.status, WarmupHarnessStatus::TimedOut);
        assert!(snapshot.hold_before_grace_timed_out);
        assert_eq!(snapshot.counters.hold_before_grace_wait_timed_out, 1);
        assert!(!snapshot.hold_timed_out);
        assert!(!snapshot.hold_released);
    }
}
