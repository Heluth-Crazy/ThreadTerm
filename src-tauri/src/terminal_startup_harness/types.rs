//! Typed, privacy-safe request values for the feature-only startup harness.
//!
//! These values are intentionally all enums (apart from the generated case
//! token held by the facade).  In particular, the request has no command,
//! cwd, provider/session identifier, environment, or free-form text field.

use serde::{Deserialize, Serialize};

/// Shell selection accepted by a harness case.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessShell {
    Auto,
    Pwsh,
    WindowsPowerShell,
    Cmd,
}

/// Which creation surface the case exercises.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessSurface {
    UiNextCreate,
    Detached,
}

/// Bounded timing scenario.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessTiming {
    Natural,
    HoldMarker,
    ManualTimeout,
    SameTick,
    LateMarker,
}

/// The only sidecar operations that may drive a bound production startup.
/// Keeping this as a closed enum prevents arbitrary coordinator controls from
/// crossing the non-shipping IPC boundary.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessDriveAction {
    ReleaseReady,
    FireTimeout,
    RaceReadyTimeout,
}

/// Count-only timing observations retained in a case snapshot.  No PTY
/// identity, command, cwd, or output is included in this projection.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessTimingCounters {
    pub(crate) drive: u32,
    pub(crate) ready: u32,
    pub(crate) timeout: u32,
    pub(crate) same_tick: u32,
    pub(crate) sent_observed: u32,
}

/// Count-only evidence observed by the real PTY output path.  These booleans
/// intentionally collapse repeated chunks/markers into one case-local fact;
/// no output bytes or parser tail crosses the harness boundary.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessOutputEvidence {
    pub(crate) marker_matched: bool,
    pub(crate) first_output_observed: bool,
}

/// Bounded DA1 writer fault scenario.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessDa1Fault {
    None,
    Reject,
    Zero,
    Partial,
    Unknown,
}

/// Process-private writer observation.  This enum is intentionally not
/// serializable; only the bounded counters below may appear in a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum HarnessDa1Outcome {
    Query,
    Committed,
    Rejected,
    Zero,
    Partial,
    Unknown,
    Fatal,
}

/// Count-only DA1 projection safe for IPC snapshots.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessDa1Counters {
    pub(crate) queries: u32,
    pub(crate) committed: u32,
    pub(crate) rejected: u32,
    pub(crate) zero: u32,
    pub(crate) partial: u32,
    pub(crate) unknown: u32,
    pub(crate) fatal: u32,
}

/// Bounded warmup scenario.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessWarmup {
    Disabled,
    Normal,
    SpawnFailure,
    NeverExit,
    HoldBeforeNativeSpawn,
}

/// Fixed synthetic fixture selector.  No fixture carries a free-form value.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessFixture {
    SyntheticProvider,
    PlainShell,
    DeviceAttributes,
    Warmup,
    OutputNonce,
}

/// Fully typed input for the prepare command.  `deny_unknown_fields` makes
/// accidental expansion into an unbounded/free-form IPC contract fail closed.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HarnessPrepareCaseRequest {
    pub(crate) shell: HarnessShell,
    pub(crate) surface: HarnessSurface,
    pub(crate) timing: HarnessTiming,
    pub(crate) da1_fault: HarnessDa1Fault,
    pub(crate) warmup: HarnessWarmup,
    pub(crate) fixture: HarnessFixture,
}

impl HarnessPrepareCaseRequest {
    /// Reject combinations that do not describe one of the fixed fixtures.
    pub(crate) const fn validate(self) -> bool {
        let marker_timing = matches!(
            self.timing,
            HarnessTiming::HoldMarker | HarnessTiming::LateMarker
        );

        // Timing injection must exercise a real synthetic Provider startup.
        // Rejecting every other fixture here prevents a future fixture from
        // accidentally acquiring a coordinator control surface.
        if !matches!(self.timing, HarnessTiming::Natural)
            && !matches!(self.fixture, HarnessFixture::SyntheticProvider)
        {
            return false;
        }

        if matches!(self.fixture, HarnessFixture::PlainShell)
            && (!matches!(self.timing, HarnessTiming::Natural)
                || !matches!(self.da1_fault, HarnessDa1Fault::None))
        {
            return false;
        }

        if matches!(self.fixture, HarnessFixture::OutputNonce)
            && (!matches!(self.timing, HarnessTiming::Natural)
                || !matches!(self.da1_fault, HarnessDa1Fault::None))
        {
            return false;
        }

        if matches!(self.fixture, HarnessFixture::Warmup)
            && matches!(self.warmup, HarnessWarmup::Disabled)
        {
            return false;
        }

        if matches!(self.fixture, HarnessFixture::DeviceAttributes)
            && (!matches!(self.timing, HarnessTiming::Natural)
                || !matches!(self.warmup, HarnessWarmup::Disabled))
        {
            return false;
        }

        if marker_timing
            && (!matches!(self.fixture, HarnessFixture::SyntheticProvider)
                || matches!(self.shell, HarnessShell::Cmd))
        {
            return false;
        }

        true
    }
}
