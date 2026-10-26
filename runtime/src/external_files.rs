//! Explicit local-user read grants. Registration never changes a session's authority.
use crate::{db::Database, workspace_services as workspace};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) const ERROR_CODES: &[&str] = &[
    "invalid_path",
    "invalid_request",
    "external_file_not_file",
    "external_file_not_found",
    "external_file_unknown",
    "external_file_unavailable",
    "file_too_large",
    "binary_file",
    "image_too_large",
    "unsupported_image",
    "file_reference_session_not_found",
    "file_reference_config_missing",
    "file_reference_project_missing",
    "file_reference_scope_mismatch",
    "file_reference_cwd_unavailable",
    "file_reference_relative_requires_absolute",
];

pub(crate) fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS external_files (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            source TEXT NOT NULL, opened_at TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS external_files_recent ON external_files(opened_at DESC);",
        )?;
        Ok(())
    })
}

pub(crate) fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "filesystem.external.open"
            | "filesystem.external.read"
            | "filesystem.external.image"
            | "filesystem.external.list"
            | "filesystem.external.forget"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let allowed: &[&str] = match method {
        "filesystem.external.open" => &["path", "source", "sessionId"],
        "filesystem.external.list" => &[],
        "filesystem.external.forget" => &["id", "operationId"],
        _ => &["id"],
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow!("invalid_request"));
    }
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("invalid_request"))
    };
    let value = match method {
        "filesystem.external.open" => {
            let source = string("source")?;
            if !matches!(source, "dialog" | "drop" | "link" | "recent") {
                return Err(anyhow!("invalid_request"));
            }
            let session = match object.get("sessionId") {
                None => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| anyhow!("invalid_request"))?,
                ),
            };
            open(db, string("path")?, source, session)?
        }
        "filesystem.external.read" => read(db, string("id")?, false)?,
        "filesystem.external.image" => read(db, string("id")?, true)?,
        "filesystem.external.list" => list(db)?,
        "filesystem.external.forget" => {
            let id = string("id")?;
            let operation_id = string("operationId")?;
            db.bind_operation(operation_id, method, params)?;
            db.transaction(|tx| {
                let prior: Option<String> = tx
                    .query_row(
                        "SELECT result FROM operations WHERE id=?",
                        [operation_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(prior) = prior {
                    return Ok(serde_json::from_str(&prior)?);
                }
                let removed = tx.execute("DELETE FROM external_files WHERE id=?", [id])?;
                if removed > 0 {
                    tx.execute(r#"INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{"kind":"externalFiles"}',?)"#,
                        [Utc::now().to_rfc3339()])?;
                }
                tx.execute(
                    "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,'null',?)",
                    params![operation_id, method, Utc::now().to_rfc3339()],
                )?;
                Ok(Value::Null)
            })?
        }
        _ => unreachable!(),
    };
    Ok(Some(value))
}

fn io_error(error: std::io::Error) -> anyhow::Error {
    anyhow!(if error.kind() == std::io::ErrorKind::NotFound {
        "external_file_not_found"
    } else {
        "external_file_unavailable"
    })
}

fn validate_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 16 * 1024 || path.chars().any(char::is_control) {
        return Err(anyhow!("invalid_path"));
    }
    let windows = path.replace('\\', "/");
    let plain = windows.strip_prefix("//?/").unwrap_or(&windows);
    let bytes = plain.as_bytes();
    let drive = bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':');
    if windows.starts_with("//./")
        || windows.starts_with("/??/")
        || (windows.starts_with("//?/") && !drive && !plain.starts_with("UNC/"))
        || plain
            .char_indices()
            .any(|(i, c)| c == ':' && !(drive && i == 1))
    {
        return Err(anyhow!("invalid_path"));
    }
    // Windows aliases can address devices without an explicit device namespace.
    #[cfg(windows)]
    for part in plain.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(anyhow!("invalid_path"));
        }
    }
    Ok(())
}

fn canonical_file(path: &Path) -> Result<(PathBuf, fs::Metadata)> {
    validate_path(path.to_str().ok_or_else(|| anyhow!("invalid_path"))?)?;
    if !path.is_absolute() {
        return Err(anyhow!("invalid_path"));
    }
    let canonical = path.canonicalize().map_err(io_error)?;
    validate_path(canonical.to_str().ok_or_else(|| anyhow!("invalid_path"))?)?;
    let metadata = fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(anyhow!("external_file_not_file"));
    }
    Ok((canonical, metadata))
}

fn display_path(path: &Path) -> Result<String> {
    let text = path.to_str().ok_or_else(|| anyhow!("invalid_path"))?;
    Ok(if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
    })
}

fn modified(metadata: &fs::Metadata) -> Result<String> {
    Ok(DateTime::<Utc>::from(metadata.modified().map_err(io_error)?).to_rfc3339())
}

fn file_value(
    id: &str,
    path: &str,
    name: &str,
    opened_at: &str,
    metadata: Option<&fs::Metadata>,
) -> Result<Value> {
    let image = Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp"
            )
        });
    Ok(
        json!({"id":id,"path":path,"name":name,"openedAt":opened_at,"image":image,
        "size":metadata.map_or(0, fs::Metadata::len),
        "modifiedAt":metadata.map(modified).transpose()?.unwrap_or_default()}),
    )
}

fn open(db: &Database, path: &str, source: &str, session_id: Option<&str>) -> Result<Value> {
    validate_path(path)?;
    let scope = session_id
        .map(|id| workspace::session_file_scope(db, id))
        .transpose()?;
    let requested = Path::new(path);
    let candidate = if let Some(scope) = &scope {
        scope.candidate(path).map_err(|e| {
            if e.to_string() == "file_reference_invalid_path" {
                anyhow!("invalid_path")
            } else {
                e
            }
        })?
    } else {
        if !requested.is_absolute() {
            return Err(anyhow!("invalid_path"));
        }
        requested.to_path_buf()
    };
    let (canonical, metadata) = canonical_file(&candidate)?;
    if let Some(scope) = scope {
        if workspace::path_is_within(&canonical, &scope.root)? {
            return Ok(json!({"inWorkspace":{"projectId":scope.project_id,
                "worktreePath":scope.root.to_str().ok_or_else(|| anyhow!("invalid_path"))?,
                "path":workspace::relative_path_string(&scope.root, &canonical)?}}));
        }
    }
    let path = canonical.to_str().ok_or_else(|| anyhow!("invalid_path"))?;
    let name = canonical
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| anyhow!("invalid_path"))?;
    let opened_at = Utc::now().to_rfc3339();
    let id = db.transaction(|tx| {
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO external_files(id,path,name,source,opened_at) VALUES(?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET name=excluded.name,source=excluded.source,opened_at=excluded.opened_at",
            params![id, path, name, source, opened_at])?;
        let id: String = tx.query_row("SELECT id FROM external_files WHERE path=?", [path], |row| row.get(0))?;
        tx.execute("DELETE FROM external_files WHERE id NOT IN
            (SELECT id FROM external_files ORDER BY opened_at DESC,rowid DESC LIMIT 200)", [])?;
        tx.execute(r#"INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{"kind":"externalFiles"}',?)"#,
            [&opened_at])?;
        Ok(id)
    })?;
    Ok(
        json!({"file":file_value(&id, &display_path(&canonical)?, name, &opened_at, Some(&metadata))?}),
    )
}

fn lookup(db: &Database, id: &str) -> Result<String> {
    db.transaction(|tx| {
        tx.query_row("SELECT path FROM external_files WHERE id=?", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| anyhow!("external_file_unknown"))
    })
}

fn read(db: &Database, id: &str, image: bool) -> Result<Value> {
    let path = lookup(db, id)?;
    let (canonical, _) = canonical_file(Path::new(&path))?;
    let file = fs::File::open(&canonical).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(anyhow!("external_file_not_file"));
    }
    let limit = if image {
        workspace::MAX_IMAGE_BYTES
    } else {
        workspace::MAX_DOCUMENT_BYTES as u64
    };
    let too_large = if image {
        "image_too_large"
    } else {
        "file_too_large"
    };
    if metadata.len() > limit {
        return Err(anyhow!(too_large));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Err(anyhow!(too_large));
    }
    if image {
        let mime = workspace::image_mime(&bytes).ok_or_else(|| anyhow!("unsupported_image"))?;
        return Ok(json!({"mime":mime,"data":BASE64.encode(bytes)}));
    }
    if bytes.contains(&0) {
        return Err(anyhow!("binary_file"));
    }
    let content = String::from_utf8(bytes).map_err(|_| anyhow!("binary_file"))?;
    Ok(
        json!({"path":display_path(&canonical)?,"fingerprint":workspace::fingerprint(content.as_bytes()),
        "content":content,"readonly":true,"size":metadata.len(),"modifiedAt":modified(&metadata)?}),
    )
}

fn list(db: &Database) -> Result<Value> {
    let rows = db.transaction(|tx| {
        let mut query = tx.prepare(
            "SELECT id,path,name,opened_at FROM external_files
            ORDER BY opened_at DESC,rowid DESC LIMIT 30",
        )?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let files = rows
        .into_iter()
        .map(|(id, path, name, opened)| {
            let metadata = fs::metadata(&path).ok().filter(fs::Metadata::is_file);
            let mut value = file_value(
                &id,
                &display_path(Path::new(&path))?,
                &name,
                &opened,
                metadata.as_ref(),
            )?;
            value["exists"] = json!(metadata.is_some());
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"files":files}))
}

#[cfg(test)]
#[path = "external_files_tests.rs"]
mod tests;
