//! Stable workspace service error codes shared with TypeScript and future bridge v2.

use serde::Serialize;
use std::fmt;

/// Machine-stable error codes. Display form is `code: human message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceErrorCode {
    WorkspaceNotFound,
    WorkspaceUnavailable,
    TabNotFound,
    PathOutsideWorkspace,
    PathInvalid,
    PermissionDenied,
    LeaseRequired,
    LeaseConflict,
    StaleRevision,
    FileConflict,
    FileTooLarge,
    FileBinary,
    FileNotUtf8,
    FileNotFound,
    PersistenceFailed,
    SecureTransportRequired,
    InvalidArgument,
}

impl WorkspaceErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WorkspaceNotFound => "workspace_not_found",
            Self::WorkspaceUnavailable => "workspace_unavailable",
            Self::TabNotFound => "tab_not_found",
            Self::PathOutsideWorkspace => "path_outside_workspace",
            Self::PathInvalid => "path_invalid",
            Self::PermissionDenied => "permission_denied",
            Self::LeaseRequired => "lease_required",
            Self::LeaseConflict => "lease_conflict",
            Self::StaleRevision => "stale_revision",
            Self::FileConflict => "file_conflict",
            Self::FileTooLarge => "file_too_large",
            Self::FileBinary => "file_binary",
            Self::FileNotUtf8 => "file_not_utf8",
            Self::FileNotFound => "file_not_found",
            Self::PersistenceFailed => "persistence_failed",
            Self::SecureTransportRequired => "secure_transport_required",
            Self::InvalidArgument => "invalid_argument",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceError {
    pub code: WorkspaceErrorCode,
    pub message: String,
}

impl WorkspaceError {
    pub fn new(code: WorkspaceErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn wire(&self) -> String {
        format!("{}: {}", self.code.as_str(), self.message)
    }

    pub fn from_file_error(err: &str) -> Self {
        let code = if let Some((prefix, _)) = err.split_once(':') {
            match prefix.trim() {
                "file_outside_workspace" => WorkspaceErrorCode::PathOutsideWorkspace,
                "file_too_large" => WorkspaceErrorCode::FileTooLarge,
                "file_binary" => WorkspaceErrorCode::FileBinary,
                "file_not_utf8" => WorkspaceErrorCode::FileNotUtf8,
                "file_conflict" => WorkspaceErrorCode::FileConflict,
                "file_path_required"
                | "workspace_root_required"
                | "workspace_root_not_absolute"
                | "workspace_root_not_directory"
                | "workspace_root_unresolved"
                | "file_parent_missing"
                | "file_parent_unresolved"
                | "file_name_missing"
                | "file_unresolved"
                | "file_not_regular" => WorkspaceErrorCode::PathInvalid,
                "file_stat_failed" | "file_read_failed" | "file_write_failed" => {
                    WorkspaceErrorCode::PersistenceFailed
                }
                _ => WorkspaceErrorCode::InvalidArgument,
            }
        } else {
            WorkspaceErrorCode::InvalidArgument
        };
        let message = err
            .split_once(':')
            .map(|(_, rest)| rest.trim().to_string())
            .unwrap_or_else(|| err.to_string());
        Self::new(code, message)
    }
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.wire())
    }
}

impl std::error::Error for WorkspaceError {}

impl From<WorkspaceError> for String {
    fn from(value: WorkspaceError) -> Self {
        value.wire()
    }
}

/// Canonical list of error code strings for contract tests.
#[cfg_attr(not(test), allow(dead_code))]
pub const WORKSPACE_ERROR_CODES: &[&str] = &[
    "workspace_not_found",
    "workspace_unavailable",
    "tab_not_found",
    "path_outside_workspace",
    "path_invalid",
    "permission_denied",
    "lease_required",
    "lease_conflict",
    "stale_revision",
    "file_conflict",
    "file_too_large",
    "file_binary",
    "file_not_utf8",
    "file_not_found",
    "persistence_failed",
    "secure_transport_required",
    "invalid_argument",
];
