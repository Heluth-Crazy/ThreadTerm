use serde::{Deserialize, Serialize};
use std::fmt;

pub const TERMINAL_LAUNCH_V1: &str = "terminal-launch/v1";
pub const REQUIRED_TERMINAL_LAUNCH_V1_CAPABILITIES: [&str; 6] = [
    "terminal.create",
    "terminal.get-by-request-id",
    "terminal.present",
    "terminal.close-by-handle",
    "presentation.window.background",
    "exit.close-on-exit",
];
pub const REQUEST_ID_MAX_BYTES: usize = 512;
pub const SESSION_HANDLE_MAX_BYTES: usize = 128;
pub const MAX_LAUNCH_ARGUMENTS: usize = 256;
pub const MAX_LAUNCH_COMMAND_BYTES: usize = 32 * 1024;
pub const MAX_LAUNCH_TITLE_BYTES: usize = 1024;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHello {
    pub protocol_version: ProtocolVersion,
    pub runtime_id: String,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalHostStatus {
    pub platform: TerminalHostPlatform,
    pub runtime_state: TerminalHostRuntimeState,
    pub desktop_available: bool,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub protocol_version: Option<u16>,
    pub contract_versions: Vec<String>,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalHostPlatform {
    Windows,
    Unsupported,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalHostRuntimeState {
    Available,
    Unavailable,
    UpgradeDeferred,
}
impl TerminalHostStatus {
    pub fn supports_terminal_launch_v1(&self) -> bool {
        self.platform == TerminalHostPlatform::Windows
            && self.runtime_state == TerminalHostRuntimeState::Available
            && self.desktop_available
            && self
                .contract_versions
                .iter()
                .any(|v| v == TERMINAL_LAUNCH_V1)
            && REQUIRED_TERMINAL_LAUNCH_V1_CAPABILITIES
                .iter()
                .all(|r| self.capabilities.iter().any(|v| v == r))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Placement {
    Workspace,
    Window,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Presentation {
    Background,
    Focused,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExitBehavior {
    Keep,
    CloseOnSuccess,
    CloseOnExit,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalLaunchV1 {
    pub version: u8,
    pub request_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub title: Option<String>,
    pub placement: Placement,
    #[serde(default)]
    pub presentation: Option<Presentation>,
    #[serde(default)]
    pub exit_behavior: Option<ExitBehavior>,
}
#[derive(Clone, Eq, PartialEq)]
pub struct NormalizedTerminalLaunchV1 {
    pub request_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub title: Option<String>,
    pub placement: Placement,
    pub presentation: Presentation,
    pub exit_behavior: ExitBehavior,
    pub workspace_path: String,
}
impl fmt::Debug for TerminalLaunchV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalLaunchV1")
            .field("version", &self.version)
            .field("request_id", &"[redacted]")
            .field("executable", &"[redacted]")
            .field("args", &"[redacted]")
            .field("cwd", &"[redacted]")
            .field("title", &self.title.as_ref().map(|_| "[redacted]"))
            .field("placement", &self.placement)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .finish()
    }
}
impl fmt::Debug for NormalizedTerminalLaunchV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NormalizedTerminalLaunchV1")
            .field("request_id", &"[redacted]")
            .field("executable", &"[redacted]")
            .field("args", &"[redacted]")
            .field("cwd", &"[redacted]")
            .field("title", &self.title.as_ref().map(|_| "[redacted]"))
            .field("placement", &self.placement)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .field("workspace_path", &"[redacted]")
            .finish()
    }
}
impl TerminalLaunchV1 {
    pub fn normalize(self) -> Result<NormalizedTerminalLaunchV1, &'static str> {
        if self.version != 1
            || !is_valid_request_id(&self.request_id)
            || !is_valid_launch_field(&self.executable, MAX_LAUNCH_COMMAND_BYTES)
            || !is_valid_launch_field(&self.cwd, MAX_LAUNCH_COMMAND_BYTES)
            || self.args.len() > MAX_LAUNCH_ARGUMENTS
            || !self
                .args
                .iter()
                .all(|arg| arg.len() <= MAX_LAUNCH_COMMAND_BYTES)
            || self
                .title
                .as_ref()
                .is_some_and(|title| title.len() > MAX_LAUNCH_TITLE_BYTES)
        {
            return Err("invalid_request");
        }
        Ok(NormalizedTerminalLaunchV1 {
            request_id: self.request_id,
            executable: self.executable,
            args: self.args,
            cwd: self.cwd.clone(),
            title: self.title.and_then(|v| (!v.trim().is_empty()).then_some(v)),
            placement: self.placement,
            presentation: self.presentation.unwrap_or(Presentation::Focused),
            exit_behavior: self.exit_behavior.unwrap_or(ExitBehavior::Keep),
            workspace_path: self.cwd,
        })
    }
}
fn is_valid_launch_field(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}
pub fn is_valid_request_id(request_id: &str) -> bool {
    !request_id.trim().is_empty() && request_id.len() <= REQUEST_ID_MAX_BYTES
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSelector {
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}
impl SessionSelector {
    pub fn is_exactly_one(&self) -> bool {
        self.handle.is_some() ^ self.request_id.is_some()
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = match (&self.handle, &self.request_id) {
            (Some(handle), None) => {
                !handle.trim().is_empty() && handle.len() <= SESSION_HANDLE_MAX_BYTES
            }
            (None, Some(request_id)) => is_valid_request_id(request_id),
            _ => false,
        };
        valid.then_some(()).ok_or("invalid_request")
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalErrorCode {
    AppUnavailable,
    UnsupportedPlatform,
    InvalidRequest,
    RequestConflict,
    SpawnFailed,
    SurfaceFailed,
    TerminalNotFound,
    IncompatibleRuntime,
    InternalError,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClassification {
    NoEffect,
    SessionCreated,
    OutcomeUnknown,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalErrorEnvelope {
    pub code: TerminalErrorCode,
    pub message: String,
    pub effect: EffectClassification,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
    pub retryable: bool,
}
impl fmt::Debug for TerminalErrorEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalErrorEnvelope")
            .field("code", &self.code)
            .field("effect", &self.effect)
            .field("request_id", &self.request_id)
            .field("handle", &self.handle)
            .field("retryable", &self.retryable)
            .finish()
    }
}
impl fmt::Display for TerminalErrorEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.code {
            TerminalErrorCode::AppUnavailable => "app_unavailable",
            TerminalErrorCode::UnsupportedPlatform => "unsupported_platform",
            TerminalErrorCode::InvalidRequest => "invalid_request",
            TerminalErrorCode::RequestConflict => "request_conflict",
            TerminalErrorCode::SpawnFailed => "spawn_failed",
            TerminalErrorCode::SurfaceFailed => "surface_failed",
            TerminalErrorCode::TerminalNotFound => "terminal_not_found",
            TerminalErrorCode::IncompatibleRuntime => "incompatible_runtime",
            TerminalErrorCode::InternalError => "internal_error",
        })
    }
}
impl std::error::Error for TerminalErrorEnvelope {}
impl TerminalErrorEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self.effect {
            EffectClassification::NoEffect => self.handle.is_none(),
            EffectClassification::SessionCreated => {
                self.handle.is_some() && self.request_id.is_some()
            }
            EffectClassification::OutcomeUnknown => {
                self.request_id.is_some() && self.handle.is_none()
            }
        }
        .then_some(())
        .ok_or("invalid_request")
    }
}
