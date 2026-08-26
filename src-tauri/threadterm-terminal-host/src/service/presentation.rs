use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use terminal_host_core::{DaemonPtyEngine, PresentationTarget};
use terminal_host_protocol::{
    DesktopRegisterRequest, EnvelopeKind, EventEnvelope, EventName, Placement, Presentation,
    ProtocolVersion, SurfacePresentRequestedEvent,
};
use tokio::sync::mpsc;

use super::pty::{DeliveryState, HighFrame};

#[derive(Clone)]
struct DesktopConnection {
    request: DesktopRegisterRequest,
    high: mpsc::Sender<HighFrame>,
    deliveries: Arc<Mutex<HashMap<String, DeliveryState>>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ActiveSurfaceLease {
    pub(super) connection_id: String,
    pub(super) revision: u64,
    pub(super) attach_id: String,
    pub(super) stream_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttemptState {
    Pending,
    Ready,
    Failed,
}

pub(super) struct PresentationAttempt {
    handle: String,
    revision: u64,
    desktop_connection_id: String,
    state: Mutex<AttemptState>,
    attachment: Mutex<AttemptAttachment>,
    changed: Condvar,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum AttemptAttachment {
    Empty,
    Reserved,
    Bound {
        attach_id: String,
        stream_id: String,
    },
}

impl PresentationAttempt {
    fn completed(handle: String, revision: u64, desktop_connection_id: String) -> Arc<Self> {
        Arc::new(Self {
            handle,
            revision,
            desktop_connection_id,
            state: Mutex::new(AttemptState::Ready),
            attachment: Mutex::new(AttemptAttachment::Empty),
            changed: Condvar::new(),
        })
    }

    fn pending(handle: String, revision: u64, desktop_connection_id: String) -> Arc<Self> {
        Arc::new(Self {
            handle,
            revision,
            desktop_connection_id,
            state: Mutex::new(AttemptState::Pending),
            attachment: Mutex::new(AttemptAttachment::Empty),
            changed: Condvar::new(),
        })
    }

    fn finish(&self, state: AttemptState) {
        if let Ok(mut current) = self.state.lock() {
            *current = state;
            self.changed.notify_all();
        }
    }

    fn commit_ready<F>(&self, commit: F) -> Result<(), PrepareError>
    where
        F: FnOnce() -> Result<(), PrepareError>,
    {
        let mut state = self.state.lock().map_err(|_| PrepareError::SurfaceFailed)?;
        if *state != AttemptState::Pending {
            return Err(PrepareError::SurfaceFailed);
        }
        commit()?;
        *state = AttemptState::Ready;
        self.changed.notify_all();
        Ok(())
    }

    fn try_reserve_attachment(&self) -> Result<bool, PrepareError> {
        let state = self.state.lock().map_err(|_| PrepareError::SurfaceFailed)?;
        if *state != AttemptState::Pending {
            return Ok(false);
        }
        let mut attachment = self
            .attachment
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        if *attachment != AttemptAttachment::Empty {
            return Ok(false);
        }
        *attachment = AttemptAttachment::Reserved;
        Ok(true)
    }

    fn bind_attachment(&self, attach_id: String, stream_id: String) -> Result<(), PrepareError> {
        let state = self.state.lock().map_err(|_| PrepareError::SurfaceFailed)?;
        if *state != AttemptState::Pending {
            return Err(PrepareError::SurfaceFailed);
        }
        let mut attachment = self
            .attachment
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        if *attachment != AttemptAttachment::Reserved {
            return Err(PrepareError::SurfaceFailed);
        }
        *attachment = AttemptAttachment::Bound {
            attach_id,
            stream_id,
        };
        Ok(())
    }

    fn release_attachment(&self, attach_id: &str, stream_id: &str) {
        if let Ok(mut attachment) = self.attachment.lock() {
            let matches = matches!(
                &*attachment,
                AttemptAttachment::Bound {
                    attach_id: current_attach,
                    stream_id: current_stream,
                } if current_attach == attach_id && current_stream == stream_id
            );
            if matches {
                *attachment = AttemptAttachment::Empty;
            }
        }
    }

    fn release_reservation(&self) {
        if let Ok(mut attachment) = self.attachment.lock() {
            if *attachment == AttemptAttachment::Reserved {
                *attachment = AttemptAttachment::Empty;
            }
        }
    }

    fn owns_attachment(&self, attach_id: &str, stream_id: &str) -> bool {
        self.attachment.lock().is_ok_and(|attachment| {
            matches!(
                &*attachment,
                AttemptAttachment::Bound {
                    attach_id: current_attach,
                    stream_id: current_stream,
                } if current_attach == attach_id && current_stream == stream_id
            )
        })
    }

    fn take_failed_attachment(&self) -> Option<(String, String)> {
        let state = self.state.lock().ok()?;
        if *state != AttemptState::Failed {
            return None;
        }
        let mut attachment = self.attachment.lock().ok()?;
        match std::mem::replace(&mut *attachment, AttemptAttachment::Empty) {
            AttemptAttachment::Bound {
                attach_id,
                stream_id,
            } => Some((attach_id, stream_id)),
            other => {
                *attachment = other;
                None
            }
        }
    }

    pub(super) fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while *state == AttemptState::Pending {
            let now = Instant::now();
            if now >= deadline {
                *state = AttemptState::Failed;
                self.changed.notify_all();
                return false;
            }
            let Ok((next, result)) = self.changed.wait_timeout(state, deadline - now) else {
                return false;
            };
            state = next;
            if result.timed_out() && *state == AttemptState::Pending {
                *state = AttemptState::Failed;
                self.changed.notify_all();
                return false;
            }
        }
        *state == AttemptState::Ready
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PrepareError {
    Unavailable,
    SurfaceFailed,
}

#[derive(Default)]
pub(super) struct PresentationCoordinator {
    desktops: Mutex<BTreeMap<String, DesktopConnection>>,
    attempts: Mutex<HashMap<(String, u64), Arc<PresentationAttempt>>>,
    leases: Mutex<HashMap<String, ActiveSurfaceLease>>,
}

impl PresentationCoordinator {
    pub(super) fn register(
        &self,
        connection_id: String,
        request: DesktopRegisterRequest,
        high: mpsc::Sender<HighFrame>,
        deliveries: Arc<Mutex<HashMap<String, DeliveryState>>>,
    ) -> Result<(), PrepareError> {
        let mut desktops = self
            .desktops
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        desktops.insert(
            connection_id,
            DesktopConnection {
                request,
                high,
                deliveries,
            },
        );
        Ok(())
    }

    pub(super) fn is_available(&self, placement: &Placement, presentation: &Presentation) -> bool {
        self.select_desktop(placement, presentation).is_ok()
    }

    pub(super) fn desktop_available(&self) -> bool {
        self.desktops
            .lock()
            .is_ok_and(|desktops| desktops.values().any(|desktop| !desktop.high.is_closed()))
    }

    pub(super) fn connection_supports(
        &self,
        connection_id: &str,
        placement: &Placement,
        presentation: &Presentation,
    ) -> bool {
        self.desktops.lock().is_ok_and(|desktops| {
            desktops.get(connection_id).is_some_and(|desktop| {
                supports(&desktop.request, placement, presentation) && !desktop.high.is_closed()
            })
        })
    }

    pub(super) fn prepare(
        &self,
        engine: &DaemonPtyEngine,
        version: ProtocolVersion,
        event: SurfacePresentRequestedEvent,
    ) -> Result<Arc<PresentationAttempt>, PrepareError> {
        let preferred_connection = if let Ok(leases) = self.leases.lock() {
            if let Some(lease) = leases.get(&event.handle) {
                if lease.revision == event.revision {
                    return Ok(PresentationAttempt::completed(
                        event.handle,
                        event.revision,
                        lease.connection_id.clone(),
                    ));
                }
                Some(lease.connection_id.clone())
            } else {
                None
            }
        } else {
            return Err(PrepareError::SurfaceFailed);
        };

        let key = (event.handle.clone(), event.revision);
        let (attempt, desktop) = {
            // Keep lookup and insertion under one lock so concurrent create or
            // present callers join the same readiness attempt and emit one
            // surface request.
            let mut attempts = self
                .attempts
                .lock()
                .map_err(|_| PrepareError::SurfaceFailed)?;
            if let Some(attempt) = attempts.get(&key) {
                return Ok(Arc::clone(attempt));
            }
            let (connection_id, desktop) = self.select_desktop_with_preference(
                &event.placement,
                &event.presentation,
                preferred_connection.as_deref(),
            )?;
            self.detach_previous_lease(engine, &event.handle)?;
            let attempt =
                PresentationAttempt::pending(event.handle.clone(), event.revision, connection_id);
            attempts.insert(key.clone(), Arc::clone(&attempt));
            (attempt, desktop)
        };
        let payload = serde_json::to_value(&event).map_err(|_| PrepareError::SurfaceFailed)?;
        if desktop
            .high
            .try_send(HighFrame::Event(EventEnvelope {
                version,
                kind: EnvelopeKind::Event,
                event: EventName::SurfacePresentRequested,
                payload,
            }))
            .is_err()
        {
            attempt.finish(AttemptState::Failed);
            if let Ok(mut attempts) = self.attempts.lock() {
                if attempts
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &attempt))
                {
                    attempts.remove(&key);
                }
            }
            return Err(PrepareError::SurfaceFailed);
        }
        Ok(attempt)
    }

    pub(super) fn finish_wait(&self, engine: &DaemonPtyEngine, attempt: &Arc<PresentationAttempt>) {
        if let Ok(mut attempts) = self.attempts.lock() {
            let key = (attempt.handle.clone(), attempt.revision);
            if attempts
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, attempt))
            {
                attempts.remove(&key);
            }
        }
        if let Some((attach_id, stream_id)) = attempt.take_failed_attachment() {
            let _ = engine.detach(&attach_id, &stream_id);
            let desktop = self
                .desktops
                .lock()
                .ok()
                .and_then(|desktops| desktops.get(&attempt.desktop_connection_id).cloned());
            if let Some(desktop) = desktop {
                if let Ok(mut deliveries) = desktop.deliveries.lock() {
                    deliveries.remove(&attach_id);
                }
            }
        }
    }

    pub(super) fn reserve_attachment(
        &self,
        connection_id: &str,
        handle: &str,
    ) -> Result<Option<Arc<PresentationAttempt>>, PrepareError> {
        let attempts = self
            .attempts
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        let mut candidates = attempts
            .values()
            .filter(|attempt| {
                attempt.handle == handle && attempt.desktop_connection_id == connection_id
            })
            .cloned()
            .collect::<Vec<_>>();
        candidates.sort_by_key(|attempt| attempt.revision);
        for attempt in candidates {
            if attempt.try_reserve_attachment()? {
                return Ok(Some(attempt));
            }
        }
        Ok(None)
    }

    pub(super) fn bind_attachment(
        &self,
        attempt: &Arc<PresentationAttempt>,
        attach_id: String,
        stream_id: String,
    ) -> Result<(), PrepareError> {
        attempt.bind_attachment(attach_id, stream_id)
    }

    pub(super) fn release_reservation(&self, attempt: &Arc<PresentationAttempt>) {
        attempt.release_reservation();
    }

    pub(super) fn ready(
        &self,
        connection_id: &str,
        handle: &str,
        revision: u64,
        attach_id: String,
        stream_id: String,
    ) -> Result<(), PrepareError> {
        let supports = self
            .desktops
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?
            .contains_key(connection_id);
        if !supports {
            return Err(PrepareError::Unavailable);
        }
        let key = (handle.to_owned(), revision);
        let attempt = self
            .attempts
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?
            .get(&key)
            .cloned();
        if let Some(attempt) = &attempt {
            if attempt.desktop_connection_id != connection_id {
                return Err(PrepareError::SurfaceFailed);
            }
        }
        {
            let leases = self
                .leases
                .lock()
                .map_err(|_| PrepareError::SurfaceFailed)?;
            if let Some(existing) = leases.get(handle) {
                return (existing.connection_id == connection_id
                    && existing.revision == revision
                    && existing.attach_id == attach_id
                    && existing.stream_id == stream_id)
                    .then_some(())
                    .ok_or(PrepareError::SurfaceFailed);
            }
        }
        let attempt = attempt.ok_or(PrepareError::SurfaceFailed)?;
        if !attempt.owns_attachment(&attach_id, &stream_id) {
            return Err(PrepareError::SurfaceFailed);
        }
        attempt.commit_ready(|| {
            let mut leases = self
                .leases
                .lock()
                .map_err(|_| PrepareError::SurfaceFailed)?;
            if leases.contains_key(handle) {
                return Err(PrepareError::SurfaceFailed);
            }
            leases.insert(
                handle.to_owned(),
                ActiveSurfaceLease {
                    connection_id: connection_id.to_owned(),
                    revision,
                    attach_id,
                    stream_id,
                },
            );
            Ok(())
        })
    }

    pub(super) fn lease(
        &self,
        connection_id: &str,
        handle: &str,
        revision: u64,
        attach_id: &str,
        stream_id: &str,
    ) -> Result<ActiveSurfaceLease, PrepareError> {
        let leases = self
            .leases
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        let lease = leases.get(handle).ok_or(PrepareError::SurfaceFailed)?;
        (lease.connection_id == connection_id
            && lease.revision == revision
            && lease.attach_id == attach_id
            && lease.stream_id == stream_id)
            .then(|| lease.clone())
            .ok_or(PrepareError::SurfaceFailed)
    }

    pub(super) fn remove_lease(&self, handle: &str, revision: u64) {
        if let Ok(mut leases) = self.leases.lock() {
            if leases
                .get(handle)
                .is_some_and(|lease| lease.revision == revision)
            {
                leases.remove(handle);
            }
        }
    }

    pub(super) fn release_attachment(&self, connection_id: &str, attach_id: &str, stream_id: &str) {
        if let Ok(attempts) = self.attempts.lock() {
            for attempt in attempts.values() {
                if attempt.desktop_connection_id == connection_id {
                    attempt.release_attachment(attach_id, stream_id);
                }
            }
        }
        if let Ok(mut leases) = self.leases.lock() {
            leases.retain(|_, lease| {
                lease.connection_id != connection_id
                    || lease.attach_id != attach_id
                    || lease.stream_id != stream_id
            });
        }
    }

    pub(super) fn disconnect(&self, connection_id: &str) {
        if let Ok(mut desktops) = self.desktops.lock() {
            desktops.remove(connection_id);
        }
        if let Ok(mut leases) = self.leases.lock() {
            leases.retain(|_, lease| lease.connection_id != connection_id);
        }
        let pending = self
            .attempts
            .lock()
            .map(|attempts| {
                attempts
                    .values()
                    .filter(|attempt| attempt.desktop_connection_id == connection_id)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for attempt in pending {
            attempt.finish(AttemptState::Failed);
        }
    }

    pub(super) fn session_closed(&self, handle: &str) {
        if let Ok(mut leases) = self.leases.lock() {
            leases.remove(handle);
        }
        let pending = self
            .attempts
            .lock()
            .map(|mut attempts| {
                let keys = attempts
                    .keys()
                    .filter(|(attempt_handle, _)| attempt_handle == handle)
                    .cloned()
                    .collect::<Vec<_>>();
                keys.into_iter()
                    .filter_map(|key| attempts.remove(&key))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for attempt in pending {
            attempt.finish(AttemptState::Failed);
        }
    }

    fn select_desktop(
        &self,
        placement: &Placement,
        presentation: &Presentation,
    ) -> Result<(String, DesktopConnection), PrepareError> {
        self.select_desktop_with_preference(placement, presentation, None)
    }

    fn select_desktop_with_preference(
        &self,
        placement: &Placement,
        presentation: &Presentation,
        preferred_connection: Option<&str>,
    ) -> Result<(String, DesktopConnection), PrepareError> {
        let desktops = self
            .desktops
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?;
        if let Some(preferred_connection) = preferred_connection {
            if let Some(desktop) = desktops.get(preferred_connection) {
                if supports(&desktop.request, placement, presentation) && !desktop.high.is_closed()
                {
                    return Ok((preferred_connection.to_owned(), desktop.clone()));
                }
            }
        }
        desktops
            .iter()
            .find(|(_, desktop)| {
                supports(&desktop.request, placement, presentation) && !desktop.high.is_closed()
            })
            .map(|(id, desktop)| (id.clone(), desktop.clone()))
            .ok_or(PrepareError::Unavailable)
    }

    fn detach_previous_lease(
        &self,
        engine: &DaemonPtyEngine,
        handle: &str,
    ) -> Result<(), PrepareError> {
        let previous = self
            .leases
            .lock()
            .map_err(|_| PrepareError::SurfaceFailed)?
            .remove(handle);
        if let Some(previous) = previous {
            engine
                .detach(&previous.attach_id, &previous.stream_id)
                .map_err(|_| PrepareError::SurfaceFailed)?;
            if let Ok(desktops) = self.desktops.lock() {
                if let Some(desktop) = desktops.get(&previous.connection_id) {
                    if let Ok(mut deliveries) = desktop.deliveries.lock() {
                        deliveries.remove(&previous.attach_id);
                    }
                }
            }
        }
        Ok(())
    }
}

fn supports(
    request: &DesktopRegisterRequest,
    placement: &Placement,
    presentation: &Presentation,
) -> bool {
    request
        .placements
        .iter()
        .any(|supported| supported == placement)
        && (*presentation != Presentation::Background || request.background_presentation)
}

pub(super) fn map_target(
    placement: &Placement,
    workspace_target: Option<String>,
) -> Result<PresentationTarget, PrepareError> {
    match placement {
        Placement::Workspace => workspace_target
            .map(|normalized_path| PresentationTarget::Workspace { normalized_path })
            .ok_or(PrepareError::SurfaceFailed),
        Placement::Window => Ok(PresentationTarget::Window),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_host_core::{PtyRuntimeConfig, RuntimeIdentity};
    use terminal_host_protocol::{PROTOCOL_VERSION, SURFACE_PRESENTATION_V1};

    fn engine() -> (tempfile::TempDir, DaemonPtyEngine) {
        let temp = tempfile::tempdir().unwrap();
        let (engine, _) = DaemonPtyEngine::open(
            temp.path().join("runtime.sqlite"),
            RuntimeIdentity {
                runtime_id: "runtime".into(),
                launch_nonce: "nonce".into(),
            },
            PtyRuntimeConfig::default(),
        )
        .unwrap();
        (temp, engine)
    }

    fn register(
        coordinator: &PresentationCoordinator,
    ) -> (
        mpsc::Receiver<HighFrame>,
        Arc<Mutex<HashMap<String, DeliveryState>>>,
    ) {
        let (high, events) = mpsc::channel(16);
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        coordinator
            .register(
                "desktop-a".into(),
                DesktopRegisterRequest {
                    surface_protocol_version: SURFACE_PRESENTATION_V1.into(),
                    placements: vec![Placement::Workspace, Placement::Window],
                    background_presentation: true,
                },
                high,
                Arc::clone(&deliveries),
            )
            .unwrap();
        (events, deliveries)
    }

    fn event() -> SurfacePresentRequestedEvent {
        SurfacePresentRequestedEvent {
            handle: "handle-a".into(),
            revision: 1,
            placement: Placement::Window,
            workspace_target: None,
            presentation: Presentation::Background,
        }
    }

    #[test]
    fn concurrent_prepare_joins_one_attempt_and_emits_one_request() {
        let (_temp, engine) = engine();
        let coordinator = PresentationCoordinator::default();
        let (mut events, _) = register(&coordinator);
        let attempts = std::thread::scope(|scope| {
            let workers = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        coordinator
                            .prepare(&engine, PROTOCOL_VERSION, event())
                            .unwrap()
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(attempts
            .iter()
            .all(|attempt| Arc::ptr_eq(attempt, &attempts[0])));
        assert!(matches!(events.try_recv(), Ok(HighFrame::Event(_))));
        assert!(events.try_recv().is_err());
        coordinator.disconnect("desktop-a");
        assert!(!attempts[0].wait(Duration::ZERO));
        coordinator.finish_wait(&engine, &attempts[0]);
    }

    #[test]
    fn ready_requires_live_matching_attempt_and_remains_idempotent_for_exact_lease() {
        let (_temp, engine) = engine();
        let coordinator = PresentationCoordinator::default();
        let (mut events, _) = register(&coordinator);
        let (other_high, _other_events) = mpsc::channel(8);
        coordinator
            .register(
                "desktop-b".into(),
                DesktopRegisterRequest {
                    surface_protocol_version: SURFACE_PRESENTATION_V1.into(),
                    placements: vec![Placement::Workspace, Placement::Window],
                    background_presentation: true,
                },
                other_high,
                Arc::new(Mutex::new(HashMap::new())),
            )
            .unwrap();
        assert_eq!(
            coordinator.ready(
                "desktop-a",
                "handle-a",
                1,
                "attach-a".into(),
                "stream-a".into(),
            ),
            Err(PrepareError::SurfaceFailed)
        );

        let attempt = coordinator
            .prepare(&engine, PROTOCOL_VERSION, event())
            .unwrap();
        assert!(matches!(events.try_recv(), Ok(HighFrame::Event(_))));
        let reservation = coordinator
            .reserve_attachment("desktop-a", "handle-a")
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&attempt, &reservation));
        coordinator
            .bind_attachment(&reservation, "attach-a".into(), "stream-a".into())
            .unwrap();
        assert_eq!(
            coordinator.ready(
                "desktop-b",
                "handle-a",
                1,
                "attach-a".into(),
                "stream-a".into(),
            ),
            Err(PrepareError::SurfaceFailed)
        );
        coordinator
            .ready(
                "desktop-a",
                "handle-a",
                1,
                "attach-a".into(),
                "stream-a".into(),
            )
            .unwrap();
        assert!(attempt.wait(Duration::ZERO));
        coordinator.finish_wait(&engine, &attempt);
        coordinator
            .ready(
                "desktop-a",
                "handle-a",
                1,
                "attach-a".into(),
                "stream-a".into(),
            )
            .unwrap();
        coordinator.release_attachment("desktop-a", "attach-a", "stream-a");
        assert_eq!(
            coordinator.lease("desktop-a", "handle-a", 1, "attach-a", "stream-a"),
            Err(PrepareError::SurfaceFailed)
        );
    }

    #[test]
    fn ready_after_attempt_timeout_cannot_install_a_lease() {
        let (_temp, engine) = engine();
        let coordinator = PresentationCoordinator::default();
        let (mut events, _) = register(&coordinator);
        let attempt = coordinator
            .prepare(&engine, PROTOCOL_VERSION, event())
            .unwrap();
        assert!(matches!(events.try_recv(), Ok(HighFrame::Event(_))));
        let reservation = coordinator
            .reserve_attachment("desktop-a", "handle-a")
            .unwrap()
            .unwrap();
        coordinator
            .bind_attachment(&reservation, "attach-a".into(), "stream-a".into())
            .unwrap();
        assert!(!attempt.wait(Duration::ZERO));
        assert_eq!(
            coordinator.ready(
                "desktop-a",
                "handle-a",
                1,
                "attach-a".into(),
                "stream-a".into(),
            ),
            Err(PrepareError::SurfaceFailed)
        );
        assert_eq!(
            coordinator.lease("desktop-a", "handle-a", 1, "attach-a", "stream-a"),
            Err(PrepareError::SurfaceFailed)
        );
        coordinator.finish_wait(&engine, &attempt);
    }

    #[test]
    fn transfer_prefers_the_current_desktop_over_lexicographic_reselection() {
        let (_temp, engine) = engine();
        let coordinator = PresentationCoordinator::default();
        let (current_high, mut current_events) = mpsc::channel(8);
        coordinator
            .register(
                "desktop-z".into(),
                DesktopRegisterRequest {
                    surface_protocol_version: SURFACE_PRESENTATION_V1.into(),
                    placements: vec![Placement::Workspace, Placement::Window],
                    background_presentation: true,
                },
                current_high,
                Arc::new(Mutex::new(HashMap::new())),
            )
            .unwrap();
        let first = coordinator
            .prepare(&engine, PROTOCOL_VERSION, event())
            .unwrap();
        assert!(matches!(current_events.try_recv(), Ok(HighFrame::Event(_))));
        let reservation = coordinator
            .reserve_attachment("desktop-z", "handle-a")
            .unwrap()
            .unwrap();
        coordinator
            .bind_attachment(&reservation, "attach-z".into(), "stream-z".into())
            .unwrap();
        coordinator
            .ready(
                "desktop-z",
                "handle-a",
                1,
                "attach-z".into(),
                "stream-z".into(),
            )
            .unwrap();
        assert!(first.wait(Duration::ZERO));
        coordinator.finish_wait(&engine, &first);

        let (other_high, mut other_events) = mpsc::channel(8);
        coordinator
            .register(
                "desktop-a".into(),
                DesktopRegisterRequest {
                    surface_protocol_version: SURFACE_PRESENTATION_V1.into(),
                    placements: vec![Placement::Workspace, Placement::Window],
                    background_presentation: true,
                },
                other_high,
                Arc::new(Mutex::new(HashMap::new())),
            )
            .unwrap();
        let second = coordinator
            .prepare(
                &engine,
                PROTOCOL_VERSION,
                SurfacePresentRequestedEvent {
                    revision: 2,
                    ..event()
                },
            )
            .unwrap();
        assert!(matches!(current_events.try_recv(), Ok(HighFrame::Event(_))));
        assert!(other_events.try_recv().is_err());
        coordinator.disconnect("desktop-z");
        assert!(!second.wait(Duration::ZERO));
        coordinator.finish_wait(&engine, &second);
    }
}
