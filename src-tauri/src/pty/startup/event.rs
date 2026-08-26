use super::types::PtyStartupSnapshot;

pub(crate) const PTY_STARTUP_STATE_EVENT: &str = "pty-startup-state";

/// A startup event/query is valid only for the generation that owns the
/// session. Keeping this comparison separate makes stale responses easy to
/// reject without touching the process-global registry in tests.
pub(crate) fn generation_matches(current: &str, requested: &str) -> bool {
    current == requested
}

/// Return a snapshot only when the requested generation is current. The
/// closure is deliberately not evaluated for a stale generation, so a stale
/// caller cannot observe a poisoned/replaced startup runtime.
pub(crate) fn snapshot_for_generation<F>(
    current: &str,
    requested: &str,
    snapshot: F,
) -> Result<Option<PtyStartupSnapshot>, String>
where
    F: FnOnce() -> Result<PtyStartupSnapshot, String>,
{
    if !generation_matches(current, requested) {
        return Ok(None);
    }
    snapshot().map(Some)
}
