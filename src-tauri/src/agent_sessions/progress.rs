use super::types::{AgentSessionCatalogPhase, AgentSessionCatalogProgress, AgentSessionProvider};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub(crate) const CATALOG_PROGRESS_EVENT: &str = "agent-session://catalog-progress";
pub(crate) const CATALOG_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const CATALOG_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);
const CATALOG_CANCELLED_ERROR: &str = "Agent session catalog scan was cancelled";

static ACTIVE_SCANS: Lazy<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LastProgress {
    phase: AgentSessionCatalogPhase,
    completed: usize,
    total: Option<usize>,
    emitted_at: Instant,
}

#[derive(Clone)]
pub(crate) struct CatalogProgressReporter {
    app: Option<AppHandle>,
    request_id: u64,
    provider: AgentSessionProvider,
    started_at: Instant,
    cancelled: Arc<AtomicBool>,
    last_progress: Arc<Mutex<Option<LastProgress>>>,
}

pub(crate) struct CatalogScanRegistration {
    request_id: u64,
    cancelled: Arc<AtomicBool>,
}

pub(crate) fn register_catalog_scan(
    app: AppHandle,
    request_id: u64,
    provider: AgentSessionProvider,
) -> (CatalogScanRegistration, CatalogProgressReporter) {
    register_catalog_scan_inner(Some(app), request_id, provider)
}

fn register_catalog_scan_inner(
    app: Option<AppHandle>,
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
    };
    let reporter = CatalogProgressReporter {
        app,
        request_id,
        provider,
        started_at: Instant::now(),
        cancelled,
        last_progress: Arc::new(Mutex::new(None)),
    };
    (registration, reporter)
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
        if let Some(app) = &self.app {
            let _ = app.emit(
                CATALOG_PROGRESS_EVENT,
                AgentSessionCatalogProgress {
                    request_id: self.request_id,
                    provider: self.provider,
                    phase,
                    completed,
                    total,
                    elapsed_ms: self.elapsed_ms(),
                },
            );
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
}
