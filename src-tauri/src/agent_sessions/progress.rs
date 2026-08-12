use super::types::{AgentSessionCatalogPhase, AgentSessionCatalogProgress, AgentSessionProvider};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

pub(crate) const CATALOG_PROGRESS_EVENT: &str = "agent-session://catalog-progress";
pub(crate) const CATALOG_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const CATALOG_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);
const CATALOG_CANCELLED_ERROR: &str = "Agent session catalog scan was cancelled";

static ACTIVE_SCANS: Lazy<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

type CatalogProgressSink =
    Arc<dyn Fn(AgentSessionCatalogProgress) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LastProgress {
    phase: AgentSessionCatalogPhase,
    completed: usize,
    total: Option<usize>,
    emitted_at: Instant,
}

#[derive(Clone)]
pub(crate) struct CatalogProgressReporter {
    sink: Option<CatalogProgressSink>,
    request_id: u64,
    provider: AgentSessionProvider,
    started_at: Instant,
    cancelled: Arc<AtomicBool>,
    last_progress: Arc<Mutex<Option<LastProgress>>>,
    emit_gate: Arc<Mutex<()>>,
}

pub(crate) struct CatalogScanRegistration {
    request_id: u64,
    cancelled: Arc<AtomicBool>,
    heartbeat: Option<CatalogHeartbeatLease>,
}

struct CatalogHeartbeatLease {
    task: JoinHandle<()>,
}

pub(crate) fn register_catalog_scan(
    app: AppHandle,
    request_id: u64,
    provider: AgentSessionProvider,
) -> (CatalogScanRegistration, CatalogProgressReporter) {
    let sink: CatalogProgressSink = Arc::new(move |progress| {
        app.emit(CATALOG_PROGRESS_EVENT, progress)
            .map_err(|error| error.to_string())
    });
    let (mut registration, reporter) =
        register_catalog_scan_inner(Some(sink), request_id, provider);
    registration.heartbeat = Some(CatalogHeartbeatLease::spawn(
        reporter.clone(),
        CATALOG_HEARTBEAT_INTERVAL,
    ));
    (registration, reporter)
}

fn register_catalog_scan_inner(
    sink: Option<CatalogProgressSink>,
    request_id: u64,
    provider: AgentSessionProvider,
) -> (CatalogScanRegistration, CatalogProgressReporter) {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut scans) = ACTIVE_SCANS.lock() {
        if let Some(previous) = scans.insert(request_id, cancelled.clone()) {
            previous.store(true, Ordering::Release);
        }
    }
    let registration = CatalogScanRegistration {
        request_id,
        cancelled: cancelled.clone(),
        heartbeat: None,
    };
    let reporter = CatalogProgressReporter {
        sink,
        request_id,
        provider,
        started_at: Instant::now(),
        cancelled,
        last_progress: Arc::new(Mutex::new(None)),
        emit_gate: Arc::new(Mutex::new(())),
    };
    (registration, reporter)
}

impl CatalogHeartbeatLease {
    fn spawn(reporter: CatalogProgressReporter, interval: Duration) -> Self {
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Consume Tokio's immediate first tick. Provider code emits the
            // initial truthful phase; the lease only fills later quiet gaps.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if reporter.heartbeat().is_err() {
                    break;
                }
            }
        });
        Self { task }
    }
}

impl Drop for CatalogHeartbeatLease {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
pub(crate) fn test_catalog_scan(
    request_id: u64,
    provider: AgentSessionProvider,
) -> (CatalogScanRegistration, CatalogProgressReporter) {
    register_catalog_scan_inner(None, request_id, provider)
}

pub(crate) fn cancel_catalog_scan(request_id: u64) -> bool {
    let Ok(scans) = ACTIVE_SCANS.lock() else {
        return false;
    };
    let Some(cancelled) = scans.get(&request_id) else {
        return false;
    };
    cancelled.store(true, Ordering::Release);
    true
}

impl CatalogProgressReporter {
    pub(crate) fn provider(&self) -> AgentSessionProvider {
        self.provider
    }

    pub(crate) fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn check_cancelled(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CATALOG_CANCELLED_ERROR.to_string())
        } else {
            Ok(())
        }
    }

    pub(crate) fn report(
        &self,
        phase: AgentSessionCatalogPhase,
        completed: usize,
        total: Option<usize>,
    ) -> Result<(), String> {
        self.check_cancelled()?;
        let _emit_guard = self
            .emit_gate
            .lock()
            .map_err(|_| "Agent session catalog progress lock was poisoned".to_string())?;
        self.check_cancelled()?;
        let now = Instant::now();
        let should_emit = self.last_progress.lock().map_or(true, |mut last| {
            let changed_phase = last.as_ref().map_or(true, |value| value.phase != phase);
            let completed_work = total.is_some_and(|value| completed >= value);
            let interval_elapsed = last.as_ref().map_or(true, |value| {
                now.duration_since(value.emitted_at) >= CATALOG_PROGRESS_THROTTLE
            });
            let emit = changed_phase || completed == 0 || completed_work || interval_elapsed;
            if emit {
                *last = Some(LastProgress {
                    phase,
                    completed,
                    total,
                    emitted_at: now,
                });
            }
            emit
        });
        if !should_emit {
            return Ok(());
        }
        self.emit_progress(phase, completed, total);
        Ok(())
    }

    pub(crate) fn report_now(
        &self,
        phase: AgentSessionCatalogPhase,
        completed: usize,
        total: Option<usize>,
    ) -> Result<(), String> {
        self.check_cancelled()?;
        let _emit_guard = self
            .emit_gate
            .lock()
            .map_err(|_| "Agent session catalog progress lock was poisoned".to_string())?;
        self.check_cancelled()?;
        if let Ok(mut last) = self.last_progress.lock() {
            *last = Some(LastProgress {
                phase,
                completed,
                total,
                emitted_at: Instant::now(),
            });
        }
        self.emit_progress(phase, completed, total);
        Ok(())
    }

    fn heartbeat(&self) -> Result<(), String> {
        self.check_cancelled()?;
        let _emit_guard = self
            .emit_gate
            .lock()
            .map_err(|_| "Agent session catalog progress lock was poisoned".to_string())?;
        self.check_cancelled()?;
        let last = self
            .last_progress
            .lock()
            .ok()
            .and_then(|progress| progress.as_ref().copied());
        if let Some(last) = last {
            self.emit_progress(last.phase, last.completed, last.total);
        }
        Ok(())
    }

    fn emit_progress(
        &self,
        phase: AgentSessionCatalogPhase,
        completed: usize,
        total: Option<usize>,
    ) {
        tracing::debug!(
            provider = self.provider.as_str(),
            phase = ?phase,
            completed,
            total,
            elapsed_ms = self.elapsed_ms(),
            "Agent session catalog scan progress"
        );
        let progress = AgentSessionCatalogProgress {
            request_id: self.request_id,
            provider: self.provider,
            phase,
            completed,
            total,
            elapsed_ms: self.elapsed_ms(),
        };
        if let Some(sink) = &self.sink {
            if let Err(error) = sink(progress) {
                tracing::warn!(
                    request_id = self.request_id,
                    provider = self.provider.as_str(),
                    phase = ?phase,
                    error = %error,
                    "Failed to emit agent session catalog progress"
                );
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn test_last_progress(
        &self,
    ) -> Option<(AgentSessionCatalogPhase, usize, Option<usize>)> {
        self.last_progress.lock().ok().and_then(|last| {
            last.as_ref()
                .map(|value| (value.phase, value.completed, value.total))
        })
    }
}

impl Drop for CatalogScanRegistration {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut scans) = ACTIVE_SCANS.lock() {
            if scans
                .get(&self.request_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
            {
                scans.remove(&self.request_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_catalog_scan_with_heartbeat(
        request_id: u64,
        provider: AgentSessionProvider,
        interval: Duration,
    ) -> (
        CatalogScanRegistration,
        CatalogProgressReporter,
        Arc<Mutex<Vec<AgentSessionCatalogProgress>>>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: CatalogProgressSink = Arc::new(move |progress| {
            captured
                .lock()
                .map_err(|error| error.to_string())?
                .push(progress);
            Ok(())
        });
        let (mut registration, reporter) =
            register_catalog_scan_inner(Some(sink), request_id, provider);
        registration.heartbeat = Some(CatalogHeartbeatLease::spawn(reporter.clone(), interval));
        (registration, reporter, events)
    }

    #[test]
    fn cancellation_is_correlated_and_registration_unregisters_on_drop() {
        let (registration, reporter) =
            register_catalog_scan_inner(None, 701, AgentSessionProvider::Claude);
        assert!(!reporter.is_cancelled());
        assert!(cancel_catalog_scan(701));
        assert!(reporter.check_cancelled().is_err());
        drop(registration);
        assert!(!cancel_catalog_scan(701));
    }

    #[test]
    fn replacing_an_id_cancels_only_the_previous_generation() {
        let (first_registration, first) =
            register_catalog_scan_inner(None, 702, AgentSessionProvider::Claude);
        let (second_registration, second) =
            register_catalog_scan_inner(None, 702, AgentSessionProvider::Codex);
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        drop(first_registration);
        assert!(cancel_catalog_scan(702));
        drop(second_registration);
        assert!(!cancel_catalog_scan(702));
    }

    #[tokio::test]
    async fn heartbeat_replays_the_last_truthful_snapshot_and_stops_with_its_registration() {
        let (registration, reporter, events) = test_catalog_scan_with_heartbeat(
            703,
            AgentSessionProvider::Opencode,
            Duration::from_millis(10),
        );
        reporter
            .report(AgentSessionCatalogPhase::Enriching, 3, Some(9))
            .expect("initial progress");

        let deadline = Instant::now() + Duration::from_millis(500);
        while events.lock().expect("heartbeat events").len() < 3 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let captured = events.lock().expect("captured events").clone();
        assert!(captured.len() >= 3, "captured {captured:?}");
        assert!(captured.iter().all(|event| {
            event.request_id == 703
                && event.provider == AgentSessionProvider::Opencode
                && event.phase == AgentSessionCatalogPhase::Enriching
                && event.completed == 3
                && event.total == Some(9)
        }));
        assert!(captured
            .windows(2)
            .all(|pair| pair[0].elapsed_ms <= pair[1].elapsed_ms));

        drop(registration);
        tokio::time::sleep(Duration::from_millis(20)).await;
        let settled_count = events.lock().expect("events after abort").len();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            events.lock().expect("events after drop").len(),
            settled_count
        );
    }

    #[tokio::test]
    async fn cancellation_stops_heartbeat_without_inventing_progress() {
        let (_registration, reporter, events) = test_catalog_scan_with_heartbeat(
            704,
            AgentSessionProvider::Codex,
            Duration::from_millis(10),
        );
        reporter
            .report(AgentSessionCatalogPhase::Listing, 0, None)
            .expect("initial progress");
        tokio::time::sleep(Duration::from_millis(16)).await;
        assert!(cancel_catalog_scan(704));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let count_after_cancel = events.lock().expect("events after cancellation").len();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            events.lock().expect("events after cancellation").len(),
            count_after_cancel
        );
        assert!(events.lock().expect("truthful events").iter().all(|event| {
            event.phase == AgentSessionCatalogPhase::Listing
                && event.completed == 0
                && event.total.is_none()
        }));
    }
}
