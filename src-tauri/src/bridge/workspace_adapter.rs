//! Thin bridge adapter over the authoritative workspace service.
//!
//! Business rules stay in `crate::workspace`; this module only maps v2
//! messages, surfaces, audit metadata, and errors.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::protocol::{
    draft_patch_from_message, DevicePermission, V2ClientMessage, V2ServerMessage,
    WorkspaceMetaSnapshot,
};
use crate::workspace::types::{
    CloseTabDecision, CloseTabDecisionKind, OpenTabRequest, WorkspaceTabKind,
};
use crate::workspace::{shared_workspace_service, WorkspaceService};

static WORKSPACE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_workspace_seq() -> u64 {
    WORKSPACE_SEQ.fetch_add(1, Ordering::Relaxed)
}

fn surface_id_for_device(device_id: &str) -> String {
    format!("mobile:secure:{device_id}")
}

pub struct WorkspaceBridgeAdapter {
    service: Arc<WorkspaceService>,
}

impl Default for WorkspaceBridgeAdapter {
    fn default() -> Self {
        Self {
            service: shared_workspace_service(),
        }
    }
}

impl WorkspaceBridgeAdapter {
    #[allow(dead_code)]
    pub fn new(service: Arc<WorkspaceService>) -> Self {
        Self { service }
    }

    pub fn service(&self) -> Arc<WorkspaceService> {
        self.service.clone()
    }

    pub async fn handle(
        &self,
        device_id: &str,
        permission: &DevicePermission,
        runtime_id: &str,
        message: V2ClientMessage,
    ) -> Result<Vec<V2ServerMessage>, (String, String)> {
        let service = self.service.clone();
        let device_id = device_id.to_string();
        let permission = permission.clone();
        let runtime_id = runtime_id.to_string();
        tokio::task::spawn_blocking(move || {
            handle_blocking(&service, &device_id, &permission, &runtime_id, message)
        })
        .await
        .map_err(|error| {
            (
                "persistence_failed".to_string(),
                format!("Workspace worker failed: {error}"),
            )
        })?
    }
}

fn handle_blocking(
    service: &WorkspaceService,
    device_id: &str,
    permission: &DevicePermission,
    runtime_id: &str,
    message: V2ClientMessage,
) -> Result<Vec<V2ServerMessage>, (String, String)> {
    let surface = surface_id_for_device(device_id);
    match message {
        V2ClientMessage::GetWorkspaceSnapshot {
            request_id,
            workspace_id,
        } => {
            audit(device_id, "workspace_snapshot", &workspace_id, None, 0);
            let snapshot = service.get_snapshot(&workspace_id).map_err(workspace_err)?;
            Ok(vec![meta_snapshot_message(
                Some(request_id),
                snapshot,
                permission,
                runtime_id,
            )])
        }
        V2ClientMessage::SubscribeWorkspace { workspace_id } => {
            audit(device_id, "workspace_subscribe", &workspace_id, None, 0);
            let snapshot = service.get_snapshot(&workspace_id).map_err(workspace_err)?;
            Ok(vec![meta_snapshot_message(
                None, snapshot, permission, runtime_id,
            )])
        }
        V2ClientMessage::UnsubscribeWorkspace { workspace_id } => {
            audit(device_id, "workspace_unsubscribe", &workspace_id, None, 0);
            Ok(vec![])
        }
        V2ClientMessage::OpenTab {
            request_id,
            workspace_id,
            tab_kind,
            title,
            card_id,
            relative_path,
        } => {
            let parsed_kind = WorkspaceTabKind::parse(&tab_kind).ok_or_else(|| {
                (
                    "invalid_argument".to_string(),
                    format!("Unknown tab kind: {tab_kind}"),
                )
            })?;
            let title = title.unwrap_or_else(|| tab_kind.clone());
            audit(
                device_id,
                "open_tab",
                &workspace_id,
                relative_path.as_deref(),
                0,
            );
            let tab = service
                .open_tab(
                    &workspace_id,
                    OpenTabRequest {
                        kind: parsed_kind,
                        title,
                        card_id,
                        relative_path,
                    },
                )
                .map_err(workspace_err)?;
            Ok(vec![result_ok(
                request_id,
                Some(tab.shared_order as u64),
                Some(serde_json::to_value(&tab).unwrap_or_default()),
            )])
        }
        V2ClientMessage::CloseTab {
            request_id,
            workspace_id,
            tab_id,
            force,
        } => {
            audit(device_id, "close_tab", &workspace_id, Some(&tab_id), 0);
            let force = force.unwrap_or(false);
            let decisions = if force {
                vec![CloseTabDecision {
                    tab_id: tab_id.clone(),
                    kind: CloseTabDecisionKind::DiscardAndClose,
                    expected_revision: None,
                }]
            } else {
                let prepare = service
                    .prepare_close(&workspace_id, std::slice::from_ref(&tab_id))
                    .map_err(workspace_err)?;
                if !prepare.dirty_tab_ids.is_empty() || !prepare.conflict_tab_ids.is_empty() {
                    return Ok(vec![result_err(
                        request_id,
                        "tab_dirty",
                        "Tab has unsaved changes; save, discard, or force close.",
                    )]);
                }
                vec![CloseTabDecision {
                    tab_id,
                    kind: CloseTabDecisionKind::CloseClean,
                    expected_revision: None,
                }]
            };
            service
                .commit_close(&workspace_id, &decisions)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(request_id, None, None)])
        }
        V2ClientMessage::ReorderTabs {
            request_id,
            workspace_id,
            ordered_tab_ids,
        } => {
            audit(device_id, "reorder_tabs", &workspace_id, None, 0);
            service
                .reorder_tabs(&workspace_id, &ordered_tab_ids)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(request_id, None, None)])
        }
        V2ClientMessage::SetActiveTab {
            request_id,
            workspace_id,
            tab_id,
        } => {
            audit(device_id, "set_active_tab", &workspace_id, Some(&tab_id), 0);
            service
                .set_active_tab(&workspace_id, &surface, &tab_id)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(request_id, None, None)])
        }
        V2ClientMessage::ReadFile {
            request_id,
            workspace_id,
            relative_path,
        } => {
            let file = service
                .read_file(&workspace_id, &relative_path)
                .map_err(workspace_err)?;
            if file.contents.len() > super::protocol::MAX_V2_PAYLOAD_BYTES {
                return Err((
                    "payload_too_large".to_string(),
                    "File content exceeds the 1 MiB secure bridge limit.".to_string(),
                ));
            }
            audit(
                device_id,
                "read_file",
                &workspace_id,
                Some(&relative_path),
                file.size_bytes,
            );
            // Never log contents. Absolute path is omitted from the wire response.
            Ok(vec![V2ServerMessage::FileContent {
                request_id,
                workspace_id,
                relative_path: file.relative_path,
                contents: file.contents,
                size_bytes: file.size_bytes,
                modified_unix_ms: file.modified_unix_ms,
            }])
        }
        V2ClientMessage::GetDraft {
            request_id,
            workspace_id,
            tab_id,
        } => {
            let draft = service
                .ensure_draft_from_disk(&workspace_id, &tab_id)
                .map_err(workspace_err)?;
            if draft.contents.len() > super::protocol::MAX_V2_PAYLOAD_BYTES {
                return Err((
                    "payload_too_large".to_string(),
                    "Draft content exceeds the 1 MiB secure bridge limit.".to_string(),
                ));
            }
            audit(
                device_id,
                "get_draft",
                &workspace_id,
                Some(&tab_id),
                draft.meta.size_bytes,
            );
            Ok(vec![V2ServerMessage::DraftContent {
                request_id,
                workspace_id,
                tab_id,
                revision: draft.meta.revision,
                dirty: draft.meta.dirty,
                conflict: draft.meta.conflict,
                contents: draft.contents,
                size_bytes: draft.meta.size_bytes,
            }])
        }
        V2ClientMessage::ApplyDraftPatch {
            request_id,
            workspace_id,
            tab_id,
            base_revision,
            changes,
            full_text,
        } => {
            let size_hint = full_text.as_ref().map(|t| t.len() as u64).unwrap_or(0);
            audit(
                device_id,
                "apply_draft_patch",
                &workspace_id,
                Some(&tab_id),
                size_hint,
            );
            let patch =
                draft_patch_from_message(workspace_id, tab_id, base_revision, changes, full_text);
            let result = service
                .apply_draft_patch(&surface, patch, true)
                .map_err(workspace_err)?;
            Ok(vec![V2ServerMessage::DraftPatched { request_id, result }])
        }
        V2ClientMessage::SaveDraft {
            request_id,
            workspace_id,
            tab_id,
            expected_revision,
            force,
        } => {
            audit(device_id, "save_draft", &workspace_id, Some(&tab_id), 0);
            let saved = service
                .save_draft(
                    &workspace_id,
                    &tab_id,
                    expected_revision,
                    force.unwrap_or(false),
                )
                .map_err(workspace_err)?;
            let revision = saved.draft_meta.as_ref().map(|m| m.revision);
            Ok(vec![result_ok(
                request_id,
                revision,
                Some(serde_json::json!({
                    "relativePath": saved.file.relative_path,
                    "sizeBytes": saved.file.size_bytes,
                })),
            )])
        }
        V2ClientMessage::DiscardDraft {
            request_id,
            workspace_id,
            tab_id,
            expected_revision,
        } => {
            audit(device_id, "discard_draft", &workspace_id, Some(&tab_id), 0);
            service
                .discard_draft(&workspace_id, &tab_id, Some(expected_revision))
                .map_err(workspace_err)?;
            Ok(vec![result_ok(request_id, Some(expected_revision), None)])
        }
        V2ClientMessage::AcquireLease {
            request_id,
            workspace_id,
            tab_id,
        } => {
            audit(device_id, "acquire_lease", &workspace_id, Some(&tab_id), 0);
            let lease = service
                .acquire_lease(&workspace_id, &tab_id, &surface)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(
                request_id,
                Some(lease.revision),
                Some(serde_json::to_value(&lease).unwrap_or_default()),
            )])
        }
        V2ClientMessage::RenewLease {
            request_id,
            workspace_id,
            tab_id,
        } => {
            let lease = service
                .renew_lease(&workspace_id, &tab_id, &surface)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(
                request_id,
                Some(lease.revision),
                Some(serde_json::to_value(&lease).unwrap_or_default()),
            )])
        }
        V2ClientMessage::ReleaseLease {
            request_id,
            workspace_id,
            tab_id,
        } => {
            service
                .release_lease(&workspace_id, &tab_id, &surface)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(request_id, None, None)])
        }
        V2ClientMessage::TakeoverLease {
            request_id,
            workspace_id,
            tab_id,
        } => {
            audit(device_id, "takeover_lease", &workspace_id, Some(&tab_id), 0);
            let lease = service
                .takeover_lease(&workspace_id, &tab_id, &surface)
                .map_err(workspace_err)?;
            Ok(vec![result_ok(
                request_id,
                Some(lease.revision),
                Some(serde_json::to_value(&lease).unwrap_or_default()),
            )])
        }
        V2ClientMessage::ListDirectory {
            request_id,
            workspace_id,
            relative_path,
        } => {
            audit(
                device_id,
                "list_directory",
                &workspace_id,
                relative_path.as_deref(),
                0,
            );
            let entries = service
                .list_directory(&workspace_id, relative_path.as_deref())
                .map_err(workspace_err)?;
            Ok(vec![result_ok(
                request_id,
                None,
                Some(serde_json::to_value(&entries).unwrap_or_default()),
            )])
        }
        other => Err((
            "invalid_message".to_string(),
            format!("Message is not a workspace operation: {other:?}"),
        )),
    }
}

fn meta_snapshot_message(
    request_id: Option<String>,
    snapshot: crate::workspace::types::WorkspaceSnapshot,
    permission: &DevicePermission,
    runtime_id: &str,
) -> V2ServerMessage {
    let mut meta = WorkspaceMetaSnapshot::from(snapshot);
    meta.permission = permission.clone();
    meta.revision = next_workspace_seq();
    V2ServerMessage::WorkspaceSnapshot {
        request_id,
        snapshot: meta,
        runtime_id: runtime_id.to_string(),
        workspace_seq: next_workspace_seq(),
    }
}

fn result_ok(
    request_id: String,
    revision: Option<u64>,
    payload: Option<serde_json::Value>,
) -> V2ServerMessage {
    V2ServerMessage::WorkspaceResult {
        request_id,
        ok: true,
        error_code: None,
        message: None,
        revision,
        payload,
    }
}

fn result_err(request_id: String, code: &str, message: &str) -> V2ServerMessage {
    V2ServerMessage::WorkspaceResult {
        request_id,
        ok: false,
        error_code: Some(code.to_string()),
        message: Some(message.to_string()),
        revision: None,
        payload: None,
    }
}

fn workspace_err(error: crate::workspace::WorkspaceError) -> (String, String) {
    (error.code.as_str().to_string(), error.message)
}

/// Metadata-only audit: never log token, OTP, file, draft, or terminal bodies.
fn audit(device_id: &str, action: &str, workspace_id: &str, tab_or_path: Option<&str>, bytes: u64) {
    let summary = match tab_or_path {
        Some(value) => format!(
            "workspace_id_bytes={}, ref_bytes={}, bytes={}",
            workspace_id.len(),
            value.len(),
            bytes
        ),
        None => format!("workspace_id_bytes={}, bytes={}", workspace_id.len(), bytes),
    };
    crate::db::enqueue_audit_log(device_id, action, None, &summary);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{WorkspaceError, WorkspaceErrorCode};

    #[test]
    fn surface_id_is_device_scoped() {
        assert_eq!(surface_id_for_device("dev_1"), "mobile:secure:dev_1");
    }

    #[test]
    fn workspace_err_preserves_stable_codes() {
        let err = WorkspaceError::new(WorkspaceErrorCode::StaleRevision, "stale");
        let (code, message) = workspace_err(err);
        assert_eq!(code, "stale_revision");
        assert_eq!(message, "stale");
    }
}
