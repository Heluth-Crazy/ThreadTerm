//! Authoritative workspace service: registry, repository, leases, conflicts.

use super::error::{WorkspaceError, WorkspaceErrorCode};
use super::hash::content_hash;
use super::leases::{Clock, LeaseTable, SystemClock};
use super::paths::{
    canonicalize_workspace_root, comparison_key, display_path, normalize_relative_key,
    resolve_existing_relative_file, resolve_relative_directory, resolve_relative_file_for_write,
    validate_relative_path,
};
#[cfg(test)]
use super::schema::ensure_workspace_schema;
use super::types::*;
use crate::files::{self, DirEntry};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}_{ms}_{n}")
}

fn now_ms_system() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn modified_unix_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

/// Apply UTF-16-offset text changes (CodeMirror-compatible) to a string.
fn apply_text_changes(base: &str, changes: &[TextChange]) -> Result<String, WorkspaceError> {
    let mut utf16: Vec<u16> = base.encode_utf16().collect();
    // Apply from the end so earlier offsets stay valid when changes are ordered.
    let mut ordered = changes.to_vec();
    ordered.sort_by(|a, b| b.from.cmp(&a.from).then(b.to.cmp(&a.to)));
    for change in ordered {
        if change.from > change.to {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::InvalidArgument,
                "Text change from must be <= to.",
            ));
        }
        let from = change.from as usize;
        let to = change.to as usize;
        if to > utf16.len() {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::InvalidArgument,
                "Text change range is out of bounds.",
            ));
        }
        let insert: Vec<u16> = change.insert.encode_utf16().collect();
        utf16.splice(from..to, insert);
    }
    String::from_utf16(&utf16).map_err(|_| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidArgument,
            "Text change produced invalid UTF-16.",
        )
    })
}

fn assert_text_size(contents: &str) -> Result<(), WorkspaceError> {
    if contents.len() as u64 > MAX_DRAFT_BYTES {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileTooLarge,
            format!("Draft is larger than {MAX_DRAFT_BYTES} bytes."),
        ));
    }
    if contents.as_bytes().contains(&0) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileBinary,
            "Binary content cannot be edited.",
        ));
    }
    Ok(())
}

pub struct WorkspaceService {
    clock: Arc<dyn Clock>,
    leases: Mutex<LeaseTable>,
    event_log: Mutex<Vec<WorkspaceEvent>>,
    /// Optional fixed connection for unit tests (avoids global DB).
    test_conn: Option<Mutex<Connection>>,
    persistence_failures: AtomicU64,
    pending_ops: AtomicU64,
}

impl Default for WorkspaceService {
    fn default() -> Self {
        Self::new(Arc::new(SystemClock))
    }
}

impl WorkspaceService {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            leases: Mutex::new(LeaseTable::default()),
            event_log: Mutex::new(Vec::new()),
            test_conn: None,
            persistence_failures: AtomicU64::new(0),
            pending_ops: AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    pub fn with_test_connection(clock: Arc<dyn Clock>, conn: Connection) -> Self {
        ensure_workspace_schema(&conn).expect("workspace schema");
        Self {
            clock,
            leases: Mutex::new(LeaseTable::default()),
            event_log: Mutex::new(Vec::new()),
            test_conn: Some(Mutex::new(conn)),
            persistence_failures: AtomicU64::new(0),
            pending_ops: AtomicU64::new(0),
        }
    }

    fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    fn publish(&self, event: WorkspaceEvent) {
        if let Ok(mut log) = self.event_log.lock() {
            log.push(event);
        }
    }

    pub fn take_events(&self) -> Vec<WorkspaceEvent> {
        self.event_log
            .lock()
            .map(|mut log| std::mem::take(&mut *log))
            .unwrap_or_default()
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, WorkspaceError>,
    ) -> Result<T, WorkspaceError> {
        self.pending_ops.fetch_add(1, Ordering::Relaxed);
        let result = if let Some(test) = &self.test_conn {
            let conn = test.lock().map_err(|_| {
                WorkspaceError::new(
                    WorkspaceErrorCode::PersistenceFailed,
                    "Workspace test connection lock poisoned.",
                )
            })?;
            f(&conn)
        } else {
            let conn = crate::db::get_db().map_err(|e| {
                self.persistence_failures.fetch_add(1, Ordering::Relaxed);
                WorkspaceError::new(WorkspaceErrorCode::PersistenceFailed, e)
            })?;
            f(&conn)
        };
        self.pending_ops.fetch_sub(1, Ordering::Relaxed);
        if result.is_err() {
            // Only count persistence failures, not domain errors.
        }
        result
    }

    // ── Registry ──────────────────────────────────────────────────────────

    pub fn ensure_workspace(&self, root_path: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        let now = self.now_ms();
        match canonicalize_workspace_root(root_path) {
            Ok(canonical) => {
                let key = comparison_key(&canonical);
                let display = display_path(&canonical);
                let canonical_str = canonical.to_string_lossy().into_owned();
                self.with_conn(|conn| {
                    if let Some(mut existing) = load_workspace_by_key(conn, &key)? {
                        if existing.availability != WorkspaceAvailability::Available
                            || existing.canonical_root != canonical_str
                            || existing.display_path != display
                        {
                            existing.availability = WorkspaceAvailability::Available;
                            existing.canonical_root = canonical_str;
                            existing.display_path = display;
                            existing.updated_at_unix_ms = now;
                            update_workspace(conn, &existing)?;
                        }
                        return Ok(existing);
                    }
                    let record = WorkspaceRecord {
                        id: next_id("ws"),
                        canonical_root: canonical_str,
                        display_path: display,
                        availability: WorkspaceAvailability::Available,
                        created_at_unix_ms: now,
                        updated_at_unix_ms: now,
                    };
                    insert_workspace(conn, &record, &key)?;
                    Ok(record)
                })
            }
            Err(err) if err.code == WorkspaceErrorCode::WorkspaceUnavailable => {
                // Root temporarily offline: keep prior registration if comparison
                // can still be derived from the raw path without canonicalize.
                let raw = Path::new(root_path.trim());
                if raw.is_absolute() {
                    let key = comparison_key(raw);
                    self.with_conn(|conn| {
                        if let Some(mut existing) = load_workspace_by_key(conn, &key)? {
                            existing.availability = WorkspaceAvailability::Unavailable;
                            existing.updated_at_unix_ms = now;
                            update_workspace(conn, &existing)?;
                            return Ok(existing);
                        }
                        Err(err)
                    })
                } else {
                    Err(err)
                }
            }
            Err(err) => Err(err),
        }
    }

    pub fn get_workspace(&self, workspace_id: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        self.with_conn(|conn| {
            load_workspace(conn, workspace_id)?.ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::WorkspaceNotFound,
                    format!("Workspace not found: {workspace_id}"),
                )
            })
        })
    }

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceRecord>, WorkspaceError> {
        self.with_conn(list_workspaces)
    }

    pub fn refresh_availability(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        let mut record = self.get_workspace(workspace_id)?;
        let path = PathBuf::from(&record.canonical_root);
        let available = path.is_dir() && path.canonicalize().is_ok();
        let now = self.now_ms();
        let next = if available {
            WorkspaceAvailability::Available
        } else {
            WorkspaceAvailability::Unavailable
        };
        if record.availability != next {
            record.availability = next;
            record.updated_at_unix_ms = now;
            self.with_conn(|conn| update_workspace(conn, &record))?;
            self.publish(WorkspaceEvent::WorkspaceChanged {
                workspace_id: record.id.clone(),
                availability: record.availability,
            });
        }
        Ok(record)
    }

    fn require_available(&self, workspace_id: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        let record = self.get_workspace(workspace_id)?;
        if record.availability != WorkspaceAvailability::Available
            || !Path::new(&record.canonical_root).is_dir()
        {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::WorkspaceUnavailable,
                "Workspace root is currently unavailable.",
            ));
        }
        Ok(record)
    }

    fn root_path(record: &WorkspaceRecord) -> PathBuf {
        PathBuf::from(&record.canonical_root)
    }

    // ── Tabs ──────────────────────────────────────────────────────────────

    pub fn open_tab(
        &self,
        workspace_id: &str,
        request: OpenTabRequest,
    ) -> Result<WorkspaceTab, WorkspaceError> {
        if request.kind == WorkspaceTabKind::Home {
            return Ok(synthetic_home_tab(workspace_id, self.now_ms()));
        }
        let _ = self.get_workspace(workspace_id)?;
        let now = self.now_ms();
        let relative_path = match request.relative_path.as_deref() {
            Some(path) if !path.is_empty() => Some(normalize_relative_key(path)?),
            _ => None,
        };
        let tab_id = match request.kind {
            WorkspaceTabKind::Terminal => {
                let card = request.card_id.as_deref().ok_or_else(|| {
                    WorkspaceError::new(
                        WorkspaceErrorCode::InvalidArgument,
                        "Terminal tabs require cardId.",
                    )
                })?;
                format!("terminal:{card}")
            }
            WorkspaceTabKind::File => {
                let path = relative_path.as_deref().ok_or_else(|| {
                    WorkspaceError::new(
                        WorkspaceErrorCode::InvalidArgument,
                        "File tabs require relativePath.",
                    )
                })?;
                format!("file:{path}")
            }
            WorkspaceTabKind::Diff => {
                let path = relative_path.as_deref().ok_or_else(|| {
                    WorkspaceError::new(
                        WorkspaceErrorCode::InvalidArgument,
                        "Diff tabs require relativePath.",
                    )
                })?;
                format!("diff:{path}")
            }
            WorkspaceTabKind::Home => unreachable!(),
        };

        let tab = self.with_conn(|conn| {
            if let Some(existing) = load_tab(conn, workspace_id, &tab_id)? {
                return Ok(existing);
            }
            let max_order: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(shared_order), 0) FROM workspace_tabs WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let tab = WorkspaceTab {
                id: tab_id,
                workspace_id: workspace_id.to_string(),
                kind: request.kind,
                title: request.title,
                card_id: request.card_id,
                relative_path,
                shared_order: max_order + 1,
                created_at_unix_ms: now,
                updated_at_unix_ms: now,
            };
            insert_tab(conn, &tab)?;
            Ok(tab)
        })?;
        self.publish(WorkspaceEvent::TabsChanged {
            workspace_id: workspace_id.to_string(),
            tab_ids: vec![tab.id.clone()],
        });
        Ok(tab)
    }

    pub fn reorder_tabs(
        &self,
        workspace_id: &str,
        ordered_tab_ids: &[String],
    ) -> Result<Vec<WorkspaceTab>, WorkspaceError> {
        let _ = self.get_workspace(workspace_id)?;
        let now = self.now_ms();
        let tabs = self.with_conn(|conn| {
            let mut order = 1i64;
            for tab_id in ordered_tab_ids {
                if tab_id == HOME_TAB_ID {
                    continue;
                }
                conn.execute(
                    "UPDATE workspace_tabs SET shared_order = ?1, updated_at_ms = ?2
                     WHERE workspace_id = ?3 AND tab_id = ?4",
                    params![order, now as i64, workspace_id, tab_id],
                )
                .map_err(persist_err)?;
                order += 1;
            }
            list_tabs(conn, workspace_id)
        })?;
        self.publish(WorkspaceEvent::TabsChanged {
            workspace_id: workspace_id.to_string(),
            tab_ids: tabs.iter().map(|t| t.id.clone()).collect(),
        });
        Ok(tabs)
    }

    pub fn set_active_tab(
        &self,
        workspace_id: &str,
        surface_id: &str,
        active_tab_id: &str,
    ) -> Result<WorkspaceViewState, WorkspaceError> {
        let _ = self.get_workspace(workspace_id)?;
        if active_tab_id != HOME_TAB_ID {
            let exists =
                self.with_conn(|conn| Ok(load_tab(conn, workspace_id, active_tab_id)?.is_some()))?;
            if !exists {
                return Err(WorkspaceError::new(
                    WorkspaceErrorCode::TabNotFound,
                    format!("Tab not found: {active_tab_id}"),
                ));
            }
        }
        let now = self.now_ms();
        let state = WorkspaceViewState {
            workspace_id: workspace_id.to_string(),
            surface_id: surface_id.to_string(),
            active_tab_id: active_tab_id.to_string(),
            last_seen_at_unix_ms: now,
        };
        self.with_conn(|conn| upsert_view_state(conn, &state))?;
        Ok(state)
    }

    pub fn get_snapshot(&self, workspace_id: &str) -> Result<WorkspaceSnapshot, WorkspaceError> {
        let workspace = self.get_workspace(workspace_id)?;
        let (tabs, draft_metas, view_states) = self.with_conn(|conn| {
            Ok((
                list_tabs(conn, workspace_id)?,
                list_draft_metas(conn, workspace_id)?,
                list_view_states(conn, workspace_id)?,
            ))
        })?;
        let now = self.now_ms();
        let active_leases = self
            .leases
            .lock()
            .map(|table| {
                table
                    .snapshot_all(now)
                    .into_iter()
                    .filter(|lease| lease.workspace_id == workspace_id)
                    .collect()
            })
            .unwrap_or_default();
        Ok(WorkspaceSnapshot {
            workspace,
            tabs,
            draft_metas,
            view_states,
            active_leases,
        })
    }

    // ── Scoped file I/O ───────────────────────────────────────────────────

    pub fn list_directory(
        &self,
        workspace_id: &str,
        relative: Option<&str>,
    ) -> Result<Vec<DirEntry>, WorkspaceError> {
        let record = self.require_available(workspace_id)?;
        let root = Self::root_path(&record);
        let dir = resolve_relative_directory(&root, relative)?;
        files::read_directory_for_path(&dir)
            .map_err(|e| WorkspaceError::new(WorkspaceErrorCode::PathInvalid, e))
    }

    pub fn read_file(
        &self,
        workspace_id: &str,
        relative: &str,
    ) -> Result<WorkspaceFileContent, WorkspaceError> {
        let record = self.require_available(workspace_id)?;
        let root = Self::root_path(&record);
        let rel_key = normalize_relative_key(relative)?;
        let file = resolve_existing_relative_file(&root, &rel_key)?;
        read_file_at(&file, workspace_id, &rel_key)
    }

    // ── Drafts ────────────────────────────────────────────────────────────

    pub fn get_draft(
        &self,
        workspace_id: &str,
        tab_id: &str,
    ) -> Result<Option<WorkspaceDraft>, WorkspaceError> {
        self.with_conn(|conn| load_draft(conn, workspace_id, tab_id))
    }

    /// Seed a draft from disk when the tab is first edited, or return existing.
    pub fn ensure_draft_from_disk(
        &self,
        workspace_id: &str,
        tab_id: &str,
    ) -> Result<WorkspaceDraft, WorkspaceError> {
        if let Some(existing) = self.get_draft(workspace_id, tab_id)? {
            return Ok(existing);
        }
        let tab = self.with_conn(|conn| {
            load_tab(conn, workspace_id, tab_id)?.ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::TabNotFound,
                    format!("Tab not found: {tab_id}"),
                )
            })
        })?;
        let relative = tab.relative_path.as_deref().ok_or_else(|| {
            WorkspaceError::new(
                WorkspaceErrorCode::InvalidArgument,
                "Only file/diff tabs hold drafts.",
            )
        })?;
        let file = self.read_file(workspace_id, relative)?;
        let now = self.now_ms();
        let draft = WorkspaceDraft {
            meta: WorkspaceDraftMeta {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.to_string(),
                revision: 0,
                dirty: false,
                conflict: DraftConflictState::None,
                base_modified_unix_ms: file.modified_unix_ms,
                base_hash: Some(file.content_hash.clone()),
                size_bytes: file.size_bytes,
                updated_at_unix_ms: now,
            },
            contents: file.contents,
        };
        self.with_conn(|conn| upsert_draft(conn, &draft))?;
        Ok(draft)
    }

    pub fn apply_draft_patch(
        &self,
        surface_id: &str,
        patch: DraftPatch,
        require_lease: bool,
    ) -> Result<DraftPatchResult, WorkspaceError> {
        if require_lease {
            let now = self.now_ms();
            let leases = self.leases.lock().map_err(|_| {
                WorkspaceError::new(
                    WorkspaceErrorCode::PersistenceFailed,
                    "Lease table lock poisoned.",
                )
            })?;
            if !leases.is_holder(&patch.workspace_id, &patch.tab_id, surface_id, now) {
                return Err(WorkspaceError::new(
                    WorkspaceErrorCode::LeaseRequired,
                    "An edit lease is required before patching this draft.",
                ));
            }
        }

        let mut draft = self
            .get_draft(&patch.workspace_id, &patch.tab_id)?
            .ok_or_else(|| {
                WorkspaceError::new(WorkspaceErrorCode::TabNotFound, "Draft not found for tab.")
            })?;

        if draft.meta.revision != patch.base_revision {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::StaleRevision,
                format!(
                    "Expected revision {}, current is {}.",
                    patch.base_revision, draft.meta.revision
                ),
            ));
        }

        let next_contents = if let Some(full) = &patch.full_text {
            full.clone()
        } else {
            apply_text_changes(&draft.contents, &patch.changes)?
        };
        assert_text_size(&next_contents)?;

        let now = self.now_ms();
        draft.contents = next_contents;
        draft.meta.revision = draft.meta.revision.saturating_add(1);
        draft.meta.dirty = true;
        draft.meta.size_bytes = draft.contents.len() as u64;
        draft.meta.updated_at_unix_ms = now;
        // First dirty transition freezes base markers if missing.
        if draft.meta.base_hash.is_none() {
            draft.meta.base_hash = Some(content_hash(draft.contents.as_bytes()));
        }

        self.with_conn(|conn| upsert_draft(conn, &draft))?;
        self.publish(WorkspaceEvent::DraftRevision {
            workspace_id: draft.meta.workspace_id.clone(),
            tab_id: draft.meta.tab_id.clone(),
            revision: draft.meta.revision,
            dirty: draft.meta.dirty,
            conflict: draft.meta.conflict,
        });
        Ok(DraftPatchResult {
            revision: draft.meta.revision,
            dirty: draft.meta.dirty,
            size_bytes: draft.meta.size_bytes,
        })
    }

    // ── Save / conflict ───────────────────────────────────────────────────

    pub fn save_draft(
        &self,
        workspace_id: &str,
        tab_id: &str,
        expected_revision: u64,
        force: bool,
    ) -> Result<WorkspaceSaveResult, WorkspaceError> {
        let record = self.require_available(workspace_id)?;
        let tab = self.with_conn(|conn| {
            load_tab(conn, workspace_id, tab_id)?.ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::TabNotFound,
                    format!("Tab not found: {tab_id}"),
                )
            })
        })?;
        let relative = tab.relative_path.as_deref().ok_or_else(|| {
            WorkspaceError::new(
                WorkspaceErrorCode::InvalidArgument,
                "Only file tabs can be saved.",
            )
        })?;
        let mut draft = self.get_draft(workspace_id, tab_id)?.ok_or_else(|| {
            WorkspaceError::new(WorkspaceErrorCode::TabNotFound, "Draft not found.")
        })?;
        if draft.meta.revision != expected_revision {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::StaleRevision,
                format!(
                    "Expected revision {}, current is {}.",
                    expected_revision, draft.meta.revision
                ),
            ));
        }
        assert_text_size(&draft.contents)?;

        let root = Self::root_path(&record);
        let file_path = resolve_relative_file_for_write(&root, relative)?;
        let current_meta = if file_path.exists() {
            std::fs::metadata(&file_path).ok()
        } else {
            None
        };
        let current_modified = current_meta.as_ref().and_then(modified_unix_ms);
        let current_hash = if file_path.exists() {
            std::fs::read(&file_path)
                .ok()
                .map(|bytes| content_hash(&bytes))
        } else {
            None
        };

        let base_mismatch = match (
            draft.meta.base_modified_unix_ms,
            draft.meta.base_hash.as_ref(),
        ) {
            (Some(base_ms), Some(base_hash)) => {
                current_modified != Some(base_ms) || current_hash.as_deref() != Some(base_hash)
            }
            (Some(base_ms), None) => current_modified != Some(base_ms),
            (None, Some(base_hash)) => current_hash.as_deref() != Some(base_hash),
            (None, None) => false,
        };

        if base_mismatch && !force {
            draft.meta.conflict = DraftConflictState::ExternalChange;
            draft.meta.updated_at_unix_ms = self.now_ms();
            self.with_conn(|conn| upsert_draft(conn, &draft))?;
            self.publish(WorkspaceEvent::Conflict {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.to_string(),
                conflict: DraftConflictState::ExternalChange,
                revision: draft.meta.revision,
            });
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::FileConflict,
                "File changed on disk. Resolve the conflict before saving.",
            ));
        }

        std::fs::write(&file_path, draft.contents.as_bytes()).map_err(|err| {
            self.persistence_failures.fetch_add(1, Ordering::Relaxed);
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                format!("Failed to write file: {err}"),
            )
        })?;

        let file = read_file_at(&file_path, workspace_id, relative)?;
        draft.meta.dirty = false;
        draft.meta.conflict = DraftConflictState::None;
        draft.meta.base_modified_unix_ms = file.modified_unix_ms;
        draft.meta.base_hash = Some(file.content_hash.clone());
        draft.meta.size_bytes = file.size_bytes;
        draft.meta.updated_at_unix_ms = self.now_ms();
        draft.contents = file.contents.clone();
        self.with_conn(|conn| upsert_draft(conn, &draft))?;
        self.publish(WorkspaceEvent::DraftRevision {
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            revision: draft.meta.revision,
            dirty: false,
            conflict: DraftConflictState::None,
        });
        Ok(WorkspaceSaveResult {
            file,
            draft_meta: Some(draft.meta),
        })
    }

    pub fn discard_draft(
        &self,
        workspace_id: &str,
        tab_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), WorkspaceError> {
        if let Some(expected) = expected_revision {
            if let Some(draft) = self.get_draft(workspace_id, tab_id)? {
                if draft.meta.revision != expected {
                    return Err(WorkspaceError::new(
                        WorkspaceErrorCode::StaleRevision,
                        format!(
                            "Expected revision {}, current is {}.",
                            expected, draft.meta.revision
                        ),
                    ));
                }
            }
        }
        self.with_conn(|conn| delete_draft(conn, workspace_id, tab_id))?;
        self.publish(WorkspaceEvent::DraftRevision {
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            revision: 0,
            dirty: false,
            conflict: DraftConflictState::None,
        });
        Ok(())
    }

    pub fn use_disk_version(
        &self,
        workspace_id: &str,
        tab_id: &str,
    ) -> Result<WorkspaceDraft, WorkspaceError> {
        let tab = self.with_conn(|conn| {
            load_tab(conn, workspace_id, tab_id)?.ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::TabNotFound,
                    format!("Tab not found: {tab_id}"),
                )
            })
        })?;
        let relative = tab.relative_path.as_deref().ok_or_else(|| {
            WorkspaceError::new(
                WorkspaceErrorCode::InvalidArgument,
                "Only file/diff tabs have disk versions.",
            )
        })?;
        let file = self.read_file(workspace_id, relative)?;
        let prev_revision = self
            .get_draft(workspace_id, tab_id)?
            .map(|d| d.meta.revision)
            .unwrap_or(0);
        let now = self.now_ms();
        let draft = WorkspaceDraft {
            meta: WorkspaceDraftMeta {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.to_string(),
                revision: prev_revision.saturating_add(1),
                dirty: false,
                conflict: DraftConflictState::None,
                base_modified_unix_ms: file.modified_unix_ms,
                base_hash: Some(file.content_hash),
                size_bytes: file.size_bytes,
                updated_at_unix_ms: now,
            },
            contents: file.contents,
        };
        self.with_conn(|conn| upsert_draft(conn, &draft))?;
        self.publish(WorkspaceEvent::DraftRevision {
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            revision: draft.meta.revision,
            dirty: false,
            conflict: DraftConflictState::None,
        });
        Ok(draft)
    }

    pub fn save_as(
        &self,
        workspace_id: &str,
        tab_id: &str,
        new_relative_path: &str,
        expected_revision: u64,
    ) -> Result<WorkspaceSaveResult, WorkspaceError> {
        let record = self.require_available(workspace_id)?;
        let draft = self.get_draft(workspace_id, tab_id)?.ok_or_else(|| {
            WorkspaceError::new(WorkspaceErrorCode::TabNotFound, "Draft not found.")
        })?;
        if draft.meta.revision != expected_revision {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::StaleRevision,
                format!(
                    "Expected revision {}, current is {}.",
                    expected_revision, draft.meta.revision
                ),
            ));
        }
        let rel = normalize_relative_key(new_relative_path)?;
        let root = Self::root_path(&record);
        let file_path = resolve_relative_file_for_write(&root, &rel)?;
        assert_text_size(&draft.contents)?;
        std::fs::write(&file_path, draft.contents.as_bytes()).map_err(|err| {
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                format!("Failed to write file: {err}"),
            )
        })?;
        let file = read_file_at(&file_path, workspace_id, &rel)?;
        Ok(WorkspaceSaveResult {
            file,
            draft_meta: None,
        })
    }

    // ── Close coordinator ─────────────────────────────────────────────────

    pub fn prepare_close(
        &self,
        workspace_id: &str,
        tab_ids: &[String],
    ) -> Result<ClosePrepareResult, WorkspaceError> {
        let mut clean = Vec::new();
        let mut dirty = Vec::new();
        let mut conflict = Vec::new();
        for tab_id in tab_ids {
            if tab_id == HOME_TAB_ID {
                continue;
            }
            match self.get_draft(workspace_id, tab_id)? {
                Some(draft) if draft.meta.conflict != DraftConflictState::None => {
                    conflict.push(tab_id.clone());
                }
                Some(draft) if draft.meta.dirty => dirty.push(tab_id.clone()),
                _ => clean.push(tab_id.clone()),
            }
        }
        Ok(ClosePrepareResult {
            clean_tab_ids: clean,
            dirty_tab_ids: dirty,
            conflict_tab_ids: conflict,
        })
    }

    pub fn commit_close(
        &self,
        workspace_id: &str,
        decisions: &[CloseTabDecision],
    ) -> Result<Vec<String>, WorkspaceError> {
        // Validate all decisions first — never partially delete.
        for decision in decisions {
            if decision.tab_id == HOME_TAB_ID {
                return Err(WorkspaceError::new(
                    WorkspaceErrorCode::InvalidArgument,
                    "Home tab cannot be closed.",
                ));
            }
            if let Some(expected) = decision.expected_revision {
                if let Some(draft) = self.get_draft(workspace_id, &decision.tab_id)? {
                    if draft.meta.revision != expected
                        && matches!(
                            decision.kind,
                            CloseTabDecisionKind::SaveAndClose
                                | CloseTabDecisionKind::DiscardAndClose
                        )
                    {
                        return Err(WorkspaceError::new(
                            WorkspaceErrorCode::StaleRevision,
                            format!("Tab {} revision changed during close.", decision.tab_id),
                        ));
                    }
                }
            }
            if matches!(decision.kind, CloseTabDecisionKind::CloseClean) {
                if let Some(draft) = self.get_draft(workspace_id, &decision.tab_id)? {
                    if draft.meta.dirty || draft.meta.conflict != DraftConflictState::None {
                        return Err(WorkspaceError::new(
                            WorkspaceErrorCode::InvalidArgument,
                            format!(
                                "Tab {} is dirty/conflicted and needs an explicit close decision.",
                                decision.tab_id
                            ),
                        ));
                    }
                }
            }
        }

        let mut closed = Vec::new();
        for decision in decisions {
            match decision.kind {
                CloseTabDecisionKind::KeepOpen => {}
                CloseTabDecisionKind::CloseClean => {
                    self.delete_tab(workspace_id, &decision.tab_id)?;
                    closed.push(decision.tab_id.clone());
                }
                CloseTabDecisionKind::DiscardAndClose => {
                    self.discard_draft(workspace_id, &decision.tab_id, decision.expected_revision)?;
                    self.delete_tab(workspace_id, &decision.tab_id)?;
                    closed.push(decision.tab_id.clone());
                }
                CloseTabDecisionKind::SaveAndClose => {
                    let rev = decision.expected_revision.ok_or_else(|| {
                        WorkspaceError::new(
                            WorkspaceErrorCode::InvalidArgument,
                            "Save-and-close requires expectedRevision.",
                        )
                    })?;
                    self.save_draft(workspace_id, &decision.tab_id, rev, false)?;
                    self.discard_draft(workspace_id, &decision.tab_id, None)?;
                    self.delete_tab(workspace_id, &decision.tab_id)?;
                    closed.push(decision.tab_id.clone());
                }
            }
        }
        if !closed.is_empty() {
            self.publish(WorkspaceEvent::TabsChanged {
                workspace_id: workspace_id.to_string(),
                tab_ids: closed.clone(),
            });
        }
        Ok(closed)
    }

    fn delete_tab(&self, workspace_id: &str, tab_id: &str) -> Result<(), WorkspaceError> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM workspace_drafts WHERE workspace_id = ?1 AND tab_id = ?2",
                params![workspace_id, tab_id],
            )
            .map_err(persist_err)?;
            conn.execute(
                "DELETE FROM workspace_tabs WHERE workspace_id = ?1 AND tab_id = ?2",
                params![workspace_id, tab_id],
            )
            .map_err(persist_err)?;
            Ok(())
        })?;
        if let Ok(mut leases) = self.leases.lock() {
            let _ = leases.release(workspace_id, tab_id, "", self.now_ms());
            // Force remove regardless of holder.
            leases.takeover(workspace_id, tab_id, "__deleted__", 0, self.now_ms());
            let _ = leases.release(workspace_id, tab_id, "__deleted__", self.now_ms());
        }
        Ok(())
    }

    // ── Leases ────────────────────────────────────────────────────────────

    pub fn acquire_lease(
        &self,
        workspace_id: &str,
        tab_id: &str,
        surface_id: &str,
    ) -> Result<EditorLeaseSnapshot, WorkspaceError> {
        let revision = self
            .get_draft(workspace_id, tab_id)?
            .map(|d| d.meta.revision)
            .unwrap_or(0);
        let now = self.now_ms();
        let mut leases = self.leases.lock().map_err(|_| {
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                "Lease table lock poisoned.",
            )
        })?;
        match leases.acquire(workspace_id, tab_id, surface_id, revision, now) {
            Ok(entry) => {
                let snap = lease_snapshot(workspace_id, tab_id, &entry);
                self.publish(WorkspaceEvent::LeaseChanged {
                    workspace_id: workspace_id.to_string(),
                    tab_id: tab_id.to_string(),
                    holder_surface_id: Some(surface_id.to_string()),
                    revision,
                });
                Ok(snap)
            }
            Err(Some(existing)) => Err(WorkspaceError::new(
                WorkspaceErrorCode::LeaseConflict,
                format!("Lease held by {}.", existing.holder_surface_id),
            )),
            Err(None) => Err(WorkspaceError::new(
                WorkspaceErrorCode::LeaseConflict,
                "Lease unavailable.",
            )),
        }
    }

    pub fn renew_lease(
        &self,
        workspace_id: &str,
        tab_id: &str,
        surface_id: &str,
    ) -> Result<EditorLeaseSnapshot, WorkspaceError> {
        let now = self.now_ms();
        let mut leases = self.leases.lock().map_err(|_| {
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                "Lease table lock poisoned.",
            )
        })?;
        match leases.renew(workspace_id, tab_id, surface_id, now) {
            Ok(entry) => Ok(lease_snapshot(workspace_id, tab_id, &entry)),
            Err(_) => Err(WorkspaceError::new(
                WorkspaceErrorCode::LeaseConflict,
                "Cannot renew lease; not the current holder.",
            )),
        }
    }

    pub fn release_lease(
        &self,
        workspace_id: &str,
        tab_id: &str,
        surface_id: &str,
    ) -> Result<bool, WorkspaceError> {
        let now = self.now_ms();
        let mut leases = self.leases.lock().map_err(|_| {
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                "Lease table lock poisoned.",
            )
        })?;
        let ok = leases.release(workspace_id, tab_id, surface_id, now);
        if ok {
            self.publish(WorkspaceEvent::LeaseChanged {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.to_string(),
                holder_surface_id: None,
                revision: 0,
            });
        }
        Ok(ok)
    }

    pub fn takeover_lease(
        &self,
        workspace_id: &str,
        tab_id: &str,
        surface_id: &str,
    ) -> Result<EditorLeaseSnapshot, WorkspaceError> {
        let revision = self
            .get_draft(workspace_id, tab_id)?
            .map(|d| d.meta.revision)
            .unwrap_or(0);
        let now = self.now_ms();
        let mut leases = self.leases.lock().map_err(|_| {
            WorkspaceError::new(
                WorkspaceErrorCode::PersistenceFailed,
                "Lease table lock poisoned.",
            )
        })?;
        let entry = leases.takeover(workspace_id, tab_id, surface_id, revision, now);
        self.publish(WorkspaceEvent::LeaseChanged {
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            holder_surface_id: Some(surface_id.to_string()),
            revision,
        });
        Ok(lease_snapshot(workspace_id, tab_id, &entry))
    }

    pub fn disconnect_surface(&self, surface_id: &str, graceful: bool) {
        let now = self.now_ms();
        if let Ok(mut leases) = self.leases.lock() {
            if graceful {
                for (workspace_id, tab_id) in leases.revoke_holder(surface_id) {
                    self.publish(WorkspaceEvent::LeaseChanged {
                        workspace_id,
                        tab_id,
                        holder_surface_id: None,
                        revision: 0,
                    });
                }
            } else {
                // Mark grace on all leases for this surface.
                let snapshots = leases.snapshot_all(now);
                for snap in snapshots {
                    if snap.holder_surface_id == surface_id {
                        leases.schedule_disconnect_grace(
                            &snap.workspace_id,
                            &snap.tab_id,
                            surface_id,
                            now,
                        );
                    }
                }
            }
        }
    }

    #[cfg(test)]
    pub fn test_disconnect_surface(&self, surface_id: &str, graceful: bool) {
        self.disconnect_surface(surface_id, graceful);
    }

    pub fn diagnostics(&self) -> Result<WorkspaceDiagnostics, WorkspaceError> {
        let (registered, available, tab_count, dirty, conflict, draft_bytes) =
            self.with_conn(|conn| {
                let registered: u64 = conn
                    .query_row("SELECT COUNT(*) FROM workspaces", [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .map_err(persist_err)? as u64;
                let available: u64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM workspaces WHERE availability = 'available'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(persist_err)? as u64;
                let tab_count: u64 = conn
                    .query_row("SELECT COUNT(*) FROM workspace_tabs", [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .map_err(persist_err)? as u64;
                let dirty: u64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM workspace_drafts WHERE dirty = 1",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(persist_err)? as u64;
                let conflict: u64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM workspace_drafts WHERE conflict != 'none'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(persist_err)? as u64;
                let draft_bytes: u64 = conn
                    .query_row(
                        "SELECT COALESCE(SUM(LENGTH(contents)), 0) FROM workspace_drafts",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(persist_err)? as u64;
                Ok((
                    registered,
                    available,
                    tab_count,
                    dirty,
                    conflict,
                    draft_bytes,
                ))
            })?;
        let now = self.now_ms();
        let active_leases = self.leases.lock().map(|t| t.active_count(now)).unwrap_or(0);
        Ok(WorkspaceDiagnostics {
            registered_workspaces: registered,
            available_workspaces: available,
            tab_count,
            dirty_draft_count: dirty,
            conflict_draft_count: conflict,
            loaded_draft_bytes: draft_bytes,
            active_leases,
            pending_persistence_ops: self.pending_ops.load(Ordering::Relaxed),
            persistence_failures: self.persistence_failures.load(Ordering::Relaxed),
        })
    }
}

fn lease_snapshot(
    workspace_id: &str,
    tab_id: &str,
    entry: &super::leases::LeaseEntry,
) -> EditorLeaseSnapshot {
    EditorLeaseSnapshot {
        workspace_id: workspace_id.to_string(),
        tab_id: tab_id.to_string(),
        holder_surface_id: entry.holder_surface_id.clone(),
        revision: entry.revision,
        acquired_at_unix_ms: entry.acquired_at_unix_ms,
        renewed_at_unix_ms: entry.renewed_at_unix_ms,
        expires_at_unix_ms: entry.expires_at_unix_ms,
    }
}

fn synthetic_home_tab(workspace_id: &str, now: u64) -> WorkspaceTab {
    WorkspaceTab {
        id: HOME_TAB_ID.to_string(),
        workspace_id: workspace_id.to_string(),
        kind: WorkspaceTabKind::Home,
        title: "Home".to_string(),
        card_id: None,
        relative_path: None,
        shared_order: 0,
        created_at_unix_ms: now,
        updated_at_unix_ms: now,
    }
}

fn read_file_at(
    file: &Path,
    workspace_id: &str,
    relative: &str,
) -> Result<WorkspaceFileContent, WorkspaceError> {
    let metadata = std::fs::metadata(file).map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::PersistenceFailed,
            format!("Failed to stat file: {err}"),
        )
    })?;
    if metadata.len() > MAX_DRAFT_BYTES {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileTooLarge,
            format!("File is larger than {MAX_DRAFT_BYTES} bytes."),
        ));
    }
    let bytes = std::fs::read(file).map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::PersistenceFailed,
            format!("Failed to read file: {err}"),
        )
    })?;
    if bytes.contains(&0) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileBinary,
            "Binary files cannot be edited.",
        ));
    }
    let contents = String::from_utf8(bytes).map_err(|_| {
        WorkspaceError::new(
            WorkspaceErrorCode::FileNotUtf8,
            "File is not valid UTF-8 text.",
        )
    })?;
    let hash = content_hash(contents.as_bytes());
    Ok(WorkspaceFileContent {
        workspace_id: workspace_id.to_string(),
        relative_path: relative.to_string(),
        absolute_path: file.to_string_lossy().into_owned(),
        contents,
        size_bytes: metadata.len(),
        modified_unix_ms: modified_unix_ms(&metadata),
        content_hash: hash,
    })
}

fn persist_err(err: rusqlite::Error) -> WorkspaceError {
    WorkspaceError::new(
        WorkspaceErrorCode::PersistenceFailed,
        format!("Database error: {err}"),
    )
}

// ── SQLite helpers ────────────────────────────────────────────────────────

fn insert_workspace(
    conn: &Connection,
    record: &WorkspaceRecord,
    comparison_key: &str,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO workspaces
            (id, canonical_root, comparison_key, display_path, availability, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            record.id,
            record.canonical_root,
            comparison_key,
            record.display_path,
            record.availability.as_str(),
            record.created_at_unix_ms as i64,
            record.updated_at_unix_ms as i64,
        ],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn update_workspace(conn: &Connection, record: &WorkspaceRecord) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE workspaces
         SET canonical_root = ?1, display_path = ?2, availability = ?3, updated_at_ms = ?4
         WHERE id = ?5",
        params![
            record.canonical_root,
            record.display_path,
            record.availability.as_str(),
            record.updated_at_unix_ms as i64,
            record.id,
        ],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn map_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        canonical_root: row.get(1)?,
        display_path: row.get(2)?,
        availability: WorkspaceAvailability::parse(&row.get::<_, String>(3)?),
        created_at_unix_ms: row.get::<_, i64>(4)? as u64,
        updated_at_unix_ms: row.get::<_, i64>(5)? as u64,
    })
}

fn load_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
    conn.query_row(
        "SELECT id, canonical_root, display_path, availability, created_at_ms, updated_at_ms
         FROM workspaces WHERE id = ?1",
        [workspace_id],
        map_workspace,
    )
    .optional()
    .map_err(persist_err)
}

fn load_workspace_by_key(
    conn: &Connection,
    key: &str,
) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
    conn.query_row(
        "SELECT id, canonical_root, display_path, availability, created_at_ms, updated_at_ms
         FROM workspaces WHERE comparison_key = ?1",
        [key],
        map_workspace,
    )
    .optional()
    .map_err(persist_err)
}

fn list_workspaces(conn: &Connection) -> Result<Vec<WorkspaceRecord>, WorkspaceError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, canonical_root, display_path, availability, created_at_ms, updated_at_ms
             FROM workspaces ORDER BY updated_at_ms DESC",
        )
        .map_err(persist_err)?;
    let rows = stmt
        .query_map([], map_workspace)
        .map_err(persist_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(persist_err)?;
    Ok(rows)
}

fn insert_tab(conn: &Connection, tab: &WorkspaceTab) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO workspace_tabs
            (workspace_id, tab_id, kind, title, card_id, relative_path, shared_order, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            tab.workspace_id,
            tab.id,
            tab.kind.as_str(),
            tab.title,
            tab.card_id,
            tab.relative_path,
            tab.shared_order,
            tab.created_at_unix_ms as i64,
            tab.updated_at_unix_ms as i64,
        ],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn map_tab(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceTab> {
    let kind_str: String = row.get(2)?;
    Ok(WorkspaceTab {
        workspace_id: row.get(0)?,
        id: row.get(1)?,
        kind: WorkspaceTabKind::parse(&kind_str).unwrap_or(WorkspaceTabKind::File),
        title: row.get(3)?,
        card_id: row.get(4)?,
        relative_path: row.get(5)?,
        shared_order: row.get(6)?,
        created_at_unix_ms: row.get::<_, i64>(7)? as u64,
        updated_at_unix_ms: row.get::<_, i64>(8)? as u64,
    })
}

fn load_tab(
    conn: &Connection,
    workspace_id: &str,
    tab_id: &str,
) -> Result<Option<WorkspaceTab>, WorkspaceError> {
    conn.query_row(
        "SELECT workspace_id, tab_id, kind, title, card_id, relative_path, shared_order, created_at_ms, updated_at_ms
         FROM workspace_tabs WHERE workspace_id = ?1 AND tab_id = ?2",
        params![workspace_id, tab_id],
        map_tab,
    )
    .optional()
    .map_err(persist_err)
}

fn list_tabs(conn: &Connection, workspace_id: &str) -> Result<Vec<WorkspaceTab>, WorkspaceError> {
    let mut stmt = conn
        .prepare(
            "SELECT workspace_id, tab_id, kind, title, card_id, relative_path, shared_order, created_at_ms, updated_at_ms
             FROM workspace_tabs WHERE workspace_id = ?1 ORDER BY shared_order ASC",
        )
        .map_err(persist_err)?;
    let rows = stmt
        .query_map([workspace_id], map_tab)
        .map_err(persist_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(persist_err)?;
    Ok(rows)
}

fn upsert_draft(conn: &Connection, draft: &WorkspaceDraft) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO workspace_drafts
            (workspace_id, tab_id, contents, base_modified_unix_ms, base_hash, revision, dirty, conflict, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(workspace_id, tab_id) DO UPDATE SET
            contents = excluded.contents,
            base_modified_unix_ms = excluded.base_modified_unix_ms,
            base_hash = excluded.base_hash,
            revision = excluded.revision,
            dirty = excluded.dirty,
            conflict = excluded.conflict,
            updated_at_ms = excluded.updated_at_ms",
        params![
            draft.meta.workspace_id,
            draft.meta.tab_id,
            draft.contents,
            draft.meta.base_modified_unix_ms.map(|v| v as i64),
            draft.meta.base_hash,
            draft.meta.revision as i64,
            if draft.meta.dirty { 1 } else { 0 },
            draft.meta.conflict.as_str(),
            draft.meta.updated_at_unix_ms as i64,
        ],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn map_draft(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceDraft> {
    let conflict: String = row.get(7)?;
    Ok(WorkspaceDraft {
        meta: WorkspaceDraftMeta {
            workspace_id: row.get(0)?,
            tab_id: row.get(1)?,
            revision: row.get::<_, i64>(5)? as u64,
            dirty: row.get::<_, i64>(6)? != 0,
            conflict: DraftConflictState::parse(&conflict),
            base_modified_unix_ms: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
            base_hash: row.get(4)?,
            size_bytes: row.get::<_, String>(2)?.len() as u64,
            updated_at_unix_ms: row.get::<_, i64>(8)? as u64,
        },
        contents: row.get(2)?,
    })
}

fn load_draft(
    conn: &Connection,
    workspace_id: &str,
    tab_id: &str,
) -> Result<Option<WorkspaceDraft>, WorkspaceError> {
    conn.query_row(
        "SELECT workspace_id, tab_id, contents, base_modified_unix_ms, base_hash, revision, dirty, conflict, updated_at_ms
         FROM workspace_drafts WHERE workspace_id = ?1 AND tab_id = ?2",
        params![workspace_id, tab_id],
        map_draft,
    )
    .optional()
    .map_err(persist_err)
}

fn list_draft_metas(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<WorkspaceDraftMeta>, WorkspaceError> {
    let mut stmt = conn
        .prepare(
            "SELECT workspace_id, tab_id, LENGTH(contents), base_modified_unix_ms, base_hash, revision, dirty, conflict, updated_at_ms
             FROM workspace_drafts WHERE workspace_id = ?1",
        )
        .map_err(persist_err)?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            let conflict: String = row.get(7)?;
            Ok(WorkspaceDraftMeta {
                workspace_id: row.get(0)?,
                tab_id: row.get(1)?,
                size_bytes: row.get::<_, i64>(2)? as u64,
                base_modified_unix_ms: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                base_hash: row.get(4)?,
                revision: row.get::<_, i64>(5)? as u64,
                dirty: row.get::<_, i64>(6)? != 0,
                conflict: DraftConflictState::parse(&conflict),
                updated_at_unix_ms: row.get::<_, i64>(8)? as u64,
            })
        })
        .map_err(persist_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(persist_err)?;
    Ok(rows)
}

fn delete_draft(conn: &Connection, workspace_id: &str, tab_id: &str) -> Result<(), WorkspaceError> {
    conn.execute(
        "DELETE FROM workspace_drafts WHERE workspace_id = ?1 AND tab_id = ?2",
        params![workspace_id, tab_id],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn upsert_view_state(conn: &Connection, state: &WorkspaceViewState) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO workspace_view_state (workspace_id, surface_id, active_tab_id, last_seen_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id, surface_id) DO UPDATE SET
            active_tab_id = excluded.active_tab_id,
            last_seen_at_ms = excluded.last_seen_at_ms",
        params![
            state.workspace_id,
            state.surface_id,
            state.active_tab_id,
            state.last_seen_at_unix_ms as i64,
        ],
    )
    .map_err(persist_err)?;
    Ok(())
}

fn list_view_states(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<WorkspaceViewState>, WorkspaceError> {
    let mut stmt = conn
        .prepare(
            "SELECT workspace_id, surface_id, active_tab_id, last_seen_at_ms
             FROM workspace_view_state WHERE workspace_id = ?1",
        )
        .map_err(persist_err)?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok(WorkspaceViewState {
                workspace_id: row.get(0)?,
                surface_id: row.get(1)?,
                active_tab_id: row.get(2)?,
                last_seen_at_unix_ms: row.get::<_, i64>(3)? as u64,
            })
        })
        .map_err(persist_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(persist_err)?;
    Ok(rows)
}

// Silence unused import in non-test builds for validate_relative_path re-export path.
#[allow(dead_code)]
fn _path_helpers_used() {
    let _ = validate_relative_path;
    let _ = now_ms_system;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::leases::TestClock;
    use rusqlite::Connection;
    use std::sync::Arc;

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "threadterm_ws_svc_{name}_{}_{}",
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn service_with_root(name: &str) -> (WorkspaceService, PathBuf, WorkspaceRecord) {
        let clock = Arc::new(TestClock::new(1_000_000));
        let conn = Connection::open_in_memory().unwrap();
        let service = WorkspaceService::with_test_connection(clock, conn);
        let root = temp_root(name);
        let record = service
            .ensure_workspace(root.to_str().unwrap())
            .expect("ensure");
        (service, root, record)
    }

    #[test]
    fn same_path_returns_same_workspace_id() {
        let (service, root, first) = service_with_root("same");
        let second = service.ensure_workspace(root.to_str().unwrap()).unwrap();
        assert_eq!(first.id, second.id);
        let other = temp_root("other");
        let third = service.ensure_workspace(other.to_str().unwrap()).unwrap();
        assert_ne!(first.id, third.id);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn path_traversal_rejected() {
        let (service, root, ws) = service_with_root("trav");
        std::fs::write(root.join("a.txt"), "a").unwrap();
        let err = service.read_file(&ws.id, "../a.txt").unwrap_err();
        assert_eq!(err.code, WorkspaceErrorCode::PathOutsideWorkspace);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn draft_patch_revision_and_stale_race() {
        let (service, root, ws) = service_with_root("draft");
        std::fs::write(root.join("notes.txt"), "hello").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "notes.txt".into(),
                    card_id: None,
                    relative_path: Some("notes.txt".into()),
                },
            )
            .unwrap();
        let draft = service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        assert_eq!(draft.meta.revision, 0);
        assert!(!draft.meta.dirty);

        let r1 = service
            .apply_draft_patch(
                DESKTOP_MAIN_SURFACE,
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("hello world".into()),
                },
                false,
            )
            .unwrap();
        assert_eq!(r1.revision, 1);
        assert!(r1.dirty);

        let stale = service
            .apply_draft_patch(
                DESKTOP_MAIN_SURFACE,
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("lost".into()),
                },
                false,
            )
            .unwrap_err();
        assert_eq!(stale.code, WorkspaceErrorCode::StaleRevision);
        let kept = service.get_draft(&ws.id, &tab.id).unwrap().unwrap();
        assert_eq!(kept.contents, "hello world");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restart_round_trip_preserves_tabs_and_dirty_drafts() {
        let root = temp_root("restart");
        std::fs::write(root.join("a.txt"), "base").unwrap();
        let db_path = root.join("threadterm.db");
        let ws_id;
        let tab_id;
        {
            let clock = Arc::new(TestClock::new(10));
            let conn = Connection::open(&db_path).unwrap();
            let service = WorkspaceService::with_test_connection(clock, conn);
            let ws = service.ensure_workspace(root.to_str().unwrap()).unwrap();
            ws_id = ws.id.clone();
            let tab = service
                .open_tab(
                    &ws.id,
                    OpenTabRequest {
                        kind: WorkspaceTabKind::File,
                        title: "a.txt".into(),
                        card_id: None,
                        relative_path: Some("a.txt".into()),
                    },
                )
                .unwrap();
            tab_id = tab.id.clone();
            service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
            service
                .apply_draft_patch(
                    DESKTOP_MAIN_SURFACE,
                    DraftPatch {
                        workspace_id: ws.id.clone(),
                        tab_id: tab.id.clone(),
                        base_revision: 0,
                        changes: vec![],
                        full_text: Some("dirty after restart".into()),
                    },
                    false,
                )
                .unwrap();
            service
                .set_active_tab(&ws.id, DESKTOP_MAIN_SURFACE, &tab.id)
                .unwrap();
            // Leases must not survive restart — drop service without persisting them.
        }
        {
            let clock = Arc::new(TestClock::new(20));
            let conn = Connection::open(&db_path).unwrap();
            let service = WorkspaceService::with_test_connection(clock, conn);
            let snap = service.get_snapshot(&ws_id).unwrap();
            assert_eq!(snap.tabs.len(), 1);
            assert_eq!(snap.tabs[0].id, tab_id);
            assert_eq!(snap.view_states[0].active_tab_id, tab_id);
            let draft = service.get_draft(&ws_id, &tab_id).unwrap().unwrap();
            assert_eq!(draft.contents, "dirty after restart");
            assert!(draft.meta.dirty);
            assert!(snap.active_leases.is_empty());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn external_change_blocks_ordinary_save() {
        let (service, root, ws) = service_with_root("conflict");
        std::fs::write(root.join("a.txt"), "v1").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        service
            .apply_draft_patch(
                DESKTOP_MAIN_SURFACE,
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("local".into()),
                },
                false,
            )
            .unwrap();
        // External modification.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("a.txt"), "external").unwrap();
        let err = service.save_draft(&ws.id, &tab.id, 1, false).unwrap_err();
        assert_eq!(err.code, WorkspaceErrorCode::FileConflict);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "external"
        );
        // Force overwrite succeeds.
        service.save_draft(&ws.id, &tab.id, 1, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "local"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_has_no_draft_bodies() {
        let (service, root, ws) = service_with_root("snap");
        std::fs::write(root.join("a.txt"), "secret body").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        service
            .apply_draft_patch(
                DESKTOP_MAIN_SURFACE,
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("secret body dirty".into()),
                },
                false,
            )
            .unwrap();
        let snap = service.get_snapshot(&ws.id).unwrap();
        let encoded = serde_json::to_string(&snap).unwrap();
        assert!(!encoded.contains("secret body"));
        assert_eq!(snap.draft_metas.len(), 1);
        assert!(snap.draft_metas[0].dirty);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lease_required_blocks_patch_from_other_surface() {
        let (service, root, ws) = service_with_root("lease");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        service
            .acquire_lease(&ws.id, &tab.id, "desktop:main")
            .unwrap();
        let err = service
            .apply_draft_patch(
                "mobile:1",
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("nope".into()),
                },
                true,
            )
            .unwrap_err();
        assert_eq!(err.code, WorkspaceErrorCode::LeaseRequired);
        service.takeover_lease(&ws.id, &tab.id, "mobile:1").unwrap();
        service
            .apply_draft_patch(
                "mobile:1",
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("taken".into()),
                },
                true,
            )
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_close_rejects_partial_dirty_without_decision() {
        let (service, root, ws) = service_with_root("close");
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        let tab_a = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        let tab_b = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "b.txt".into(),
                    card_id: None,
                    relative_path: Some("b.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab_a.id).unwrap();
        service
            .apply_draft_patch(
                DESKTOP_MAIN_SURFACE,
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab_a.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("dirty a".into()),
                },
                false,
            )
            .unwrap();
        let prep = service
            .prepare_close(&ws.id, &[tab_a.id.clone(), tab_b.id.clone()])
            .unwrap();
        assert_eq!(prep.dirty_tab_ids, vec![tab_a.id.clone()]);
        assert_eq!(prep.clean_tab_ids, vec![tab_b.id.clone()]);

        let err = service
            .commit_close(
                &ws.id,
                &[CloseTabDecision {
                    tab_id: tab_a.id.clone(),
                    kind: CloseTabDecisionKind::CloseClean,
                    expected_revision: Some(1),
                }],
            )
            .unwrap_err();
        assert_eq!(err.code, WorkspaceErrorCode::InvalidArgument);

        service
            .commit_close(
                &ws.id,
                &[
                    CloseTabDecision {
                        tab_id: tab_a.id.clone(),
                        kind: CloseTabDecisionKind::DiscardAndClose,
                        expected_revision: Some(1),
                    },
                    CloseTabDecision {
                        tab_id: tab_b.id.clone(),
                        kind: CloseTabDecisionKind::CloseClean,
                        expected_revision: None,
                    },
                ],
            )
            .unwrap();
        assert!(service.get_snapshot(&ws.id).unwrap().tabs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disconnect_grace_and_revoke() {
        let (service, root, ws) = service_with_root("disconnect");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        service.acquire_lease(&ws.id, &tab.id, "mobile:1").unwrap();
        service.test_disconnect_surface("mobile:1", false);
        // Still held during grace.
        assert!(service
            .apply_draft_patch(
                "mobile:1",
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 0,
                    changes: vec![],
                    full_text: Some("during grace".into()),
                },
                true,
            )
            .is_ok());
        service.test_disconnect_surface("mobile:1", true);
        let err = service
            .apply_draft_patch(
                "mobile:1",
                DraftPatch {
                    workspace_id: ws.id.clone(),
                    tab_id: tab.id.clone(),
                    base_revision: 1,
                    changes: vec![],
                    full_text: Some("after revoke".into()),
                },
                true,
            )
            .unwrap_err();
        assert_eq!(err.code, WorkspaceErrorCode::LeaseRequired);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unavailable_root_preserves_registration() {
        let root = temp_root("gone");
        let clock = Arc::new(TestClock::new(1));
        let conn = Connection::open_in_memory().unwrap();
        let service = WorkspaceService::with_test_connection(clock, conn);
        let ws = service.ensure_workspace(root.to_str().unwrap()).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let tab = service
            .open_tab(
                &ws.id,
                OpenTabRequest {
                    kind: WorkspaceTabKind::File,
                    title: "a.txt".into(),
                    card_id: None,
                    relative_path: Some("a.txt".into()),
                },
            )
            .unwrap();
        service.ensure_draft_from_disk(&ws.id, &tab.id).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let refreshed = service.refresh_availability(&ws.id).unwrap();
        assert_eq!(refreshed.availability, WorkspaceAvailability::Unavailable);
        let snap = service.get_snapshot(&ws.id).unwrap();
        assert_eq!(snap.tabs.len(), 1);
        assert!(service.read_file(&ws.id, "a.txt").is_err());
    }
}
