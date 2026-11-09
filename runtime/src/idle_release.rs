//! Idle-release bookkeeping and Windows process memory.
//!
//! The clock records the last time a session did something the user can notice:
//! a connect, a send, an approval, a keystroke, an explicit claim or a provider
//! event. A renew carrying `visible:false` is deliberately not use. The sweep
//! itself lives in `service.rs`, because releasing needs the service's locks.
use chrono::{DateTime, Utc};
use std::{
    collections::HashMap,
    sync::Mutex,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct Usage {
    pub last_used: DateTime<Utc>,
    pub last_visible: Option<DateTime<Utc>>,
}

#[derive(Default)]
pub(crate) struct IdleClock {
    entries: Mutex<HashMap<String, Usage>>,
}

impl IdleClock {
    fn with<T>(&self, read: impl FnOnce(&mut HashMap<String, Usage>) -> T) -> T {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        read(&mut entries)
    }

    pub(crate) fn touch_at(&self, session_id: &str, now: DateTime<Utc>, visible: bool) {
        self.with(|entries| {
            let usage = entries
                .entry(session_id.to_owned())
                .or_insert(Usage { last_used: now, last_visible: None });
            usage.last_used = now;
            if visible {
                usage.last_visible = Some(now);
            }
        });
    }

    /// Any user-visible use that is not a visibility report.
    pub(crate) fn touch(&self, session_id: &str) {
        self.touch_at(session_id, Utc::now(), false);
    }

    /// A renew: `None` is use from an older client, `Some(true)` is a visible
    /// view, `Some(false)` is a hidden view and changes nothing.
    pub(crate) fn renew(&self, session_id: &str, visible: Option<bool>) {
        match visible {
            Some(false) => {}
            Some(true) => self.touch_at(session_id, Utc::now(), true),
            None => self.touch(session_id),
        }
    }

    pub(crate) fn last_used(&self, session_id: &str) -> Option<DateTime<Utc>> {
        self.with(|entries| entries.get(session_id).map(|usage| usage.last_used))
    }

    /// The first sweep gives an existing worker a fresh start; nothing is
    /// released until a later sweep has seen it idle for the threshold.
    pub(crate) fn seed(&self, session_id: &str, now: DateTime<Utc>) -> bool {
        self.with(|entries| {
            if entries.contains_key(session_id) {
                return false;
            }
            entries.insert(
                session_id.to_owned(),
                Usage { last_used: now, last_visible: None },
            );
            true
        })
    }

    pub(crate) fn idle_seconds(&self, session_id: &str, now: DateTime<Utc>) -> Option<i64> {
        self.last_used(session_id)
            .map(|last| (now - last).num_seconds().max(0))
    }

    pub(crate) fn visible_within(&self, session_id: &str, now: DateTime<Utc>, seconds: i64) -> bool {
        self.with(|entries| {
            entries
                .get(session_id)
                .and_then(|usage| usage.last_visible)
                .is_some_and(|last| (now - last).num_seconds() <= seconds)
        })
    }

    pub(crate) fn forget(&self, session_id: &str) {
        self.with(|entries| {
            entries.remove(session_id);
        });
    }
}

/// Resident working set of one process, the metric the owner's sampler uses.
/// `None` means the process is gone or cannot be queried.
#[cfg(windows)]
pub(crate) fn process_memory_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let ok = GetProcessMemoryInfo(
            handle,
            &raw mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        CloseHandle(handle);
        (ok != 0).then_some(counters.WorkingSetSize as u64)
    }
}

#[cfg(not(windows))]
pub(crate) fn process_memory_bytes(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn a_hidden_renew_does_not_count_as_use_but_a_visible_one_does() {
        let clock = IdleClock::default();
        let now = Utc::now();
        clock.touch_at("s", now, false);
        clock.touch_at("s", now + Duration::minutes(5), false);
        clock.renew("hidden", Some(false));
        assert!(clock.last_used("hidden").is_none());
        clock.renew("old", None);
        assert!(clock.last_used("old").is_some());
        assert!(!clock.visible_within("s", now + Duration::minutes(5), 30));
        clock.renew("s", Some(true));
        assert!(clock.visible_within("s", Utc::now(), 30));
    }

    #[test]
    fn the_first_seed_is_reported_and_does_not_move_the_clock_again() {
        let clock = IdleClock::default();
        let now = Utc::now();
        assert!(clock.seed("s", now));
        assert!(!clock.seed("s", now + Duration::hours(1)));
        assert_eq!(clock.last_used("s"), Some(now));
    }
}
