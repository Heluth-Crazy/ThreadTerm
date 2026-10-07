use crate::{
    db::Database,
    workspace_services::root_for,
};
use anyhow::{anyhow, Result};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{fs, io::Read, path::{Path, PathBuf}};

const MAX_DOCUMENTS: i64 = 20;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TITLE_BYTES: u64 = 64 * 1024;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_documents (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, path TEXT NOT NULL, pinned_at TEXT NOT NULL, PRIMARY KEY(session_id,path)); CREATE INDEX IF NOT EXISTS session_documents_session ON session_documents(session_id,pinned_at,path);";

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| Ok(tx.execute_batch(SCHEMA)?))
}

pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(method, "session.documents.list" | "session.documents.pin" | "session.documents.unpin") {
        return Ok(None);
    }
    let object = params.as_object().ok_or_else(|| anyhow!("invalid_request"))?;
    let session_id = required(object, "sessionId")?;
    let result = match method {
        "session.documents.list" => list(db, session_id)?,
        "session.documents.pin" | "session.documents.unpin" => {
            let path = normalize_path(required(object, "path")?)?;
            let operation_id = required(object, "operationId")?;
            mutate(db, method, session_id, &path, operation_id)?
        }
        _ => unreachable!(),
    };
    Ok(Some(result))
}

fn required<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    object.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or_else(|| anyhow!("invalid_request"))
}

fn normalize_path(value: &str) -> Result<String> {
    if value.contains('\0') || value.starts_with('/') || value.starts_with('\\') || value.len() >= 2 && value.as_bytes()[1] == b':' {
        return Err(anyhow!("path_outside_root"));
    }
    let mut parts = Vec::new();
    for part in value.split(['/', '\\']) {
        match part {
            "" | "." => {},
            ".." => return Err(anyhow!("path_outside_root")),
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(anyhow!("path_outside_root"));
    }
    Ok(parts.join("/"))
}

fn scope(db: &Database, session_id: &str) -> Result<PathBuf> {
    db.transaction(|tx| {
        let row: Option<(Option<String>, Option<String>)> = tx.query_row(
            "SELECT project_id,worktree_path FROM sessions WHERE id=?", [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (project_id, worktree_path) = row.ok_or_else(|| anyhow!("session_not_found"))?;
        let project_id = project_id.ok_or_else(|| anyhow!("session_not_found"))?;
        root_for(tx, &project_id, worktree_path.as_deref())
    })
}

fn resolve(root: &Path, path: &str) -> Result<PathBuf> {
    let root = root.canonicalize().map_err(|_| anyhow!("path_outside_root"))?;
    let candidate = root.join(path);
    let canonical = candidate.canonicalize().map_err(|_| anyhow!("not_a_file"))?;
    if !canonical.starts_with(&root) {
        return Err(anyhow!("path_outside_root"));
    }
    let metadata = fs::metadata(&canonical).map_err(|_| anyhow!("not_a_file"))?;
    if !metadata.is_file() {
        return Err(anyhow!("not_a_file"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    Ok(canonical)
}

fn mutate(db: &Database, method: &str, session_id: &str, path: &str, operation_id: &str) -> Result<Value> {
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        if let Some(result) = operation(tx, operation_id)? {
            return Ok(result);
        }
        let root = session_root(tx, session_id)?;
        let changed = if method == "session.documents.pin" {
            let already_pinned: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_documents WHERE session_id=? AND path=?)", params![session_id, path], |row| row.get(0))?;
            if already_pinned {
                false
            } else {
                resolve(&root, path)?;
                let count: i64 = tx.query_row("SELECT COUNT(*) FROM session_documents WHERE session_id=?", [session_id], |row| row.get(0))?;
                if count >= MAX_DOCUMENTS {
                    return Err(anyhow!("too_many_documents"));
                }
                tx.execute("INSERT INTO session_documents(session_id,path,pinned_at) VALUES(?,?,?)", params![session_id, path, timestamp()])?;
                true
            }
        } else {
            tx.execute("DELETE FROM session_documents WHERE session_id=? AND path=?", params![session_id, path])? > 0
        };
        let result = list_tx(tx, session_id, Some(&root))?;
        tx.execute("INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)", params![operation_id, method, serde_json::to_string(&result)?, timestamp()])?;
        if changed {
            tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)", params![serde_json::to_string(&json!({"kind":"session.documents","sessionId":session_id}))?, timestamp()])?;
        }
        Ok(result)
    })
}

fn session_root(tx: &Transaction<'_>, session_id: &str) -> Result<PathBuf> {
    let row: Option<(Option<String>, Option<String>)> = tx.query_row(
        "SELECT project_id,worktree_path FROM sessions WHERE id=?", [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let (project_id, worktree_path) = row.ok_or_else(|| anyhow!("session_not_found"))?;
    let project_id = project_id.ok_or_else(|| anyhow!("session_not_found"))?;
    root_for(tx, &project_id, worktree_path.as_deref())
}

fn operation(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx.query_row("SELECT result FROM operations WHERE id=?", [id], |row| row.get(0)).optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

fn list(db: &Database, session_id: &str) -> Result<Value> {
    let root = scope(db, session_id)?;
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        list_tx(tx, session_id, Some(&root))
    })
}

fn list_tx(tx: &Transaction<'_>, session_id: &str, root: Option<&Path>) -> Result<Value> {
    let root = match root {
        Some(root) => root.to_path_buf(),
        None => session_root(tx, session_id)?,
    }.canonicalize().map_err(|_| anyhow!("path_outside_root"))?;
    let mut statement = tx.prepare("SELECT path,pinned_at FROM session_documents WHERE session_id=? ORDER BY pinned_at,path")?;
    let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let documents = rows.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().map(|(path, pinned_at)| document_json(&root, path, pinned_at)).collect::<Vec<_>>();
    Ok(json!(documents))
}

fn document_json(root: &Path, path: String, pinned_at: String) -> Value {
    let candidate = root.join(&path);
    let canonical = candidate.canonicalize();
    let missing = canonical.as_ref().ok().filter(|candidate| candidate.starts_with(root)).and_then(|candidate| fs::metadata(candidate).ok()).is_none_or(|metadata| !metadata.is_file());
    let mut value = json!({"path":path,"pinnedAt":pinned_at});
    if missing {
        value["missing"] = json!(true);
    } else if markdown(&path) {
        if let Some(title) = canonical.ok().and_then(|path| title(&path)) {
            value["title"] = json!(title);
        }
    }
    value
}

fn markdown(path: &str) -> bool {
    Path::new(path).extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"))
}

fn title(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    let truncated = fs::metadata(path).ok()?.len() > TITLE_BYTES;
    fs::File::open(path).ok()?.take(TITLE_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let complete = !truncated || bytes.last().is_some_and(|byte| matches!(byte, b'\n' | b'\r'));
    let mut front_matter = text.starts_with("---\n") || text.starts_with("---\r\n");
    let mut fenced = false;
    let lines = text.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        if index + 1 == lines.len() && !complete {
            break;
        }
        if front_matter {
            if line.trim() == "---" && index != 0 { front_matter = false; }
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced { continue; }
        let hashes = trimmed.chars().take_while(|character| *character == '#').count();
        if (1..=6).contains(&hashes) && trimmed.as_bytes().get(hashes).is_some_and(|byte| byte.is_ascii_whitespace()) {
            let heading = trimmed[hashes..].trim();
            if !heading.is_empty() {
                return Some(heading.chars().take(200).collect());
            }
        }
    }
    None
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
