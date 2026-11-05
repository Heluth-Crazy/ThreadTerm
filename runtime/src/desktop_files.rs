//! DB-only coordination for the optional desktop-main filesystem backend.
//!
//! The authenticated Electron main process performs every filesystem access.
//! This module only resolves persisted authority and owns mutation receipts,
//! notifications and opaque in-flight reservations.
use crate::{db::Database, domain::Session, workspace_services::MAX_DOCUMENT_BYTES};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
    sync::{Arc, Mutex},
};

const MAX_RESERVATIONS: usize = 256;
const MAX_ACCESS_LEASES: i64 = 256;
const MAX_PATH_BYTES: usize = 16 * 1024;

pub(crate) const ERROR_CODES: &[&str] = &[
    "desktop_files_forbidden",
    "desktop_files_busy",
    "desktop_files_unavailable",
    "desktop_files_access_unknown",
    "desktop_files_reservation_unknown",
    "invalid_request",
    "invalid_path",
    "project_missing",
    "worktree_not_registered",
    "file_reference_session_not_found",
    "file_reference_config_missing",
    "file_reference_project_missing",
    "file_reference_scope_mismatch",
    "file_reference_cwd_unavailable",
    "external_file_unknown",
    "operation_conflict",
    "operation_outcome_unknown",
];

#[derive(Clone)]
struct Scope {
    project_id: String,
    root_path: String,
    worktree_path: Option<String>,
    event_worktree_path: Option<String>,
}

struct Reservation {
    principal: String,
    access_id: String,
    operation_id: String,
    method: String,
    params: Value,
    scope: Scope,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessState {
    Live(u64),
    Dead,
    Unknown,
}

struct AccessSnapshot {
    ids: HashSet<String>,
    writer: bool,
}

pub(crate) struct DesktopFiles {
    reservations: Mutex<HashMap<String, Reservation>>,
    released_epochs_pruned: Mutex<bool>,
    instance_id: String,
    process_supported: bool,
    process_state: Arc<dyn Fn(u32) -> ProcessState + Send + Sync>,
}

impl Default for DesktopFiles {
    fn default() -> Self {
        Self {
            reservations: Mutex::default(),
            released_epochs_pruned: Mutex::new(false),
            instance_id: uuid::Uuid::new_v4().to_string(),
            process_supported: cfg!(windows),
            process_state: Arc::new(process_state),
        }
    }
}

impl DesktopFiles {
    #[cfg(test)]
    fn with_process_state(inspect: impl Fn(u32) -> ProcessState + Send + Sync + 'static) -> Self {
        Self {
            reservations: Mutex::default(),
            released_epochs_pruned: Mutex::new(false),
            instance_id: uuid::Uuid::new_v4().to_string(),
            process_supported: true,
            process_state: Arc::new(inspect),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_live_process_for_test(created: u64) -> Self {
        Self::with_process_state(move |_| ProcessState::Live(created))
    }

    /// Destructive lifecycle work may proceed only after Electron main has
    /// released every filesystem access lease. OS query failures stay busy;
    /// elapsed time is never evidence that a Node call stopped.
    pub(crate) fn require_idle(&self, db: &Database) -> Result<()> {
        let access = self.prune_access_leases(db, None)?;
        let mut reservations = self
            .reservations
            .lock()
            .map_err(|_| anyhow!("desktop_files_busy"))?;
        reservations.retain(|_, reservation| access.ids.contains(&reservation.access_id));
        if access.ids.is_empty() && reservations.is_empty() {
            Ok(())
        } else {
            Err(anyhow!("desktop_files_busy"))
        }
    }

    pub(crate) fn require_no_writer(&self, db: &Database) -> Result<()> {
        if self.prune_access_leases(db, None)?.writer {
            Err(anyhow!("desktop_files_busy"))
        } else {
            Ok(())
        }
    }

    fn access_begin(&self, db: &Database, principal: &str, value: &Value) -> Result<Value> {
        let object = exact_object(value, &["accessId", "pid", "write"])?;
        let access_id = required_uuid(object, "accessId")?;
        let write = object
            .get("write")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("invalid_request"))?;
        let pid = object
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|pid| *pid > 0 && *pid <= u64::from(u32::MAX))
            .map(|pid| pid as u32)
            .ok_or_else(|| anyhow!("invalid_request"))?;
        if !self.process_supported {
            return Err(anyhow!("desktop_files_unavailable"));
        }
        let process_created = match (self.process_state)(pid) {
            ProcessState::Live(created) => created,
            ProcessState::Dead => return Err(anyhow!("invalid_request")),
            ProcessState::Unknown => return Err(anyhow!("desktop_files_busy")),
        }
        .to_string();
        self.prune_access_leases(db, Some(access_id))?;
        db.transaction(|tx| {
            let prior: Option<(String, String, Option<i64>, Option<String>, Option<i64>)> = tx
                .query_row(
                    "SELECT principal,state,pid,process_created,write_access FROM desktop_file_access_leases WHERE id=?",
                    [access_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?;
            if let Some((owner, state, prior_pid, prior_created, prior_write)) = prior {
                if owner == principal
                    && state == "active"
                    && prior_pid == Some(i64::from(pid))
                    && prior_created.as_deref() == Some(process_created.as_str())
                    && prior_write == Some(i64::from(write))
                {
                    return Ok(());
                }
                return Err(anyhow!("desktop_files_access_unknown"));
            }
            if write {
                let writer: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM desktop_file_access_leases WHERE state='active' AND write_access=1)",
                    [],
                    |row| row.get(0),
                )?;
                if writer {
                    return Err(anyhow!("desktop_files_busy"));
                }
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM desktop_file_access_leases WHERE state='active'",
                [],
                |row| row.get(0),
            )?;
            if count >= MAX_ACCESS_LEASES {
                return Err(anyhow!("desktop_files_busy"));
            }
            tx.execute(
                "INSERT INTO desktop_file_access_leases(id,principal,state,pid,process_created,write_access,runtime_instance,created_at) VALUES(?,?,'active',?,?,?,?,?)",
                params![
                    access_id,
                    principal,
                    i64::from(pid),
                    process_created,
                    i64::from(write),
                    &self.instance_id,
                    Utc::now().to_rfc3339(),
                ],
            )?;
            Ok(())
        })?;
        Ok(json!({"accessId":access_id}))
    }

    fn access_release(&self, db: &Database, principal: &str, value: &Value) -> Result<Value> {
        let object = exact_object(value, &["accessId"])?;
        let access_id = required_uuid(object, "accessId")?;
        let mut reservations = self
            .reservations
            .lock()
            .map_err(|_| anyhow!("desktop_files_busy"))?;
        db.transaction(|tx| {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT principal FROM desktop_file_access_leases WHERE id=?",
                    [access_id],
                    |row| row.get(0),
                )
                .optional()?;
            if owner.as_deref().is_some_and(|owner| owner != principal) {
                return Err(anyhow!("desktop_files_access_unknown"));
            }
            if owner.is_some() {
                tx.execute(
                    "UPDATE desktop_file_access_leases SET state='released',runtime_instance=?,created_at=? WHERE id=? AND principal=?",
                    params![&self.instance_id, Utc::now().to_rfc3339(), access_id, principal],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO desktop_file_access_leases(id,principal,state,pid,process_created,write_access,runtime_instance,created_at) VALUES(?,?,'released',NULL,NULL,NULL,?,?)",
                    params![access_id, principal, &self.instance_id, Utc::now().to_rfc3339()],
                )?;
            }
            Ok(())
        })?;
        reservations.retain(|_, reservation| {
            reservation.access_id != access_id || reservation.principal != principal
        });
        Ok(Value::Null)
    }

    fn prune_access_leases(&self, db: &Database, preserve: Option<&str>) -> Result<AccessSnapshot> {
        {
            let mut pruned = self
                .released_epochs_pruned
                .lock()
                .map_err(|_| anyhow!("desktop_files_busy"))?;
            if !*pruned {
                db.transaction(|tx| {
                    tx.execute(
                        "DELETE FROM desktop_file_access_leases WHERE state='released' AND runtime_instance<>?",
                        [&self.instance_id],
                    )?;
                    Ok(())
                })?;
                *pruned = true;
            }
        }
        let leases = db.transaction(|tx| {
            let mut query = tx.prepare(
                "SELECT id,pid,process_created FROM desktop_file_access_leases WHERE state='active'",
            )?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        let stale = leases
            .iter()
            .filter_map(|(id, pid, expected)| {
                if preserve == Some(id.as_str()) {
                    return None;
                }
                let pid = u32::try_from((*pid)?).ok()?;
                let expected = expected.as_deref()?.parse::<u64>().ok()?;
                match (self.process_state)(pid) {
                    ProcessState::Dead => Some(id.clone()),
                    ProcessState::Live(actual) if actual != expected => Some(id.clone()),
                    ProcessState::Live(_) | ProcessState::Unknown => None,
                }
            })
            .collect::<Vec<_>>();
        if !stale.is_empty() {
            db.transaction(|tx| {
                for id in &stale {
                    tx.execute("DELETE FROM desktop_file_access_leases WHERE id=?", [id])?;
                }
                Ok(())
            })?;
        }
        db.transaction(|tx| {
            let mut query = tx.prepare(
                "SELECT id,write_access FROM desktop_file_access_leases WHERE state='active'",
            )?;
            let active = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(AccessSnapshot {
                writer: active.iter().any(|(_, write)| *write),
                ids: active.into_iter().map(|(id, _)| id).collect(),
            })
        })
    }

    pub(crate) fn dispatch(
        &self,
        db: &Database,
        principal: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        if !method.starts_with("desktop.files.") {
            return Err(anyhow!("invalid_request"));
        }
        if !local_desktop_principal(principal) {
            return Err(anyhow!("desktop_files_forbidden"));
        }
        match method {
            "desktop.files.access.begin" => self.access_begin(db, principal, params),
            "desktop.files.access.release" => self.access_release(db, principal, params),
            "desktop.files.context" => context(db, params),
            "desktop.files.external.get" => external_get(db, params),
            "desktop.files.external.list" => external_list(db, params),
            "desktop.files.external.open" => external_open(db, params),
            "desktop.files.external.forget" => external_forget(db, params),
            "desktop.files.mutation.begin" => self.mutation_begin(db, principal, params),
            "desktop.files.mutation.complete" => self.mutation_complete(db, principal, params),
            "desktop.files.mutation.abort" => self.mutation_abort(db, principal, params),
            _ => Err(anyhow!("invalid_request")),
        }
    }

    fn mutation_begin(&self, db: &Database, principal: &str, value: &Value) -> Result<Value> {
        let object = exact_object(value, &["accessId", "method", "params"])?;
        let access_id = required_string(object, "accessId")?;
        let method = required_string(object, "method")?;
        if !matches!(
            method,
            "filesystem.write" | "filesystem.create" | "filesystem.rename" | "filesystem.delete"
        ) {
            return Err(anyhow!("invalid_request"));
        }
        let public_params = object
            .get("params")
            .ok_or_else(|| anyhow!("invalid_request"))?;
        validate_mutation_request(method, public_params)?;
        let public = public_params
            .as_object()
            .ok_or_else(|| anyhow!("invalid_request"))?;
        let operation_id = required_string(public, "operationId")?;

        let mut reservations = self
            .reservations
            .lock()
            .map_err(|_| anyhow!("desktop_files_busy"))?;
        db.bind_operation(operation_id, method, public_params)?;

        let admission = db.transaction(|tx| {
            let owns_access: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM desktop_file_access_leases WHERE id=? AND principal=? AND state='active' AND write_access=1)",
                params![access_id, principal],
                |row| row.get(0),
            )?;
            if !owns_access {
                return Err(anyhow!("desktop_files_access_unknown"));
            }
            let scope = workspace_scope_tx(
                tx,
                required_string(public, "projectId")?,
                optional_string(public, "worktreePath")?,
            )?;
            let prior: Option<String> = tx
                .query_row(
                    "SELECT result FROM operations WHERE id=?",
                    [operation_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(prior) = prior {
                return Ok(Err(serde_json::from_str::<Value>(&prior)?));
            }
            if reservations.len() >= MAX_RESERVATIONS {
                return Err(anyhow!("desktop_files_busy"));
            }
            if tx.execute(
                "INSERT OR IGNORE INTO external_operations(id,started_at) VALUES (?,?)",
                params![operation_id, Utc::now().to_rfc3339()],
            )? != 1
            {
                return Err(anyhow!("operation_outcome_unknown"));
            }
            Ok(Ok(scope))
        })?;
        let scope = match admission {
            Err(result) => return Ok(json!({"kind":"replay","result":result})),
            Ok(scope) => scope,
        };

        let reservation_id = allocate_reservation_id(&reservations)?;
        reservations.insert(
            reservation_id.clone(),
            Reservation {
                principal: principal.to_owned(),
                access_id: access_id.to_owned(),
                operation_id: operation_id.to_owned(),
                method: method.to_owned(),
                params: public_params.clone(),
                scope: scope.clone(),
            },
        );
        let mut result = json!({
            "kind":"execute",
            "reservationId":reservation_id,
            "rootPath":scope.root_path,
            "projectId":scope.project_id,
        });
        if let Some(path) = scope.worktree_path {
            result["worktreePath"] = json!(path);
        }
        Ok(result)
    }

    fn mutation_complete(&self, db: &Database, principal: &str, value: &Value) -> Result<Value> {
        let object = exact_object(value, &["reservationId", "result"])?;
        let reservation_id = required_string(object, "reservationId")?;
        let result = object
            .get("result")
            .ok_or_else(|| anyhow!("invalid_request"))?;
        let mut reservations = self
            .reservations
            .lock()
            .map_err(|_| anyhow!("desktop_files_busy"))?;
        let reservation = reservations
            .get(reservation_id)
            .ok_or_else(|| anyhow!("desktop_files_reservation_unknown"))?;
        if reservation.principal != principal {
            return Err(anyhow!("desktop_files_reservation_unknown"));
        }
        validate_mutation_result(&reservation.method, &reservation.params, result)?;
        db.transaction(|tx| {
            let pending: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM external_operations WHERE id=?)",
                [&reservation.operation_id],
                |row| row.get(0),
            )?;
            if !pending {
                return Err(anyhow!("desktop_files_reservation_unknown"));
            }
            let prior: Option<String> = tx
                .query_row(
                    "SELECT result FROM operations WHERE id=?",
                    [&reservation.operation_id],
                    |row| row.get(0),
                )
                .optional()?;
            if prior.is_some() {
                return Err(anyhow!("desktop_files_reservation_unknown"));
            }
            if reservation.method == "filesystem.write" {
                let path = required_string(
                    reservation
                        .params
                        .as_object()
                        .ok_or_else(|| anyhow!("invalid_request"))?,
                    "path",
                )?;
                crate::group_chat::editor_saved(tx, &reservation.scope.root_path, path)?;
            }
            crate::git_actions::complete(
                tx,
                &reservation.operation_id,
                &reservation.method,
                result,
                Some((
                    &reservation.scope.project_id,
                    reservation.scope.event_worktree_path.as_deref(),
                )),
            )
        })?;
        let result = result.clone();
        reservations.remove(reservation_id);
        Ok(result)
    }

    fn mutation_abort(&self, db: &Database, principal: &str, value: &Value) -> Result<Value> {
        let object = exact_object(value, &["reservationId", "effect"])?;
        let reservation_id = required_string(object, "reservationId")?;
        if required_string(object, "effect")? != "none" {
            return Err(anyhow!("invalid_request"));
        }
        let mut reservations = self
            .reservations
            .lock()
            .map_err(|_| anyhow!("desktop_files_busy"))?;
        let reservation = reservations
            .get(reservation_id)
            .ok_or_else(|| anyhow!("desktop_files_reservation_unknown"))?;
        if reservation.principal != principal {
            return Err(anyhow!("desktop_files_reservation_unknown"));
        }
        db.transaction(|tx| {
            let completed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE id=?)",
                [&reservation.operation_id],
                |row| row.get(0),
            )?;
            if completed {
                return Err(anyhow!("desktop_files_reservation_unknown"));
            }
            tx.execute(
                "DELETE FROM external_operations WHERE id=?",
                [&reservation.operation_id],
            )?;
            Ok(())
        })?;
        reservations.remove(reservation_id);
        Ok(Value::Null)
    }
}

pub(crate) fn initialize_connection(connection: &rusqlite::Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS desktop_file_access_leases (
           id TEXT PRIMARY KEY,
           principal TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('active','released')),
           pid INTEGER CHECK(pid IS NULL OR (pid > 0 AND pid <= 4294967295)),
           process_created TEXT,
           write_access INTEGER CHECK(write_access IS NULL OR write_access IN (0,1)),
           runtime_instance TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS desktop_file_access_leases_state_write
           ON desktop_file_access_leases(state,write_access);",
    )?;
    Ok(())
}

#[cfg(windows)]
fn process_state(pid: u32) -> ProcessState {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: limited query rights only; every successful handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Windows documents ERROR_INVALID_PARAMETER for a PID that is no
        // longer present. Access/query failures are not proof of process exit.
        return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            ProcessState::Dead
        } else {
            ProcessState::Unknown
        };
    }
    let mut creation = unsafe { std::mem::zeroed() };
    let mut exit = unsafe { std::mem::zeroed() };
    let mut kernel = unsafe { std::mem::zeroed() };
    let mut user = unsafe { std::mem::zeroed() };
    // SAFETY: all four FILETIME outputs are valid stack slots for this process handle.
    let queried =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    // SAFETY: the handle was opened above and is not used after this close.
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        return ProcessState::Unknown;
    }
    let exited = exit.dwHighDateTime != 0 || exit.dwLowDateTime != 0;
    if exited {
        return ProcessState::Dead;
    }
    ProcessState::Live(
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
    )
}

#[cfg(not(windows))]
fn process_state(_pid: u32) -> ProcessState {
    ProcessState::Unknown
}

fn local_desktop_principal(principal: &str) -> bool {
    !principal.is_empty()
        && !["peer:", "mcp-", "mcp:", "agent:", "remote:", "device:"]
            .iter()
            .any(|prefix| principal.starts_with(prefix))
}

fn allocate_reservation_id(reservations: &HashMap<String, Reservation>) -> Result<String> {
    for _ in 0..8 {
        let candidate = uuid::Uuid::new_v4().to_string();
        if !reservations.contains_key(&candidate) {
            return Ok(candidate);
        }
    }
    Err(anyhow!("desktop_files_busy"))
}

fn context(db: &Database, value: &Value) -> Result<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    match required_string(object, "kind")? {
        "workspace" => {
            exact_keys(object, &["kind", "projectId", "worktreePath"])?;
            let scope = db.transaction(|tx| {
                workspace_scope_tx(
                    tx,
                    required_string(object, "projectId")?,
                    optional_string(object, "worktreePath")?,
                )
            })?;
            Ok(scope_value("workspace", &scope, None))
        }
        "session" => {
            exact_keys(object, &["kind", "sessionId"])?;
            session_context(db, required_string(object, "sessionId")?)
        }
        _ => Err(anyhow!("invalid_request")),
    }
}

fn session_context(db: &Database, session_id: &str) -> Result<Value> {
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow!("file_reference_session_not_found"))?;
    let config = crate::session_configs::read(db, session_id)?
        .ok_or_else(|| anyhow!("file_reference_config_missing"))?;
    let project_id = session
        .project_id
        .as_deref()
        .ok_or_else(|| anyhow!("file_reference_project_missing"))?;
    if config.launch.project_id.as_deref() != Some(project_id)
        || config.launch.provider != session.provider
        || config.launch.mode != session.mode
    {
        return Err(anyhow!("file_reference_scope_mismatch"));
    }
    path_key(&config.launch.cwd).map_err(|_| anyhow!("file_reference_cwd_unavailable"))?;
    let scope = db
        .transaction(|tx| {
            session_scope_tx(
                tx,
                project_id,
                &config.launch.cwd,
                session.worktree_path.as_deref(),
            )
        })
        .map_err(|_| anyhow!("file_reference_scope_mismatch"))?;
    let relative_requires_absolute =
        session.run.is_none() && matches!(session.provider.as_str(), "shell" | "custom");
    Ok(scope_value(
        "session",
        &scope,
        Some((&session, &config.launch.cwd, relative_requires_absolute)),
    ))
}

/// Filesystem-free counterpart of `workspace_root_for_cwd`. Main canonicalizes
/// both paths and repeats containment before it opens a reference.
fn session_scope_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    cwd: &str,
    session_root: Option<&str>,
) -> Result<Scope> {
    let cwd_key = path_key(cwd)?;
    let mut statement = tx.prepare(
        "SELECT id,path,1 FROM projects
         UNION ALL SELECT project_id,path,0 FROM worktrees",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut depth = None;
    let mut closest = Vec::new();
    for (candidate_project, candidate_path, is_project) in rows {
        let Ok(candidate_key) = path_key(&candidate_path) else {
            continue;
        };
        if !lexically_within(&cwd_key, &candidate_key) {
            continue;
        }
        let candidate_depth = path_depth(&candidate_key);
        match depth {
            Some(best) if candidate_depth < best => continue,
            Some(best) if candidate_depth == best => {}
            _ => {
                depth = Some(candidate_depth);
                closest.clear();
            }
        }
        closest.push((candidate_project, candidate_path, candidate_key, is_project));
    }
    if closest.iter().any(|candidate| candidate.3) {
        closest.retain(|candidate| candidate.3);
    }
    let (_, root_path, root_key, is_project) = closest
        .into_iter()
        .find(|candidate| candidate.0 == project_id)
        .ok_or_else(|| anyhow!("file_reference_scope_mismatch"))?;
    if session_root.is_some_and(|value| path_key(value).ok().as_deref() != Some(root_key.as_str()))
    {
        return Err(anyhow!("file_reference_scope_mismatch"));
    }
    Ok(Scope {
        project_id: project_id.to_owned(),
        root_path: root_path.clone(),
        worktree_path: (!is_project).then_some(root_path),
        event_worktree_path: None,
    })
}

fn scope_value(kind: &str, scope: &Scope, session: Option<(&Session, &str, bool)>) -> Value {
    let mut value = json!({
        "kind":kind,
        "projectId":scope.project_id,
        "rootPath":scope.root_path,
    });
    if let Some(path) = &scope.worktree_path {
        value["worktreePath"] = json!(path);
    }
    if let Some((session, cwd, relative_requires_absolute)) = session {
        value["sessionId"] = json!(session.id);
        value["cwd"] = json!(cwd);
        value["provider"] = json!(session.provider);
        value["mode"] = json!(session.mode);
        value["relativeRequiresAbsolute"] = json!(relative_requires_absolute);
    }
    value
}

fn workspace_scope_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    worktree_path: Option<&str>,
) -> Result<Scope> {
    let project_path: Option<String> = tx
        .query_row(
            "SELECT path FROM projects WHERE id=?",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    let project_path = project_path.ok_or_else(|| anyhow!("project_missing"))?;
    let Some(requested) = worktree_path else {
        return Ok(Scope {
            project_id: project_id.to_owned(),
            root_path: project_path,
            worktree_path: None,
            event_worktree_path: None,
        });
    };
    let requested_key = path_key(requested)?;
    if requested_key == path_key(&project_path)? {
        return Ok(Scope {
            project_id: project_id.to_owned(),
            root_path: project_path,
            worktree_path: None,
            event_worktree_path: Some(requested.to_owned()),
        });
    }
    let mut statement = tx.prepare("SELECT path FROM worktrees WHERE project_id=?")?;
    let paths = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut matches = paths
        .into_iter()
        .filter_map(|path| (path_key(&path).ok()? == requested_key).then_some(path));
    let root_path = matches
        .next()
        .ok_or_else(|| anyhow!("worktree_not_registered"))?;
    if matches.next().is_some() {
        return Err(anyhow!("worktree_not_registered"));
    }
    Ok(Scope {
        project_id: project_id.to_owned(),
        root_path: root_path.clone(),
        worktree_path: Some(root_path),
        event_worktree_path: Some(requested.to_owned()),
    })
}

/// Filesystem-free equality key for persisted/display Windows paths and POSIX paths.
fn path_key(value: &str) -> Result<String> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return Err(anyhow!("invalid_path"));
    }
    let mut text = value.replace('\\', "/");
    if text
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
    {
        text = format!("//{}", &text[8..]);
    } else if text
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/"))
    {
        text = text[4..].to_owned();
    }
    let (prefix, tail, windows) = if text.as_bytes().get(1) == Some(&b':')
        && text.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && text.as_bytes().get(2) == Some(&b'/')
    {
        (
            format!("drive:{}", text[..1].to_ascii_lowercase()),
            &text[3..],
            true,
        )
    } else if let Some(unc) = text.strip_prefix("//") {
        ("unc".to_owned(), unc, true)
    } else if let Some(posix) = text.strip_prefix('/') {
        ("posix".to_owned(), posix, false)
    } else {
        return Err(anyhow!("invalid_path"));
    };
    let mut components = Vec::new();
    for component in tail.split('/').filter(|component| !component.is_empty()) {
        if matches!(component, "." | "..") {
            return Err(anyhow!("invalid_path"));
        }
        components.push(if windows {
            component.to_lowercase()
        } else {
            component.to_owned()
        });
    }
    if windows && prefix == "unc" && components.len() < 2 {
        return Err(anyhow!("invalid_path"));
    }
    Ok(format!("{prefix}/{}", components.join("/")))
}

fn lexically_within(path: &str, root: &str) -> bool {
    path == root
        || path.strip_prefix(root).is_some_and(|suffix| {
            if root.ends_with('/') {
                !suffix.is_empty()
            } else {
                suffix.starts_with('/')
            }
        })
}

fn path_depth(path: &str) -> usize {
    path.split_once('/').map_or(0, |(_, tail)| {
        tail.split('/').filter(|part| !part.is_empty()).count()
    })
}

fn external_get(db: &Database, value: &Value) -> Result<Value> {
    let object = exact_object(value, &["id"])?;
    let id = required_string(object, "id")?;
    db.transaction(|tx| external_row(tx, id))
}

fn external_list(db: &Database, value: &Value) -> Result<Value> {
    exact_object(value, &[])?;
    db.transaction(|tx| {
        let mut query = tx.prepare(
            "SELECT id,path,name,source,opened_at FROM external_files
             ORDER BY opened_at DESC,rowid DESC LIMIT 30",
        )?;
        let files = query
            .query_map([], |row| {
                Ok(json!({
                    "id":row.get::<_,String>(0)?,
                    "canonicalPath":row.get::<_,String>(1)?,
                    "name":row.get::<_,String>(2)?,
                    "source":row.get::<_,String>(3)?,
                    "openedAt":row.get::<_,String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"files":files}))
    })
}

fn external_open(db: &Database, value: &Value) -> Result<Value> {
    let object = exact_object(value, &["canonicalPath", "source"])?;
    let path = required_string(object, "canonicalPath")?;
    path_key(path)?;
    let source = required_string(object, "source")?;
    if !matches!(source, "dialog" | "drop" | "link" | "recent") {
        return Err(anyhow!("invalid_request"));
    }
    let name = lexical_file_name(path)?;
    let opened_at = Utc::now().to_rfc3339();
    db.transaction(|tx| {
        let proposed = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO external_files(id,path,name,source,opened_at) VALUES(?,?,?,?,?)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name,source=excluded.source,opened_at=excluded.opened_at",
            params![proposed, path, name, source, opened_at],
        )?;
        let id: String = tx.query_row(
            "SELECT id FROM external_files WHERE path=?",
            [path],
            |row| row.get(0),
        )?;
        tx.execute(
            "DELETE FROM external_files WHERE id NOT IN
             (SELECT id FROM external_files ORDER BY opened_at DESC,rowid DESC LIMIT 200)",
            [],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{\"kind\":\"externalFiles\"}',?)",
            [&opened_at],
        )?;
        external_row(tx, &id)
    })
}

fn external_forget(db: &Database, value: &Value) -> Result<Value> {
    let object = exact_object(value, &["id", "operationId"])?;
    required_string(object, "id")?;
    required_string(object, "operationId")?;
    crate::external_files::dispatch(db, "filesystem.external.forget", value)?
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn external_row(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    tx.query_row(
        "SELECT id,path,name,source,opened_at FROM external_files WHERE id=?",
        [id],
        |row| {
            Ok(json!({
                "id":row.get::<_,String>(0)?,
                "canonicalPath":row.get::<_,String>(1)?,
                "name":row.get::<_,String>(2)?,
                "source":row.get::<_,String>(3)?,
                "openedAt":row.get::<_,String>(4)?,
            }))
        },
    )
    .optional()?
    .ok_or_else(|| anyhow!("external_file_unknown"))
}

fn lexical_file_name(path: &str) -> Result<String> {
    let normalized = path.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("invalid_path"))
}

fn validate_mutation_request(method: &str, value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let allowed: &[&str] = match method {
        "filesystem.write" => &[
            "projectId",
            "worktreePath",
            "path",
            "content",
            "expectedFingerprint",
            "operationId",
        ],
        "filesystem.create" => &["projectId", "worktreePath", "path", "kind", "operationId"],
        "filesystem.rename" => &[
            "projectId",
            "worktreePath",
            "path",
            "newPath",
            "operationId",
        ],
        "filesystem.delete" => &[
            "projectId",
            "worktreePath",
            "path",
            "permanent",
            "operationId",
        ],
        _ => return Err(anyhow!("invalid_request")),
    };
    exact_keys(object, allowed)?;
    required_string(object, "projectId")?;
    required_string(object, "operationId")?;
    if let Some(path) = optional_string(object, "worktreePath")? {
        path_key(path)?;
    }
    let path = required_string(object, "path")?;
    if method == "filesystem.write" {
        validate_write_path(path)?;
    } else {
        relative_result_path(path)?;
    }
    match method {
        "filesystem.write" => {
            let content = required_string_allow_empty(object, "content")?;
            if content.len() > MAX_DOCUMENT_BYTES || content.as_bytes().contains(&0) {
                return Err(anyhow!("invalid_request"));
            }
            required_string(object, "expectedFingerprint")?;
        }
        "filesystem.create" => {
            if !matches!(required_string(object, "kind")?, "file" | "directory") {
                return Err(anyhow!("invalid_request"));
            }
        }
        "filesystem.rename" => {
            relative_result_path(required_string(object, "newPath")?)?;
        }
        "filesystem.delete" => {
            if object
                .get("permanent")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(anyhow!("invalid_request"));
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_mutation_result(method: &str, params: &Value, result: &Value) -> Result<()> {
    let request = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let output = result
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    match method {
        "filesystem.write" => {
            exact_keys(
                output,
                &[
                    "path",
                    "content",
                    "fingerprint",
                    "readonly",
                    "size",
                    "modifiedAt",
                ],
            )?;
            let content = required_string_allow_empty(output, "content")?;
            if required_string(output, "path")? != required_string(request, "path")?
                || content != required_string_allow_empty(request, "content")?
                || output.get("readonly") != Some(&Value::Bool(false))
                || output.get("size").and_then(Value::as_u64) != Some(content.len() as u64)
                || content_fingerprint(content) != required_string(output, "fingerprint")?
                || DateTime::parse_from_rfc3339(required_string(output, "modifiedAt")?).is_err()
            {
                return Err(anyhow!("invalid_request"));
            }
        }
        "filesystem.create" | "filesystem.rename" => {
            exact_keys(output, &["path", "name", "kind", "size"])?;
            let requested_path = if method == "filesystem.rename" {
                required_string(request, "newPath")?
            } else {
                required_string(request, "path")?
            };
            let expected_path = relative_result_path(requested_path)?;
            if required_string(output, "path")? != expected_path
                || required_string(output, "name")? != lexical_file_name(&expected_path)?
            {
                return Err(anyhow!("invalid_request"));
            }
            let kind = required_string(output, "kind")?;
            if !matches!(kind, "file" | "directory" | "symlink")
                || (method == "filesystem.create" && kind != required_string(request, "kind")?)
                || (kind == "file" && output.get("size").and_then(Value::as_u64).is_none())
                || (kind != "file" && output.contains_key("size"))
            {
                return Err(anyhow!("invalid_request"));
            }
        }
        "filesystem.delete" => {
            exact_keys(output, &["path", "recycled"])?;
            if required_string(output, "path")?
                != relative_result_path(required_string(request, "path")?)?
                || output.get("recycled").and_then(Value::as_bool).is_none()
            {
                return Err(anyhow!("invalid_request"));
            }
        }
        _ => return Err(anyhow!("invalid_request")),
    }
    Ok(())
}

fn relative_result_path(path: &str) -> Result<String> {
    let path = crate::file_ops::normal_relative(path)?;
    Ok(path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn validate_write_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("invalid_path"));
    }
    Ok(())
}

fn content_fingerprint(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

fn exact_object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    exact_keys(object, allowed)?;
    Ok(object)
}

fn exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn required_uuid<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    let value = required_string(object, key)?;
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| anyhow!("invalid_request"))?;
    if parsed.hyphenated().to_string() != value {
        return Err(anyhow!("invalid_request"));
    }
    Ok(value)
}

fn required_string_allow_empty<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn optional_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .filter(|value| !value.is_empty())
            .map(Some)
            .ok_or_else(|| anyhow!("invalid_request")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::CreateSession, session_configs::LaunchSpec};
    use serde_json::json;
    use std::{fs, path::Path};

    struct Fixture {
        _temp: tempfile::TempDir,
        db: Database,
        coordinator: DesktopFiles,
        access: String,
        project: String,
        root: String,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("Project Root");
            fs::create_dir(&root).unwrap();
            let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
            crate::workspace_services::initialize(&db).unwrap();
            crate::external_files::initialize(&db).unwrap();
            crate::session_configs::initialize(&db).unwrap();
            let project = db
                .add_project(root.to_str().unwrap(), Some("Project"), "project-op")
                .unwrap()
                .id;
            let coordinator = DesktopFiles::with_process_state(|_| ProcessState::Live(7));
            let access = uuid::Uuid::new_v4().to_string();
            coordinator
                .dispatch(
                    &db,
                    "desktop",
                    "desktop.files.access.begin",
                    &json!({"accessId":access,"pid":42,"write":true}),
                )
                .unwrap();
            Self {
                _temp: temp,
                db,
                coordinator,
                access,
                project,
                root: root.to_string_lossy().into_owned(),
            }
        }

        fn call(&self, method: &str, params: Value) -> Result<Value> {
            self.coordinator
                .dispatch(&self.db, "desktop", method, &params)
        }

        fn begin_access(&self) -> String {
            let access_id = uuid::Uuid::new_v4().to_string();
            self.call(
                "desktop.files.access.begin",
                json!({"accessId":access_id,"pid":42,"write":true}),
            )
            .unwrap();
            access_id
        }

        fn release_access(&self, access_id: &str) {
            self.call(
                "desktop.files.access.release",
                json!({"accessId":access_id}),
            )
            .unwrap();
        }

        fn write_request(&self, operation: &str, content: &str) -> Value {
            json!({
                "accessId":self.access,
                "method":"filesystem.write",
                "params":{
                    "projectId":self.project,
                    "path":"README.md",
                    "content":content,
                    "expectedFingerprint":"0".repeat(64),
                    "operationId":operation,
                }
            })
        }
    }

    #[test]
    fn path_keys_match_windows_display_verbatim_case_and_separators_without_io() {
        assert_eq!(
            path_key(r"D:\Repo\Src").unwrap(),
            path_key(r"\\?\d:\repo/src\").unwrap()
        );
        assert_eq!(
            path_key(r"\\Server\Share\Repo").unwrap(),
            path_key(r"\\?\UNC\server\share\repo").unwrap()
        );
        assert_ne!(
            path_key(r"D:\Repo").unwrap(),
            path_key(r"D:\Other").unwrap()
        );
        assert!(path_key(r"D:relative").is_err());
        assert!(path_key(r"D:\Repo\..\Other").is_err());
    }

    #[test]
    fn context_uses_only_registered_rows_and_session_launch_metadata() {
        let fixture = Fixture::new();
        let workspace = fixture
            .call(
                "desktop.files.context",
                json!({"kind":"workspace","projectId":fixture.project}),
            )
            .unwrap();
        assert_eq!(workspace["rootPath"], fixture.root);
        assert!(workspace.get("worktreePath").is_none());
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('feature',?,?,'feature','head',0,0)",
                    params![fixture.project, r"\\?\D:\Repo\Feature"],
                )?;
                Ok(())
            })
            .unwrap();
        let lexical = fixture
            .call(
                "desktop.files.context",
                json!({"kind":"workspace","projectId":fixture.project,"worktreePath":"d:/repo/feature/"}),
            )
            .unwrap();
        assert_eq!(lexical["rootPath"], r"\\?\D:\Repo\Feature");
        assert_eq!(lexical["worktreePath"], r"\\?\D:\Repo\Feature");

        let session = fixture
            .db
            .create_session(CreateSession {
                project_id: Some(&fixture.project),
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "session-op",
            })
            .unwrap();
        fixture
            .db
            .bind_session(&session.id, Some(&fixture.root), None)
            .unwrap();
        crate::session_configs::save_new(
            &fixture.db,
            &session.id,
            &LaunchSpec {
                provider: "shell".into(),
                mode: "terminal".into(),
                cwd: fixture.root.clone(),
                project_id: Some(fixture.project.clone()),
                title: None,
                executable: None,
                args: Vec::new(),
            },
            None,
        )
        .unwrap();
        let context = fixture
            .call(
                "desktop.files.context",
                json!({"kind":"session","sessionId":session.id}),
            )
            .unwrap();
        assert_eq!(context["rootPath"], fixture.root);
        assert_eq!(context["cwd"], fixture.root);
        assert_eq!(context["relativeRequiresAbsolute"], true);

        let unbound = fixture
            .db
            .create_session(CreateSession {
                project_id: Some(&fixture.project),
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "unbound-session-op",
            })
            .unwrap();
        crate::session_configs::save_new(
            &fixture.db,
            &unbound.id,
            &LaunchSpec {
                provider: "codex".into(),
                mode: "chat".into(),
                cwd: fixture.root.clone(),
                project_id: Some(fixture.project.clone()),
                title: None,
                executable: None,
                args: Vec::new(),
            },
            None,
        )
        .unwrap();
        let unbound_context = fixture
            .call(
                "desktop.files.context",
                json!({"kind":"session","sessionId":unbound.id}),
            )
            .unwrap();
        assert_eq!(unbound_context["rootPath"], fixture.root);
        assert!(unbound_context.get("worktreePath").is_none());
        assert!(fixture
            .call(
                "desktop.files.context",
                json!({"kind":"workspace","projectId":fixture.project,"worktreePath":fixture._temp.path().join("other").to_string_lossy()}),
            )
            .unwrap_err()
            .to_string()
            .contains("worktree_not_registered"));
    }

    #[test]
    fn external_rows_are_db_only_bounded_and_forget_keeps_public_receipts() {
        let fixture = Fixture::new();
        let missing = fixture._temp.path().join("does-not-exist.txt");
        let opened = fixture
            .call(
                "desktop.files.external.open",
                json!({"canonicalPath":missing.to_string_lossy(),"source":"dialog"}),
            )
            .unwrap();
        assert_eq!(opened["name"], "does-not-exist.txt");
        assert_eq!(
            fixture
                .call("desktop.files.external.list", json!({}))
                .unwrap()["files"][0]["id"],
            opened["id"]
        );
        assert_eq!(
            fixture
                .call("desktop.files.external.get", json!({"id":opened["id"]}),)
                .unwrap()["canonicalPath"],
            missing.to_string_lossy().as_ref()
        );
        fixture
            .call(
                "desktop.files.external.forget",
                json!({"id":opened["id"],"operationId":"forget-op"}),
            )
            .unwrap();
        assert_eq!(
            fixture.db.operation("forget-op").unwrap(),
            Some(Value::Null)
        );
        let method: String = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT method FROM operations WHERE id='forget-op'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(method, "filesystem.external.forget");
    }

    #[test]
    fn reservations_bind_public_identity_complete_events_and_replay_across_paths() {
        let fixture = Fixture::new();
        let request = fixture.write_request("save-op", "saved body");
        let begin = fixture
            .call("desktop.files.mutation.begin", request.clone())
            .unwrap();
        assert_eq!(begin["kind"], "execute");
        let result = json!({
            "path":"README.md",
            "content":"saved body",
            "fingerprint":content_fingerprint("saved body"),
            "readonly":false,
            "size":10,
            "modifiedAt":"2026-11-05T00:00:00Z",
        });
        fixture
            .call(
                "desktop.files.mutation.complete",
                json!({"reservationId":begin["reservationId"],"result":result}),
            )
            .unwrap();
        let replay = fixture
            .call("desktop.files.mutation.begin", request.clone())
            .unwrap();
        assert_eq!(replay["kind"], "replay");
        assert_eq!(replay["result"]["content"], "saved body");
        assert!(fixture
            .call(
                "desktop.files.mutation.begin",
                fixture.write_request("save-op", "changed"),
            )
            .unwrap_err()
            .to_string()
            .starts_with("operation_conflict"));
        let event: String = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT data FROM outbox ORDER BY seq DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap(),
            json!({"kind":"git","projectId":fixture.project,"worktreePath":null})
        );
    }

    #[test]
    fn write_completion_fingerprint_is_bound_to_exact_utf8_content() {
        let request = json!({
            "path":"README.md",
            "content":"é",
        });
        let valid = json!({
            "path":"README.md",
            "content":"é",
            "fingerprint":content_fingerprint("é"),
            "readonly":false,
            "size":2,
            "modifiedAt":"2026-11-05T00:00:00Z",
        });
        validate_mutation_result("filesystem.write", &request, &valid).unwrap();
        let mut forged = valid;
        forged["fingerprint"] = json!("a".repeat(64));
        assert_eq!(
            validate_mutation_result("filesystem.write", &request, &forged)
                .unwrap_err()
                .to_string(),
            "invalid_request"
        );
    }

    #[test]
    fn abort_releases_only_known_no_effect_and_unknown_claim_fences_default_write() {
        let fixture = Fixture::new();
        fs::write(Path::new(&fixture.root).join("README.md"), "before").unwrap();
        let request = fixture.write_request("pending-op", "after");
        let begin = fixture
            .call("desktop.files.mutation.begin", request.clone())
            .unwrap();
        let public = request["params"].clone();
        assert_eq!(
            crate::workspace_services::dispatch(&fixture.db, "filesystem.write", &public)
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        let restarted = DesktopFiles::default();
        assert_eq!(
            restarted
                .dispatch(
                    &fixture.db,
                    "desktop",
                    "desktop.files.mutation.begin",
                    &request,
                )
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        fixture
            .call(
                "desktop.files.mutation.abort",
                json!({"reservationId":begin["reservationId"],"effect":"none"}),
            )
            .unwrap();
        assert!(!fixture.db.external_operation_pending("pending-op").unwrap());
        let retry = fixture
            .call("desktop.files.mutation.begin", request)
            .unwrap();
        assert_eq!(retry["kind"], "execute");
    }

    #[test]
    fn lifecycle_barrier_releases_only_after_explicit_abort_or_completion() {
        let fixture = Fixture::new();

        let aborted = fixture
            .call(
                "desktop.files.mutation.begin",
                fixture.write_request("barrier-abort", "not written"),
            )
            .unwrap();
        assert_eq!(
            fixture
                .coordinator
                .require_idle(&fixture.db)
                .unwrap_err()
                .to_string(),
            "desktop_files_busy"
        );
        fixture
            .call(
                "desktop.files.mutation.abort",
                json!({"reservationId":aborted["reservationId"],"effect":"none"}),
            )
            .unwrap();
        assert_eq!(
            fixture
                .coordinator
                .require_idle(&fixture.db)
                .unwrap_err()
                .to_string(),
            "desktop_files_busy",
            "the access lease, not only the mutation, owns lifecycle admission"
        );
        fixture.release_access(&fixture.access);
        fixture.coordinator.require_idle(&fixture.db).unwrap();

        let next_access = fixture.begin_access();
        let mut request = fixture.write_request("barrier-complete", "written");
        request["accessId"] = json!(next_access);
        let completed = fixture
            .call("desktop.files.mutation.begin", request)
            .unwrap();
        assert_eq!(
            fixture
                .coordinator
                .require_idle(&fixture.db)
                .unwrap_err()
                .to_string(),
            "desktop_files_busy"
        );
        fixture
            .call(
                "desktop.files.mutation.complete",
                json!({
                    "reservationId":completed["reservationId"],
                    "result":{
                        "path":"README.md",
                        "content":"written",
                        "fingerprint":content_fingerprint("written"),
                        "readonly":false,
                        "size":7,
                        "modifiedAt":"2026-11-05T00:00:00Z",
                    }
                }),
            )
            .unwrap();
        assert!(fixture.coordinator.require_idle(&fixture.db).is_err());
        fixture.release_access(&next_access);
        fixture.coordinator.require_idle(&fixture.db).unwrap();
    }

    #[test]
    fn durable_access_survives_runtime_restart_and_released_ids_never_reactivate() {
        let fixture = Fixture::new();
        fixture.release_access(&fixture.access);
        let read_access = uuid::Uuid::new_v4().to_string();
        fixture
            .call(
                "desktop.files.access.begin",
                json!({"accessId":read_access,"pid":42,"write":false}),
            )
            .unwrap();
        let restarted = DesktopFiles::with_live_process_for_test(7);
        assert_eq!(
            restarted.require_idle(&fixture.db).unwrap_err().to_string(),
            "desktop_files_busy"
        );
        let replay = restarted
            .dispatch(
                &fixture.db,
                "desktop",
                "desktop.files.access.begin",
                &json!({"accessId":read_access,"pid":42,"write":false}),
            )
            .unwrap();
        assert_eq!(replay, json!({"accessId":read_access}));
        assert_eq!(
            restarted
                .dispatch(
                    &fixture.db,
                    "another-desktop",
                    "desktop.files.access.release",
                    &json!({"accessId":read_access}),
                )
                .unwrap_err()
                .to_string(),
            "desktop_files_access_unknown"
        );
        restarted
            .dispatch(
                &fixture.db,
                "desktop",
                "desktop.files.access.release",
                &json!({"accessId":read_access}),
            )
            .unwrap();
        restarted.require_idle(&fixture.db).unwrap();
        // A retry is idempotent, but a delayed duplicate begin must not turn
        // the released tombstone active again.
        restarted
            .dispatch(
                &fixture.db,
                "desktop",
                "desktop.files.access.release",
                &json!({"accessId":read_access}),
            )
            .unwrap();
        assert_eq!(
            restarted
                .dispatch(
                    &fixture.db,
                    "desktop",
                    "desktop.files.access.begin",
                    &json!({"accessId":read_access,"pid":42,"write":false}),
                )
                .unwrap_err()
                .to_string(),
            "desktop_files_access_unknown"
        );
        let next_runtime = DesktopFiles::with_live_process_for_test(7);
        next_runtime.require_idle(&fixture.db).unwrap();
        let rows: i64 = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM desktop_file_access_leases",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(rows, 0, "a new Runtime prunes old released tombstones");

        let released_before_begin = uuid::Uuid::new_v4().to_string();
        next_runtime
            .dispatch(
                &fixture.db,
                "desktop",
                "desktop.files.access.release",
                &json!({"accessId":released_before_begin}),
            )
            .unwrap();
        assert_eq!(
            next_runtime
                .dispatch(
                    &fixture.db,
                    "desktop",
                    "desktop.files.access.begin",
                    &json!({"accessId":released_before_begin,"pid":42,"write":false}),
                )
                .unwrap_err()
                .to_string(),
            "desktop_files_access_unknown"
        );
    }

    #[test]
    fn read_leases_coexist_but_only_one_write_lease_is_active() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let coordinator = DesktopFiles::with_live_process_for_test(7);
        let begin = |access_id: &str, write: bool| {
            coordinator.dispatch(
                &db,
                "desktop",
                "desktop.files.access.begin",
                &json!({"accessId":access_id,"pid":42,"write":write}),
            )
        };
        let release = |access_id: &str| {
            coordinator
                .dispatch(
                    &db,
                    "desktop",
                    "desktop.files.access.release",
                    &json!({"accessId":access_id}),
                )
                .unwrap();
        };

        let read_one = uuid::Uuid::new_v4().to_string();
        let read_two = uuid::Uuid::new_v4().to_string();
        let writer_one = uuid::Uuid::new_v4().to_string();
        let writer_two = uuid::Uuid::new_v4().to_string();
        begin(&read_one, false).unwrap();
        begin(&read_two, false).unwrap();
        begin(&writer_one, true).unwrap();
        assert_eq!(
            begin(&writer_two, true).unwrap_err().to_string(),
            "desktop_files_busy"
        );
        assert_eq!(
            coordinator.require_no_writer(&db).unwrap_err().to_string(),
            "desktop_files_busy"
        );

        release(&writer_one);
        coordinator.require_no_writer(&db).unwrap();
        begin(&writer_two, true).unwrap();
        release(&writer_two);
        release(&read_one);
        release(&read_two);
        coordinator.require_idle(&db).unwrap();
    }

    #[test]
    fn released_tombstones_do_not_consume_the_active_lease_cap() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let coordinator = DesktopFiles::with_live_process_for_test(7);
        let indexes = db
            .transaction(|tx| {
                let mut query = tx.prepare("PRAGMA index_list(desktop_file_access_leases)")?;
                let rows = query
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert!(indexes
            .iter()
            .any(|name| name == "desktop_file_access_leases_state_write"));

        for _ in 0..=MAX_ACCESS_LEASES {
            let access_id = uuid::Uuid::new_v4().to_string();
            coordinator
                .dispatch(
                    &db,
                    "desktop",
                    "desktop.files.access.begin",
                    &json!({"accessId":access_id,"pid":42,"write":false}),
                )
                .unwrap();
            coordinator
                .dispatch(
                    &db,
                    "desktop",
                    "desktop.files.access.release",
                    &json!({"accessId":access_id}),
                )
                .unwrap();
        }

        let (active, released): (i64, i64) = db
            .transaction(|tx| {
                Ok((
                    tx.query_row(
                        "SELECT COUNT(*) FROM desktop_file_access_leases WHERE state='active'",
                        [],
                        |row| row.get(0),
                    )?,
                    tx.query_row(
                        "SELECT COUNT(*) FROM desktop_file_access_leases WHERE state='released'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(active, 0);
        assert_eq!(released, MAX_ACCESS_LEASES + 1);
        coordinator.require_idle(&db).unwrap();
    }

    #[test]
    fn process_exit_and_pid_reuse_prune_access_but_unknown_liveness_stays_busy() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let state = std::sync::Arc::new(std::sync::Mutex::new(ProcessState::Live(100)));
        let inspected = std::sync::Arc::clone(&state);
        let coordinator = DesktopFiles::with_process_state(move |_| *inspected.lock().unwrap());

        let exited = uuid::Uuid::new_v4().to_string();
        coordinator
            .dispatch(
                &db,
                "desktop",
                "desktop.files.access.begin",
                &json!({"accessId":exited,"pid":42,"write":false}),
            )
            .unwrap();
        *state.lock().unwrap() = ProcessState::Dead;
        coordinator.require_idle(&db).unwrap();

        *state.lock().unwrap() = ProcessState::Live(200);
        let reused = uuid::Uuid::new_v4().to_string();
        coordinator
            .dispatch(
                &db,
                "desktop",
                "desktop.files.access.begin",
                &json!({"accessId":reused,"pid":42,"write":false}),
            )
            .unwrap();
        *state.lock().unwrap() = ProcessState::Live(201);
        coordinator.require_idle(&db).unwrap();

        *state.lock().unwrap() = ProcessState::Live(300);
        let unknown = uuid::Uuid::new_v4().to_string();
        coordinator
            .dispatch(
                &db,
                "desktop",
                "desktop.files.access.begin",
                &json!({"accessId":unknown,"pid":42,"write":false}),
            )
            .unwrap();
        *state.lock().unwrap() = ProcessState::Unknown;
        assert_eq!(
            coordinator.require_idle(&db).unwrap_err().to_string(),
            "desktop_files_busy"
        );
    }

    #[test]
    fn releasing_settled_unknown_effect_keeps_durable_replay_fence() {
        let fixture = Fixture::new();
        let mut request = fixture.write_request("unknown-effect", "possibly written");
        fixture
            .call("desktop.files.mutation.begin", request.clone())
            .unwrap();
        fixture.release_access(&fixture.access);
        fixture.coordinator.require_idle(&fixture.db).unwrap();
        assert!(fixture
            .db
            .external_operation_pending("unknown-effect")
            .unwrap());

        let retry_access = fixture.begin_access();
        request["accessId"] = json!(retry_access);
        assert_eq!(
            fixture
                .call("desktop.files.mutation.begin", request)
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        fixture.release_access(&retry_access);
    }

    #[test]
    fn write_admission_preserves_legacy_scoped_path_syntax() {
        let fixture = Fixture::new();
        let mut request = fixture.write_request("legacy-write-path", "body");
        request["params"]["path"] = json!("src/./main.rs");
        let begin = fixture
            .call("desktop.files.mutation.begin", request)
            .unwrap();
        fixture
            .call(
                "desktop.files.mutation.abort",
                json!({"reservationId":begin["reservationId"],"effect":"none"}),
            )
            .unwrap();
        assert!(fixture
            .call(
                "desktop.files.mutation.begin",
                json!({"accessId":fixture.access,"method":"filesystem.write","params":{
                    "projectId":fixture.project,
                    "path":"../outside.txt",
                    "content":"body",
                    "expectedFingerprint":"0".repeat(64),
                    "operationId":"outside-write",
                }}),
            )
            .unwrap_err()
            .to_string()
            .contains("invalid_path"));
    }

    #[test]
    fn private_methods_reject_peer_agent_device_and_wrong_reservation_owner() {
        let fixture = Fixture::new();
        for principal in [
            "peer:device:client",
            "mcp-host",
            "mcp:tool",
            "agent:tool",
            "remote:phone",
            "device:tool",
        ] {
            assert_eq!(
                fixture
                    .coordinator
                    .dispatch(
                        &fixture.db,
                        principal,
                        "desktop.files.context",
                        &json!({"kind":"workspace","projectId":fixture.project}),
                    )
                    .unwrap_err()
                    .to_string(),
                "desktop_files_forbidden"
            );
        }
        let begin = fixture
            .call(
                "desktop.files.mutation.begin",
                fixture.write_request("owned-op", "body"),
            )
            .unwrap();
        assert_eq!(
            fixture
                .coordinator
                .dispatch(
                    &fixture.db,
                    "another-desktop",
                    "desktop.files.mutation.abort",
                    &json!({"reservationId":begin["reservationId"],"effect":"none"}),
                )
                .unwrap_err()
                .to_string(),
            "desktop_files_reservation_unknown"
        );
    }
}
