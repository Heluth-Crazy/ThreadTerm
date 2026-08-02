//! Tauri command adapters for the workspace service.

use super::service::WorkspaceService;
use super::types::*;
use crate::files::DirEntry;
use once_cell::sync::Lazy;
use std::sync::Arc;
use tauri::Emitter;

static WORKSPACE_SERVICE: Lazy<Arc<WorkspaceService>> =
    Lazy::new(|| Arc::new(WorkspaceService::default()));

/// Shared workspace authority used by desktop IPC and the secure bridge adapter.
pub fn shared_workspace_service() -> Arc<WorkspaceService> {
    WORKSPACE_SERVICE.clone()
}

fn emit_pending(app: &tauri::AppHandle) {
    let events = WORKSPACE_SERVICE.take_events();
    for event in events {
        let _ = app.emit(WORKSPACE_EVENT_CHANNEL, event);
    }
}

#[tauri::command]
pub async fn workspace_ensure(root_path: String) -> Result<WorkspaceRecord, String> {
    tokio::task::spawn_blocking(move || WORKSPACE_SERVICE.ensure_workspace(&root_path))
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_get(workspace_id: String) -> Result<WorkspaceRecord, String> {
    tokio::task::spawn_blocking(move || WORKSPACE_SERVICE.get_workspace(&workspace_id))
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_list() -> Result<Vec<WorkspaceRecord>, String> {
    tokio::task::spawn_blocking(|| WORKSPACE_SERVICE.list_workspaces())
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_get_snapshot(workspace_id: String) -> Result<WorkspaceSnapshot, String> {
    tokio::task::spawn_blocking(move || WORKSPACE_SERVICE.get_snapshot(&workspace_id))
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_open_tab(
    app: tauri::AppHandle,
    workspace_id: String,
    request: OpenTabRequest,
) -> Result<WorkspaceTab, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.open_tab(&workspace_id, request)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_reorder_tabs(
    app: tauri::AppHandle,
    workspace_id: String,
    ordered_tab_ids: Vec<String>,
) -> Result<Vec<WorkspaceTab>, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.reorder_tabs(&workspace_id, &ordered_tab_ids)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_set_active_tab(
    workspace_id: String,
    surface_id: String,
    active_tab_id: String,
) -> Result<WorkspaceViewState, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.set_active_tab(&workspace_id, &surface_id, &active_tab_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_list_directory(
    workspace_id: String,
    relative_path: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.list_directory(&workspace_id, relative_path.as_deref())
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_read_workspace_file(
    workspace_id: String,
    relative_path: String,
) -> Result<WorkspaceFileContent, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.read_file(&workspace_id, &relative_path)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_get_draft(
    workspace_id: String,
    tab_id: String,
) -> Result<Option<WorkspaceDraft>, String> {
    tokio::task::spawn_blocking(move || WORKSPACE_SERVICE.get_draft(&workspace_id, &tab_id))
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_ensure_draft(
    workspace_id: String,
    tab_id: String,
) -> Result<WorkspaceDraft, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.ensure_draft_from_disk(&workspace_id, &tab_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_apply_draft_patch(
    app: tauri::AppHandle,
    surface_id: String,
    patch: DraftPatch,
    require_lease: Option<bool>,
) -> Result<DraftPatchResult, String> {
    let require = require_lease.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.apply_draft_patch(&surface_id, patch, require)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_save_draft(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
    expected_revision: u64,
    force: Option<bool>,
) -> Result<WorkspaceSaveResult, String> {
    let force = force.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.save_draft(&workspace_id, &tab_id, expected_revision, force)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_discard_draft(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
    expected_revision: Option<u64>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.discard_draft(&workspace_id, &tab_id, expected_revision)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(())
}

#[tauri::command]
pub async fn workspace_refresh_availability(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<WorkspaceRecord, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.refresh_availability(&workspace_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_disconnect_surface(
    app: tauri::AppHandle,
    surface_id: String,
    graceful: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.disconnect_surface(&surface_id, graceful);
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?;
    emit_pending(&app);
    Ok(())
}

#[tauri::command]
pub async fn workspace_use_disk_version(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
) -> Result<WorkspaceDraft, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.use_disk_version(&workspace_id, &tab_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_save_as(
    workspace_id: String,
    tab_id: String,
    new_relative_path: String,
    expected_revision: u64,
) -> Result<WorkspaceSaveResult, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.save_as(&workspace_id, &tab_id, &new_relative_path, expected_revision)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_prepare_close(
    workspace_id: String,
    tab_ids: Vec<String>,
) -> Result<ClosePrepareResult, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.prepare_close(&workspace_id, &tab_ids)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_commit_close(
    app: tauri::AppHandle,
    workspace_id: String,
    decisions: Vec<CloseTabDecision>,
) -> Result<Vec<String>, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.commit_close(&workspace_id, &decisions)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_acquire_lease(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
    surface_id: String,
) -> Result<EditorLeaseSnapshot, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.acquire_lease(&workspace_id, &tab_id, &surface_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_renew_lease(
    workspace_id: String,
    tab_id: String,
    surface_id: String,
) -> Result<EditorLeaseSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.renew_lease(&workspace_id, &tab_id, &surface_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_release_lease(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
    surface_id: String,
) -> Result<bool, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.release_lease(&workspace_id, &tab_id, &surface_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_takeover_lease(
    app: tauri::AppHandle,
    workspace_id: String,
    tab_id: String,
    surface_id: String,
) -> Result<EditorLeaseSnapshot, String> {
    let result = tokio::task::spawn_blocking(move || {
        WORKSPACE_SERVICE.takeover_lease(&workspace_id, &tab_id, &surface_id)
    })
    .await
    .map_err(|e| format!("persistence_failed: {e}"))?
    .map_err(String::from)?;
    emit_pending(&app);
    Ok(result)
}

#[tauri::command]
pub async fn workspace_diagnostics() -> Result<WorkspaceDiagnostics, String> {
    tokio::task::spawn_blocking(|| WORKSPACE_SERVICE.diagnostics())
        .await
        .map_err(|e| format!("persistence_failed: {e}"))?
        .map_err(Into::into)
}
