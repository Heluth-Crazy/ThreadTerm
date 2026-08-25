use super::*;
use std::cell::Cell;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

struct FakeChild {
    polls: VecDeque<ChildPoll>,
    fallback: ChildPoll,
    kills: usize,
    kill_ok: bool,
}

struct KillThenExitChild {
    killed: bool,
}

impl ChildProbe for KillThenExitChild {
    fn try_wait(&mut self) -> ChildPoll {
        if self.killed {
            ChildPoll::Exited
        } else {
            ChildPoll::Running
        }
    }

    fn kill(&mut self) -> bool {
        self.killed = true;
        true
    }
}

impl FakeChild {
    fn one(poll: ChildPoll) -> Self {
        Self {
            polls: VecDeque::from([poll]),
            fallback: poll,
            kills: 0,
            kill_ok: true,
        }
    }
}

impl ChildProbe for FakeChild {
    fn try_wait(&mut self) -> ChildPoll {
        self.polls.pop_front().unwrap_or(self.fallback)
    }

    fn kill(&mut self) -> bool {
        self.kills += 1;
        self.kill_ok
    }
}

fn run_fake(child: &mut FakeChild) -> (WarmupStatus, Duration) {
    let origin = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let status = reap_with_deadlines(
        child,
        || origin + elapsed.get(),
        |duration| elapsed.set(elapsed.get() + duration),
    );
    (status, elapsed.get())
}

#[test]
fn warmup_flag_is_conservative() {
    assert!(super::super::session::feature_flag_enabled("1"));
    assert!(super::super::session::feature_flag_enabled("TrUe"));
    assert!(super::super::session::feature_flag_enabled("enabled"));
    for value in [None, Some(""), Some("yes"), Some(" true "), Some("0")] {
        assert!(!super::super::session::feature_flag_enabled(
            value.unwrap_or("")
        ));
    }
}

#[test]
fn click_before_grace_skips_without_spawn() {
    let coordinator = Coordinator::new(false);
    coordinator.notify_real_create();
    assert!(!coordinator.claim_after_grace());
    assert_eq!(coordinator.status(), WarmupStatus::Skipped);
}

#[test]
fn no_click_enters_spawn_after_grace() {
    let coordinator = Coordinator::new(false);
    assert!(coordinator.claim_after_grace());
    assert_eq!(coordinator.status(), WarmupStatus::Spawning);
}

#[test]
fn click_during_native_spawn_does_not_change_spawn_state() {
    let coordinator = Coordinator::new(false);
    assert!(coordinator.claim_after_grace());
    let started = Instant::now();
    coordinator.notify_real_create();
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(coordinator.status(), WarmupStatus::Spawning);
}

#[test]
fn fake_child_success_completes() {
    let mut child = FakeChild::one(ChildPoll::Exited);
    let (status, elapsed) = run_fake(&mut child);
    assert_eq!(status, WarmupStatus::Completed);
    assert_eq!(child.kills, 0);
    assert_eq!(elapsed, Duration::ZERO);
}

#[test]
fn fake_spawn_failure_is_nonfatal_status() {
    let coordinator = Coordinator::new(false);
    coordinator.set_status(WarmupStatus::Failed);
    assert_eq!(coordinator.status(), WarmupStatus::Failed);
}

#[test]
fn never_exit_is_killed_and_reaped_with_bound() {
    let mut child = FakeChild {
        polls: VecDeque::new(),
        fallback: ChildPoll::Running,
        kills: 0,
        kill_ok: true,
    };
    let (status, elapsed) = run_fake(&mut child);
    assert_eq!(status, WarmupStatus::TimedOut);
    assert_eq!(child.kills, 1);
    assert!(elapsed <= CHILD_LIMIT + REAP_LIMIT + POLL_INTERVAL);
}

#[test]
fn kill_failure_is_bounded_and_failed() {
    let mut child = FakeChild::one(ChildPoll::Running);
    child.kill_ok = false;
    let (status, elapsed) = run_fake(&mut child);
    assert_eq!(status, WarmupStatus::Failed);
    assert!(elapsed <= CHILD_LIMIT + POLL_INTERVAL);
}

#[test]
fn observed_timeout_requires_confirmed_reap_for_never_exit_fixture() {
    let mut child = KillThenExitChild { killed: false };
    let origin = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let observation = reap_with_deadlines_observed(
        &mut child,
        || origin + elapsed.get(),
        |duration| elapsed.set(elapsed.get() + duration),
    );
    assert_eq!(observation.status, WarmupStatus::TimedOut);
    assert!(observation.kill_attempted);
    assert!(observation.reap_confirmed);
    assert!(!observation.reap_timed_out);
    assert!(elapsed.get() >= CHILD_LIMIT);
}

#[test]
fn observed_reap_deadline_is_not_reported_as_confirmed() {
    let mut child = FakeChild {
        polls: VecDeque::new(),
        fallback: ChildPoll::Running,
        kills: 0,
        kill_ok: true,
    };
    let origin = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let observation = reap_with_deadlines_observed(
        &mut child,
        || origin + elapsed.get(),
        |duration| elapsed.set(elapsed.get() + duration),
    );
    assert_eq!(observation.status, WarmupStatus::TimedOut);
    assert!(observation.kill_attempted);
    assert!(!observation.reap_confirmed);
    assert!(observation.reap_timed_out);
    assert_eq!(child.kills, 1);
}
