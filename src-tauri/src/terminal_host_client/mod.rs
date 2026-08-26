//! Desktop client for the detached terminal host.
//!
//! The client is intentionally additive. It owns no PTY state and never derives
//! the active profile from Tauri state; callers pass the already-resolved
//! operational profile directory.

// The module is feature-gated and its application facade is landed in a
// separate Phase 4 file. Keep the complete typed seam warning-clean meanwhile.
#![allow(dead_code, unused_imports)]

mod connection;
mod event_projection;
mod presentation;
mod reconnect;
mod request_mux;

pub use event_projection::{DaemonEvent, DaemonEventSink, ReconcileSnapshot};
pub use reconnect::{
    ensure_daemon_running, DaemonClientConfig, DaemonClientError, DaemonClientHandle, HealthStatus,
};

#[cfg(test)]
mod tests;
