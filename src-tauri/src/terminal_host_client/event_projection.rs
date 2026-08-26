use std::fmt;

use terminal_host_protocol::{
    SessionExitEvent, SessionListResponse, SessionOutputEvent, SessionResyncRequiredEvent,
    SessionStateEvent, SurfacePresentRequestedEvent,
};

/// Events projected from the daemon connection onto the desktop coordinator.
#[derive(Clone)]
pub enum DaemonEvent {
    SessionOutput(SessionOutputEvent),
    SessionState(SessionStateEvent),
    SessionExit(SessionExitEvent),
    SessionResyncRequired(SessionResyncRequiredEvent),
    SurfacePresentRequested(SurfacePresentRequestedEvent),
    Reconcile(ReconcileSnapshot),
    Disconnected,
}

impl fmt::Debug for DaemonEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionOutput(value) => {
                formatter.debug_tuple("SessionOutput").field(value).finish()
            }
            Self::SessionState(value) => {
                formatter.debug_tuple("SessionState").field(value).finish()
            }
            Self::SessionExit(value) => formatter.debug_tuple("SessionExit").field(value).finish(),
            Self::SessionResyncRequired(value) => formatter
                .debug_tuple("SessionResyncRequired")
                .field(value)
                .finish(),
            Self::SurfacePresentRequested(value) => formatter
                .debug_tuple("SurfacePresentRequested")
                .field(value)
                .finish(),
            Self::Reconcile(value) => formatter.debug_tuple("Reconcile").field(value).finish(),
            Self::Disconnected => formatter.write_str("Disconnected"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ReconcileSnapshot {
    pub previous_runtime_id: Option<String>,
    pub runtime_id: String,
    pub catalog: SessionListResponse,
}

/// Must return quickly; callbacks run on the connection actor to retain event order.
pub trait DaemonEventSink: Send + Sync + 'static {
    fn on_event(&self, event: DaemonEvent);
}

impl<F> DaemonEventSink for F
where
    F: Fn(DaemonEvent) + Send + Sync + 'static,
{
    fn on_event(&self, event: DaemonEvent) {
        self(event);
    }
}
