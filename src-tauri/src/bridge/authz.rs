//! Central authorization funnel for bridge transports and operations.
//!
//! Handlers must acquire an authorization decision here before performing
//! side effects. Workspace mutations re-check via pairing leases before commit.

use super::protocol::{ClientClass, DevicePermission};

/// How the client reached the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeTransport {
    /// Existing HTTP/WebSocket plaintext v1 listener.
    LegacyPlaintext,
    /// Pinned TLS v2 secure listener.
    SecureTlsV2,
}

/// Requested capability class for authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeOperation {
    /// Terminal snapshot / output / read-only card list.
    TerminalView,
    /// Terminal input, resize, close, spawn, rename (existing full ops).
    TerminalMutate,
    /// Workspace metadata snapshot/subscribe and file/diff reads.
    WorkspaceRead,
    /// Open / reorder / close clean tabs; set active view.
    WorkspaceMetadataMutate,
    /// Draft patch, save/discard, lease takeover, end terminal.
    WorkspaceContentMutate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthzError {
    SecureTransportRequired,
    LegacyClientDenied,
    PermissionDenied,
    DeviceInactive,
}

impl AuthzError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SecureTransportRequired => "secure_transport_required",
            Self::LegacyClientDenied => "legacy_client_denied",
            Self::PermissionDenied => "permission_denied",
            Self::DeviceInactive => "auth_revoked",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::SecureTransportRequired => {
                "This operation requires the secure mobile bridge (TLS v2)."
            }
            Self::LegacyClientDenied => {
                "Legacy terminal tokens cannot access secure workspace operations."
            }
            Self::PermissionDenied => "This device is not authorized for the requested operation.",
            Self::DeviceInactive => "This mobile bridge authorization is no longer active.",
        }
    }
}

/// Device facts required by the funnel (subset of BridgeDevice).
#[derive(Debug, Clone, Copy)]
pub struct AuthzDevice<'a> {
    pub client_class: ClientClass,
    pub permission: &'a DevicePermission,
    pub active: bool,
}

/// Single server-side authorization decision for a requested operation.
pub fn authorize(
    transport: BridgeTransport,
    device: AuthzDevice<'_>,
    operation: BridgeOperation,
) -> Result<(), AuthzError> {
    if !device.active {
        return Err(AuthzError::DeviceInactive);
    }

    match operation {
        BridgeOperation::TerminalView => {
            // Terminal viewing is available on both transports for any paired device.
            Ok(())
        }
        BridgeOperation::TerminalMutate => {
            if *device.permission != DevicePermission::Full {
                return Err(AuthzError::PermissionDenied);
            }
            Ok(())
        }
        BridgeOperation::WorkspaceRead
        | BridgeOperation::WorkspaceMetadataMutate
        | BridgeOperation::WorkspaceContentMutate => {
            if transport != BridgeTransport::SecureTlsV2 {
                return Err(AuthzError::SecureTransportRequired);
            }
            if device.client_class != ClientClass::SecureWorkspace {
                return Err(AuthzError::LegacyClientDenied);
            }
            match operation {
                BridgeOperation::WorkspaceRead | BridgeOperation::WorkspaceMetadataMutate => Ok(()),
                BridgeOperation::WorkspaceContentMutate => {
                    if *device.permission != DevicePermission::Full {
                        return Err(AuthzError::PermissionDenied);
                    }
                    Ok(())
                }
                _ => unreachable!(),
            }
        }
    }
}

/// Whether a workspace mutation requires Full permission.
#[allow(dead_code)]
pub fn workspace_op_requires_full(operation: BridgeOperation) -> bool {
    matches!(operation, BridgeOperation::WorkspaceContentMutate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(class: ClientClass, permission: DevicePermission) -> (ClientClass, DevicePermission) {
        (class, permission)
    }

    fn authz(class: ClientClass, permission: &DevicePermission) -> AuthzDevice<'_> {
        AuthzDevice {
            client_class: class,
            permission,
            active: true,
        }
    }

    #[test]
    fn legacy_token_cannot_access_workspace_even_with_full() {
        let (_class, perm) = device(ClientClass::LegacyTerminal, DevicePermission::Full);
        let err = authorize(
            BridgeTransport::SecureTlsV2,
            authz(ClientClass::LegacyTerminal, &perm),
            BridgeOperation::WorkspaceRead,
        )
        .expect_err("legacy denied");
        assert_eq!(err.code(), "legacy_client_denied");
    }

    #[test]
    fn workspace_ops_require_tls_v2() {
        let (_class, perm) = device(ClientClass::SecureWorkspace, DevicePermission::Full);
        let err = authorize(
            BridgeTransport::LegacyPlaintext,
            authz(ClientClass::SecureWorkspace, &perm),
            BridgeOperation::WorkspaceRead,
        )
        .expect_err("plaintext denied");
        assert_eq!(err.code(), "secure_transport_required");
    }

    #[test]
    fn read_only_can_read_and_manage_clean_tabs_but_not_draft() {
        let (_class, perm) = device(ClientClass::SecureWorkspace, DevicePermission::ReadOnly);
        authorize(
            BridgeTransport::SecureTlsV2,
            authz(ClientClass::SecureWorkspace, &perm),
            BridgeOperation::WorkspaceRead,
        )
        .expect("read");
        authorize(
            BridgeTransport::SecureTlsV2,
            authz(ClientClass::SecureWorkspace, &perm),
            BridgeOperation::WorkspaceMetadataMutate,
        )
        .expect("metadata");
        let err = authorize(
            BridgeTransport::SecureTlsV2,
            authz(ClientClass::SecureWorkspace, &perm),
            BridgeOperation::WorkspaceContentMutate,
        )
        .expect_err("content");
        assert_eq!(err.code(), "permission_denied");
    }

    #[test]
    fn full_secure_device_can_mutate_content() {
        let (_class, perm) = device(ClientClass::SecureWorkspace, DevicePermission::Full);
        authorize(
            BridgeTransport::SecureTlsV2,
            authz(ClientClass::SecureWorkspace, &perm),
            BridgeOperation::WorkspaceContentMutate,
        )
        .expect("full content");
    }

    #[test]
    fn inactive_device_is_rejected() {
        let perm = DevicePermission::Full;
        let err = authorize(
            BridgeTransport::SecureTlsV2,
            AuthzDevice {
                client_class: ClientClass::SecureWorkspace,
                permission: &perm,
                active: false,
            },
            BridgeOperation::WorkspaceRead,
        )
        .expect_err("inactive");
        assert_eq!(err.code(), "auth_revoked");
    }

    #[test]
    fn terminal_view_allowed_on_legacy() {
        let perm = DevicePermission::ReadOnly;
        authorize(
            BridgeTransport::LegacyPlaintext,
            authz(ClientClass::LegacyTerminal, &perm),
            BridgeOperation::TerminalView,
        )
        .expect("terminal view");
    }
}
