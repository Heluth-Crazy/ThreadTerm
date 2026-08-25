use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const CLOSED: u8 = 0;
const OPEN: u8 = 1;
const FAILED: u8 = 2;

/// User writes may queue while startup is pending, but only the writer worker
/// may move this gate to a terminal state.  The acquire/release ordering also
/// makes the startup write's commit visible before user scheduling resumes.
#[derive(Clone)]
pub(super) struct StartupGate {
    state: Arc<AtomicU8>,
}

impl StartupGate {
    #[allow(dead_code)]
    pub(super) fn closed() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(CLOSED)),
        }
    }

    pub(super) fn is_open(&self) -> bool {
        self.state.load(Ordering::Acquire) == OPEN
    }

    pub(super) fn open(&self) {
        let _ = self
            .state
            .compare_exchange(CLOSED, OPEN, Ordering::AcqRel, Ordering::Acquire);
    }

    pub(super) fn fail(&self) {
        let _ = self
            .state
            .compare_exchange(CLOSED, FAILED, Ordering::AcqRel, Ordering::Acquire);
    }
}
