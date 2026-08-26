//! Consumer-neutral terminal-runtime boundary.
//!
//! Phase 1 intentionally keeps the existing in-process registry authoritative.
//! This module provides the object-safe seam a detached owner can implement
//! later without allowing a second registry to appear in the desktop process.

use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Object-safe return type used by asynchronous runtime operations.
pub type RuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeSessionSelector {
    Id(String),
}
impl RuntimeSessionSelector {
    pub fn id(self) -> String {
        match self {
            Self::Id(id) => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeCloseRequest {
    Force,
    Graceful {
        attempt_id: String,
        profile: super::GracefulShutdownProfile,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeCloseResult {
    Forced,
    Graceful(super::GracefulShutdownResult),
}

impl RuntimeCloseResult {
    pub fn into_graceful(self) -> Result<super::GracefulShutdownResult, String> {
        match self {
            Self::Graceful(result) => Ok(result),
            Self::Forced => Err("terminal runtime returned a force-close result".to_string()),
        }
    }

    pub fn into_forced(self) -> Result<(), String> {
        match self {
            Self::Forced => Ok(()),
            Self::Graceful(_) => {
                Err("terminal runtime returned a graceful-close result".to_string())
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutputConsumer {
    Background,
    Renderer(String),
}
impl OutputConsumer {
    pub fn from_legacy(kind: String, id: Option<String>) -> Result<Self, String> {
        match kind.as_str() {
            "background" => Ok(Self::Background),
            "renderer" => id
                .filter(|id| !id.trim().is_empty())
                .map(Self::Renderer)
                .ok_or_else(|| "Renderer ACK requires a consumer id".to_string()),
            _ => Err(format!("Unknown output consumer kind: {kind}")),
        }
    }
}

/// Events that the terminal core may project to its presentation host.
///
/// Bridge broadcasts deliberately remain outside this sink: their ordering is
/// part of the existing Bridge contract and the current core still publishes
/// them immediately beside the corresponding desktop event.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalEvent {
    SessionStateChanged {
        pty_id: String,
        state: super::SessionState,
    },
    Output {
        id: String,
        data: String,
        seq: u64,
    },
    AttentionRequired {
        pty_id: String,
        session_id: String,
        attention_type: String,
        message: String,
        fingerprint: String,
    },
    Exit {
        id: String,
        code: Option<u32>,
        generation: String,
    },
    ProtocolFailure {
        id: String,
        code: &'static str,
    },
}

/// Synchronous by design: event publication stays on the current reader path
/// and cannot delay DA1 replies, output ACK accounting, or teardown.
pub trait TerminalEventSink: Send + Sync {
    fn publish(&self, event: TerminalEvent) -> Result<(), String>;
}

#[derive(Clone)]
pub struct RuntimeCreateRequest {
    pub id: String,
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub provider: Option<String>,
    pub launch_attempt_id: Option<String>,
    pub launch: Option<super::PtyLaunchDescriptor>,
    pub startup: RuntimeCreateStartup,
}

#[derive(Clone)]
pub enum RuntimeCreateStartup {
    Legacy,
    Explicit(super::PtyStartupIntent),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeCreateResult {
    pub id: String,
    pub disposition: super::PtyCreateDisposition,
    pub descriptor_disposition: super::PtyDescriptorDisposition,
    pub generation: String,
    pub shell_family: super::PtyShellFamily,
    pub startup: super::PtyStartupSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunchPhase {
    pub launch_attempt_id: String,
    pub pty_id: String,
    pub phase: String,
    pub elapsed_ms: f64,
    pub domain: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Per-call create observer. Implementations may project progress to a window,
/// a detached host protocol, or a deterministic test recorder.
pub trait TerminalLaunchObserver: Send + Sync {
    fn observe(&self, phase: TerminalLaunchPhase) -> Result<(), String>;
}

/// Consumer-neutral owner for every session-originated host interaction.
/// Implementations decide how to publish presentation events and where to
/// execute startup side effects; the PTY core never holds a Tauri capability.
pub trait TerminalSessionHost: TerminalEventSink {
    fn publish_startup(&self, snapshot: super::PtyStartupSnapshot) -> Result<(), String>;
    fn ensure_startup_side_effect_dispatcher(&self) -> Result<(), String>;
    fn submit_startup_side_effect(
        &self,
        request: super::StartupSideEffectRequest,
    ) -> Result<(), String>;
}

/// Object-safe runtime contract. The initial adapter exposes the existing
/// create/read/lifecycle surface while keeping presentation capabilities in
/// the injected host and per-call launch observer.
pub trait TerminalRuntime: Send + Sync {
    fn create<'a>(
        &'a self,
        request: RuntimeCreateRequest,
        host: Arc<dyn TerminalSessionHost>,
        observer: Arc<dyn TerminalLaunchObserver>,
    ) -> RuntimeFuture<'a, Result<RuntimeCreateResult, String>>;
    fn cancel_graceful_shutdown<'a>(
        &'a self,
        id: String,
        attempt_id: String,
    ) -> RuntimeFuture<'a, Result<bool, String>>;
    fn input<'a>(&'a self, id: String, data: String) -> RuntimeFuture<'a, Result<(), String>>;
    fn resize<'a>(
        &'a self,
        id: String,
        rows: u16,
        cols: u16,
    ) -> RuntimeFuture<'a, Result<(), String>>;
    fn close<'a>(
        &'a self,
        selector: RuntimeSessionSelector,
        request: RuntimeCloseRequest,
    ) -> RuntimeFuture<'a, Result<RuntimeCloseResult, String>>;
    fn session_state<'a>(
        &'a self,
        id: String,
    ) -> RuntimeFuture<'a, Result<super::SessionState, String>>;
    fn attach_snapshot<'a>(
        &'a self,
        id: String,
    ) -> RuntimeFuture<'a, Result<Option<super::PtyAttachSnapshot>, String>>;
    fn startup_state<'a>(
        &'a self,
        id: String,
        generation: String,
    ) -> RuntimeFuture<'a, Result<Option<super::PtyStartupSnapshot>, String>>;
    fn all_session_states<'a>(
        &'a self,
    ) -> RuntimeFuture<'a, Result<HashMap<String, super::SessionState>, String>>;
    fn recent_output<'a>(&'a self, id: String)
        -> RuntimeFuture<'a, Result<Option<String>, String>>;
    fn register_output_consumer<'a>(
        &'a self,
        id: String,
        consumer_id: String,
    ) -> RuntimeFuture<'a, Result<(), String>>;
    fn unregister_output_consumer<'a>(
        &'a self,
        id: String,
        consumer_id: String,
    ) -> RuntimeFuture<'a, Result<(), String>>;
    fn acknowledge_output<'a>(
        &'a self,
        selector: RuntimeSessionSelector,
        through_seq: u64,
        consumer: OutputConsumer,
    ) -> RuntimeFuture<'a, Result<(), String>>;
}

/// Thin façade over the one process-global registry in `registry.rs`.
/// It owns no map and creates no secondary PTY core.
#[derive(Default)]
pub struct InProcessTerminalRuntime;

impl TerminalRuntime for InProcessTerminalRuntime {
    fn create<'a>(
        &'a self,
        request: RuntimeCreateRequest,
        host: Arc<dyn TerminalSessionHost>,
        observer: Arc<dyn TerminalLaunchObserver>,
    ) -> RuntimeFuture<'a, Result<RuntimeCreateResult, String>> {
        Box::pin(super::create_session(request, host, observer))
    }
    fn cancel_graceful_shutdown<'a>(
        &'a self,
        id: String,
        attempt_id: String,
    ) -> RuntimeFuture<'a, Result<bool, String>> {
        Box::pin(super::in_process_cancel_graceful_shutdown(id, attempt_id))
    }
    fn input<'a>(&'a self, id: String, data: String) -> RuntimeFuture<'a, Result<(), String>> {
        Box::pin(super::in_process_input(id, data))
    }

    fn resize<'a>(
        &'a self,
        id: String,
        rows: u16,
        cols: u16,
    ) -> RuntimeFuture<'a, Result<(), String>> {
        Box::pin(super::in_process_resize(id, rows, cols))
    }

    fn close<'a>(
        &'a self,
        selector: RuntimeSessionSelector,
        request: RuntimeCloseRequest,
    ) -> RuntimeFuture<'a, Result<RuntimeCloseResult, String>> {
        let id = selector.id();
        match request {
            RuntimeCloseRequest::Force => Box::pin(async move {
                super::in_process_kill(id)
                    .await
                    .map(|_| RuntimeCloseResult::Forced)
            }),
            RuntimeCloseRequest::Graceful {
                attempt_id,
                profile,
            } => Box::pin(async move {
                super::in_process_graceful_shutdown(id, attempt_id, profile)
                    .await
                    .map(RuntimeCloseResult::Graceful)
            }),
        }
    }

    fn session_state<'a>(
        &'a self,
        id: String,
    ) -> RuntimeFuture<'a, Result<super::SessionState, String>> {
        Box::pin(super::in_process_session_state(id))
    }

    fn attach_snapshot<'a>(
        &'a self,
        id: String,
    ) -> RuntimeFuture<'a, Result<Option<super::PtyAttachSnapshot>, String>> {
        Box::pin(super::in_process_attach_snapshot(id))
    }

    fn startup_state<'a>(
        &'a self,
        id: String,
        generation: String,
    ) -> RuntimeFuture<'a, Result<Option<super::PtyStartupSnapshot>, String>> {
        Box::pin(super::in_process_startup_state(id, generation))
    }

    fn all_session_states<'a>(
        &'a self,
    ) -> RuntimeFuture<'a, Result<HashMap<String, super::SessionState>, String>> {
        Box::pin(super::in_process_all_session_states())
    }

    fn recent_output<'a>(
        &'a self,
        id: String,
    ) -> RuntimeFuture<'a, Result<Option<String>, String>> {
        Box::pin(super::in_process_recent_output(id))
    }

    fn register_output_consumer<'a>(
        &'a self,
        id: String,
        consumer_id: String,
    ) -> RuntimeFuture<'a, Result<(), String>> {
        Box::pin(super::in_process_register_output_consumer(id, consumer_id))
    }

    fn unregister_output_consumer<'a>(
        &'a self,
        id: String,
        consumer_id: String,
    ) -> RuntimeFuture<'a, Result<(), String>> {
        Box::pin(super::in_process_unregister_output_consumer(
            id,
            consumer_id,
        ))
    }

    fn acknowledge_output<'a>(
        &'a self,
        selector: RuntimeSessionSelector,
        through_seq: u64,
        consumer: OutputConsumer,
    ) -> RuntimeFuture<'a, Result<(), String>> {
        Box::pin(super::in_process_acknowledge_output(
            selector.id(),
            through_seq,
            match &consumer {
                OutputConsumer::Background => "background".to_string(),
                OutputConsumer::Renderer(_) => "renderer".to_string(),
            },
            match consumer {
                OutputConsumer::Background => None,
                OutputConsumer::Renderer(id) => Some(id),
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<TerminalEvent>>);
    impl TerminalEventSink for RecordingSink {
        fn publish(&self, event: TerminalEvent) -> Result<(), String> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingHost {
        events: Mutex<Vec<TerminalEvent>>,
        startup: Mutex<Vec<super::super::PtyStartupSnapshot>>,
        effects: Mutex<Vec<super::super::StartupSideEffectRequest>>,
    }

    impl TerminalEventSink for RecordingHost {
        fn publish(&self, event: TerminalEvent) -> Result<(), String> {
            self.events.lock().unwrap().push(event);
            Ok(())
        }
    }

    impl TerminalSessionHost for RecordingHost {
        fn publish_startup(
            &self,
            snapshot: super::super::PtyStartupSnapshot,
        ) -> Result<(), String> {
            self.startup.lock().unwrap().push(snapshot);
            Ok(())
        }

        fn submit_startup_side_effect(
            &self,
            request: super::super::StartupSideEffectRequest,
        ) -> Result<(), String> {
            self.effects.lock().unwrap().push(request);
            Ok(())
        }

        fn ensure_startup_side_effect_dispatcher(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingObserver(Mutex<Vec<TerminalLaunchPhase>>);

    impl TerminalLaunchObserver for RecordingObserver {
        fn observe(&self, phase: TerminalLaunchPhase) -> Result<(), String> {
            self.0.lock().unwrap().push(phase);
            Ok(())
        }
    }

    #[test]
    fn sink_contract_preserves_event_order_and_payload() {
        let sink = RecordingSink::default();
        sink.publish(TerminalEvent::Output {
            id: "pty-1".into(),
            data: "hello".into(),
            seq: 7,
        })
        .unwrap();
        sink.publish(TerminalEvent::Exit {
            id: "pty-1".into(),
            code: Some(0),
            generation: "g-1".into(),
        })
        .unwrap();
        assert_eq!(
            *sink.0.lock().unwrap(),
            vec![
                TerminalEvent::Output {
                    id: "pty-1".into(),
                    data: "hello".into(),
                    seq: 7
                },
                TerminalEvent::Exit {
                    id: "pty-1".into(),
                    code: Some(0),
                    generation: "g-1".into()
                },
            ]
        );
    }

    #[test]
    fn in_process_adapter_is_send_sync_and_has_no_registry_state() {
        fn assert_runtime<T: TerminalRuntime + Send + Sync>() {}
        assert_runtime::<InProcessTerminalRuntime>();
        assert_eq!(std::mem::size_of::<InProcessTerminalRuntime>(), 0);
    }

    #[test]
    fn close_results_preserve_the_requested_typed_outcome() {
        let graceful = RuntimeCloseResult::Graceful(super::super::GracefulShutdownResult {
            attempt_id: "attempt-1".into(),
            outcome: super::super::shutdown::GracefulShutdownOutcome::Graceful,
            stage: super::super::shutdown::GracefulShutdownStage::ShellExit,
        });
        assert_eq!(
            graceful.clone().into_graceful().unwrap().attempt_id,
            "attempt-1"
        );
        assert!(graceful.into_forced().is_err());
        assert!(RuntimeCloseResult::Forced.into_graceful().is_err());
        assert!(RuntimeCloseResult::Forced.into_forced().is_ok());
    }

    #[test]
    fn fake_host_keeps_terminal_startup_and_effect_channels_distinct() {
        let host = RecordingHost::default();
        host.publish(TerminalEvent::ProtocolFailure {
            id: "pty-1".into(),
            code: "protocol_reply_partial",
        })
        .unwrap();
        host.publish_startup(super::super::PtyStartupSnapshot {
            pty_id: "pty-1".into(),
            generation: "0123456789abcdef0123456789abcdef".into(),
            revision: 1,
            state: super::super::PtyStartupState::Ready,
            trigger: Some(super::super::PtyStartupTrigger::Marker),
        })
        .unwrap();

        assert_eq!(host.events.lock().unwrap().len(), 1);
        assert_eq!(host.startup.lock().unwrap().len(), 1);
        assert!(host.effects.lock().unwrap().is_empty());
    }

    #[test]
    fn fake_launch_observer_preserves_phase_order_and_wire_shape() {
        let observer = RecordingObserver::default();
        for (phase, elapsed_ms) in [("openPtyStarted", 1.25), ("childSpawned", 2.5)] {
            observer
                .observe(TerminalLaunchPhase {
                    launch_attempt_id: "attempt-1".into(),
                    pty_id: "pty-1".into(),
                    phase: phase.into(),
                    elapsed_ms,
                    domain: "backend",
                    provider: Some("codex".into()),
                })
                .unwrap();
        }
        let phases = observer.0.lock().unwrap();
        assert_eq!(phases[0].phase, "openPtyStarted");
        assert_eq!(phases[1].phase, "childSpawned");
        assert_eq!(
            serde_json::to_value(&phases[0]).unwrap(),
            serde_json::json!({
                "launchAttemptId": "attempt-1",
                "ptyId": "pty-1",
                "phase": "openPtyStarted",
                "elapsedMs": 1.25,
                "domain": "backend",
                "provider": "codex"
            })
        );
    }
}
