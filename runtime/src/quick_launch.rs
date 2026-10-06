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
];

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
         stop_requested INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS quick_launch_admission ON quick_launch_runs(command_id,root);"
    )?;
    Ok(())
}

pub(crate) fn run_from_row(row: &Row<'_>, offset: usize) -> rusqlite::Result<Option<SessionRun>> {
    let Some(raw) = row.get::<_, Option<String>>(offset)? else {
        return Ok(None);
    };
    let snapshot: QuickLaunchCommand = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(offset, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Some(projection(
        &snapshot,
        row.get(offset + 1)?,
        row.get(offset + 2)?,
        row.get::<_, bool>(offset + 3)?,
    )))
}
fn projection(
    snapshot: &QuickLaunchCommand,
    url: Option<String>,
    url_source: Option<String>,
    stopped: bool,
) -> SessionRun {
    SessionRun {
        command_id: snapshot.id.clone(),
        name: snapshot.name.clone(),
        kind: snapshot.kind.clone(),
        shell: snapshot.shell.clone(),
        url,
        url_source,
        stop_requested: stopped.then_some(true),
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
    env: Vec<EnvVar>,
    preview_url: Option<String>,
    operation_id: String,
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
struct Run {
    command_id: String,
    cwd: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rerun {
    session_id: String,
    operation_id: String,
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "quickLaunch.list" | "quickLaunch.save" | "quickLaunch.delete" | "quickLaunch.run"
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
            required(&p.command_id)?;
            required(&p.cwd)?;
            required(&p.operation_id)?;
        }
        "quickLaunch.save" => {
            for key in ["id", "expectedRevision", "previewUrl"] {
                if value.get(key).is_some_and(Value::is_null) {
                    return Err(anyhow!("invalid_request"));
                }
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
                        || units(&item.value) > 8192
                        || item.value.contains('\0')
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

pub(crate) fn dispatch(
    db: &Arc<Database>,
    pty: &PtyManager,
    method: &str,
    value: &Value,
) -> Result<Value> {
    validate(method, value)?;
    match method {
        "quickLaunch.list" => {
            let p: List = serde_json::from_value(value.clone())?;
            db.transaction(|tx| {
                let mut stmt = tx.prepare(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE project_id=? ORDER BY created_at,rowid"))?;
                let commands = stmt.query_map([p.project_id], command_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(serde_json::to_value(commands)?)
            })
        }
        "quickLaunch.save" => save(db, serde_json::from_value(value.clone())?),
        "quickLaunch.delete" => delete(db, serde_json::from_value(value.clone())?),
        "quickLaunch.run" => {
            let p: Run = serde_json::from_value(value.clone())?;
            let _guard = ADMISSION
                .lock()
                .map_err(|_| anyhow!("quick launch admission poisoned"))?;
            if let Some(result) = db.operation(&p.operation_id)? {
                return Ok(result);
            }
            let snapshot = read_command(db, &p.command_id)?;
            start(
                db,
                pty,
                &snapshot,
                &p.cwd,
                &p.operation_id,
                "quickLaunch.run",
                None,
            )
        }
        _ => Err(anyhow!("unknown_method")),
    }
}
fn save(db: &Database, p: Save) -> Result<Value> {
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
        let now = Utc::now().to_rfc3339();
        let command = QuickLaunchCommand { id: p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), project_id:p.project_id,
            revision:previous.as_ref().map_or(1, |c| c.revision + 1), name:trim_wire(&p.name).to_owned(), command:p.command,
            shell:p.shell, cwd:p.cwd, kind:p.kind, env:p.env, preview_url:p.preview_url,
            created_at:previous.map_or_else(|| now.clone(), |c| c.created_at), updated_at:now };
        tx.execute("INSERT INTO quick_launch_commands(id,project_id,revision,name,command,shell,cwd,kind,env_json,preview_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,command=excluded.command,shell=excluded.shell,cwd=excluded.cwd,kind=excluded.kind,env_json=excluded.env_json,preview_url=excluded.preview_url,updated_at=excluded.updated_at",
            params![command.id,command.project_id,command.revision,command.name,command.command,command.shell,command.cwd,command.kind,serde_json::to_string(&command.env)?,command.preview_url,command.created_at,command.updated_at])?;
        let result = serde_json::to_value(command)?;
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
                .map(|dir| PathBuf::from(dir).join("PowerShell").join("7").join("pwsh.exe"));
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
) -> Result<Value> {
    if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
        return Err(anyhow!("cwd_missing"));
    }
    let root = crate::workspace_services::workspace_root_for_cwd(db, &snapshot.project_id, cwd)
        .map_err(|error| match error.to_string().as_str() {
            "invalid_cwd" => anyhow!("cwd_missing"),
            "cwd_not_in_registered_project" | "selected_project_mismatch" => {
                anyhow!("cwd_outside_root")
            }
            _ => error,
        })?;
    if Path::new(cwd)
        .canonicalize()
        .map_err(|_| anyhow!("cwd_missing"))?
        != root
    {
        return Err(anyhow!("cwd_outside_root"));
    }
    let directory = launch_directory(&root, &snapshot.cwd)?;
    // Persist the canonical operational path, including Windows' verbatim
    // prefix and Unicode spelling, so reruns reopen exactly this worktree.
    let root_key = root.to_string_lossy().into_owned();
    let active = db.transaction(|tx| {
        Ok(tx.query_row("SELECT q.session_id FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id LEFT JOIN session_organization o ON o.session_id=s.id WHERE q.command_id=? AND q.root=? AND s.status IN ('starting','running','idle','waiting') AND COALESCE(json_extract(o.data,'$.archived'),0)=0 LIMIT 1", params![snapshot.id,root_key], |r| r.get::<_,String>(0)).optional()?)
    })?;
    if let Some(id) = active {
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
    // Reserve durable session, association and LaunchSpec together. Never hold the
    // SQLite connection during ConPTY/bootstrap or shell execution.
    db.transaction(|tx| {
        tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed) VALUES(?,?,?,?,'custom','terminal','starting',?,?,0)", params![id,snapshot.project_id,root.to_string_lossy(),snapshot.name,now,now])?;
        tx.execute("INSERT INTO session_activity(session_id,state,revision) VALUES(?,'unknown',1)", [&id])?;
        tx.execute("INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES(?,1,'custom','terminal',?,?,?,?,?,?)", params![id,launch.cwd,launch.project_id,launch.title,launch.executable,serde_json::to_string(&args)?,source])?;
        tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at) VALUES(?,?,?,?,?,?,?,0,?)", params![id,snapshot.id,snapshot.project_id,root_key,serde_json::to_string(snapshot)?,snapshot.preview_url,snapshot.preview_url.as_ref().map(|_| "configured"),now])?;
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
    Ok(result)
}
// Only needed inside the admission transaction; use the canonical projection
// without taking Database's connection mutex recursively.
fn session_value(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let (root, title, created, project): (String, String, String, String) = tx.query_row(
        "SELECT worktree_path,title,created_at,project_id FROM sessions WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let run = tx.query_row("SELECT snapshot_json,url,url_source,stop_requested FROM quick_launch_runs WHERE session_id=?", [id], |r| run_from_row(r,0))?;
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
    let snapshot: QuickLaunchCommand = serde_json::from_str(&raw)?;
    Ok(Some(start(
        db,
        pty,
        &snapshot,
        &root,
        &p.operation_id,
        "session.rerun",
        Some(&p.session_id),
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

/// A run the user asked to stop ends quietly: its exit is not a "needs you" inbox item.
pub(crate) fn stop_requested_tx(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    Ok(tx
        .query_row("SELECT stop_requested FROM quick_launch_runs WHERE session_id=?", [session_id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some_and(|flag| flag != 0))
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
    let snapshot: QuickLaunchCommand = serde_json::from_str(&raw)?;
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
    let overrides: Vec<_> = snapshot
        .env
        .iter()
        .map(|item| (item.name.clone(), expand(&item.value, &inherited)))
        .collect();
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
enum Escape {
    #[default]
    Text,
    Esc,
    Csi,
    Osc,
    OscEsc,
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
            match self.escape {
                Escape::Text if byte == 0x1b => self.escape = Escape::Esc,
                Escape::Text => self.pending.push(byte),
                Escape::Esc => {
                    self.escape = match byte {
                        b'[' => Escape::Csi,
                        b']' => Escape::Osc,
                        0x20..=0x2f => Escape::Esc,
                        _ => Escape::Text,
                    }
                }
                Escape::Csi if (0x40..=0x7e).contains(&byte) => self.escape = Escape::Text,
                Escape::Osc if byte == 7 => self.escape = Escape::Text,
                Escape::Osc if byte == 0x1b => self.escape = Escape::OscEsc,
                Escape::OscEsc => {
                    self.escape = if byte == b'\\' {
                        Escape::Text
                    } else {
                        Escape::Osc
                    }
                }
                _ => {}
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
        if tx.execute("UPDATE quick_launch_runs SET url=?,url_source='output' WHERE session_id=? AND (url_source IS NULL OR url_source!='output')", params![url,id])? != 0 {
            changed(tx, "session.run", Some(id))?;
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "quick_launch_tests.rs"]
mod tests;
