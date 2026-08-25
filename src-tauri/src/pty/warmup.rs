#[cfg(feature = "terminal-startup-harness")]
use crate::terminal_startup_warmup_harness as harness;
#[cfg(any(target_os = "windows", test))]
use once_cell::sync::OnceCell;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "windows", test))]
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
#[cfg(any(target_os = "windows", test))]
use std::time::{Duration, Instant};
#[cfg(any(target_os = "windows", test))]
#[path = "warmup_lifecycle.rs"]
mod lifecycle;
#[cfg(any(
    test,
    all(target_os = "windows", not(feature = "terminal-startup-harness"))
))]
pub(crate) use lifecycle::reap_with_deadlines;
#[cfg(any(test, all(target_os = "windows", feature = "terminal-startup-harness")))]
pub(crate) use lifecycle::reap_with_deadlines_observed;
#[cfg(any(target_os = "windows", test))]
pub(crate) use lifecycle::{ChildPoll, ChildProbe};
#[cfg(any(target_os = "windows", test))]
pub(super) const IDLE_GRACE: Duration = Duration::from_millis(250);
#[cfg(any(target_os = "windows", test))]
pub(super) const POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(any(target_os = "windows", test))]
pub(super) const CHILD_LIMIT: Duration = Duration::from_millis(1500);
#[cfg(any(target_os = "windows", test))]
pub(super) const REAP_LIMIT: Duration = Duration::from_millis(250);
#[cfg(any(target_os = "windows", test))]
static COORDINATOR: OnceCell<Arc<Coordinator>> = OnceCell::new();
#[cfg(target_os = "windows")]
static REAL_CREATE_SEEN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WarmupStatus {
    Skipped,
    Spawning,
    Waiting,
    Completed,
    Failed,
    TimedOut,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug)]
struct CoordinatorState {
    real_create_seen: bool,
    status: WarmupStatus,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) struct Coordinator {
    state: Mutex<CoordinatorState>,
    wake: Condvar,
}

#[cfg(any(target_os = "windows", test))]
impl Coordinator {
    pub(super) fn new(real_create_seen: bool) -> Self {
        Self {
            state: Mutex::new(CoordinatorState {
                real_create_seen,
                status: WarmupStatus::Waiting,
            }),
            wake: Condvar::new(),
        }
    }

    pub(super) fn notify_real_create(&self) {
        let mut state = self.lock_state();
        state.real_create_seen = true;
        self.wake.notify_one();
    }

    #[cfg(test)]
    pub(super) fn claim_after_grace(&self) -> bool {
        let mut state = self.lock_state();
        Self::claim_locked(&mut state)
    }

    fn wait_for_grace(&self) -> bool {
        let mut state = self.lock_state();
        let deadline = Instant::now() + IDLE_GRACE;
        loop {
            #[cfg(target_os = "windows")]
            if REAL_CREATE_SEEN.load(Ordering::SeqCst) {
                state.real_create_seen = true;
            }
            if state.real_create_seen {
                // Claim under the grace mutex to close the deadline/create race.
                return Self::claim_locked(&mut state);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Self::claim_locked(&mut state);
            }
            let (next, _) = self
                .wake
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
        }
    }

    fn claim_locked(state: &mut CoordinatorState) -> bool {
        if state.real_create_seen {
            state.status = WarmupStatus::Skipped;
            false
        } else {
            state.status = WarmupStatus::Spawning;
            true
        }
    }

    pub(crate) fn set_status(&self, status: WarmupStatus) {
        let mut state = self.lock_state();
        state.status = status;
    }

    #[cfg(test)]
    pub(super) fn status(&self) -> WarmupStatus {
        self.lock_state().status
    }

    #[cfg(all(target_os = "windows", feature = "terminal-startup-harness"))]
    pub(super) fn real_create_seen(&self) -> bool {
        self.lock_state().real_create_seen
    }

    fn lock_state(&self) -> MutexGuard<'_, CoordinatorState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

pub(super) fn start_from_env() {
    let enabled = super::session::env_flag_enabled("THREADTERM_CONPTY_WARMUP");
    #[cfg(feature = "terminal-startup-harness")]
    let enabled = enabled || harness::scenario_enables_warmup();
    start(enabled);
}

pub(super) fn start(enabled: bool) {
    if !enabled {
        return;
    }
    #[cfg(feature = "terminal-startup-harness")]
    let _harness_started = harness::begin();
    #[cfg(target_os = "windows")]
    {
        let initial_real_create = REAL_CREATE_SEEN.load(Ordering::SeqCst);
        let coordinator = COORDINATOR
            .get_or_init(|| Arc::new(Coordinator::new(initial_real_create)))
            .clone();
        if WORKER_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let worker = Arc::clone(&coordinator);
        if std::thread::Builder::new()
            .name("threadterm-conpty-warmup".to_owned())
            .spawn(move || run_worker(worker))
            .is_err()
        {
            coordinator.set_status(WarmupStatus::Failed);
            #[cfg(feature = "terminal-startup-harness")]
            harness::record_worker_spawn_failure();
            tracing::debug!("ConPTY warmup failed");
        }
    }
}

pub(super) fn notify_real_create() {
    #[cfg(target_os = "windows")]
    {
        REAL_CREATE_SEEN.store(true, Ordering::SeqCst);
        #[cfg(feature = "terminal-startup-harness")]
        harness::record_real_create_seen();
        if let Some(coordinator) = COORDINATOR.get() {
            coordinator.notify_real_create();
        }
    }
}

#[cfg(target_os = "windows")]
fn run_worker(coordinator: Arc<Coordinator>) {
    #[cfg(feature = "terminal-startup-harness")]
    if harness::should_hold_before_grace() {
        if !harness::enter_hold_before_grace() {
            harness::record_native_spawn_failure();
            return;
        }
        if !harness::wait_for_hold_before_grace_release() {
            coordinator.set_status(WarmupStatus::TimedOut);
            // This terminal hold is before production grace; timeout must not
            // fall through into `wait_for_grace` or native `openpty`.
            return;
        }
    }

    if !coordinator.wait_for_grace() {
        #[cfg(feature = "terminal-startup-harness")]
        harness::record_skipped_for_real_create();
        tracing::debug!("ConPTY warmup skipped");
        return;
    }

    #[cfg(feature = "terminal-startup-harness")]
    if harness::should_hold_before_native_spawn() {
        if !harness::enter_hold() {
            harness::record_native_spawn_failure();
            return;
        }
        if !harness::wait_for_hold_release() {
            coordinator.set_status(WarmupStatus::TimedOut);
            // The harness deadline is terminal for this one-shot worker.  In
            // particular, never fall through to native `openpty` afterwards.
            return;
        }
        // A real create during the hold wins.  Releasing the harness point
        // must never force a second native warmup spawn.
        if coordinator.real_create_seen() {
            coordinator.set_status(WarmupStatus::Skipped);
            harness::record_skipped_for_real_create();
            return;
        }
    }
    super::warmup_windows::run(&coordinator);
}

#[cfg(test)]
#[path = "warmup_tests.rs"]
mod tests;
