//! Workspace authority DTOs. Field names and enum values are contract-locked
//! with TypeScript (`src/lib/workspace/types.ts`).

use serde::{Deserialize, Serialize};

pub const MAX_DRAFT_BYTES: u64 = 1024 * 1024;
pub const LEASE_DISCONNECT_GRACE_MS: u64 = 30_000;
pub const HOME_TAB_ID: &str = "home";
#[allow(dead_code)] // Contract constant shared with TypeScript / future bridge.
pub const DESKTOP_MAIN_SURFACE: &str = "desktop:main";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceTabKind {
    Home,
    Terminal,
    File,
    Diff,
}

impl WorkspaceTabKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Terminal => "terminal",
            Self::File => "file",
            Self::Diff => "diff",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "home" => Some(Self::Home),
            "terminal" => Some(Self::Terminal),
            "file" => Some(Self::File),
            "diff" => Some(Self::Diff),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAvailability {
    Available,
    Unavailable,
}

impl WorkspaceAvailability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "unavailable" {
            Self::Unavailable
        } else {
            Self::Available
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftConflictState {
    None,
    ExternalChange,
    StaleRevision,
}

impl DraftConflictState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ExternalChange => "external_change",
            Self::StaleRevision => "stale_revision",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "external_change" => Self::ExternalChange,
            "stale_revision" => Self::StaleRevision,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub canonical_root: String,
    pub display_path: String,
    pub availability: WorkspaceAvailability,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    pub id: String,
    pub workspace_id: String,
    pub kind: WorkspaceTabKind,
    pub title: String,
    /// Terminal card id when kind is terminal.
    pub card_id: Option<String>,
    /// Workspace-relative path for file/diff tabs.
    pub relative_path: Option<String>,
    pub shared_order: i64,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDraftMeta {
    pub workspace_id: String,
    pub tab_id: String,
    pub revision: u64,
    pub dirty: bool,
    pub conflict: DraftConflictState,
    pub base_modified_unix_ms: Option<u64>,
    pub base_hash: Option<String>,
    pub size_bytes: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDraft {
    #[serde(flatten)]
    pub meta: WorkspaceDraftMeta,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceViewState {
    pub workspace_id: String,
    pub surface_id: String,
    pub active_tab_id: String,
    pub last_seen_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub workspace: WorkspaceRecord,
    pub tabs: Vec<WorkspaceTab>,
    pub draft_metas: Vec<WorkspaceDraftMeta>,
    pub view_states: Vec<WorkspaceViewState>,
    pub active_leases: Vec<EditorLeaseSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorLeaseSnapshot {
    pub workspace_id: String,
    pub tab_id: String,
    pub holder_surface_id: String,
    pub revision: u64,
    pub acquired_at_unix_ms: u64,
    pub renewed_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextChange {
    /// UTF-16 code unit offset into the previous draft (CodeMirror-compatible).
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftPatch {
    pub workspace_id: String,
    pub tab_id: String,
    pub base_revision: u64,
    pub changes: Vec<TextChange>,
    /// When set, replace the entire draft instead of applying changes.
    pub full_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftPatchResult {
    pub revision: u64,
    pub dirty: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseTabDecisionKind {
    CloseClean,
    SaveAndClose,
    DiscardAndClose,
    KeepOpen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseTabDecision {
    pub tab_id: String,
    pub kind: CloseTabDecisionKind,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClosePrepareResult {
    pub clean_tab_ids: Vec<String>,
    pub dirty_tab_ids: Vec<String>,
    pub conflict_tab_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabRequest {
    pub kind: WorkspaceTabKind,
    pub title: String,
    pub card_id: Option<String>,
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub workspace_id: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub contents: String,
    pub size_bytes: u64,
    pub modified_unix_ms: Option<u64>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSaveResult {
    pub file: WorkspaceFileContent,
    pub draft_meta: Option<WorkspaceDraftMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiagnostics {
    pub registered_workspaces: u64,
    pub available_workspaces: u64,
    pub tab_count: u64,
    pub dirty_draft_count: u64,
    pub conflict_draft_count: u64,
    pub loaded_draft_bytes: u64,
    pub active_leases: u64,
    pub pending_persistence_ops: u64,
    pub persistence_failures: u64,
}

/// Metadata-only event payloads (never include draft bodies).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceEvent {
    #[serde(rename = "workspaceChanged")]
    WorkspaceChanged {
        workspace_id: String,
        availability: WorkspaceAvailability,
    },
    #[serde(rename = "tabsChanged")]
    TabsChanged {
        workspace_id: String,
        tab_ids: Vec<String>,
    },
    #[serde(rename = "draftRevision")]
    DraftRevision {
        workspace_id: String,
        tab_id: String,
        revision: u64,
        dirty: bool,
        conflict: DraftConflictState,
    },
    #[serde(rename = "leaseChanged")]
    LeaseChanged {
        workspace_id: String,
        tab_id: String,
        holder_surface_id: Option<String>,
        revision: u64,
    },
    #[serde(rename = "conflict")]
    Conflict {
        workspace_id: String,
        tab_id: String,
        conflict: DraftConflictState,
        revision: u64,
    },
}

pub const WORKSPACE_EVENT_CHANNEL: &str = "workspace://changed";
