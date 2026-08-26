use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

use crate::catalog::TerminalState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamIdentity {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResyncReason {
    QueueOverflow,
    ReplayTruncated,
}

#[derive(Clone, Eq, PartialEq)]
pub enum RuntimeEvent {
    Output {
        identity: StreamIdentity,
        attach_id: String,
        seq: u64,
        bytes: Vec<u8>,
    },
    State {
        identity: StreamIdentity,
        revision: u64,
        state: TerminalState,
    },
    Exit {
        identity: StreamIdentity,
        revision: u64,
        exit_code: Option<i32>,
    },
    ResyncRequired {
        identity: StreamIdentity,
        attach_id: String,
        last_delivered_seq: u64,
        current_seq: u64,
        reason: ResyncReason,
    },
}

impl std::fmt::Debug for RuntimeEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Output {
                identity,
                seq,
                bytes,
                ..
            } => formatter
                .debug_struct("Output")
                .field("identity", identity)
                .field("attach_id", &"[redacted]")
                .field("seq", seq)
                .field("byte_count", &bytes.len())
                .finish(),
            Self::State {
                identity,
                revision,
                state,
            } => formatter
                .debug_struct("State")
                .field("identity", identity)
                .field("revision", revision)
                .field("state", state)
                .finish(),
            Self::Exit {
                identity,
                revision,
                exit_code,
            } => formatter
                .debug_struct("Exit")
                .field("identity", identity)
                .field("revision", revision)
                .field("exit_code", exit_code)
                .finish(),
            Self::ResyncRequired {
                identity,
                last_delivered_seq,
                current_seq,
                reason,
                ..
            } => formatter
                .debug_struct("ResyncRequired")
                .field("identity", identity)
                .field("attach_id", &"[redacted]")
                .field("last_delivered_seq", last_delivered_seq)
                .field("current_seq", current_seq)
                .field("reason", reason)
                .finish(),
        }
    }
}

#[derive(Debug)]
struct EventQueueState {
    control: VecDeque<RuntimeEvent>,
    output: VecDeque<RuntimeEvent>,
    terminal: VecDeque<RuntimeEvent>,
    output_capacity: usize,
    closed: bool,
}

#[derive(Debug)]
pub(crate) struct EventQueue {
    state: Mutex<EventQueueState>,
    ready: Condvar,
}

impl EventQueue {
    pub(crate) fn new(output_capacity: usize) -> Self {
        Self {
            state: Mutex::new(EventQueueState {
                control: VecDeque::new(),
                output: VecDeque::new(),
                terminal: VecDeque::new(),
                output_capacity,
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    pub(crate) fn push_output(&self, event: RuntimeEvent) -> bool {
        let mut state = self.state.lock().expect("event queue poisoned");
        if state.closed || state.output.len() >= state.output_capacity {
            return false;
        }
        state.output.push_back(event);
        self.ready.notify_one();
        true
    }

    pub(crate) fn push_control(&self, event: RuntimeEvent) {
        let mut state = self.state.lock().expect("event queue poisoned");
        if !state.closed {
            state.control.push_back(event);
            self.ready.notify_one();
        }
    }

    pub(crate) fn push_terminal(&self, event: RuntimeEvent) {
        let mut state = self.state.lock().expect("event queue poisoned");
        if !state.closed {
            state.terminal.push_back(event);
            self.ready.notify_one();
        }
    }

    pub(crate) fn reset_output(&self) {
        let mut state = self.state.lock().expect("event queue poisoned");
        state.output.clear();
        state
            .control
            .retain(|event| !matches!(event, RuntimeEvent::ResyncRequired { .. }));
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().expect("event queue poisoned");
        state.closed = true;
        state.control.clear();
        state.output.clear();
        state.terminal.clear();
        self.ready.notify_all();
    }

    pub(crate) fn finish(&self) {
        let mut state = self.state.lock().expect("event queue poisoned");
        state.closed = true;
        self.ready.notify_all();
    }

    fn is_finished(&self) -> bool {
        let state = self.state.lock().expect("event queue poisoned");
        state.closed
            && state.control.is_empty()
            && state.terminal.is_empty()
            && state.output.is_empty()
    }

    fn receive(&self, timeout: Duration) -> Option<RuntimeEvent> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().expect("event queue poisoned");
        loop {
            if let Some(event) = state.control.pop_front() {
                return Some(event);
            }
            if let Some(event) = state.terminal.pop_front() {
                return Some(event);
            }
            if let Some(event) = state.output.pop_front() {
                return Some(event);
            }
            if state.closed {
                return None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next, wait) = self
                .ready
                .wait_timeout(state, remaining)
                .expect("event queue poisoned");
            state = next;
            if wait.timed_out() {
                return None;
            }
        }
    }
}

pub struct EventSubscription {
    pub attach_id: String,
    pub(crate) queue: std::sync::Arc<EventQueue>,
}

impl EventSubscription {
    pub fn recv_timeout(&self, timeout: Duration) -> Option<RuntimeEvent> {
        self.queue.receive(timeout)
    }

    /// Returns true only after the producer has closed the subscription and
    /// every event retained for delivery has been consumed.
    pub fn is_finished(&self) -> bool {
        self.queue.is_finished()
    }
}

impl std::fmt::Debug for EventSubscription {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EventSubscription")
            .field("attach_id", &"[redacted]")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::catalog::TerminalState;

    use super::{EventQueue, RuntimeEvent, StreamIdentity};

    fn identity() -> StreamIdentity {
        StreamIdentity {
            runtime_id: "runtime".to_owned(),
            handle: "handle".to_owned(),
            stream_id: "stream".to_owned(),
        }
    }

    #[test]
    fn state_and_exit_preempt_output_without_dropping_it() {
        let queue = EventQueue::new(1);
        assert!(queue.push_output(RuntimeEvent::Output {
            identity: identity(),
            attach_id: "attach".to_owned(),
            seq: 1,
            bytes: b"tail".to_vec(),
        }));
        queue.push_terminal(RuntimeEvent::Exit {
            identity: identity(),
            revision: 3,
            exit_code: Some(0),
        });
        queue.push_control(RuntimeEvent::State {
            identity: identity(),
            revision: 2,
            state: TerminalState::Closing,
        });
        queue.finish();

        assert!(matches!(
            queue.receive(Duration::ZERO),
            Some(RuntimeEvent::State {
                state: TerminalState::Closing,
                ..
            })
        ));
        assert!(matches!(
            queue.receive(Duration::ZERO),
            Some(RuntimeEvent::Exit { .. })
        ));
        assert!(matches!(
            queue.receive(Duration::ZERO),
            Some(RuntimeEvent::Output { bytes, .. }) if bytes == b"tail"
        ));
        assert_eq!(queue.receive(Duration::ZERO), None);
    }

    #[test]
    fn capability_close_discards_every_queued_event() {
        let queue = EventQueue::new(1);
        queue.push_control(RuntimeEvent::State {
            identity: identity(),
            revision: 2,
            state: TerminalState::Closing,
        });
        assert!(queue.push_output(RuntimeEvent::Output {
            identity: identity(),
            attach_id: "attach".to_owned(),
            seq: 1,
            bytes: b"secret".to_vec(),
        }));
        queue.push_terminal(RuntimeEvent::Exit {
            identity: identity(),
            revision: 3,
            exit_code: Some(0),
        });
        queue.close();
        assert_eq!(queue.receive(Duration::ZERO), None);
        assert!(queue.is_finished());
    }

    #[test]
    fn finish_becomes_observable_only_after_retained_events_are_drained() {
        let queue = EventQueue::new(1);
        assert!(queue.push_output(RuntimeEvent::Output {
            identity: identity(),
            attach_id: "attach".to_owned(),
            seq: 1,
            bytes: b"tail".to_vec(),
        }));
        queue.finish();
        assert!(!queue.is_finished());
        assert!(matches!(
            queue.receive(Duration::ZERO),
            Some(RuntimeEvent::Output { bytes, .. }) if bytes == b"tail"
        ));
        assert!(queue.is_finished());
        assert_eq!(queue.receive(Duration::ZERO), None);
    }
}
