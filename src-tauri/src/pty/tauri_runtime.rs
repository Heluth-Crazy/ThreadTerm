//! Tauri-only projection adapters for the consumer-neutral PTY runtime.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Window};

use super::{
    TerminalEvent, TerminalEventSink, TerminalLaunchObserver, TerminalLaunchPhase,
    TerminalSessionHost,
};

pub(super) struct TauriTerminalHost {
    app_handle: AppHandle,
    startup_dispatcher: Option<super::startup::StartupSideEffectDispatcher>,
}

impl TauriTerminalHost {
    pub(super) fn new(
        app_handle: AppHandle,
        startup_dispatcher: Option<super::startup::StartupSideEffectDispatcher>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app_handle,
            startup_dispatcher,
        })
    }
}

pub(super) struct TauriTerminalLaunchObserver {
    window: Window,
}

impl TauriTerminalLaunchObserver {
    pub(super) fn new(window: Window) -> Arc<Self> {
        Arc::new(Self { window })
    }
}

#[derive(Debug, PartialEq)]
enum TauriProjection {
    Broadcast {
        name: &'static str,
        payload: serde_json::Value,
    },
    Window {
        label: &'static str,
        name: &'static str,
        payload: serde_json::Value,
    },
}

fn tauri_projection(event: &TerminalEvent, float_exists: bool) -> Vec<TauriProjection> {
    let broadcast = |name, payload| vec![TauriProjection::Broadcast { name, payload }];
    match event {
        TerminalEvent::SessionStateChanged { pty_id, state } => broadcast(
            "session-state-changed",
            serde_json::json!({"ptyId": pty_id, "state": state}),
        ),
        TerminalEvent::Output { id, data, seq } => {
            let payload = serde_json::json!({"id": id, "data": data, "seq": seq});
            let mut projections = vec![TauriProjection::Window {
                label: "main",
                name: "pty-output",
                payload: payload.clone(),
            }];
            if float_exists {
                projections.push(TauriProjection::Window {
                    label: "float",
                    name: "pty-output",
                    payload,
                });
            }
            projections
        }
        TerminalEvent::AttentionRequired {
            pty_id,
            session_id,
            attention_type,
            message,
            fingerprint,
        } => broadcast(
            "attention-required",
            serde_json::json!({"ptyId": pty_id, "sessionId": session_id, "type": attention_type, "message": message, "fingerprint": fingerprint}),
        ),
        TerminalEvent::Exit {
            id,
            code,
            generation,
        } => broadcast(
            "pty-exit",
            serde_json::json!({"id": id, "code": code, "generation": generation}),
        ),
        TerminalEvent::ProtocolFailure { id, code } => broadcast(
            "pty-protocol-failure",
            serde_json::json!({"id": id, "code": code}),
        ),
    }
}

impl TerminalEventSink for TauriTerminalHost {
    fn publish(&self, event: TerminalEvent) -> Result<(), String> {
        for projection in tauri_projection(
            &event,
            self.app_handle.get_webview_window("float").is_some(),
        ) {
            match projection {
                TauriProjection::Broadcast { name, payload } => self
                    .app_handle
                    .emit(name, payload)
                    .map_err(|error| error.to_string())?,
                TauriProjection::Window {
                    label,
                    name,
                    payload,
                } => self
                    .app_handle
                    .emit_to(label, name, payload)
                    .map_err(|error| error.to_string())?,
            }
        }
        Ok(())
    }
}

impl TerminalSessionHost for TauriTerminalHost {
    fn publish_startup(&self, snapshot: super::PtyStartupSnapshot) -> Result<(), String> {
        self.app_handle
            .emit(super::startup::PTY_STARTUP_STATE_EVENT, snapshot)
            .map_err(|error| error.to_string())
    }

    fn submit_startup_side_effect(
        &self,
        request: super::StartupSideEffectRequest,
    ) -> Result<(), String> {
        request.validate()?;
        let dispatcher = self
            .startup_dispatcher
            .as_ref()
            .ok_or_else(|| "startup_side_effect_context_required".to_string())?
            .clone();
        let app_handle = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            dispatcher
                .process(request, &|| {
                    crate::managed_state::emit_terminal_startup_effects_changed(&app_handle)
                })
                .await;
        });
        Ok(())
    }

    fn ensure_startup_side_effect_dispatcher(&self) -> Result<(), String> {
        self.startup_dispatcher
            .as_ref()
            .map(|_| ())
            .ok_or_else(|| "startup_side_effect_context_required".to_string())
    }
}

impl TerminalLaunchObserver for TauriTerminalLaunchObserver {
    fn observe(&self, phase: TerminalLaunchPhase) -> Result<(), String> {
        self.window
            .emit(super::PTY_LAUNCH_PHASE_EVENT, phase)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::SessionState;

    #[test]
    fn projection_preserves_all_legacy_event_wires() {
        assert_eq!(
            tauri_projection(
                &TerminalEvent::SessionStateChanged {
                    pty_id: "p".into(),
                    state: SessionState::Running
                },
                false
            ),
            vec![TauriProjection::Broadcast {
                name: "session-state-changed",
                payload: serde_json::json!({"ptyId":"p","state":"Running"})
            }]
        );
        let output = TerminalEvent::Output {
            id: "p".into(),
            data: "x".into(),
            seq: 7,
        };
        assert_eq!(
            tauri_projection(&output, false),
            vec![TauriProjection::Window {
                label: "main",
                name: "pty-output",
                payload: serde_json::json!({"id":"p","data":"x","seq":7})
            }]
        );
        assert_eq!(
            tauri_projection(&output, true),
            vec![
                TauriProjection::Window {
                    label: "main",
                    name: "pty-output",
                    payload: serde_json::json!({"id":"p","data":"x","seq":7})
                },
                TauriProjection::Window {
                    label: "float",
                    name: "pty-output",
                    payload: serde_json::json!({"id":"p","data":"x","seq":7})
                }
            ]
        );
        assert_eq!(
            tauri_projection(
                &TerminalEvent::AttentionRequired {
                    pty_id: "p".into(),
                    session_id: "p".into(),
                    attention_type: "waiting".into(),
                    message: "m".into(),
                    fingerprint: "f".into()
                },
                false
            ),
            vec![TauriProjection::Broadcast {
                name: "attention-required",
                payload: serde_json::json!({"ptyId":"p","sessionId":"p","type":"waiting","message":"m","fingerprint":"f"})
            }]
        );
        assert_eq!(
            tauri_projection(
                &TerminalEvent::Exit {
                    id: "p".into(),
                    code: Some(0),
                    generation: "g".into()
                },
                false
            ),
            vec![TauriProjection::Broadcast {
                name: "pty-exit",
                payload: serde_json::json!({"id":"p","code":0,"generation":"g"})
            }]
        );
        assert_eq!(
            tauri_projection(
                &TerminalEvent::ProtocolFailure {
                    id: "p".into(),
                    code: "protocol_reply_partial"
                },
                false
            ),
            vec![TauriProjection::Broadcast {
                name: "pty-protocol-failure",
                payload: serde_json::json!({"id":"p","code":"protocol_reply_partial"})
            }]
        );
    }
}
