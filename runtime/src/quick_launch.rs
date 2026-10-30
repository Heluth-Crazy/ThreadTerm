//! Saved project commands and their immutable, session-owned run snapshots.
use crate::{db::Database, pty::PtyManager, session_configs::LaunchSpec};
use anyhow::{anyhow, Result};
use base64::Engine;
use chrono::Utc;
use portable_pty::CommandBuilder;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

// Dispatch holds only a shared service gate. Serialize admission across clients,
// including reruns, until the reserved session has either launched or failed.
static ADMISSION: Mutex<()> = Mutex::new(());
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub(crate) const ERROR_CODES: &[&str] = &[
    "too_many_commands",
    "cmd_single_line",
    "command_not_found",
    "cwd_outside_root",
    "cwd_missing",
    "shell_unavailable",
    "setup_empty",
    "invalid_step",
    "not_a_task",
    "detected_entry_not_found",
    "tool_not_found",
    "invalid_command",
    "restart_stop_timeout",
    "run_not_found",
    "run_not_permitted",
    "run_declined",
    "detected_entry_changed",
    "detected_command_too_long",
    "repo_config_invalid",
    "repo_config_conflict",
    "repo_entry_not_found",
    "repo_entry_changed",
    "secret_missing",
];

#[path = "quick_launch_setup.rs"]
mod setup;
pub(crate) use setup::root_for_setup;
pub use setup::{mark_setup_runs_interrupted, setup_after_worktree_create};
pub(crate) use setup::{setup_terminal_exited, start_next_setup_step};
#[path = "quick_launch_readiness.rs"]
mod readiness;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuickLaunchCommand {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub name: String,
    pub command: String,
    pub shell: String,
    pub cwd: String,
    pub kind: String,
    pub env: Vec<EnvVar>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRun {
    pub command_id: String,
    pub name: String,
    pub kind: String,
    pub shell: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_requested: Option<bool>,
    /// `waiting` while a service run is watched, `ready` once it listened or
    /// printed a URL, `none` when the watcher gave up or this platform cannot
    /// tell. Absent for tasks and for runs recorded before readiness existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness: Option<String>,
    /// The port the run was announced on, when it became ready by port.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The Chat session whose agent started this run. Absent for user runs; set
    /// by the caller-scoped run tools only, and shown as "started by" in 2b.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<setup::SetupStep>,
}

pub(crate) fn initialize_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS quick_launch_commands (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         revision INTEGER NOT NULL, name TEXT NOT NULL, command TEXT NOT NULL, shell TEXT NOT NULL,
         cwd TEXT NOT NULL, kind TEXT NOT NULL, env_json TEXT NOT NULL, preview_url TEXT,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS quick_launch_project ON quick_launch_commands(project_id,created_at);
         CREATE TABLE IF NOT EXISTS quick_launch_runs (
         session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         command_id TEXT NOT NULL, project_id TEXT NOT NULL, root TEXT NOT NULL,
         snapshot_json TEXT NOT NULL, url TEXT, url_source TEXT,
         stop_requested INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL,
         readiness TEXT, ready_port INTEGER, started_by TEXT);
         CREATE INDEX IF NOT EXISTS quick_launch_admission ON quick_launch_runs(command_id,root);
         CREATE TABLE IF NOT EXISTS quick_launch_setup (
         project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
         revision INTEGER NOT NULL, command_ids_json TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS quick_launch_setup_runs (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         root TEXT NOT NULL, command_ids_json TEXT NOT NULL, names_json TEXT NOT NULL,
         snapshots_json TEXT NOT NULL, step INTEGER NOT NULL, state TEXT NOT NULL,
         session_ids_json TEXT NOT NULL, exit_code INTEGER, trigger TEXT NOT NULL,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS quick_launch_setup_root ON quick_launch_setup_runs(project_id,root,created_at);
         CREATE INDEX IF NOT EXISTS quick_launch_setup_creations ON operations(method) WHERE method='worktree.create';
         CREATE UNIQUE INDEX IF NOT EXISTS quick_launch_setup_active ON quick_launch_setup_runs(project_id,root) WHERE state='running';"
    )?;
    crate::run_repo_config::initialize_connection(conn)?;
    // Additive migration: readiness arrived after the first runs were recorded, so
    // old rows stay NULL (= no readiness state) instead of being rewritten.
    let mut columns = conn.prepare("PRAGMA table_info(quick_launch_runs)")?;
    let existing: Vec<String> = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (column, definition) in [("readiness", "TEXT"), ("ready_port", "INTEGER"), ("started_by", "TEXT"),
    ] {
        if !existing.iter().any(|name| name == column) {
            conn.execute_batch(&format!(
                "ALTER TABLE quick_launch_runs ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    Ok(())
}

pub(crate) fn run_from_row(row: &Row<'_>, offset: usize) -> rusqlite::Result<Option<SessionRun>> {
    let Some(raw) = row.get::<_, Option<String>>(offset)? else {
        return Ok(None);
    };
    let (snapshot, setup) = setup::decode_snapshot(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(offset, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let mut run = projection(
        &snapshot,
        row.get(offset + 1)?,
        row.get(offset + 2)?,
        row.get::<_, bool>(offset + 3)?,
        row.get(offset + 4)?,
        row.get::<_, Option<i64>>(offset + 5)?
            .and_then(|port| u16::try_from(port).ok()),
        row.get(offset + 6)?,
    );
    run.setup = setup;
    Ok(Some(run))
}
fn projection(
    snapshot: &QuickLaunchCommand,
    url: Option<String>,
    url_source: Option<String>,
    stopped: bool,
    readiness: Option<String>,
    port: Option<u16>,
    started_by: Option<String>,
) -> SessionRun {
    SessionRun {
        command_id: snapshot.id.clone(),
        name: snapshot.name.clone(),
        kind: snapshot.kind.clone(),
        shell: snapshot.shell.clone(),
        url,
        url_source,
        stop_requested: stopped.then_some(true),
        readiness,
        port,
        started_by,
        setup: None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    project_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    project_id: String,
    id: Option<String>,
    expected_revision: Option<i64>,
    name: String,
    command: String,
    shell: String,
    cwd: String,
    kind: String,
    env: Vec<SaveEnv>,
    preview_url: Option<String>,
    repo_source: Option<RepoSource>,
    operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveEnv {
    pub(crate) name: String,
    pub(crate) value: Option<String>,
    pub(crate) secret: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoSource {
    id: String,
    fingerprint: String,
    cwd: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Delete {
    id: String,
    expected_revision: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Detect {
    project_id: String,
    cwd: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Run {
    command_id: Option<String>,
    detected_key: Option<String>,
    repo_id: Option<String>,
    project_id: Option<String>,
    cwd: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rerun {
    session_id: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restart {
    session_id: String,
    operation_id: String,
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "quickLaunch.list" | "quickLaunch.save" | "quickLaunch.delete" | "quickLaunch.run"
        | "quickLaunch.restart" | "quickLaunch.detect"
            | "quickLaunch.repo.list"
            | "quickLaunch.repo.save"
            | "quickLaunch.repo.delete"
            | "quickLaunch.repo.trust"
            | "quickLaunch.setup.read" | "quickLaunch.setup.save" | "quickLaunch.setup.run" | "quickLaunch.setup.status"
    )
}
fn required(value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}
fn revision(value: i64) -> Result<()> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}
fn units(value: &str) -> usize {
    value.encode_utf16().count()
}
fn trim_wire(value: &str) -> &str {
    // ECMAScript String.trim(), including BOM but excluding NEL (U+0085).
    value.trim_matches(|c| {
        matches!(c,
        '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}
fn relative_cwd(value: &str) -> bool {
    units(value) <= 260
        && !value.starts_with(['/', '\\'])
        && !(value.as_bytes().get(1) == Some(&b':') && value.as_bytes()[0].is_ascii_alphabetic())
        && !value.split(['/', '\\']).any(|part| part == "..")
        && !value
            .chars()
            .any(|c| c <= '\u{1f}' || "<>\"|?*".contains(c))
}
fn preview_url(value: &str) -> bool {
    !value.is_empty()
        && units(value) <= 2048
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
        && reqwest::Url::parse(value)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}
pub(crate) fn validate(method: &str, value: &Value) -> Result<()> {
    if method.starts_with("quickLaunch.setup.") {
        return setup::validate_setup(method, value);
    }
    if method.starts_with("quickLaunch.repo.") {
        return crate::run_repo_config::validate(method, value);
    }
    match method {
        "quickLaunch.list" => {
            let p: List = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
        }
        "quickLaunch.delete" => {
            let p: Delete = serde_json::from_value(value.clone())?;
            required(&p.id)?;
            required(&p.operation_id)?;
            revision(p.expected_revision)?;
        }
        "quickLaunch.run" => {
            let p: Run = serde_json::from_value(value.clone())?;
            required(&p.cwd)?;
            required(&p.operation_id)?;
            // Exactly one target; detected and repo text is always re-read from files.
            match (&p.command_id, &p.detected_key, &p.repo_id) {
                (Some(id), None, None) => required(id)?,
                (None, Some(key), None) => {
                    required(key)?;
                    if units(key) > 512 {
                        return Err(anyhow!("invalid_request"));
                    }
                    required(p.project_id.as_deref().unwrap_or_default())?;
                }
                (None, None, Some(id)) => {
                    required(id)?;
                    let bytes = id.as_bytes();
                    if bytes.len() > 64
                        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
                        || !bytes.iter().all(|byte| {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || matches!(byte, b'_' | b'.' | b'-')
                        })
                    {
                        return Err(anyhow!("invalid_request"));
                    }
                    required(p.project_id.as_deref().unwrap_or_default())?;
                }
                _ => return Err(anyhow!("invalid_request")),
            }
        }
        "quickLaunch.restart" => {
            let p: Restart = serde_json::from_value(value.clone())?;
            required(&p.session_id)?;
            required(&p.operation_id)?;
        }
        "quickLaunch.detect" => {
            let p: Detect = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
        }
        "quickLaunch.save" => {
            for key in ["id", "expectedRevision", "previewUrl", "repoSource"] {
                if value.get(key).is_some_and(Value::is_null) {
                    return Err(anyhow!("invalid_request"));
                }
            }
            if value
                .get("env")
                .and_then(Value::as_array)
                .is_some_and(|env| env.iter().any(|item| {
                    item.get("value").is_some_and(Value::is_null)
                        || item.get("secret").is_some_and(Value::is_null)
                }))
            {
                return Err(anyhow!("invalid_request"));
            }
            let p: Save = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.operation_id)?;
            let name = trim_wire(&p.name);
            if name.is_empty()
                || name.chars().count() > 80
                || name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                || trim_wire(&p.command).is_empty()
                || units(&p.command) > 8000
                || p.command.contains('\0')
                || !matches!(p.shell.as_str(), "cmd" | "powershell" | "pwsh")
                || !matches!(p.kind.as_str(), "service" | "task")
                || !relative_cwd(&p.cwd)
            {
                return Err(anyhow!("invalid_request"));
            }
            if p.shell == "cmd" && p.command.contains(['\r', '\n']) {
                return Err(anyhow!("cmd_single_line"));
            }
            let mut names = HashSet::new();
            if p.env.len() > 32
                || p.env.iter().any(|item| {
                    let bytes = item.name.as_bytes();
                    bytes.is_empty()
                        || bytes.len() > 128
                        || !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
                        || !bytes
                            .iter()
                            .all(|c| c.is_ascii_alphanumeric() || *c == b'_')
                        || item.value.as_ref().is_some_and(|value| {
                            units(value) > 8192 || value.contains('\0')
                        })
                        || item.secret != Some(true) && item.value.is_none()
                        || !names.insert(item.name.to_ascii_uppercase())
                })
                || p.preview_url.as_ref().is_some_and(|url| !preview_url(url))
                || p.id.is_some() != p.expected_revision.is_some()
            {
                return Err(anyhow!("invalid_request"));
            }
            if let Some(id) = &p.id {
                required(id)?;
            }
            if let Some(expected) = p.expected_revision {
                revision(expected)?;
            }
            if let Some(source) = &p.repo_source {
                crate::run_repo_config::validate_repo_source(&source.id, &source.fingerprint)?;
                required(&source.cwd)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn operation_tx(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row("SELECT result FROM operations WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

/// A recorded result, only when it was recorded for this method. A request id reused
/// for a different operation is not a replay, so an agent tool never answers with
/// another method's receipt.
pub(crate) fn replayed_operation(
    db: &Database,
    id: &str,
    method: &str) -> Result<Option<Value>> {
    db.transaction(|tx| {
        let row: Option<(String, String)> = tx
            .query_row("SELECT method,result FROM operations WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((recorded, result)) if recorded == method => {
                Ok(Some(serde_json::from_str(&result)?))
            }
            _ => Ok(None),
        }
    })
}
fn complete(tx: &Transaction<'_>, id: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![id, method, result.to_string(), Utc::now().to_rfc3339()],
    )?;
    Ok(())
}
fn changed(tx: &Transaction<'_>, kind: &str, session_id: Option<&str>) -> Result<()> {
    let data = if let Some(id) = session_id {
        json!({"kind":kind,"sessionId":id})
    } else {
        json!({"kind":kind})
    };
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![data.to_string(), Utc::now().to_rfc3339()],
    )?;
    Ok(())
}
fn command_row(r: &Row<'_>) -> rusqlite::Result<QuickLaunchCommand> {
    let raw: String = r.get(8)?;
    let env = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(QuickLaunchCommand {
        id: r.get(0)?,
        project_id: r.get(1)?,
        revision: r.get(2)?,
        name: r.get(3)?,
        command: r.get(4)?,
        shell: r.get(5)?,
        cwd: r.get(6)?,
        kind: r.get(7)?,
        env,
        preview_url: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

fn public_command_value(tx: &Transaction<'_>, command: &QuickLaunchCommand) -> Result<Value> {
    let mut value = serde_json::to_value(command)?;
    value["env"] = Value::Array(crate::run_repo_config::public_env(
        tx,
        &command.project_id,
        &command.id,
        &command.env,
    )?);
    Ok(value)
}

pub(crate) fn local_move_source(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    revision: i64,
) -> Result<QuickLaunchCommand> {
    let command = tx
        .query_row(
            &format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"),
            params![id, project],
            command_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("command_not_found"))?;
    if command.revision != revision {
        return Err(anyhow!("revision_conflict"));
    }
    Ok(command)
}
const COMMAND_COLUMNS: &str =
    "id,project_id,revision,name,command,shell,cwd,kind,env_json,preview_url,created_at,updated_at";
fn read_command(db: &Database, id: &str) -> Result<QuickLaunchCommand> {
    db.transaction(|tx| {
        tx.query_row(
            &format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=?"),
            [id],
            command_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("command_not_found"))
    })
}

/// Converts a live detection entry into the same immutable snapshot saved
/// commands use, so admission, rerun and the run projection need no special
/// case. The request only names a key: command text always comes from the
/// files, never from the client.
fn detected_snapshot(
    db: &Database,
    project: &str,
    cwd: &str,
    key: &str,
) -> Result<QuickLaunchCommand> {
    let root = setup::root_for_setup(db, project, cwd)?;
    let detection = crate::run_detect::detect(&root);
    let entry = detection
        .entries
        .into_iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| anyhow!("detected_entry_not_found"))?;
    detected_command(project, entry)
}

/// The immutable snapshot one detected entry becomes, from an entry that was just
/// detected by the caller. Shared with the agent run tools, which must show the same
/// text they launch and never a second, differently-timed scan.
pub(crate) fn detected_command(
    project: &str,
    entry: crate::run_detect::DetectedRunEntry,
) -> Result<QuickLaunchCommand> {
    if let Some(tool) = entry.missing_tool {
        return Err(anyhow!("tool_not_found: {tool}"));
    }
    // Detection already drops these, so this only guards a listing that changed
    // between the click and the re-detection.
    if !crate::run_detect::command_is_safe(&entry.command, &entry.shell) {
        return Err(anyhow!("invalid_command"));
    }
    let now = Utc::now().to_rfc3339();
    Ok(QuickLaunchCommand {
        id: format!("detected:{}", entry.key),
        project_id: project.to_owned(),
        revision: 1,
        name: entry.name,
        command: entry.command,
        shell: entry.shell,
        cwd: entry.cwd,
        kind: entry.kind,
        env: Vec::new(),
        preview_url: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// The saved commands of one project, in list order.
pub(crate) fn saved_commands(db: &Database, project: &str) -> Result<Vec<QuickLaunchCommand>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(&format!(
            "SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE project_id=? ORDER BY created_at,rowid"
        ))?;
        let commands = statement
            .query_map([project], command_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(commands)
    })
}

/// One saved command, scoped to the caller's project: an id from another project is
/// `run_not_found`, so a scope is never revealed by an error.
pub(crate) fn scoped_command(db: &Database, project: &str, id: &str) -> Result<QuickLaunchCommand> {
    db.transaction(|tx| {
        tx.query_row(
            &format!(
                "SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"
            ),
            params![id, project],
            command_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("run_not_found"))
    })
}

/// The stored display name of a run snapshot, without materialising the whole snapshot.
pub(crate) fn snapshot_name(raw: &str) -> serde_json::Result<String> {
    let (snapshot, _) = setup::decode_snapshot(raw)?;
    Ok(snapshot.name)
}

pub(crate) fn dispatch(
    db: &Arc<Database>,
    pty: &PtyManager,
    method: &str,
    value: &Value,
) -> Result<Value> {
    validate(method, value)?;
    if method.starts_with("quickLaunch.setup.") {
        return setup::dispatch_setup(db, pty, method, value);
    }
    if method.starts_with("quickLaunch.repo.") {
        let project = value
            .get("projectId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cwd = value.get("cwd").and_then(Value::as_str).unwrap_or_default();
        let root = setup::root_for_setup(db, project, cwd)?;
        if method == "quickLaunch.repo.list" {
            return crate::run_repo_config::list(db, project, &root);
        }
        return crate::run_repo_config::dispatch(db, project, &root, method, value);
    }
    match method {
        "quickLaunch.list" => {
            let p: List = serde_json::from_value(value.clone())?;
            db.transaction(|tx| {
                let mut stmt = tx.prepare(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE project_id=? ORDER BY created_at,rowid"))?;
                let commands = stmt.query_map([p.project_id], command_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
                commands.iter().map(|command| public_command_value(tx, command)).collect::<Result<Vec<_>>>().map(Value::Array)
            })
        }
        "quickLaunch.save" => save(db, serde_json::from_value(value.clone())?),
        "quickLaunch.delete" => delete(db, serde_json::from_value(value.clone())?),
        "quickLaunch.detect" => {
            let p: Detect = serde_json::from_value(value.clone())?;
            let root = setup::root_for_setup(db, &p.project_id, &p.cwd)?;
            let detection = crate::run_detect::detect(&root);
            Ok(json!({"entries":detection.entries,"truncated":detection.truncated}))
        }
        "quickLaunch.run" => {
            let p: Run = serde_json::from_value(value.clone())?;
            let _guard = ADMISSION
                .lock()
                .map_err(|_| anyhow!("quick launch admission poisoned"))?;
            if let Some(result) = db.operation(&p.operation_id)? {
                return Ok(result);
            }
            let snapshot = match (&p.command_id, &p.detected_key, &p.repo_id) {
                (Some(id), None, None) => read_command(db, id)?,
                (None, Some(key), None) => {
                    detected_snapshot(
                    db,
                    p.project_id.as_deref().unwrap_or_default(),
                    &p.cwd,
                    key)?
                }
                (None, None, Some(id)) => {
                    let project = p.project_id.as_deref().unwrap_or_default();
                    let root = setup::root_for_setup(db, project, &p.cwd)?;
                    crate::run_repo_config::snapshot(db, project, &root, id)?
                }
                _ => return Err(anyhow!("invalid_request")),
            };
            start(
                db,
                pty,
                &snapshot,
                &p.cwd,
                &p.operation_id,
                "quickLaunch.run",
                None,
                None,
                None,
            )
        }
        "quickLaunch.restart" => restart(db, pty, serde_json::from_value(value.clone())?),
        _ => Err(anyhow!("unknown_method")),
    }
}
fn save(db: &Database, p: Save) -> Result<Value> {
    let repo_root = p
        .repo_source
        .as_ref()
        .map(|source| setup::root_for_setup(db, &p.project_id, &source.cwd))
        .transpose()?;
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id)? { return Ok(result); }
        let previous = p.id.as_ref().map(|id| tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"), params![id,p.project_id], command_row).optional()).transpose()?.flatten();
        if p.id.is_some() && previous.is_none() { return Err(anyhow!("command_not_found")); }
        if previous.as_ref().is_some_and(|command| Some(command.revision) != p.expected_revision) { return Err(anyhow!("revision_conflict")); }
        if previous.as_ref().is_some_and(|command| command.revision >= MAX_SAFE_INTEGER) { return Err(anyhow!("invalid_request")); }
        if previous.is_none() {
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM quick_launch_commands WHERE project_id=?", [&p.project_id], |r| r.get(0))?;
            if count >= 100 { return Err(anyhow!("too_many_commands")); }
        }
        let id = p.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let source = match (&p.repo_source, &repo_root) {
            (Some(source), Some(root)) => crate::run_repo_config::repo_move_source(
                tx,
                &p.project_id,
                root,
                &source.id,
                &source.fingerprint,
            )?,
            (None, None) => std::collections::HashMap::new(),
            _ => return Err(anyhow!("invalid_request")),
        };
        let env = crate::run_repo_config::replace_secret_env(
            tx,
            &p.project_id,
            &id,
            &p.env,
            &source,
        )?;
        let now = Utc::now().to_rfc3339();
        let command = QuickLaunchCommand { id, project_id:p.project_id,
            revision:previous.as_ref().map_or(1, |c| c.revision + 1), name:trim_wire(&p.name).to_owned(), command:p.command,
            shell:p.shell, cwd:p.cwd, kind:p.kind, env, preview_url:p.preview_url,
            created_at:previous.map_or_else(|| now.clone(), |c| c.created_at), updated_at:now };
        tx.execute("INSERT INTO quick_launch_commands(id,project_id,revision,name,command,shell,cwd,kind,env_json,preview_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,command=excluded.command,shell=excluded.shell,cwd=excluded.cwd,kind=excluded.kind,env_json=excluded.env_json,preview_url=excluded.preview_url,updated_at=excluded.updated_at",
            params![command.id,command.project_id,command.revision,command.name,command.command,command.shell,command.cwd,command.kind,serde_json::to_string(&command.env)?,command.preview_url,command.created_at,command.updated_at])?;
        let result = public_command_value(tx, &command)?;
        complete(tx, &p.operation_id, "quickLaunch.save", &result)?;
        changed(tx, "quickLaunch.commands", None)?;
        Ok(result)
    })
}
fn delete(db: &Database, p: Delete) -> Result<Value> {
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id)? {
            return Ok(result);
        }
        let found: i64 = tx
            .query_row(
                "SELECT revision FROM quick_launch_commands WHERE id=?",
                [&p.id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("command_not_found"))?;
        if found != p.expected_revision {
            return Err(anyhow!("revision_conflict"));
        }
        setup::remove_command(tx, &p.id)?;
        tx.execute("DELETE FROM quick_launch_commands WHERE id=?", [&p.id])?;
        complete(tx, &p.operation_id, "quickLaunch.delete", &Value::Null)?;
        changed(tx, "quickLaunch.commands", None)?;
        Ok(Value::Null)
    })
}

fn launch_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root.canonicalize().map_err(|_| anyhow!("cwd_missing"))?;
    if !relative_cwd(relative) || Path::new(relative).is_absolute() {
        return Err(anyhow!("cwd_outside_root"));
    }
    let candidate = root
        .join(relative)
        .canonicalize()
        .map_err(|_| anyhow!("cwd_missing"))?;
    if !candidate.is_dir() {
        return Err(anyhow!("cwd_missing"));
    }
    // Both paths came from filesystem handles: use their final component
    // identity, without Unicode case transforms or namespace rewrites.
    if !candidate.starts_with(&root) {
        return Err(anyhow!("cwd_outside_root"));
    }
    Ok(candidate)
}
fn powershell_script(command: &str) -> String {
    let script = format!("$global:LASTEXITCODE = 0\n{command}\n$ok = $?\nif ($global:LASTEXITCODE) {{ exit $global:LASTEXITCODE }}\nif (-not $ok) {{ exit 1 }}");
    base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}
fn shell_command(shell: &str, command: &str) -> Result<(String, Vec<String>)> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let (program, args) = match shell {
        "cmd" => (
            root.join("System32").join("cmd.exe"),
            vec!["/D".into(), "/S".into(), "/C".into(), command.into()],
        ),
        "powershell" => (
            root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"),
            vec![
                "-NoLogo".into(),
                "-EncodedCommand".into(),
                powershell_script(command),
            ],
        ),
        "pwsh" => {
            let vars =
                crate::environment::for_terminal().unwrap_or_else(|| std::env::vars_os().collect());
            let found = vars
                .iter()
                .find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("PATH"))
                .and_then(|(_, path)| {
                    std::env::split_paths(path)
                        .map(|dir| dir.join("pwsh.exe"))
                        .find(|path| path.is_file())
                });
            let fallback = std::env::var_os("ProgramFiles")
                .map(|dir| {
                PathBuf::from(dir).join("PowerShell").join("7").join("pwsh.exe")
            });
            let program = found
                .or_else(|| fallback.filter(|path| path.is_file()))
                .ok_or_else(|| anyhow!("shell_unavailable"))?;
            (
                program,
                vec![
                    "-NoLogo".into(),
                    "-EncodedCommand".into(),
                    powershell_script(command),
                ],
            )
        }
        _ => return Err(anyhow!("shell_unavailable")),
    };
    if !program.is_file() {
        return Err(anyhow!("shell_unavailable"));
    }
    Ok((program.to_string_lossy().into_owned(), args))
}

fn start(
    db: &Arc<Database>,
    pty: &PtyManager,
    snapshot: &QuickLaunchCommand,
    cwd: &str,
    operation: &str,
    method: &str,
    source: Option<&str>,
    setup: Option<&setup::SetupStep>,
    started_by: Option<&str>,
) -> Result<Value> {
    ensure_secret_references(db, snapshot)?;
    let root = setup::root_for_setup(db, &snapshot.project_id, cwd)?;
    let directory = launch_directory(&root, &snapshot.cwd)?;
    // Persist the canonical operational path, including Windows' verbatim
    // prefix and Unicode spelling, so reruns reopen exactly this worktree.
    let root_key = root.to_string_lossy().into_owned();
    let active = db.transaction(|tx| {
        Ok(tx.query_row("SELECT q.session_id FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id LEFT JOIN session_organization o ON o.session_id=s.id WHERE q.command_id=? AND q.root=? AND s.status IN ('starting','running','idle','waiting') AND COALESCE(json_extract(o.data,'$.archived'),0)=0 LIMIT 1", params![snapshot.id,root_key], |r| r.get::<_,String>(0)).optional()?)
    })?;
    if let Some(id) = active {
        if let Some(step) = setup {
            db.transaction(|tx| setup::attach_session(tx, step, &id))?;
        }
        let session = db
            .session_by_id(&id)?
            .ok_or_else(|| anyhow!("session_not_found"))?;
        let result = if method == "session.rerun" {
            serde_json::to_value(session)?
        } else {
            json!({"session":session,"existing":true})
        };
        db.transaction(|tx| complete(tx, operation, method, &result))?;
        return Ok(result);
    }
    let (program, args) = shell_command(&snapshot.shell, &snapshot.command)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let launch = LaunchSpec {
        provider: "custom".into(),
        mode: "terminal".into(),
        cwd: directory.to_string_lossy().into_owned(),
        project_id: Some(snapshot.project_id.clone()),
        title: Some(snapshot.name.clone()),
        executable: Some(program.clone()),
        args: args.clone(),
    };
    // Only a service run is watched for a listening port, and only where the
    // platform can name the ports of a process tree; elsewhere the printed URL is
    // the one readiness signal (recorded as `none` until then).
    let watched = snapshot.kind == "service" && readiness::supported();
    let initial_readiness = if snapshot.kind == "service" {
        Some(if watched { "waiting" } else { "none" })
    } else {
        None
    };
    // Reserve durable session, association and LaunchSpec together. Never hold the
    // SQLite connection during ConPTY/bootstrap or shell execution.
    db.transaction(|tx| {
        tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed) VALUES(?,?,?,?,'custom','terminal','starting',?,?,0)", params![id,snapshot.project_id,root.to_string_lossy(),snapshot.name,now,now])?;
        tx.execute("INSERT INTO session_activity(session_id,state,revision) VALUES(?,'unknown',1)", [&id])?;
        tx.execute("INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES(?,1,'custom','terminal',?,?,?,?,?,?)", params![id,launch.cwd,launch.project_id,launch.title,launch.executable,serde_json::to_string(&args)?,source])?;
        tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at,readiness,started_by) VALUES(?,?,?,?,?,?,?,0,?,?,?)", params![id,snapshot.id,snapshot.project_id,root_key,serde_json::to_string(snapshot)?,snapshot.preview_url,snapshot.preview_url.as_ref().map(|_| "configured"),now,initial_readiness,started_by])?;
        if let Some(step) = setup { setup::attach_session(tx, step, &id)?; }
        changed(tx, "session.run", Some(&id))?;
        // Reserve replay before the external side effect. A runtime crash leaves
        // this exact interrupted run, never a second implicitly started process.
        let session = session_value(tx, &id)?;
        let result = if method == "session.rerun" { session } else { json!({"session":session,"existing":false}) };
        complete(tx, operation, method, &result)
    })?;
    if let Err(error) = pty.launch(Arc::clone(db), &id, &launch.cwd, Some(&program), &args) {
        eprintln!("Quick Launch terminal {id} could not start: {error}");
        db.set_session_status(&id, "error", None)?;
        let session = db
            .session_by_id(&id)?
            .ok_or_else(|| anyhow!("session_not_found"))?;
        let result = if method == "session.rerun" {
            serde_json::to_value(session)?
        } else {
            json!({"session":session,"existing":false})
        };
        db.transaction(|tx| {
            tx.execute(
                "UPDATE operations SET result=? WHERE id=?",
                params![result.to_string(), operation],
            )?;
            tx.execute(
                "UPDATE quick_launch_runs SET readiness='none' WHERE session_id=? AND readiness='waiting'",
                [&id],
            )?;
            Ok(())
        })?;
        // This operation already owns a durable terminal. Return its failed
        // state, just as a replay does, rather than reporting a different first
        // outcome and leaving the user without a terminal to inspect.
        return Ok(result);
    }
    let session = db
        .session_by_id(&id)?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    let result = if method == "session.rerun" {
        serde_json::to_value(session)?
    } else {
        json!({"session":session,"existing":false})
    };
    db.transaction(|tx| {
        tx.execute(
            "UPDATE operations SET result=? WHERE id=?",
            params![result.to_string(), operation],
        )?;
        changed(tx, "session.run", Some(&id))?;
        Ok(())
    })?;
    // After the PTY exists, so the first poll already sees the run's process tree.
    if watched {
        readiness::spawn(db, pty, &id);
    }
    Ok(result)
}

fn ensure_secret_references(db: &Database, snapshot: &QuickLaunchCommand) -> Result<()> {
    db.transaction(|tx| {
        for item in &snapshot.env {
            if crate::run_repo_config::is_secret_reference(&item.value)
                && crate::run_repo_config::resolve_secret(
                    tx,
                    &snapshot.project_id,
                    &snapshot.id,
                    &item.name,
                )?
                .is_none()
            {
                return Err(anyhow!("secret_missing: {}", item.name));
            }
        }
        Ok(())
    })
}
// Only needed inside the admission transaction; use the canonical projection
// without taking Database's connection mutex recursively.
fn session_value(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let (root, title, created, project): (String, String, String, String) = tx.query_row(
        "SELECT worktree_path,title,created_at,project_id FROM sessions WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let run = tx.query_row("SELECT snapshot_json,url,url_source,stop_requested,readiness,ready_port,started_by FROM quick_launch_runs WHERE session_id=?", [id], |r| run_from_row(r,0))?;
    Ok(
        json!({"id":id,"projectId":project,"worktreePath":root,"title":title,"provider":"custom","mode":"terminal","status":"starting","createdAt":created,"updatedAt":created,"followed":false,"archived":false,"pinned":false,"bookmarked":false,"sortOrder":0,"organizationRevision":0,"activity":{"state":"unknown","revision":1},"run":run}),
    )
}

pub(crate) fn rerun(db: &Arc<Database>, pty: &PtyManager, value: &Value) -> Result<Option<Value>> {
    let p: Rerun = serde_json::from_value(value.clone())?;
    let source = db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT snapshot_json,root FROM quick_launch_runs WHERE session_id=?",
                [&p.session_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?)
    })?;
    let Some((raw, root)) = source else {
        return Ok(None);
    };
    required(&p.operation_id)?;
    let _guard = ADMISSION
        .lock()
        .map_err(|_| anyhow!("quick launch admission poisoned"))?;
    if let Some(result) = db.operation(&p.operation_id)? {
        return Ok(Some(result));
    }
    let source = db
        .session_by_id(&p.session_id)?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    if matches!(
        source.status.as_str(),
        "starting" | "running" | "idle" | "waiting"
    ) {
        return Err(anyhow!("End the current session before rerunning it"));
    }
    let (snapshot, _) = setup::decode_snapshot(&raw)?;
    Ok(Some(start(
        db,
        pty,
        &snapshot,
        &root,
        &p.operation_id,
        "session.rerun",
        Some(&p.session_id),
        None,
        None,
    )?))
}
pub(crate) fn request_stop(db: &Database, id: &str) -> Result<()> {
    // A stop racing the reserved starting row waits for its launch to finish,
    // then targets that session's PTY. There is no window for a late launch.
    let _guard = ADMISSION
        .lock()
        .map_err(|_| anyhow!("quick launch admission poisoned"))?;
    db.transaction(|tx| {
        let changed_rows = tx.execute("UPDATE quick_launch_runs SET stop_requested=1 WHERE session_id=? AND stop_requested=0 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND status IN ('starting','running','idle','waiting'))", params![id,id])?;
        if changed_rows != 0 { changed(tx, "session.run", Some(id))?; }
        Ok(())
    })
}

/// A restart waits this long for the stopped run to leave its active status before
/// giving up; on timeout nothing has been relaunched and the original run is untouched.
const RESTART_STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// Status polling between the stop and the relaunch; the stop itself is synchronous on
/// Windows, so this only covers a run whose exit is still being finalized.
const RESTART_POLL: Duration = Duration::from_millis(20);

fn restart(db: &Arc<Database>, pty: &PtyManager, p: Restart) -> Result<Value> {
    restart_entry(db, pty, &p.session_id, &p.operation_id, None, "quickLaunch.restart", None,
    )
}

/// Stop, wait for the exit, then launch the same entry again for the same root. The
/// admission lock is released while waiting, so another run or stop is never queued
/// behind the wait; it is re-taken for the relaunch, which also re-checks the receipt.
///
/// `approved` carries a snapshot whose text the user already approved (a detected entry
/// started by an agent); it is relaunched verbatim instead of being resolved again.
/// `started_by` is the Chat session of the agent that asked, and is stored on the new run.
pub(crate) fn restart_entry(
    db: &Arc<Database>,
    pty: &PtyManager,
    session_id: &str,
    operation_id: &str,
    approved: Option<&QuickLaunchCommand>,
    method: &str,
    started_by: Option<&str>,
) -> Result<Value> {
    restart_using(
        db,
        pty,
        session_id,
        operation_id,
        approved,
        method,
        started_by,
        RESTART_STOP_TIMEOUT,
    )
}

fn restart_using(
    db: &Arc<Database>,
    pty: &PtyManager,
    session_id: &str,
    operation_id: &str,
    approved: Option<&QuickLaunchCommand>,
    method: &str,
    started_by: Option<&str>,
    stop_timeout: Duration,
) -> Result<Value> {
    // Read the run before stopping: an unknown session and a replayed operation must
    // not touch the run that is still active.
    let (raw, root, project) = db
        .transaction(|tx| {
            Ok(tx
                .query_row(
                    "SELECT snapshot_json,root,project_id FROM quick_launch_runs WHERE session_id=?",
                    [session_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?)
        })?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    {
        let _guard = ADMISSION
            .lock()
            .map_err(|_| anyhow!("quick launch admission poisoned"))?;
        if let Some(result) = replayed_operation(db, operation_id, method)? {
            return Ok(result);
        }
    }
    request_stop(db, session_id)?;
    match pty.stop(db, session_id, true) {
        Ok(()) => {}
        // Its reader may already be finalizing an exit; the bounded wait decides.
        Err(error) if error.to_string() == "session has no live PTY" => {}
        Err(error) => return Err(error),
    }
    if !wait_for_exit(db, session_id, stop_timeout)? {
        return Err(anyhow!("restart_stop_timeout"));
    }
    let _guard = ADMISSION
        .lock()
        .map_err(|_| anyhow!("quick launch admission poisoned"))?;
    if let Some(result) = replayed_operation(db, operation_id, method)? {
        return Ok(result);
    }
    let (snapshot, _) = setup::decode_snapshot(&raw)?;
    // Saved and repo entries relaunch from current storage; a detected one is re-detected,
    // so an entry whose source disappeared fails instead of running a stale command.
    let snapshot = match approved {
        Some(approved) => approved.clone(),
        None => {
            if let Some(key) = snapshot.id.strip_prefix("detected:") {
                detected_snapshot(db, &project, &root, key)?
            } else if let Some(id) = snapshot.id.strip_prefix("repo:") {
                let root_path = setup::root_for_setup(db, &project, &root)?;
                crate::run_repo_config::snapshot(db, &project, &root_path, id)?
            } else {
                read_command(db, &snapshot.id)?
            }
        }
    };
    start(
        db,
        pty,
        &snapshot,
        &root,
        operation_id,
        method,
        None,
        None,
        started_by,
    )
}

/// The caller-scoped launch behind `chat.tool.run.start`: the same admission, one active
/// instance per entry and root, and the same operation receipt and replay as
/// `quickLaunch.run`, but attributed to the Chat session that asked.
pub(crate) fn start_entry(
    db: &Arc<Database>,
    pty: &PtyManager,
    snapshot: &QuickLaunchCommand,
    root: &str,
    operation_id: &str,
    started_by: &str,
) -> Result<Value> {
    let _guard = ADMISSION
        .lock()
        .map_err(|_| anyhow!("quick launch admission poisoned"))?;
    // Only a receipt this tool recorded is a replay: an operation id that belongs to
    // another method never answers a run start.
    if let Some(result) = replayed_operation(db, operation_id, "chat.tool.run.start")? {
        return Ok(result);
    }
    start(
        db,
        pty,
        snapshot,
        root,
        operation_id,
        "chat.tool.run.start",
        None,
        None,
        Some(started_by),
    )
}

/// True once the session left its active status, false at the deadline.
fn wait_for_exit(db: &Database, id: &str, timeout: Duration) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let status: Option<String> = db.transaction(|tx| {
            Ok(tx
                .query_row("SELECT status FROM sessions WHERE id=?", [id], |r| r.get(0))
                .optional()?)
        })?;
        match status.as_deref() {
            Some("starting" | "running" | "idle" | "waiting") => {}
            _ => return Ok(true),
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(RESTART_POLL);
    }
}

/// User-stopped runs and successful setup steps end quietly: neither needs an Inbox item.
pub(crate) fn quiet_exit_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    exit_code: Option<i32>,
) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT stop_requested, json_type(snapshot_json,'$.setup') IS NOT NULL FROM quick_launch_runs WHERE session_id=?",
            [session_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)),
        )
        .optional()?
        .is_some_and(|(stop_requested, setup)| {
            stop_requested != 0 || (setup && matches!(exit_code, Some(0) | None))
        }))
}

fn expand(value: &str, inherited: &[(String, String)]) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest[1..].find('%').map(|i| i + 1) else {
            result.push_str(rest);
            return result;
        };
        let name = &rest[1..end];
        match inherited
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
        {
            Some((_, value)) => result.push_str(value),
            None => result.push_str(&rest[..=end]),
        }
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}
pub(crate) fn apply_environment(
    db: &Database,
    id: &str,
    command: &mut CommandBuilder,
) -> Result<()> {
    let raw: String = db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT snapshot_json FROM quick_launch_runs WHERE session_id=?",
            [id],
            |r| r.get(0),
        )?)
    })?;
    let (snapshot, _) = setup::decode_snapshot(&raw)?;
    // Snapshot once: every override expands against the composed inherited
    // environment, rather than against overrides ordered earlier in the form.
    let inherited: Vec<_> = command
        .iter_full_env_as_str()
        .filter(|(name, _)| {
            #[cfg(windows)]
            {
                !crate::bootstrap::is_control_environment_name(name)
            }
            #[cfg(not(windows))]
            {
                let _ = name;
                true
            }
        })
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    let overrides: Vec<_> = db.transaction(|tx| {
        snapshot
        .env
        .iter()
        .map(|item| {
                let value = if crate::run_repo_config::is_secret_reference(&item.value) {
                    crate::run_repo_config::resolve_secret(
                        tx,
                        &snapshot.project_id,
                        &snapshot.id,
                        &item.name,
                    )?
                    .ok_or_else(|| anyhow!("secret_missing: {}", item.name))?
                } else {
                    item.value.clone()
                };
                Ok((item.name.clone(), expand(&value, &inherited)))
            })
            .collect::<Result<Vec<_>>>()
    })?;
    #[cfg(windows)]
    crate::bootstrap::application_environment(command, &overrides)?;
    #[cfg(not(windows))]
    for (name, value) in overrides {
        for (key, _) in &inherited {
            if key.eq_ignore_ascii_case(&name) {
                command.env_remove(key);
            }
        }
        command.env(name, value);
    }
    Ok(())
}

const SCAN_LIMIT: usize = 1024 * 1024;
#[derive(Default)]
pub(crate) enum Escape {
    #[default]
    Text,
    Esc,
    Csi,
    Osc,
    OscEsc,
}
impl Escape {
    /// Advances one byte of terminal output. True means the byte is literal text;
    /// a control sequence consumes its bytes instead. Shared by the URL observer
    /// and the run-log reader so both strip the same sequences.
    pub(crate) fn advance(&mut self, byte: u8) -> bool {
        match *self {
            Escape::Text if byte == 0x1b => {
                *self = Escape::Esc;
                false
            }
            Escape::Text => true,
            Escape::Esc => {
                *self = match byte {
                    b'[' => Escape::Csi,
                    b']' => Escape::Osc,
                    0x20..=0x2f => Escape::Esc,
                    _ => Escape::Text,
                };
                false
            }
            Escape::Csi if (0x40..=0x7e).contains(&byte) => {
                *self = Escape::Text;
                false
            }
            Escape::Osc if byte == 7 => {
                *self = Escape::Text;
                false
            }
            Escape::Osc if byte == 0x1b => {
                *self = Escape::OscEsc;
                false
            }
            Escape::OscEsc => {
                *self = if byte == b'\\' {
                    Escape::Text
                } else {
                    Escape::Osc
                };
                false
            }
            _ => false,
        }
    }
}
/// Constructed only for run sessions, on their existing PTY reader. No timer,
/// polling worker, or output processing exists for ordinary sessions.
#[derive(Default)]
pub(crate) struct OutputObserver {
    scanned: usize,
    done: bool,
    escape: Escape,
    pending: Vec<u8>,
    tail: String,
}
impl OutputObserver {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        if self.done {
            return None;
        }
        let count = bytes.len().min(SCAN_LIMIT - self.scanned);
        self.scanned += count;
        for &byte in &bytes[..count] {
            if self.escape.advance(byte) {
                self.pending.push(byte);
            }
        }
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => e.valid_up_to(),
        };
        self.tail
            .push_str(&String::from_utf8_lossy(&self.pending[..valid]));
        self.pending.drain(..valid);
        // Invalid standalone bytes must not pin decoding forever.
        if std::str::from_utf8(&self.pending).is_err_and(|e| e.error_len().is_some()) {
            self.tail.push_str(&String::from_utf8_lossy(&self.pending));
            self.pending.clear();
        }
        // The byte budget is not EOF: do not mistake a cut-off token/port for
        // a complete URL at the cap.
        let result = detect_url(&self.tail, false);
        if result.is_some() || self.scanned == SCAN_LIMIT {
            self.done = true;
            self.tail.clear();
            self.pending.clear();
        } else {
            self.keep_tail();
        }
        result
    }
    fn keep_tail(&mut self) {
        if let Some((at, _)) = self.tail.char_indices().rev().nth(511) {
            if at > 0 {
                self.tail.drain(..at);
            }
        }
    }
    pub(crate) fn finish(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        self.done = true;
        detect_url(&self.tail, true)
    }
    pub(crate) fn is_done(&self) -> bool {
        self.done
    }
}
fn detect_url(text: &str, final_chunk: bool) -> Option<String> {
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    static SERVER: OnceLock<regex::Regex> = OnceLock::new();
    let urls = URL.get_or_init(|| regex::Regex::new(r#"(?i)https?://[^\s\x00-\x1f<>]+"#).unwrap());
    let servers = SERVER.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:Tomcat|Jetty|Netty|Undertow)\s+started on port(?:s|\(s\))?:?\s+(\d{1,5})",
        )
        .unwrap()
    });
    let url_match = urls.find_iter(text).find_map(|m| {
        if m.end() == text.len() && !final_chunk {
            return None;
        }
        let candidate = m
            .as_str()
            .trim_end_matches(['.', ',', ';', ':', ')', ']', '\'', '"']);
        let mut url = reqwest::Url::parse(candidate).ok()?;
        // Url::port omits default ports, so inspect the explicit authority too.
        let authority = candidate
            .split_once("://")?
            .1
            .split(['/', '?', '#'])
            .next()?;
        if authority.contains('@') {
            return None;
        }
        let (_, port) = authority.rsplit_once(':')?;
        let port: u16 = port.parse().ok()?;
        if port == 0 {
            return None;
        }
        let host = url.host_str()?;
        let allowed = host.eq_ignore_ascii_case("localhost")
            || matches!(host, "[::1]" | "[::]" | "::1" | "::" | "0.0.0.0")
            || host
                .parse::<std::net::Ipv4Addr>()
                .is_ok_and(|ip| ip.is_loopback());
        if !allowed {
            return None;
        }
        if matches!(host, "0.0.0.0" | "[::]" | "::") {
            url.set_host(Some("localhost")).ok()?;
        }
        Some((m.start(), url.to_string()))
    });
    let server_match = servers.captures_iter(text).find_map(|captures| {
        let m = captures.get(0)?;
        if m.end() == text.len() && !final_chunk {
            return None;
        }
        if text.as_bytes().get(m.end()).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        let port: u16 = captures[1].parse().ok()?;
        (port > 0).then(|| (m.start(), format!("http://localhost:{port}/")))
    });
    match (url_match, server_match) {
        (Some(url), Some(server)) => Some(if url.0 <= server.0 { url.1 } else { server.1 }),
        (Some(url), None) => Some(url.1),
        (None, Some(server)) => Some(server.1),
        _ => None,
    }
}
pub(crate) fn observe_output(db: &Database, id: &str, url: &str) -> Result<()> {
    db.transaction(|tx| {
        // A printed URL is readiness too: it ends the port watch, and on a platform
        // without port discovery it is the only readiness signal there is. A port that
        // stops being the address is cleared, so `port` and the link can never disagree.
        // Tasks have no readiness state to change, and a repeat is not an event.
        if tx.execute("UPDATE quick_launch_runs SET url=?,url_source='output',readiness=CASE WHEN readiness IS NULL THEN NULL ELSE 'ready' END,ready_port=CASE WHEN url_source='port' THEN NULL ELSE ready_port END WHERE session_id=? AND (url_source IS NULL OR url_source!='output' OR readiness IN ('waiting','none'))", params![url,id])? != 0 {
            changed(tx, "session.run", Some(id))?;
        }
        Ok(())
    })
}

/// Startup recovery: a `waiting` run whose session is no longer live can never become
/// ready, and is not watched again. Idempotent, so a live runtime can run it too.
pub fn reconcile_readiness(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        let waiting: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT session_id FROM quick_launch_runs q WHERE readiness='waiting' \
                 AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=q.session_id \
                 AND s.status IN ('starting','running','idle','waiting'))",
            )?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        for id in &waiting {
            tx.execute(
                "UPDATE quick_launch_runs SET readiness='none' WHERE session_id=?",
                [id],
            )?;
            changed(tx, "session.run", Some(id))?;
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "quick_launch_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "quick_launch_readiness_tests.rs"]
mod readiness_tests;

#[cfg(test)]
#[path = "quick_launch_setup_tests.rs"]
mod setup_tests;
