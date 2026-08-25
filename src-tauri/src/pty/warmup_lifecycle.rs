use std::time::{Duration, Instant};

use super::WarmupStatus;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChildPoll {
    Running,
    Exited,
    Error,
}

pub(crate) trait ChildProbe {
    fn try_wait(&mut self) -> ChildPoll;
    fn kill(&mut self) -> bool;
}

#[cfg(any(test, feature = "terminal-startup-harness"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ReapObservation {
    pub(crate) status: WarmupStatus,
    pub(crate) kill_attempted: bool,
    pub(crate) reap_confirmed: bool,
    pub(crate) reap_timed_out: bool,
}

#[cfg(any(test, not(feature = "terminal-startup-harness")))]
pub(crate) fn reap_with_deadlines<C, N, S>(child: &mut C, mut now: N, mut sleep: S) -> WarmupStatus
where
    C: ChildProbe,
    N: FnMut() -> Instant,
    S: FnMut(Duration),
{
    let deadline = now() + super::CHILD_LIMIT;
    let mut poll_error = false;
    loop {
        match child.try_wait() {
            ChildPoll::Exited => {
                return if poll_error {
                    WarmupStatus::Failed
                } else {
                    WarmupStatus::Completed
                };
            }
            ChildPoll::Error => poll_error = true,
            ChildPoll::Running => {}
        }
        if now() >= deadline || poll_error {
            break;
        }
        sleep(super::POLL_INTERVAL);
    }
    if !child.kill() {
        return WarmupStatus::Failed;
    }
    let reap_deadline = now() + super::REAP_LIMIT;
    loop {
        match child.try_wait() {
            ChildPoll::Exited => {
                return if poll_error {
                    WarmupStatus::Failed
                } else {
                    WarmupStatus::TimedOut
                };
            }
            ChildPoll::Error => return WarmupStatus::Failed,
            ChildPoll::Running => {}
        }
        if now() >= reap_deadline {
            return WarmupStatus::TimedOut;
        }
        sleep(super::POLL_INTERVAL);
    }
}

#[cfg(any(test, feature = "terminal-startup-harness"))]
pub(crate) fn reap_with_deadlines_observed<C, N, S>(
    child: &mut C,
    mut now: N,
    mut sleep: S,
) -> ReapObservation
where
    C: ChildProbe,
    N: FnMut() -> Instant,
    S: FnMut(Duration),
{
    let deadline = now() + super::CHILD_LIMIT;
    let mut poll_error = false;
    loop {
        match child.try_wait() {
            ChildPoll::Exited => {
                return ReapObservation {
                    status: if poll_error {
                        WarmupStatus::Failed
                    } else {
                        WarmupStatus::Completed
                    },
                    kill_attempted: false,
                    reap_confirmed: true,
                    reap_timed_out: false,
                };
            }
            ChildPoll::Error => poll_error = true,
            ChildPoll::Running => {}
        }
        if now() >= deadline || poll_error {
            break;
        }
        sleep(super::POLL_INTERVAL);
    }
    let kill_attempted = true;
    if !child.kill() {
        return ReapObservation {
            status: WarmupStatus::Failed,
            kill_attempted,
            reap_confirmed: false,
            reap_timed_out: false,
        };
    }
    let reap_deadline = now() + super::REAP_LIMIT;
    loop {
        match child.try_wait() {
            ChildPoll::Exited => {
                return ReapObservation {
                    status: if poll_error {
                        WarmupStatus::Failed
                    } else {
                        WarmupStatus::TimedOut
                    },
                    kill_attempted,
                    reap_confirmed: true,
                    reap_timed_out: false,
                };
            }
            ChildPoll::Error => {
                return ReapObservation {
                    status: WarmupStatus::Failed,
                    kill_attempted,
                    reap_confirmed: false,
                    reap_timed_out: false,
                };
            }
            ChildPoll::Running => {}
        }
        if now() >= reap_deadline {
            return ReapObservation {
                status: WarmupStatus::TimedOut,
                kill_attempted,
                reap_confirmed: false,
                reap_timed_out: true,
            };
        }
        sleep(super::POLL_INTERVAL);
    }
}
