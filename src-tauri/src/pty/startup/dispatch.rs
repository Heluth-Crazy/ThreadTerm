use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{
    emit_startup_state, PtyStartupSnapshot, PtyStartupTrigger, StartupEffectDescriptor,
    StartupReadinessPolicy,
};
use crate::pty::registry;
use crate::pty::session::{self, PtySession, SessionState};
use crate::pty::writer::WriteCompletion;

#[cfg(feature = "terminal-startup-harness")]
use crate::terminal_startup_harness::{HarnessDriveAction, HarnessTiming};

struct EffectContext {
    dispatcher: super::StartupSideEffectDispatcher,
    project_path: String,
}

/// Arm startup after output observation and registry publication are live.
/// The create path configures marker/first-output filtering before this call.
#[cfg(not(feature = "terminal-startup-harness"))]
pub(crate) fn arm_startup(
    id: String,
    session: Arc<PtySession>,
    policy: StartupReadinessPolicy,
) -> Result<(), String> {
    arm_startup_inner(id, session, policy, false)
}

/// Feature-only arm seam used by the WebDriver timing harness. Non-natural
/// cases deliberately do not start the production deadline thread; the
/// harness drives the same coordinator transitions explicitly.
#[cfg(feature = "terminal-startup-harness")]
pub(crate) fn arm_startup_with_harness(
    id: String,
    session: Arc<PtySession>,
    policy: StartupReadinessPolicy,
    timing: HarnessTiming,
) -> Result<(), String> {
    arm_startup_inner(
        id,
        session,
        policy,
        !matches!(timing, HarnessTiming::Natural),
    )
}

fn arm_startup_inner(
    id: String,
    session: Arc<PtySession>,
    policy: StartupReadinessPolicy,
    suppress_automatic_timing: bool,
) -> Result<(), String> {
    if suppress_automatic_timing {
        return Ok(());
    }
    match policy {
        StartupReadinessPolicy::Immediate => {
            mark_ready_and_dispatch(&id, &session, PtyStartupTrigger::Immediate)?;
        }
        StartupReadinessPolicy::Marker { timeout_ms }
        | StartupReadinessPolicy::FirstOutput { timeout_ms } => {
            let generation = session.generation.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(timeout_ms));
                dispatch_timeout(&id, &session, &generation);
            });
        }
    }
    Ok(())
}

/// Pure deadline seam: tests call this directly instead of waiting for a timer.
pub(crate) fn dispatch_timeout(id: &str, session: &Arc<PtySession>, generation: &str) {
    if session.generation != generation || !registry::is_current(id, session) {
        return;
    }
    let _ = mark_ready_and_dispatch(id, session, PtyStartupTrigger::Timeout);
}

pub(crate) fn dispatch_if_ready(id: &str, session: &Arc<PtySession>) -> Result<bool, String> {
    if !registry::is_current(id, session) {
        return Ok(false);
    }
    let Some(dispatch) = session
        .startup
        .take_dispatch(|snapshot| publish(id, session, snapshot))?
    else {
        return Ok(false);
    };
    let effect_context = match effect_context(session) {
        Ok(context) => context,
        Err(error) => {
            // A Provider write without the process-owned effect context would
            // make `sent` permanently lose record/bind/discovery. Fail before
            // enqueueing so an explicit restart gets a fresh generation.
            let _ = session
                .startup
                .complete_dispatch(false, |snapshot| publish(id, session, snapshot));
            fail_generation(id, session);
            return Err(error);
        }
    };
    // Record the effect identity before handing any bytes to the writer. If
    // this invariant cannot be established, fail this generation before it
    // can commit a command and strand the coordinator in Dispatching.
    let sent_at_ms = match session.startup.record_sent_at_ms(now_ms()) {
        Ok(sent_at_ms) => sent_at_ms,
        Err(error) => {
            let _ = session
                .startup
                .complete_dispatch(false, |snapshot| publish(id, session, snapshot));
            fail_generation(id, session);
            return Err(error);
        }
    };
    let completion = session.writer.enqueue_startup(dispatch.command_bytes());
    let success = matches!(completion, WriteCompletion::Committed { bytes } if bytes == dispatch.command_bytes().len());
    if success {
        let sent = match session
            .startup
            .complete_dispatch(true, |snapshot| publish(id, session, snapshot))
        {
            Ok(sent) => sent,
            Err(error) => {
                fail_generation(id, session);
                return Err(error);
            }
        };
        if sent {
            submit_effect(session, id, dispatch.effect(), sent_at_ms, effect_context)?;
        }
        return Ok(sent);
    }
    let transition = session
        .startup
        .complete_dispatch(false, |snapshot| publish(id, session, snapshot));
    fail_generation(id, session);
    transition.map(|_| false)
}

/// Matching and legacy attach paths may call this after installing the
/// process-owned context. The ledger makes the re-submit safe and retryable.
pub(crate) fn resubmit_sent_effects(id: &str, session: &Arc<PtySession>) -> Result<(), String> {
    if !registry::is_current(id, session) {
        return Ok(());
    }
    let Some(effect) = session.startup.sent_effect()? else {
        return Ok(());
    };
    let Some(sent_at_ms) = session.startup.sent_at_ms()? else {
        return Ok(());
    };
    submit_effect(session, id, &effect, sent_at_ms, effect_context(session)?)
}

fn mark_ready_and_dispatch(
    id: &str,
    session: &Arc<PtySession>,
    trigger: PtyStartupTrigger,
) -> Result<bool, String> {
    if trigger == PtyStartupTrigger::Timeout {
        session
            .startup
            .deadline(|snapshot| publish(id, session, snapshot))?;
    } else {
        session
            .startup
            .mark_ready(trigger, |snapshot| publish(id, session, snapshot))?;
    }
    dispatch_if_ready(id, session)
}

/// Feature-only timing driver. It never writes a Provider command directly;
/// every action goes through the coordinator lease and the existing writer.
#[cfg(feature = "terminal-startup-harness")]
pub(crate) fn drive_harness_case(
    id: &str,
    session: &Arc<PtySession>,
    generation: &str,
    timing: HarnessTiming,
    action: HarnessDriveAction,
) -> Result<bool, String> {
    if session.generation != generation || !registry::is_current(id, session) {
        return Err("harness_stale_identity".to_owned());
    }
    let ready_trigger = if matches!(session.shell_family, super::PtyShellFamily::Cmd) {
        PtyStartupTrigger::FirstOutput
    } else {
        PtyStartupTrigger::Marker
    };
    match (timing, action) {
        (HarnessTiming::HoldMarker, HarnessDriveAction::ReleaseReady)
        | (HarnessTiming::LateMarker, HarnessDriveAction::ReleaseReady) => {
            if matches!(timing, HarnessTiming::LateMarker)
                && !matches!(
                    session.startup.snapshot()?.state,
                    super::PtyStartupState::Sent
                )
            {
                // LateMarker is intentionally timeout-first. A ready signal
                // before that point would dispatch too early.
                return Err("harness_late_marker_order".to_owned());
            }
            mark_ready_and_dispatch(id, session, ready_trigger)
        }
        (HarnessTiming::ManualTimeout, HarnessDriveAction::FireTimeout)
        | (HarnessTiming::LateMarker, HarnessDriveAction::FireTimeout) => {
            mark_ready_and_dispatch(id, session, PtyStartupTrigger::Timeout)
        }
        (HarnessTiming::SameTick, HarnessDriveAction::RaceReadyTimeout) => {
            race_ready_timeout(id, session, ready_trigger)
        }
        _ => Err("harness_invalid_timing_action".to_owned()),
    }
}

/// Synchronize the two real coordinator transitions before joining. The
/// coordinator's dispatch lease still decides the winner, so exactly one
/// worker can enqueue startup bytes even when both signals arrive together.
#[cfg(feature = "terminal-startup-harness")]
fn race_ready_timeout(
    id: &str,
    session: &Arc<PtySession>,
    ready_trigger: PtyStartupTrigger,
) -> Result<bool, String> {
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers = [ready_trigger, PtyStartupTrigger::Timeout]
        .into_iter()
        .map(|trigger| {
            let barrier = Arc::clone(&barrier);
            let session = Arc::clone(session);
            let id = id.to_owned();
            std::thread::spawn(move || {
                barrier.wait();
                if trigger == PtyStartupTrigger::Timeout {
                    session
                        .startup
                        .deadline(|snapshot| publish(&id, &session, snapshot))?;
                } else {
                    session
                        .startup
                        .mark_ready(trigger, |snapshot| publish(&id, &session, snapshot))?;
                }
                dispatch_if_ready(&id, &session)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    join_race_workers(workers)
}

#[cfg(feature = "terminal-startup-harness")]
fn join_race_workers(
    workers: Vec<std::thread::JoinHandle<Result<bool, String>>>,
) -> Result<bool, String> {
    let mut sent = false;
    let mut first_error = None;
    for worker in workers {
        match worker.join() {
            Ok(Ok(result)) => sent |= result,
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some("harness_same_tick_worker_failed".to_owned());
                }
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(sent),
    }
}

fn submit_effect(
    session: &PtySession,
    id: &str,
    effect: &StartupEffectDescriptor,
    sent_at_ms: u64,
    context: EffectContext,
) -> Result<(), String> {
    context.dispatcher.submit(
        session.app_handle.clone(),
        super::StartupSideEffectRequest {
            pty_id: id.to_owned(),
            generation: session.generation.clone(),
            provider: effect.provider(),
            card_id: effect.card_id().to_owned(),
            project_path: context.project_path,
            sent_at_ms,
            side_effect_plan: effect.side_effect_plan().clone(),
        },
    )
}

fn effect_context(session: &PtySession) -> Result<EffectContext, String> {
    let context = session
        .startup_side_effects
        .lock()
        .map_err(|_| "startup_side_effect_context_unavailable".to_string())?;
    require_effect_context(context.as_ref().map(|context| EffectContext {
        dispatcher: context.dispatcher.clone(),
        project_path: context.project_path.clone(),
    }))
}

fn require_effect_context(context: Option<EffectContext>) -> Result<EffectContext, String> {
    context.ok_or_else(|| "startup_side_effect_context_required".to_string())
}

fn publish(id: &str, session: &Arc<PtySession>, snapshot: &PtyStartupSnapshot) {
    if registry::is_current(id, session) {
        emit_startup_state(&session.app_handle, snapshot);
    }
}

fn fail_generation(id: &str, session: &Arc<PtySession>) {
    session::mark_killed(session);
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    let _ = session::close_master(session, id);
    session::set_session_state(session, id, SessionState::Failed);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::require_effect_context;
    #[cfg(feature = "terminal-startup-harness")]
    use std::sync::Arc;

    #[test]
    fn missing_effect_context_is_a_stable_prewrite_invariant_error() {
        match require_effect_context(None) {
            Err(error) => assert_eq!(error, "startup_side_effect_context_required"),
            Ok(_) => panic!("missing context must reject dispatch"),
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn same_tick_join_collects_all_workers_after_first_error() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let second_finished = Arc::new(AtomicBool::new(false));
        let first = std::thread::spawn(|| Err("first".to_owned()));
        let finished = Arc::clone(&second_finished);
        let second = std::thread::spawn(move || {
            finished.store(true, Ordering::Release);
            Ok(false)
        });

        let result = super::join_race_workers(vec![first, second]);
        assert_eq!(result, Err("first".to_owned()));
        assert!(second_finished.load(Ordering::Acquire));
    }
}
