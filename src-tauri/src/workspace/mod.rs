//! Worktree-scoped workspace authority: identity, tabs, drafts, leases.

mod commands;
mod error;
mod hash;
mod leases;
mod paths;
mod schema;
mod service;
pub mod types;

pub use commands::*;
#[allow(unused_imports)]
pub use error::{WorkspaceError, WorkspaceErrorCode};
pub(crate) use paths::{normalize_project_identity_path, same_project_path};
pub use schema::ensure_workspace_schema;
pub use service::WorkspaceService;

#[cfg(test)]
mod contract_tests {
    use super::error::{WorkspaceError, WorkspaceErrorCode, WORKSPACE_ERROR_CODES};
    use super::service::WorkspaceService;
    use super::types::{
        DESKTOP_MAIN_SURFACE, HOME_TAB_ID, LEASE_DISCONNECT_GRACE_MS, MAX_DRAFT_BYTES,
        WORKSPACE_EVENT_CHANNEL,
    };

    #[test]
    fn error_code_list_matches_enum() {
        let from_enum = [
            WorkspaceErrorCode::WorkspaceNotFound.as_str(),
            WorkspaceErrorCode::WorkspaceUnavailable.as_str(),
            WorkspaceErrorCode::TabNotFound.as_str(),
            WorkspaceErrorCode::PathOutsideWorkspace.as_str(),
            WorkspaceErrorCode::PathInvalid.as_str(),
            WorkspaceErrorCode::PermissionDenied.as_str(),
            WorkspaceErrorCode::LeaseRequired.as_str(),
            WorkspaceErrorCode::LeaseConflict.as_str(),
            WorkspaceErrorCode::StaleRevision.as_str(),
            WorkspaceErrorCode::FileConflict.as_str(),
            WorkspaceErrorCode::FileTooLarge.as_str(),
            WorkspaceErrorCode::FileBinary.as_str(),
            WorkspaceErrorCode::FileNotUtf8.as_str(),
            WorkspaceErrorCode::FileNotFound.as_str(),
            WorkspaceErrorCode::PersistenceFailed.as_str(),
            WorkspaceErrorCode::SecureTransportRequired.as_str(),
            WorkspaceErrorCode::InvalidArgument.as_str(),
        ];
        assert_eq!(from_enum, WORKSPACE_ERROR_CODES);
        let _ = WorkspaceService::default();
        let _ = HOME_TAB_ID;
        let _ = DESKTOP_MAIN_SURFACE;
        let _ = WORKSPACE_EVENT_CHANNEL;
        let _ = MAX_DRAFT_BYTES;
        let _ = LEASE_DISCONNECT_GRACE_MS;
        let err = WorkspaceError::new(WorkspaceErrorCode::StaleRevision, "x");
        assert_eq!(err.code.as_str(), "stale_revision");
    }
}
