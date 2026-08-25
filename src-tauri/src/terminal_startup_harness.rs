//! Non-shipping, privacy-safe state used by the real Windows WebDriver gate.
//!
//! This module is deliberately a sidecar rather than a second terminal
//! implementation.  It allocates bounded, process-local case tokens and
//! retains a typed plan for the feature-gated timing hook.  The production
//! coordinator remains the sole owner of readiness and dispatch state.

mod types;

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const CASE_TOKEN_PREFIX: &str = "case-";
const CASE_TOKEN_HEX_DIGITS: usize = 16;
const MAX_CASE_TOKEN_LENGTH: usize = CASE_TOKEN_PREFIX.len() + CASE_TOKEN_HEX_DIGITS;
const MAX_ACTIVE_CASES: usize = 32;
const MAX_RETIRED_CASES: usize = 64;
const MAX_INTERNAL_ID_LENGTH: usize = 256;
#[cfg(target_os = "windows")]
const RUNTIME_UDF_ATTESTATION_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const TERMINAL_STARTUP_HARNESS_OFFLINE_ENV: &str =
    "THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE";
const HARNESS_PWSH_PATH_ENV: &str = "THREADTERM_WDIO_PROVIDER_PWSH_PATH";
const HARNESS_WINDOWS_POWERSHELL_PATH_ENV: &str =
    "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_PATH";
const HARNESS_CMD_PATH_ENV: &str = "THREADTERM_WDIO_PROVIDER_CMD_PATH";

/// The runner-owned attestation that makes the harness safe to launch.
///
/// Keep this type and its parser in one place.  Feature-only callers must use
/// `is_enabled`; missing, empty, or any value other than the runner's exact
/// `1` token is deliberately disabled.  Production builds do not compile this
/// module and therefore never inspect the environment variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HarnessOfflineAttestation {
    enabled: bool,
}

impl HarnessOfflineAttestation {
    pub(crate) fn from_value(value: Option<&str>) -> Self {
        Self {
            enabled: matches!(value, Some("1")),
        }
    }

    pub(crate) fn from_environment() -> Self {
        Self::from_value(
            std::env::var(TERMINAL_STARTUP_HARNESS_OFFLINE_ENV)
                .ok()
                .as_deref(),
        )
    }

    pub(crate) const fn is_enabled(self) -> bool {
        self.enabled
    }
}

pub(crate) fn offline_attestation() -> HarnessOfflineAttestation {
    HarnessOfflineAttestation::from_environment()
}

/// A process-private runner receipt for a forced shell. It is deliberately
/// not serializable: path values must never cross the harness IPC/report
/// boundary. The PTY creation path consumes the exact validated path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HarnessShellReceipt(PathBuf);

impl HarnessShellReceipt {
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn from_environment(shell: HarnessShell) -> Result<Option<Self>, HarnessHookError> {
        let (env_name, validated_shell) = match shell {
            // Harness "auto" is deliberately pinned to cmd. It must not
            // enter production default-shell discovery, which can inspect an
            // inherited PATH before this isolated test has a receipt.
            HarnessShell::Auto => (HARNESS_CMD_PATH_ENV, HarnessShell::Cmd),
            HarnessShell::Pwsh => (HARNESS_PWSH_PATH_ENV, HarnessShell::Pwsh),
            HarnessShell::WindowsPowerShell => (
                HARNESS_WINDOWS_POWERSHELL_PATH_ENV,
                HarnessShell::WindowsPowerShell,
            ),
            HarnessShell::Cmd => (HARNESS_CMD_PATH_ENV, HarnessShell::Cmd),
        };
        let value = std::env::var(env_name).map_err(|_| HarnessHookError::InvalidShellReceipt)?;
        let path = PathBuf::from(value);
        canonical_harness_shell_receipt(validated_shell, &path)
            .map(Self)
            .map(Some)
            .ok_or(HarnessHookError::InvalidShellReceipt)
    }
}

fn canonical_harness_shell_receipt(shell: HarnessShell, path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let canonical = std::fs::canonicalize(path).ok()?;
        let text = canonical.to_str()?;
        if !canonical.is_file() || !is_safe_harness_shell_receipt_text(shell, text) {
            return None;
        }
        if !has_expected_harness_shell_basename(shell, &canonical) {
            return None;
        }
        matches!(shell, HarnessShell::Pwsh)
            .then_some(!is_windows_apps_path(&canonical))
            .unwrap_or_else(|| is_expected_system32_shell(shell, &canonical))
            .then_some(canonical)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (shell, path);
        None
    }
}

fn is_safe_harness_shell_receipt_text(shell: HarnessShell, value: &str) -> bool {
    let expected = match shell {
        HarnessShell::Auto => return false,
        HarnessShell::Pwsh => "pwsh.exe",
        HarnessShell::WindowsPowerShell => "powershell.exe",
        HarnessShell::Cmd => "cmd.exe",
    };
    let lower = value.to_ascii_lowercase();
    let disk_path = value.strip_prefix("\\\\?\\").unwrap_or(value);
    let disk_or_verbatim_disk = !value.starts_with("\\\\") || value.starts_with("\\\\?\\");
    disk_path.len() >= 3
        && disk_path.as_bytes()[0].is_ascii_alphabetic()
        && disk_path.as_bytes()[1] == b':'
        && disk_path.as_bytes()[2] == b'\\'
        && !value.starts_with("\\\\.\\")
        && !value.starts_with("\\\\?\\UNC\\")
        && !value.starts_with("\\\\?\\unc\\")
        && disk_or_verbatim_disk
        && !value.contains('/')
        && !lower.contains("\\windowsapps\\")
        && value
            .rsplit('\\')
            .next()
            .is_some_and(|basename| basename.eq_ignore_ascii_case(expected))
}

#[cfg(target_os = "windows")]
fn has_expected_harness_shell_basename(shell: HarnessShell, path: &Path) -> bool {
    let expected = match shell {
        HarnessShell::Auto => return false,
        HarnessShell::Pwsh => "pwsh.exe",
        HarnessShell::WindowsPowerShell => "powershell.exe",
        HarnessShell::Cmd => "cmd.exe",
    };
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

#[cfg(target_os = "windows")]
fn is_windows_apps_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case("WindowsApps"))
}

#[cfg(target_os = "windows")]
fn is_expected_system32_shell(shell: HarnessShell, path: &Path) -> bool {
    let root = match std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR")) {
        Some(root) => root,
        None => return false,
    };
    let Ok(root) = std::fs::canonicalize(PathBuf::from(root)) else {
        return false;
    };
    let expected = match shell {
        HarnessShell::Cmd => root.join("System32").join("cmd.exe"),
        HarnessShell::WindowsPowerShell => root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        _ => return false,
    };
    std::fs::canonicalize(expected).is_ok_and(|expected| expected == path)
}

#[allow(unused_imports)]
pub(crate) use self::types::{
    HarnessDa1Counters, HarnessDa1Fault, HarnessDa1Outcome, HarnessDriveAction, HarnessFixture,
    HarnessOutputEvidence, HarnessPrepareCaseRequest, HarnessShell, HarnessSurface, HarnessTiming,
    HarnessTimingCounters, HarnessWarmup,
};

/// Capability state exposed by the non-shipping harness.
///
/// Shell forcing, timing, and DA1 fault hooks are narrowly feature-gated
/// controls over the real production paths. Case snapshots remain read-only
/// and privacy-safe; the sidecar never becomes a second PTY implementation.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessCapability {
    Supported,
    Unsupported,
}

/// The only WebView user-data-folder attestation exposed to the harness IPC.
/// Paths and platform errors deliberately remain inside the Rust host.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessRuntimeUdfAttestation {
    Matched,
    Mismatch,
    Unavailable,
    Invalid,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessCaseState {
    Prepared,
    Claimed,
    Bound,
    Failed,
    Cleaned,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HarnessErrorCode {
    InvalidCaseToken,
    InvalidCombination,
    UnknownCaseToken,
    DuplicateCaseToken,
    CaseLimitReached,
    CaseNotBound,
    InvalidDriveAction,
    DriveInFlight,
    DriveFailed,
}

/// Stable, code-only command error.  It has no free-form message and never
/// echoes an untrusted token or request field.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessError {
    pub(crate) code: HarnessErrorCode,
}

impl HarnessError {
    const fn new(code: HarnessErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for HarnessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self.code {
            HarnessErrorCode::InvalidCaseToken => "invalidCaseToken",
            HarnessErrorCode::InvalidCombination => "invalidCombination",
            HarnessErrorCode::UnknownCaseToken => "unknownCaseToken",
            HarnessErrorCode::DuplicateCaseToken => "duplicateCaseToken",
            HarnessErrorCode::CaseLimitReached => "caseLimitReached",
            HarnessErrorCode::CaseNotBound => "caseNotBound",
            HarnessErrorCode::InvalidDriveAction => "invalidDriveAction",
            HarnessErrorCode::DriveInFlight => "driveInFlight",
            HarnessErrorCode::DriveFailed => "driveFailed",
        };
        formatter.write_str(code)
    }
}

impl std::error::Error for HarnessError {}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HarnessCounters {
    active_cases: u32,
    queued_ui_create_cases: u32,
    prepared_cases: u32,
    claimed_cases: u32,
    bound_cases: u32,
    failed_cases: u32,
    snapshot_reads: u32,
    cleanups: u32,
    duplicate_tokens: u32,
    unknown_tokens: u32,
    rejected_requests: u32,
    #[serde(rename = "preparationSkipped")]
    env_preparation_skipped: u32,
}

impl HarnessCounters {
    fn increment(value: &mut u32) {
        *value = value.saturating_add(1);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessStatus {
    enabled: bool,
    shell_forcing: HarnessCapability,
    timing_injection: HarnessCapability,
    fault_injection: HarnessCapability,
    read_only_observation: HarnessCapability,
    counters: HarnessCounters,
}

/// The response repeats the complete fixed plan so a snapshot is sufficient
/// for a harness client to reconcile without receiving runtime identifiers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessCaseResult {
    case_token: String,
    plan: HarnessPrepareCaseRequest,
    state: HarnessCaseState,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding_epoch: Option<u64>,
    da1: HarnessDa1Counters,
    timing: HarnessTimingCounters,
    marker_matched: bool,
    first_output_observed: bool,
    #[serde(rename = "preparationSkipped")]
    env_preparation_skipped: bool,
    counters: HarnessCounters,
}

/// The token is the only identifier allowed across the harness IPC boundary.
/// Its syntax is checked before lookup, and generated tokens have a fixed
/// length so callers cannot smuggle arbitrary data through this sidecar.
#[derive(Debug, Clone, Eq)]
struct CaseToken(String);

impl CaseToken {
    fn generated(sequence: u64) -> Self {
        Self(format!(
            "{CASE_TOKEN_PREFIX}{sequence:0width$x}",
            width = CASE_TOKEN_HEX_DIGITS
        ))
    }

    fn parse(value: &str) -> Result<Self, HarnessError> {
        let suffix = value
            .strip_prefix(CASE_TOKEN_PREFIX)
            .ok_or_else(|| HarnessError::new(HarnessErrorCode::InvalidCaseToken))?;
        if value.len() != MAX_CASE_TOKEN_LENGTH
            || suffix.len() != CASE_TOKEN_HEX_DIGITS
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(HarnessError::new(HarnessErrorCode::InvalidCaseToken));
        }
        Ok(Self(value.to_owned()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl PartialEq for CaseToken {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Hash for CaseToken {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

/// Opaque process-local claim handle.  It deliberately has no serde
/// implementation and never crosses the Tauri boundary.
#[derive(Clone, Eq, PartialEq, Hash)]
pub(crate) struct HarnessCaseHandle(CaseToken);

/// A claimed UI-next-create plan.  The handle is consumed by later internal
/// bind/abandon calls while the plan remains a copy of bounded enums only.
#[allow(dead_code)]
pub(crate) struct HarnessClaimedPlan {
    pub(crate) handle: HarnessCaseHandle,
    pub(crate) plan: HarnessPrepareCaseRequest,
}

/// Result of an internal bind or abandon transition.  It exposes only a
/// case-local numeric epoch and enum state; runtime ids remain private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HarnessBindingReceipt {
    pub(crate) binding_epoch: u64,
    pub(crate) state: HarnessCaseState,
}

/// Immutable typed projection returned by exact `(pty id, generation)` lookup.
/// The identity itself is intentionally absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HarnessBoundPlan {
    pub(crate) plan: HarnessPrepareCaseRequest,
    pub(crate) binding_epoch: u64,
    pub(crate) state: HarnessCaseState,
}

/// A copied, process-private drive context.  The harness mutex is released
/// before this value is handed to the PTY registry/coordinator path.
#[derive(Debug)]
pub(crate) struct HarnessDriveContext {
    pub(crate) pty_id: String,
    pub(crate) generation: String,
    pub(crate) plan: HarnessPrepareCaseRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HarnessHookError {
    UnknownCase,
    NotClaimed,
    AlreadyBound,
    IdentityConflict,
    AlreadyFailed,
    InvalidState,
    InvalidIdentity,
    InvalidShellReceipt,
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct InternalIdentity {
    pty_id: String,
    generation: String,
}

struct InternalBinding {
    // The complete typed plan stays process-local and is never serialized.
    plan: HarnessPrepareCaseRequest,
    state: HarnessCaseState,
    binding_epoch: Option<u64>,
    identity: Option<InternalIdentity>,
    da1_fault_consumed: bool,
    da1: HarnessDa1Counters,
    timing: HarnessTimingCounters,
    output: HarnessOutputEvidence,
    drive_in_flight: Option<HarnessDriveAction>,
    #[allow(dead_code)]
    env_preparation_skipped: bool,
}

#[derive(Default)]
struct HarnessState {
    next_sequence: u64,
    bindings: HashMap<CaseToken, InternalBinding>,
    pending_ui_create: VecDeque<CaseToken>,
    by_identity: HashMap<InternalIdentity, CaseToken>,
    retired_tokens: VecDeque<CaseToken>,
    counters: HarnessCounters,
}

impl HarnessState {
    fn new() -> Self {
        Self {
            next_sequence: 1,
            ..Self::default()
        }
    }

    fn prepare(
        &mut self,
        request: HarnessPrepareCaseRequest,
    ) -> Result<HarnessCaseResult, HarnessError> {
        if !request.validate() {
            HarnessCounters::increment(&mut self.counters.rejected_requests);
            return Err(HarnessError::new(HarnessErrorCode::InvalidCombination));
        }

        if self.bindings.len() >= MAX_ACTIVE_CASES {
            HarnessCounters::increment(&mut self.counters.rejected_requests);
            return Err(HarnessError::new(HarnessErrorCode::CaseLimitReached));
        }

        let sequence = self.next_sequence;
        if sequence == 0 {
            HarnessCounters::increment(&mut self.counters.rejected_requests);
            return Err(HarnessError::new(HarnessErrorCode::CaseLimitReached));
        }
        self.next_sequence = sequence.wrapping_add(1);

        let token = CaseToken::generated(sequence);
        // The sequence is process-local and monotonic, so this cannot collide
        // during normal operation.  Keep the check explicit if the generator
        // is changed later.
        if self.bindings.contains_key(&token) {
            HarnessCounters::increment(&mut self.counters.duplicate_tokens);
            return Err(HarnessError::new(HarnessErrorCode::DuplicateCaseToken));
        }

        self.bindings.insert(
            token.clone(),
            InternalBinding {
                plan: request,
                state: HarnessCaseState::Prepared,
                binding_epoch: None,
                identity: None,
                da1_fault_consumed: false,
                da1: HarnessDa1Counters::default(),
                timing: HarnessTimingCounters::default(),
                output: HarnessOutputEvidence::default(),
                drive_in_flight: None,
                env_preparation_skipped: false,
            },
        );
        if matches!(request.surface, HarnessSurface::UiNextCreate) {
            self.pending_ui_create.push_back(token.clone());
            self.counters.queued_ui_create_cases =
                self.counters.queued_ui_create_cases.saturating_add(1);
        }
        self.counters.active_cases = self.counters.active_cases.saturating_add(1);
        HarnessCounters::increment(&mut self.counters.prepared_cases);

        Ok(HarnessCaseResult {
            case_token: token.as_str().to_owned(),
            plan: request,
            state: HarnessCaseState::Prepared,
            binding_epoch: None,
            da1: HarnessDa1Counters::default(),
            timing: HarnessTimingCounters::default(),
            marker_matched: false,
            first_output_observed: false,
            env_preparation_skipped: false,
            counters: self.counters,
        })
    }

    fn snapshot(&mut self, raw_token: &str) -> Result<HarnessCaseResult, HarnessError> {
        let token = self.parse_for_lookup(raw_token)?;
        let binding = match self.bindings.get(&token) {
            Some(binding) => binding,
            None if self.retired_tokens.contains(&token) => {
                HarnessCounters::increment(&mut self.counters.duplicate_tokens);
                return Err(HarnessError::new(HarnessErrorCode::DuplicateCaseToken));
            }
            None => {
                HarnessCounters::increment(&mut self.counters.unknown_tokens);
                return Err(HarnessError::new(HarnessErrorCode::UnknownCaseToken));
            }
        };

        HarnessCounters::increment(&mut self.counters.snapshot_reads);
        Ok(HarnessCaseResult {
            case_token: token.as_str().to_owned(),
            plan: binding.plan,
            state: binding.state,
            binding_epoch: binding.binding_epoch,
            da1: binding.da1,
            timing: binding.timing,
            marker_matched: binding.output.marker_matched,
            first_output_observed: binding.output.first_output_observed,
            env_preparation_skipped: binding.env_preparation_skipped,
            counters: self.counters,
        })
    }

    fn cleanup(&mut self, raw_token: &str) -> Result<HarnessCaseResult, HarnessError> {
        let token = self.parse_for_lookup(raw_token)?;
        if self
            .bindings
            .get(&token)
            .is_some_and(|binding| binding.drive_in_flight.is_some())
        {
            return Err(HarnessError::new(HarnessErrorCode::DriveInFlight));
        }
        let binding = match self.bindings.remove(&token) {
            Some(binding) => binding,
            None if self.retired_tokens.contains(&token) => {
                HarnessCounters::increment(&mut self.counters.duplicate_tokens);
                return Err(HarnessError::new(HarnessErrorCode::DuplicateCaseToken));
            }
            None => {
                HarnessCounters::increment(&mut self.counters.unknown_tokens);
                return Err(HarnessError::new(HarnessErrorCode::UnknownCaseToken));
            }
        };

        let was_queued = self.pending_ui_create.iter().any(|queued| queued == &token);
        self.pending_ui_create.retain(|queued| queued != &token);
        if was_queued {
            self.counters.queued_ui_create_cases =
                self.counters.queued_ui_create_cases.saturating_sub(1);
        }
        if let Some(identity) = binding.identity.as_ref() {
            self.by_identity.remove(identity);
        }
        self.counters.active_cases = self.counters.active_cases.saturating_sub(1);
        HarnessCounters::increment(&mut self.counters.cleanups);
        self.retired_tokens.push_back(token.clone());
        if self.retired_tokens.len() > MAX_RETIRED_CASES {
            self.retired_tokens.pop_front();
        }

        Ok(HarnessCaseResult {
            case_token: token.as_str().to_owned(),
            plan: binding.plan,
            state: HarnessCaseState::Cleaned,
            binding_epoch: binding.binding_epoch,
            da1: binding.da1,
            timing: binding.timing,
            marker_matched: binding.output.marker_matched,
            first_output_observed: binding.output.first_output_observed,
            env_preparation_skipped: binding.env_preparation_skipped,
            counters: self.counters,
        })
    }

    /// Consume the configured DA1 fault at most once for an exact bound
    /// identity.  Unknown identities and non-DeviceAttributes fixtures are
    /// deliberately normal (`None`) rather than errors.
    fn take_da1_fault(&mut self, pty_id: &str, generation: &str) -> HarnessDa1Fault {
        if !valid_internal_identity(pty_id, generation) {
            return HarnessDa1Fault::None;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let Some(token) = self.by_identity.get(&identity).cloned() else {
            return HarnessDa1Fault::None;
        };
        let Some(binding) = self.bindings.get_mut(&token) else {
            return HarnessDa1Fault::None;
        };
        if !matches!(binding.plan.fixture, HarnessFixture::DeviceAttributes)
            || binding.da1_fault_consumed
        {
            return HarnessDa1Fault::None;
        }
        binding.da1_fault_consumed = true;
        binding.plan.da1_fault
    }

    /// Record a typed DA1 observation for an exact bound identity.  Only
    /// bounded per-case counters are retained; unknown identities are a
    /// no-op and return `false`.
    fn record_da1_outcome(
        &mut self,
        pty_id: &str,
        generation: &str,
        outcome: HarnessDa1Outcome,
    ) -> bool {
        if !valid_internal_identity(pty_id, generation) {
            return false;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let Some(token) = self.by_identity.get(&identity).cloned() else {
            return false;
        };
        let Some(binding) = self.bindings.get_mut(&token) else {
            return false;
        };
        if !matches!(binding.plan.fixture, HarnessFixture::DeviceAttributes) {
            return false;
        }
        binding.da1.record(outcome);
        true
    }

    /// Record count-only startup output evidence for an exact bound identity.
    /// Repeated chunks and markers collapse into one case-local fact; unknown
    /// identities and non-provider fixtures are deliberately no-ops.
    fn record_output_evidence(
        &mut self,
        pty_id: &str,
        generation: &str,
        evidence: HarnessOutputEvidence,
    ) -> bool {
        if !valid_internal_identity(pty_id, generation) {
            return false;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let Some(token) = self.by_identity.get(&identity).cloned() else {
            return false;
        };
        let Some(binding) = self.bindings.get_mut(&token) else {
            return false;
        };
        if !matches!(binding.plan.fixture, HarnessFixture::SyntheticProvider) {
            return false;
        }
        binding.output.marker_matched |= evidence.marker_matched;
        binding.output.first_output_observed |= evidence.first_output_observed;
        true
    }

    /// Record only that the feature-only offline seam bypassed Provider
    /// environment preparation for this synthetic case.  No environment value
    /// or Provider identity is retained or serialized.
    fn record_provider_env_prepare_skipped(&mut self, pty_id: &str, generation: &str) -> bool {
        if !valid_internal_identity(pty_id, generation) {
            return false;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let Some(token) = self.by_identity.get(&identity).cloned() else {
            return false;
        };
        let Some(binding) = self.bindings.get_mut(&token) else {
            return false;
        };
        if !matches!(binding.plan.fixture, HarnessFixture::SyntheticProvider) {
            return false;
        }
        if !binding.env_preparation_skipped {
            binding.env_preparation_skipped = true;
            HarnessCounters::increment(&mut self.counters.env_preparation_skipped);
        }
        true
    }

    /// Claim the next UI-next-create plan in FIFO order.  Detached plans are
    /// never inserted into this queue, and a queue entry can transition only
    /// once from `Prepared` to `Claimed`.
    fn claim_next_ui_create_plan(&mut self) -> Option<HarnessClaimedPlan> {
        while let Some(token) = self.pending_ui_create.pop_front() {
            self.counters.queued_ui_create_cases =
                self.counters.queued_ui_create_cases.saturating_sub(1);
            let Some(binding) = self.bindings.get_mut(&token) else {
                continue;
            };
            if !matches!(binding.state, HarnessCaseState::Prepared) {
                continue;
            }
            binding.state = HarnessCaseState::Claimed;
            HarnessCounters::increment(&mut self.counters.claimed_cases);
            return Some(HarnessClaimedPlan {
                handle: HarnessCaseHandle(token),
                plan: binding.plan,
            });
        }
        None
    }

    fn bind_claimed_case(
        &mut self,
        handle: &HarnessCaseHandle,
        pty_id: &str,
        generation: &str,
    ) -> Result<HarnessBindingReceipt, HarnessHookError> {
        if !valid_internal_identity(pty_id, generation) {
            return Err(HarnessHookError::InvalidIdentity);
        }
        let binding = self
            .bindings
            .get(&handle.0)
            .ok_or(HarnessHookError::UnknownCase)?;
        if matches!(binding.state, HarnessCaseState::Bound) {
            return Err(HarnessHookError::AlreadyBound);
        }
        if !matches!(binding.state, HarnessCaseState::Claimed) {
            return Err(HarnessHookError::NotClaimed);
        }

        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        if self.by_identity.contains_key(&identity) {
            return Err(HarnessHookError::IdentityConflict);
        }

        let binding = self
            .bindings
            .get_mut(&handle.0)
            .ok_or(HarnessHookError::UnknownCase)?;
        binding.state = HarnessCaseState::Bound;
        // This epoch is local to this opaque case binding.  It is useful to
        // adapters for stale-result checks but cannot reveal the identity.
        let binding_epoch = 1;
        binding.binding_epoch = Some(binding_epoch);
        binding.identity = Some(identity.clone());
        self.by_identity.insert(identity, handle.0.clone());
        HarnessCounters::increment(&mut self.counters.bound_cases);

        Ok(HarnessBindingReceipt {
            binding_epoch,
            state: HarnessCaseState::Bound,
        })
    }

    fn lookup_bound_plan(&self, pty_id: &str, generation: &str) -> Option<HarnessBoundPlan> {
        if !valid_internal_identity(pty_id, generation) {
            return None;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let token = self.by_identity.get(&identity)?;
        let binding = self.bindings.get(token)?;
        Some(HarnessBoundPlan {
            plan: binding.plan,
            binding_epoch: binding.binding_epoch?,
            state: binding.state,
        })
    }

    /// Copy the bound identity and typed plan while holding the sidecar
    /// mutex, then let the caller release that mutex before touching the live
    /// PTY/session/coordinator.  The copied identity is never serialized.
    fn drive_context(
        &mut self,
        raw_token: &str,
        action: HarnessDriveAction,
    ) -> Result<HarnessDriveContext, HarnessError> {
        let token = self.parse_for_lookup(raw_token)?;
        let Some(binding) = self.bindings.get(&token) else {
            if self.retired_tokens.contains(&token) {
                return Err(HarnessError::new(HarnessErrorCode::DuplicateCaseToken));
            }
            HarnessCounters::increment(&mut self.counters.unknown_tokens);
            return Err(HarnessError::new(HarnessErrorCode::UnknownCaseToken));
        };
        if !matches!(binding.state, HarnessCaseState::Bound) {
            return Err(HarnessError::new(HarnessErrorCode::CaseNotBound));
        }
        if binding.drive_in_flight.is_some() {
            return Err(HarnessError::new(HarnessErrorCode::DriveInFlight));
        }
        validate_drive_action(binding.plan.timing, binding.timing, action)?;
        let identity = binding
            .identity
            .as_ref()
            .ok_or_else(|| HarnessError::new(HarnessErrorCode::CaseNotBound))?
            .clone();
        // Reserve the one-shot action before releasing the mutex. A second
        // caller therefore fails closed while the first is in the live PTY
        // coordinator/writer path.
        let binding = self
            .bindings
            .get_mut(&token)
            .ok_or_else(|| HarnessError::new(HarnessErrorCode::UnknownCaseToken))?;
        binding.drive_in_flight = Some(action);
        Ok(HarnessDriveContext {
            pty_id: identity.pty_id,
            generation: identity.generation,
            plan: binding.plan,
        })
    }

    fn record_timing(
        &mut self,
        raw_token: &str,
        action: HarnessDriveAction,
        sent: bool,
    ) -> Result<(), HarnessError> {
        let token = self.parse_for_lookup(raw_token)?;
        let binding = self
            .bindings
            .get_mut(&token)
            .ok_or_else(|| HarnessError::new(HarnessErrorCode::UnknownCaseToken))?;
        if !matches!(binding.state, HarnessCaseState::Bound) {
            return Err(HarnessError::new(HarnessErrorCode::CaseNotBound));
        }
        if binding.drive_in_flight.take() != Some(action) {
            return Err(HarnessError::new(HarnessErrorCode::DriveFailed));
        }
        binding.timing.drive = binding.timing.drive.saturating_add(1);
        match action {
            HarnessDriveAction::ReleaseReady => {
                binding.timing.ready = binding.timing.ready.saturating_add(1)
            }
            HarnessDriveAction::FireTimeout => {
                binding.timing.timeout = binding.timing.timeout.saturating_add(1)
            }
            HarnessDriveAction::RaceReadyTimeout => {
                binding.timing.same_tick = binding.timing.same_tick.saturating_add(1)
            }
        }
        if sent {
            binding.timing.sent_observed = binding.timing.sent_observed.saturating_add(1);
        }
        Ok(())
    }

    fn release_drive_reservation(&mut self, raw_token: &str, action: HarnessDriveAction) {
        let Ok(token) = CaseToken::parse(raw_token) else {
            return;
        };
        if let Some(binding) = self.bindings.get_mut(&token) {
            if binding.drive_in_flight == Some(action) {
                binding.drive_in_flight = None;
            }
        }
    }

    /// Transition one bound case to `Failed` after a create/arm failure.
    /// Removing the identity index first makes retries and stale hooks a
    /// no-op while the case-local epoch/state remain available to snapshot.
    fn fail_bound_case(&mut self, pty_id: &str, generation: &str) -> Option<HarnessBindingReceipt> {
        if !valid_internal_identity(pty_id, generation) {
            return None;
        }
        let identity = InternalIdentity {
            pty_id: pty_id.to_owned(),
            generation: generation.to_owned(),
        };
        let token = self.by_identity.get(&identity).cloned()?;
        let binding = self.bindings.get(&token)?;
        if !matches!(binding.state, HarnessCaseState::Bound) {
            return None;
        }

        self.by_identity.remove(&identity);
        let binding = self.bindings.get_mut(&token)?;
        binding.identity = None;
        binding.state = HarnessCaseState::Failed;
        HarnessCounters::increment(&mut self.counters.failed_cases);
        Some(HarnessBindingReceipt {
            binding_epoch: binding.binding_epoch.unwrap_or(0),
            state: HarnessCaseState::Failed,
        })
    }

    /// Mark a claimed case failed without accepting a free-form reason.
    fn abandon_claimed_case(
        &mut self,
        handle: &HarnessCaseHandle,
    ) -> Result<HarnessBindingReceipt, HarnessHookError> {
        let binding = self
            .bindings
            .get_mut(&handle.0)
            .ok_or(HarnessHookError::UnknownCase)?;
        match binding.state {
            HarnessCaseState::Claimed => {
                binding.state = HarnessCaseState::Failed;
                HarnessCounters::increment(&mut self.counters.failed_cases);
                Ok(HarnessBindingReceipt {
                    binding_epoch: 0,
                    state: HarnessCaseState::Failed,
                })
            }
            HarnessCaseState::Failed => Err(HarnessHookError::AlreadyFailed),
            HarnessCaseState::Bound => Err(HarnessHookError::InvalidState),
            _ => Err(HarnessHookError::NotClaimed),
        }
    }

    fn parse_for_lookup(&mut self, raw_token: &str) -> Result<CaseToken, HarnessError> {
        match CaseToken::parse(raw_token) {
            Ok(token) => Ok(token),
            Err(error) => {
                HarnessCounters::increment(&mut self.counters.rejected_requests);
                Err(error)
            }
        }
    }

    fn status_with_attestation(&self, attestation: HarnessOfflineAttestation) -> HarnessStatus {
        HarnessStatus {
            enabled: attestation.is_enabled(),
            shell_forcing: HarnessCapability::Supported,
            timing_injection: HarnessCapability::Supported,
            fault_injection: HarnessCapability::Supported,
            read_only_observation: HarnessCapability::Supported,
            counters: self.counters,
        }
    }

    fn status(&self) -> HarnessStatus {
        self.status_with_attestation(offline_attestation())
    }
}

fn validate_drive_action(
    timing: HarnessTiming,
    counters: HarnessTimingCounters,
    action: HarnessDriveAction,
) -> Result<(), HarnessError> {
    let valid = match (timing, action) {
        (HarnessTiming::HoldMarker, HarnessDriveAction::ReleaseReady) => counters.drive == 0,
        (HarnessTiming::ManualTimeout, HarnessDriveAction::FireTimeout) => counters.drive == 0,
        (HarnessTiming::SameTick, HarnessDriveAction::RaceReadyTimeout) => counters.drive == 0,
        (HarnessTiming::LateMarker, HarnessDriveAction::FireTimeout) => counters.drive == 0,
        (HarnessTiming::LateMarker, HarnessDriveAction::ReleaseReady) => {
            counters.timeout == 1 && counters.ready == 0
        }
        (HarnessTiming::Natural, _)
        | (HarnessTiming::HoldMarker, _)
        | (HarnessTiming::ManualTimeout, _)
        | (HarnessTiming::SameTick, _)
        | (HarnessTiming::LateMarker, _) => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| HarnessError::new(HarnessErrorCode::InvalidDriveAction))
}

fn valid_internal_identity(pty_id: &str, generation: &str) -> bool {
    !pty_id.is_empty()
        && !generation.is_empty()
        && pty_id.len() <= MAX_INTERNAL_ID_LENGTH
        && generation.len() <= MAX_INTERNAL_ID_LENGTH
        && pty_id.bytes().all(|byte| !byte.is_ascii_control())
        && generation.bytes().all(|byte| !byte.is_ascii_control())
}

impl HarnessDa1Counters {
    fn record(&mut self, outcome: HarnessDa1Outcome) {
        let counter = match outcome {
            HarnessDa1Outcome::Query => &mut self.queries,
            HarnessDa1Outcome::Committed => &mut self.committed,
            HarnessDa1Outcome::Rejected => &mut self.rejected,
            HarnessDa1Outcome::Zero => &mut self.zero,
            HarnessDa1Outcome::Partial => &mut self.partial,
            HarnessDa1Outcome::Unknown => &mut self.unknown,
            HarnessDa1Outcome::Fatal => &mut self.fatal,
        };
        *counter = counter.saturating_add(1);
    }
}

static HARNESS_STATE: OnceLock<Mutex<HarnessState>> = OnceLock::new();

fn state() -> &'static Mutex<HarnessState> {
    HARNESS_STATE.get_or_init(|| Mutex::new(HarnessState::new()))
}

fn with_state<T>(operation: impl FnOnce(&mut HarnessState) -> T) -> T {
    let mut guard = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut guard)
}

struct DriveReservationGuard {
    case_token: String,
    action: HarnessDriveAction,
    armed: bool,
}

impl DriveReservationGuard {
    fn new(case_token: String, action: HarnessDriveAction) -> Self {
        Self {
            case_token,
            action,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DriveReservationGuard {
    fn drop(&mut self) {
        if self.armed {
            with_state(|state| state.release_drive_reservation(&self.case_token, self.action));
        }
    }
}

/// Read-only capability and counter status for the non-shipping harness.
#[tauri::command]
pub(crate) fn terminal_startup_harness_status() -> HarnessStatus {
    with_state(|state| state.status())
}

/// Attest the actual main-WebView Environment user-data folder against the
/// already-validated harness data-root layout. The command accepts no path
/// input, and returns only a fixed status so neither side of the comparison is
/// exposed to WebDriver or the page.
#[tauri::command]
pub(crate) async fn terminal_startup_harness_attest_runtime_udf(
    app: tauri::AppHandle,
) -> HarnessRuntimeUdfAttestation {
    if !offline_attestation().is_enabled() {
        return HarnessRuntimeUdfAttestation::Invalid;
    }
    let expected = match app
        .state::<crate::data_directory::ResolvedDataRoot>()
        .webview_dir
        .clone()
    {
        Some(path) => path,
        None => return HarnessRuntimeUdfAttestation::Invalid,
    };

    #[cfg(target_os = "windows")]
    {
        attest_main_webview_udf(&app, expected).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = expected;
        HarnessRuntimeUdfAttestation::Unavailable
    }
}

#[cfg(target_os = "windows")]
async fn attest_main_webview_udf(
    app: &tauri::AppHandle,
    expected: PathBuf,
) -> HarnessRuntimeUdfAttestation {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment7;
    use windows_core::{Interface as _, PWSTR};

    let Some(window) = app.get_webview_window("main") else {
        return HarnessRuntimeUdfAttestation::Unavailable;
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if window
        .with_webview(move |webview| {
            let actual = unsafe {
                let environment = webview.environment().cast::<ICoreWebView2Environment7>();
                let mut user_data_folder = PWSTR::null();
                environment
                    .and_then(|environment| environment.UserDataFolder(&mut user_data_folder))
                    .map(|()| webview2_com::take_pwstr(user_data_folder))
            };
            let status = match actual {
                Ok(actual) => compare_runtime_udf_paths(&expected, Path::new(&actual)),
                Err(_) => HarnessRuntimeUdfAttestation::Unavailable,
            };
            let _ = sender.send(status);
        })
        .is_err()
    {
        return HarnessRuntimeUdfAttestation::Unavailable;
    }
    match tokio::time::timeout(RUNTIME_UDF_ATTESTATION_TIMEOUT, receiver).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) | Err(_) => HarnessRuntimeUdfAttestation::Unavailable,
    }
}

fn compare_runtime_udf_paths(expected: &Path, actual: &Path) -> HarnessRuntimeUdfAttestation {
    if !expected.is_absolute() || !actual.is_absolute() {
        return HarnessRuntimeUdfAttestation::Invalid;
    }
    let expected_lexical = normalize_windows_udf_path(expected);
    let actual_lexical = normalize_windows_udf_path(actual);
    if expected_lexical.is_empty() || actual_lexical.is_empty() {
        return HarnessRuntimeUdfAttestation::Invalid;
    }
    // Do not touch an untrusted runtime path unless its lexical identity first
    // proves it targets the runner-validated expected harness directory.
    if actual_lexical != expected_lexical {
        return HarnessRuntimeUdfAttestation::Mismatch;
    }
    let Ok(expected) = expected.canonicalize() else {
        return HarnessRuntimeUdfAttestation::Invalid;
    };
    let Ok(actual) = actual.canonicalize() else {
        return HarnessRuntimeUdfAttestation::Invalid;
    };
    if actual == expected {
        HarnessRuntimeUdfAttestation::Matched
    } else {
        HarnessRuntimeUdfAttestation::Mismatch
    }
}

fn normalize_windows_udf_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        value = format!("\\\\{rest}");
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        value = rest.to_owned();
    }
    value.trim_end_matches('\\').to_ascii_lowercase()
}

/// Allocate a bounded case token and retain its opaque process-local plan.
#[tauri::command]
pub(crate) fn terminal_startup_harness_prepare_case(
    request: HarnessPrepareCaseRequest,
) -> Result<HarnessCaseResult, HarnessError> {
    with_state(|state| state.prepare(request))
}

/// Return the current read-only projection for a generated case token.
#[tauri::command]
pub(crate) fn terminal_startup_harness_snapshot(
    case_token: String,
) -> Result<HarnessCaseResult, HarnessError> {
    with_state(|state| state.snapshot(&case_token))
}

/// Drive one bound timing case through the production startup coordinator.
/// The sidecar lock is held only long enough to copy the private identity and
/// typed plan; registry/session/coordinator calls happen after it is dropped.
#[tauri::command]
pub(crate) fn terminal_startup_harness_drive_case(
    case_token: String,
    action: HarnessDriveAction,
) -> Result<HarnessCaseResult, HarnessError> {
    let context = with_state(|state| state.drive_context(&case_token, action))?;
    let mut reservation = DriveReservationGuard::new(case_token.clone(), action);
    let sent = match crate::pty::drive_harness_startup(
        &context.pty_id,
        &context.generation,
        context.plan,
        action,
    ) {
        Ok(sent) => sent,
        Err(()) => return Err(HarnessError::new(HarnessErrorCode::DriveFailed)),
    };
    let result = with_state(|state| {
        state.record_timing(&case_token, action, sent)?;
        state.snapshot(&case_token)
    });
    if result.is_ok() {
        reservation.disarm();
    }
    result
}

/// Release a generated case token.  Releasing it twice returns a stable typed
/// duplicate code; no arbitrary token is echoed in an error response.
#[tauri::command]
pub(crate) fn terminal_startup_harness_cleanup_case(
    case_token: String,
) -> Result<HarnessCaseResult, HarnessError> {
    with_state(|state| state.cleanup(&case_token))
}

/// Atomically claim the next `UiNextCreate` plan.  The returned handle is
/// process-private and non-serializable; detached plans are not claimable.
#[allow(dead_code)]
pub(crate) fn claim_next_ui_create_plan() -> Option<HarnessClaimedPlan> {
    with_state(|state| state.claim_next_ui_create_plan())
}

/// Bind a claimed plan to an internal PTY identity.  `pty_id` and `generation`
/// are retained only under the process mutex and are never returned.
#[allow(dead_code)]
pub(crate) fn bind_claimed_case(
    handle: &HarnessCaseHandle,
    pty_id: &str,
    generation: &str,
) -> Result<HarnessBindingReceipt, HarnessHookError> {
    with_state(|state| state.bind_claimed_case(handle, pty_id, generation))
}

/// Look up an immutable typed plan by exact internal PTY identity.  The
/// returned projection contains only the plan, enum state, and local epoch.
#[allow(dead_code)]
pub(crate) fn lookup_bound_plan(pty_id: &str, generation: &str) -> Option<HarnessBoundPlan> {
    with_state(|state| state.lookup_bound_plan(pty_id, generation))
}

/// Fail one exact bound identity without accepting a free-form reason.  The
/// first transition returns its case-local epoch; stale/repeated hooks return
/// `None` after the identity index has been retired.
#[allow(dead_code)]
pub(crate) fn fail_bound_case(pty_id: &str, generation: &str) -> Option<HarnessBindingReceipt> {
    with_state(|state| state.fail_bound_case(pty_id, generation))
}

/// Mark a claimed case failed without accepting a free-form error/reason.
#[allow(dead_code)]
pub(crate) fn abandon_claimed_case(
    handle: &HarnessCaseHandle,
) -> Result<HarnessBindingReceipt, HarnessHookError> {
    with_state(|state| state.abandon_claimed_case(handle))
}

/// Consume one configured DeviceAttributes DA1 fault for an exact internal
/// `(pty_id, generation)` identity.  Missing/mismatched identities return the
/// normal `None` fault and never reveal whether another case exists.
#[allow(dead_code)]
pub(crate) fn take_da1_fault(pty_id: &str, generation: &str) -> HarnessDa1Fault {
    with_state(|state| state.take_da1_fault(pty_id, generation))
}

/// Record one count-only DA1 outcome for an exact bound identity.  Returns
/// `false` for an unknown identity or a non-DeviceAttributes fixture.
#[allow(dead_code)]
pub(crate) fn record_da1_outcome(
    pty_id: &str,
    generation: &str,
    outcome: HarnessDa1Outcome,
) -> bool {
    with_state(|state| state.record_da1_outcome(pty_id, generation, outcome))
}

/// Record count-only startup output evidence for an exact bound identity.
/// Output bytes, parser tails, and internal identities never cross IPC.
#[allow(dead_code)]
pub(crate) fn record_output_evidence(
    pty_id: &str,
    generation: &str,
    evidence: HarnessOutputEvidence,
) -> bool {
    with_state(|state| state.record_output_evidence(pty_id, generation, evidence))
}

/// Record count-only evidence that a synthetic Provider create skipped the
/// stats proxy preparation seam in an attested offline harness.
#[allow(dead_code)]
pub(crate) fn record_provider_env_prepare_skipped(pty_id: &str, generation: &str) -> bool {
    with_state(|state| state.record_provider_env_prepare_skipped(pty_id, generation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn offline_attestation_accepts_only_the_runner_token() {
        assert!(HarnessOfflineAttestation::from_value(Some("1")).is_enabled());
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some(" 1"),
            Some("1 "),
        ] {
            assert!(!HarnessOfflineAttestation::from_value(value).is_enabled());
        }
    }

    #[test]
    fn shell_receipt_text_validation_rejects_aliases_and_wrong_basenames() {
        assert!(is_safe_harness_shell_receipt_text(
            HarnessShell::Cmd,
            "C:\\Windows\\System32\\cmd.exe"
        ));
        assert!(is_safe_harness_shell_receipt_text(
            HarnessShell::Cmd,
            "\\\\?\\C:\\Windows\\System32\\cmd.exe"
        ));
        assert!(is_safe_harness_shell_receipt_text(
            HarnessShell::WindowsPowerShell,
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        ));
        assert!(is_safe_harness_shell_receipt_text(
            HarnessShell::Pwsh,
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
        ));
        for value in [
            "cmd.exe",
            "\\\\server\\share\\cmd.exe",
            "\\\\?\\UNC\\server\\share\\cmd.exe",
            "C:\\Users\\runner\\AppData\\Local\\Microsoft\\WindowsApps\\cmd.exe",
            "C:\\Windows\\System32\\powershell.exe",
            "C:/Windows/System32/cmd.exe",
        ] {
            assert!(!is_safe_harness_shell_receipt_text(
                HarnessShell::Cmd,
                value
            ));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn canonical_system_shell_receipts_accept_verbatim_disk_paths_when_present() {
        let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"));
        let Some(root) = root else { return };
        let cmd = PathBuf::from(&root).join("System32").join("cmd.exe");
        let powershell = PathBuf::from(root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if cmd.is_file() {
            assert!(canonical_harness_shell_receipt(HarnessShell::Cmd, &cmd).is_some());
        }
        if powershell.is_file() {
            assert!(
                canonical_harness_shell_receipt(HarnessShell::WindowsPowerShell, &powershell)
                    .is_some()
            );
        }
    }

    #[test]
    fn runtime_udf_comparator_fails_closed_without_exposing_paths() {
        let current = std::env::current_dir().expect("current directory");
        assert_eq!(
            compare_runtime_udf_paths(&current, &current),
            HarnessRuntimeUdfAttestation::Matched
        );
        let parent = current.parent().expect("workspace parent");
        assert_eq!(
            compare_runtime_udf_paths(&current, parent),
            HarnessRuntimeUdfAttestation::Mismatch
        );
        assert_eq!(
            compare_runtime_udf_paths(&current, Path::new("relative-udf")),
            HarnessRuntimeUdfAttestation::Invalid
        );
        assert_eq!(
            serde_json::to_value(HarnessRuntimeUdfAttestation::Unavailable)
                .expect("serialize status"),
            json!("unavailable")
        );
    }

    fn fresh_state() -> HarnessState {
        HarnessState::new()
    }

    fn valid_request() -> HarnessPrepareCaseRequest {
        HarnessPrepareCaseRequest {
            shell: HarnessShell::Pwsh,
            surface: HarnessSurface::UiNextCreate,
            timing: HarnessTiming::Natural,
            da1_fault: HarnessDa1Fault::None,
            warmup: HarnessWarmup::Disabled,
            fixture: HarnessFixture::SyntheticProvider,
        }
    }

    fn device_attributes_request(fault: HarnessDa1Fault) -> HarnessPrepareCaseRequest {
        HarnessPrepareCaseRequest {
            shell: HarnessShell::Auto,
            surface: HarnessSurface::UiNextCreate,
            timing: HarnessTiming::Natural,
            da1_fault: fault,
            warmup: HarnessWarmup::Disabled,
            fixture: HarnessFixture::DeviceAttributes,
        }
    }

    fn assert_no_private_fields(value: &Value) {
        let encoded = serde_json::to_string(value).expect("json should serialize");
        for forbidden in [
            "ptyId",
            "command",
            "cwd",
            "workingDir",
            "output",
            "cardId",
            "provider",
            "sessionId",
            "env",
            "message",
            "error",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "private field {forbidden:?} leaked in {encoded}"
            );
        }
    }

    #[test]
    fn typed_plan_round_trips_with_camel_case_fields() {
        let request = valid_request();
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["shell"], json!("pwsh"));
        assert_eq!(encoded["surface"], json!("uiNextCreate"));
        assert_eq!(encoded["da1Fault"], json!("none"));
        assert_eq!(encoded["warmup"], json!("disabled"));
        assert_eq!(
            serde_json::from_value::<HarnessPrepareCaseRequest>(encoded).unwrap(),
            request
        );

        let mut state = fresh_state();
        let result = state.prepare(request).unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["plan"]["timing"], json!("natural"));
        assert_eq!(value["plan"]["fixture"], json!("syntheticProvider"));
        assert_no_private_fields(&value);
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let mut value = serde_json::to_value(valid_request()).unwrap();
        value["command"] = json!("must-not-be-accepted");
        assert!(serde_json::from_value::<HarnessPrepareCaseRequest>(value).is_err());
    }

    #[test]
    fn illegal_fixture_combinations_are_rejected_before_allocation() {
        let request = HarnessPrepareCaseRequest {
            fixture: HarnessFixture::PlainShell,
            timing: HarnessTiming::LateMarker,
            ..valid_request()
        };
        assert!(!request.validate());
        let mut state = fresh_state();
        let error = state.prepare(request).unwrap_err();
        assert_eq!(error.code, HarnessErrorCode::InvalidCombination);
        assert_eq!(state.counters.active_cases, 0);
        assert_eq!(state.counters.rejected_requests, 1);
    }

    #[test]
    fn non_natural_timing_is_reserved_for_synthetic_provider_fixture() {
        for fixture in [
            HarnessFixture::PlainShell,
            HarnessFixture::DeviceAttributes,
            HarnessFixture::Warmup,
            HarnessFixture::OutputNonce,
        ] {
            let request = HarnessPrepareCaseRequest {
                fixture,
                timing: HarnessTiming::ManualTimeout,
                warmup: if matches!(fixture, HarnessFixture::Warmup) {
                    HarnessWarmup::Normal
                } else {
                    HarnessWarmup::Disabled
                },
                ..valid_request()
            };
            assert!(!request.validate(), "fixture {fixture:?} accepted timing");
        }

        let request = HarnessPrepareCaseRequest {
            timing: HarnessTiming::ManualTimeout,
            shell: HarnessShell::Cmd,
            ..valid_request()
        };
        assert!(request.validate());
    }

    #[test]
    fn snapshot_serialization_contains_only_generated_token_plan_and_counters() {
        let mut state = fresh_state();
        let prepared = state.prepare(valid_request()).unwrap();
        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        let value = serde_json::to_value(snapshot).unwrap();
        assert!(value["caseToken"].as_str().unwrap().starts_with("case-"));
        assert_no_private_fields(&value);
        assert!(value.get("plan").is_some());
    }

    #[test]
    fn existing_token_and_counter_lifecycle_remains_bounded() {
        let mut state = fresh_state();
        let mut tokens = Vec::new();
        for _ in 0..MAX_ACTIVE_CASES {
            tokens.push(state.prepare(valid_request()).unwrap().case_token);
        }
        let limit = state.prepare(valid_request()).unwrap_err();
        assert_eq!(limit.code, HarnessErrorCode::CaseLimitReached);
        assert_eq!(state.counters.active_cases as usize, MAX_ACTIVE_CASES);

        let first = tokens.remove(0);
        let cleaned = state.cleanup(&first).unwrap();
        assert_eq!(cleaned.state, HarnessCaseState::Cleaned);
        assert_eq!(cleaned.counters.active_cases as usize, MAX_ACTIVE_CASES - 1);
        assert_eq!(
            state.snapshot(&first).unwrap_err().code,
            HarnessErrorCode::DuplicateCaseToken
        );
    }

    #[test]
    fn ui_claim_is_fifo_exact_once_and_excludes_detached_plans() {
        let mut state = fresh_state();
        let first = valid_request();
        let detached = HarnessPrepareCaseRequest {
            surface: HarnessSurface::Detached,
            ..first
        };
        let second = HarnessPrepareCaseRequest {
            timing: HarnessTiming::SameTick,
            ..first
        };
        state.prepare(first).unwrap();
        state.prepare(detached).unwrap();
        state.prepare(second).unwrap();

        let claimed_first = state.claim_next_ui_create_plan().expect("first claim");
        assert_eq!(claimed_first.plan, first);
        let claimed_second = state.claim_next_ui_create_plan().expect("second claim");
        assert_eq!(claimed_second.plan, second);
        assert!(state.claim_next_ui_create_plan().is_none());
        assert_eq!(state.counters.claimed_cases, 2);
        assert_eq!(state.counters.queued_ui_create_cases, 0);
    }

    #[test]
    fn bind_is_exact_once_and_lookup_returns_no_internal_identity() {
        let mut state = fresh_state();
        let prepared = state.prepare(valid_request()).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        let receipt = state
            .bind_claimed_case(&claimed.handle, "pty-secret", "generation-secret")
            .unwrap();
        assert_eq!(receipt.state, HarnessCaseState::Bound);
        assert_eq!(receipt.binding_epoch, 1);

        let bound = state
            .lookup_bound_plan("pty-secret", "generation-secret")
            .expect("bound plan");
        assert_eq!(bound.plan, prepared.plan);
        assert_eq!(bound.binding_epoch, 1);
        assert_eq!(bound.state, HarnessCaseState::Bound);
        assert_eq!(
            state
                .bind_claimed_case(&claimed.handle, "pty-secret", "generation-secret")
                .unwrap_err(),
            HarnessHookError::AlreadyBound
        );
        assert!(state
            .lookup_bound_plan("pty-secret", "different-generation")
            .is_none());

        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("pty-secret"));
        assert!(!encoded.contains("generation-secret"));
        assert_no_private_fields(&serde_json::to_value(snapshot).unwrap());
    }

    #[test]
    fn abandoned_claim_is_terminal_failed_without_free_form_reason() {
        let mut state = fresh_state();
        let prepared = state.prepare(valid_request()).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        let receipt = state.abandon_claimed_case(&claimed.handle).unwrap();
        assert_eq!(receipt.state, HarnessCaseState::Failed);
        assert_eq!(receipt.binding_epoch, 0);
        assert_eq!(state.counters.failed_cases, 1);
        assert_eq!(
            state.abandon_claimed_case(&claimed.handle).unwrap_err(),
            HarnessHookError::AlreadyFailed
        );
        assert_eq!(
            state.snapshot(&prepared.case_token).unwrap().state,
            HarnessCaseState::Failed
        );
        assert!(state
            .lookup_bound_plan("pty-secret", "generation-secret")
            .is_none());
    }

    #[test]
    fn cleanup_retires_queued_claimed_and_bound_cases_safely() {
        let mut state = fresh_state();
        let queued = state.prepare(valid_request()).unwrap();
        let claimed = state.prepare(valid_request()).unwrap();
        state.cleanup(&queued.case_token).unwrap();
        let claimed_handle = state.claim_next_ui_create_plan().unwrap().handle;
        let bound = state.prepare(valid_request()).unwrap();
        let bound_handle = state.claim_next_ui_create_plan().unwrap().handle;
        state
            .bind_claimed_case(&bound_handle, "pty-internal", "generation-internal")
            .unwrap();

        assert_eq!(state.counters.queued_ui_create_cases, 0);
        state.cleanup(&claimed.case_token).unwrap();
        assert_eq!(state.counters.active_cases, 1);
        assert!(state
            .lookup_bound_plan("pty-internal", "generation-internal")
            .is_some());
        state.cleanup(&bound.case_token).unwrap();
        assert!(state
            .lookup_bound_plan("pty-internal", "generation-internal")
            .is_none());
        assert_eq!(state.counters.active_cases, 0);
        assert!(state.claim_next_ui_create_plan().is_none());
        assert_eq!(
            state.snapshot(&bound.case_token).unwrap_err().code,
            HarnessErrorCode::DuplicateCaseToken
        );

        // Keep the claimed handle alive through cleanup to prove it cannot
        // rebind or resurrect a retired case.
        assert_eq!(
            state.bind_claimed_case(&claimed_handle, "pty-late", "generation-late"),
            Err(HarnessHookError::UnknownCase)
        );
    }

    #[test]
    fn device_attributes_fixture_is_natural_and_non_warmup_only() {
        let detached = HarnessPrepareCaseRequest {
            surface: HarnessSurface::Detached,
            ..device_attributes_request(HarnessDa1Fault::Reject)
        };
        assert!(detached.validate());
        assert!(!HarnessPrepareCaseRequest {
            timing: HarnessTiming::LateMarker,
            ..detached
        }
        .validate());
        assert!(!HarnessPrepareCaseRequest {
            warmup: HarnessWarmup::Normal,
            ..detached
        }
        .validate());
    }

    #[test]
    fn da1_fault_is_identity_scoped_and_one_shot() {
        let mut state = fresh_state();
        let prepared = state
            .prepare(device_attributes_request(HarnessDa1Fault::Partial))
            .unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();

        assert_eq!(
            state.take_da1_fault("pty-secret", "wrong-generation"),
            HarnessDa1Fault::None
        );
        assert!(!state.record_da1_outcome(
            "pty-secret",
            "wrong-generation",
            HarnessDa1Outcome::Query
        ));
        assert_eq!(
            state
                .bind_claimed_case(&claimed.handle, "pty-secret", "generation-secret")
                .unwrap()
                .state,
            HarnessCaseState::Bound
        );
        assert_eq!(
            state.take_da1_fault("pty-secret", "generation-secret"),
            HarnessDa1Fault::Partial
        );
        assert_eq!(
            state.take_da1_fault("pty-secret", "generation-secret"),
            HarnessDa1Fault::None
        );
        assert_eq!(
            state.snapshot(&prepared.case_token).unwrap().da1,
            HarnessDa1Counters::default()
        );
    }

    #[test]
    fn da1_outcomes_repeat_normally_and_saturate_per_case() {
        let mut state = fresh_state();
        let prepared = state
            .prepare(device_attributes_request(HarnessDa1Fault::None))
            .unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-da1", "generation-da1")
            .unwrap();

        assert!(state.record_da1_outcome("pty-da1", "generation-da1", HarnessDa1Outcome::Query));
        assert!(state.record_da1_outcome("pty-da1", "generation-da1", HarnessDa1Outcome::Query));
        assert!(state.record_da1_outcome(
            "pty-da1",
            "generation-da1",
            HarnessDa1Outcome::Committed
        ));
        assert!(state.record_da1_outcome("pty-da1", "generation-da1", HarnessDa1Outcome::Partial));
        {
            let token = state
                .by_identity
                .get(&InternalIdentity {
                    pty_id: "pty-da1".to_owned(),
                    generation: "generation-da1".to_owned(),
                })
                .cloned()
                .unwrap();
            state.bindings.get_mut(&token).unwrap().da1.queries = u32::MAX;
        }
        assert!(state.record_da1_outcome("pty-da1", "generation-da1", HarnessDa1Outcome::Query));

        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert_eq!(snapshot.da1.queries, u32::MAX);
        assert_eq!(snapshot.da1.committed, 1);
        assert_eq!(snapshot.da1.partial, 1);
        assert_eq!(snapshot.da1.rejected, 0);
    }

    #[test]
    fn da1_counters_and_identity_never_leak_through_json_and_cleanup_removes_lookup() {
        let mut state = fresh_state();
        let prepared = state
            .prepare(device_attributes_request(HarnessDa1Fault::Zero))
            .unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-private", "generation-private")
            .unwrap();
        state.record_da1_outcome("pty-private", "generation-private", HarnessDa1Outcome::Zero);

        let value = serde_json::to_value(state.snapshot(&prepared.case_token).unwrap()).unwrap();
        assert_eq!(value["da1"]["zero"], json!(1));
        assert_no_private_fields(&value);
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("pty-private"));
        assert!(!encoded.contains("generation-private"));

        state.cleanup(&prepared.case_token).unwrap();
        assert!(state
            .lookup_bound_plan("pty-private", "generation-private")
            .is_none());
        assert_eq!(
            state.take_da1_fault("pty-private", "generation-private"),
            HarnessDa1Fault::None
        );
        assert!(!state.record_da1_outcome(
            "pty-private",
            "generation-private",
            HarnessDa1Outcome::Query
        ));
    }

    #[test]
    fn startup_output_evidence_is_identity_scoped_count_only_and_one_shot() {
        let mut state = fresh_state();
        let mut request = valid_request();
        request.timing = HarnessTiming::HoldMarker;
        let prepared = state.prepare(request).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-output", "generation-output")
            .unwrap();

        assert!(!state.record_output_evidence(
            "pty-output",
            "wrong-generation",
            HarnessOutputEvidence {
                marker_matched: true,
                first_output_observed: true,
            }
        ));
        assert!(state.record_output_evidence(
            "pty-output",
            "generation-output",
            HarnessOutputEvidence {
                marker_matched: true,
                first_output_observed: false,
            }
        ));
        assert!(state.record_output_evidence(
            "pty-output",
            "generation-output",
            HarnessOutputEvidence {
                marker_matched: true,
                first_output_observed: true,
            }
        ));
        assert!(state.record_output_evidence(
            "pty-output",
            "generation-output",
            HarnessOutputEvidence {
                marker_matched: false,
                first_output_observed: true,
            }
        ));

        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert!(snapshot.marker_matched);
        assert!(snapshot.first_output_observed);
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["markerMatched"], json!(true));
        assert_eq!(value["firstOutputObserved"], json!(true));
        assert_no_private_fields(&value);
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains("generation-output"));
    }

    #[test]
    fn startup_output_evidence_ignores_non_provider_fixture() {
        let mut state = fresh_state();
        let prepared = state
            .prepare(device_attributes_request(HarnessDa1Fault::None))
            .unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-device", "generation-device")
            .unwrap();
        assert!(!state.record_output_evidence(
            "pty-device",
            "generation-device",
            HarnessOutputEvidence {
                marker_matched: true,
                first_output_observed: true,
            }
        ));
        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert!(!snapshot.marker_matched);
        assert!(!snapshot.first_output_observed);
    }

    #[test]
    fn synthetic_provider_env_skip_is_count_only_and_idempotent() {
        let mut state = fresh_state();
        let prepared = state.prepare(valid_request()).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-proxy", "generation-proxy")
            .unwrap();

        assert!(state.record_provider_env_prepare_skipped("pty-proxy", "generation-proxy"));
        assert!(state.record_provider_env_prepare_skipped("pty-proxy", "generation-proxy"));
        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert!(snapshot.env_preparation_skipped);
        assert_eq!(snapshot.counters.env_preparation_skipped, 1);
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["preparationSkipped"], json!(true));
        assert_eq!(value["counters"]["preparationSkipped"], json!(1));
        assert_no_private_fields(&value);
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("proxy"));
        assert!(!encoded.contains("generation"));
    }

    #[test]
    fn provider_env_skip_ignores_non_synthetic_fixtures() {
        let mut state = fresh_state();
        let mut request = valid_request();
        request.fixture = HarnessFixture::PlainShell;
        let prepared = state.prepare(request).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-plain", "generation-plain")
            .unwrap();
        assert!(!state.record_provider_env_prepare_skipped("pty-plain", "generation-plain"));
        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert!(!snapshot.env_preparation_skipped);
        assert_eq!(snapshot.counters.env_preparation_skipped, 0);
    }

    #[test]
    fn bound_failure_is_exact_identity_once_and_retains_only_safe_state() {
        let mut state = fresh_state();
        let prepared = state.prepare(valid_request()).unwrap();
        let claimed = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claimed.handle, "pty-failure", "generation-failure")
            .unwrap();

        assert!(state
            .fail_bound_case("pty-failure", "other-generation")
            .is_none());
        assert_eq!(state.counters.failed_cases, 0);
        assert_eq!(
            state.snapshot(&prepared.case_token).unwrap().state,
            HarnessCaseState::Bound
        );

        let failed = state
            .fail_bound_case("pty-failure", "generation-failure")
            .expect("first bound failure");
        assert_eq!(failed.state, HarnessCaseState::Failed);
        assert_eq!(failed.binding_epoch, 1);
        assert_eq!(state.counters.failed_cases, 1);
        assert!(state
            .lookup_bound_plan("pty-failure", "generation-failure")
            .is_none());
        assert!(state
            .fail_bound_case("pty-failure", "generation-failure")
            .is_none());
        assert_eq!(state.counters.failed_cases, 1);

        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert_eq!(snapshot.state, HarnessCaseState::Failed);
        assert_eq!(snapshot.binding_epoch, Some(1));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("pty-failure"));
        assert!(!encoded.contains("generation-failure"));
        assert_no_private_fields(&serde_json::to_value(snapshot).unwrap());
    }

    #[test]
    fn status_reports_all_wired_harness_hooks_supported() {
        let status = fresh_state().status();
        assert_eq!(status.shell_forcing, HarnessCapability::Supported);
        assert_eq!(status.timing_injection, HarnessCapability::Supported);
        assert_eq!(status.fault_injection, HarnessCapability::Supported);
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["shellForcing"], json!("supported"));
        assert_eq!(value["timingInjection"], json!("supported"));
        assert_eq!(value["faultInjection"], json!("supported"));
        assert_no_private_fields(&value);
    }

    #[test]
    fn status_enabled_reflects_the_typed_offline_attestation() {
        let state = fresh_state();
        assert!(
            state
                .status_with_attestation(HarnessOfflineAttestation::from_value(Some("1")))
                .enabled
        );
        assert!(
            !state
                .status_with_attestation(HarnessOfflineAttestation::from_value(None))
                .enabled
        );
    }

    #[test]
    fn timing_drive_reservation_rejects_duplicate_until_finalized() {
        let mut state = fresh_state();
        let mut request = valid_request();
        request.timing = HarnessTiming::HoldMarker;
        let prepared = state.prepare(request).unwrap();
        let claim = state.claim_next_ui_create_plan().unwrap();
        state
            .bind_claimed_case(&claim.handle, "pty-drive", "generation-drive")
            .unwrap();

        let context = state
            .drive_context(&prepared.case_token, HarnessDriveAction::ReleaseReady)
            .unwrap();
        assert_eq!(context.plan.timing, HarnessTiming::HoldMarker);
        assert_eq!(
            state
                .drive_context(&prepared.case_token, HarnessDriveAction::ReleaseReady)
                .unwrap_err()
                .code,
            HarnessErrorCode::DriveInFlight
        );

        assert_eq!(
            state.cleanup(&prepared.case_token).unwrap_err().code,
            HarnessErrorCode::DriveInFlight
        );

        state.release_drive_reservation(&prepared.case_token, HarnessDriveAction::ReleaseReady);
        state
            .drive_context(&prepared.case_token, HarnessDriveAction::ReleaseReady)
            .unwrap();
        state
            .record_timing(&prepared.case_token, HarnessDriveAction::ReleaseReady, true)
            .unwrap();
        let snapshot = state.snapshot(&prepared.case_token).unwrap();
        assert_eq!(snapshot.timing.drive, 1);
        assert_eq!(snapshot.timing.ready, 1);
        assert_eq!(snapshot.timing.sent_observed, 1);
    }
}
