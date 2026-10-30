//! Repository-backed Quick Launch entries, local secrets, and reviewed trust snapshots.
use crate::{
    db::Database,
    quick_launch::{EnvVar, QuickLaunchCommand, SaveEnv},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_ENTRIES: usize = 100;
const MAX_OPERATION_ID_UNITS: usize = 512;
const SECRET_REFERENCE: &str = "\0threadterm-local-secret";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    project_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveParams {
    project_id: String,
    cwd: String,
    entry: SaveEntry,
    expected_fingerprint: Option<String>,
    local_source: Option<LocalSource>,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSource {
    id: String,
    revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveEntry {
    id: Option<String>,
    name: String,
    command: String,
    shell: String,
    cwd: String,
    kind: String,
    env: Vec<SaveEnv>,
    preview_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteParams {
    project_id: String,
    cwd: String,
    id: String,
    expected_fingerprint: Option<String>,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustParams {
    project_id: String,
    cwd: String,
    id: String,
    fingerprint: String,
    operation_id: String,
}

struct RawConfig {
    bytes: Vec<u8>,
}

pub(crate) fn initialize_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS quick_launch_repo_secrets (
         project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         entry_id TEXT NOT NULL, env_name TEXT NOT NULL, value TEXT NOT NULL,
         PRIMARY KEY(project_id,entry_id,env_name));
         CREATE TABLE IF NOT EXISTS quick_launch_repo_trust (
         project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         entry_id TEXT NOT NULL, fingerprint TEXT NOT NULL, snapshot_json TEXT NOT NULL,
         PRIMARY KEY(project_id,entry_id));",
    )?;
    // Early phase-5 builds keyed repo overrides by the bare file id. Namespace
    // those rows so a local command id can never alias a repo entry.
    conn.execute_batch(
        "INSERT OR IGNORE INTO quick_launch_repo_secrets(project_id,entry_id,env_name,value)
         SELECT secret.project_id,'repo:'||secret.entry_id,secret.env_name,secret.value
         FROM quick_launch_repo_secrets secret
         WHERE secret.entry_id NOT LIKE 'repo:%' AND EXISTS(
           SELECT 1 FROM quick_launch_repo_trust trust
           WHERE trust.project_id=secret.project_id AND trust.entry_id=secret.entry_id);
         DELETE FROM quick_launch_repo_secrets
         WHERE entry_id NOT LIKE 'repo:%' AND EXISTS(
           SELECT 1 FROM quick_launch_repo_trust trust
           WHERE trust.project_id=quick_launch_repo_secrets.project_id
             AND trust.entry_id=quick_launch_repo_secrets.entry_id);",
    )?;
    let mut statement = conn.prepare(
        "SELECT id,result FROM operations WHERE method IN ('quickLaunch.repo.save','quickLaunch.repo.trust')",
    )?;
    let receipts = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (id, raw) in receipts {
        let mut result: Value = serde_json::from_str(&raw)?;
        if redact_legacy_secret_values(&mut result) {
            conn.execute(
                "UPDATE operations SET result=? WHERE id=?",
                params![result.to_string(), id],
            )?;
        }
    }
    let mut statement = conn.prepare(
        "SELECT id,method,params FROM operation_requests
         WHERE method IN ('quickLaunch.save','quickLaunch.repo.save')",
    )?;
    let requests = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (id, method, raw) in requests {
        let already_hashed = serde_json::from_str::<Value>(&raw).is_ok_and(|value| {
            value.as_object().is_some_and(|object| {
                object.len() == 1
                    && object
                        .get("requestSha256")
                        .and_then(Value::as_str)
                        .is_some_and(valid_fingerprint)
            })
        });
        if !already_hashed {
            let digest = hex::encode(Sha256::digest(format!("{method}\0{raw}").as_bytes()));
            conn.execute(
                "UPDATE operation_requests SET params=? WHERE id=?",
                params![json!({"requestSha256":digest}).to_string(), id],
            )?;
        }
    }
    let mut statement = conn.prepare(
        "SELECT session_id,project_id,command_id,snapshot_json FROM quick_launch_runs
         WHERE command_id LIKE 'repo:%'",
    )?;
    let runs = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (session, project, command, raw) in runs {
        let mut snapshot: Value = serde_json::from_str(&raw)?;
        let Some(env) = snapshot.get_mut("env").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut changed = false;
        for item in env {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM quick_launch_repo_secrets
                 WHERE project_id=? AND entry_id=? AND upper(env_name)=upper(?))",
                params![project, command, name],
                |row| row.get(0),
            )?;
            if exists && item.get("value").and_then(Value::as_str) != Some(SECRET_REFERENCE) {
                item["value"] = json!(SECRET_REFERENCE);
                changed = true;
            }
        }
        if changed {
            conn.execute(
                "UPDATE quick_launch_runs SET snapshot_json=? WHERE session_id=?",
                params![snapshot.to_string(), session],
            )?;
        }
    }
    Ok(())
}

fn redact_legacy_secret_values(value: &mut Value) -> bool {
    match value {
        Value::Array(values) => values.iter_mut().fold(false, |changed, nested| {
            redact_legacy_secret_values(nested) || changed
        }),
        Value::Object(object) => {
            let mut changed = false;
            if object.get("secret").and_then(Value::as_bool) == Some(true)
                && object.remove("value").is_some()
            {
                object.insert("hasValue".into(), Value::Bool(true));
                changed = true;
            }
            for nested in object.values_mut() {
                changed |= redact_legacy_secret_values(nested);
            }
            changed
        }
        _ => false,
    }
}

fn required(value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}

fn bounded_operation(value: &str) -> Result<()> {
    required(value)?;
    if value.encode_utf16().count() > MAX_OPERATION_ID_UNITS {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'_' | b'.' | b'-')
        })
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(crate) fn validate_repo_source(id: &str, fingerprint: &str) -> Result<()> {
    if !valid_id(id) || !valid_fingerprint(fingerprint) {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}

pub(crate) fn is_secret_reference(value: &str) -> bool {
    value == SECRET_REFERENCE
}

fn repo_secret_key(id: &str) -> String {
    format!("repo:{}", plain_entry_id(id))
}

fn trim_wire(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
        '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn validate_save_fields(entry: &SaveEntry) -> Result<()> {
    if let Some(id) = &entry.id {
        if !valid_id(id) {
            return Err(anyhow!("invalid_request"));
        }
    }
    let env = entry
        .env
        .iter()
        .map(|item| {
            if item.secret == Some(true) {
                let mut value = json!({"name":item.name,"secret":true});
                if let Some(secret) = &item.value {
                    value["value"] = json!(secret);
                }
                value
            } else {
                json!({"name":item.name,"value":item.value})
            }
        })
        .collect::<Vec<_>>();
    let mut value = json!({
        "projectId":"project", "name":entry.name, "command":entry.command,
        "shell":entry.shell, "cwd":entry.cwd, "kind":entry.kind, "env":env,
        "operationId":"operation"
    });
    if let Some(preview) = &entry.preview_url {
        value["previewUrl"] = json!(preview);
    }
    crate::quick_launch::validate("quickLaunch.save", &value)
}

pub(crate) fn validate(method: &str, value: &Value) -> Result<()> {
    match method {
        "quickLaunch.repo.list" => {
            let p: ListParams = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
        }
        "quickLaunch.repo.save" => {
            for key in ["expectedFingerprint", "localSource"] {
                if value.get(key).is_some_and(Value::is_null) {
                    return Err(anyhow!("invalid_request"));
                }
            }
            if value
                .get("entry")
                .is_some_and(|entry| entry.get("id").is_some_and(Value::is_null))
                || value
                    .get("entry")
                    .is_some_and(|entry| entry.get("previewUrl").is_some_and(Value::is_null))
                || value
                    .get("entry")
                    .and_then(|entry| entry.get("env"))
                    .and_then(Value::as_array)
                    .is_some_and(|env| {
                        env.iter()
                            .any(|item| {
                                item.get("secret").is_some_and(Value::is_null)
                                    || item.get("value").is_some_and(Value::is_null)
                            })
                    })
            {
                return Err(anyhow!("invalid_request"));
            }
            let p: SaveParams = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
            bounded_operation(&p.operation_id)?;
            if p.expected_fingerprint
                .as_ref()
                .is_some_and(|fingerprint| !valid_fingerprint(fingerprint))
            {
                return Err(anyhow!("invalid_request"));
            }
            validate_save_fields(&p.entry)?;
            if let Some(source) = &p.local_source {
                required(&source.id)?;
                if !(1..=9_007_199_254_740_991).contains(&source.revision) {
                    return Err(anyhow!("invalid_request"));
                }
            }
        }
        "quickLaunch.repo.delete" => {
            if value.get("expectedFingerprint").is_some_and(Value::is_null) {
                return Err(anyhow!("invalid_request"));
            }
            let p: DeleteParams = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
            bounded_operation(&p.operation_id)?;
            if !valid_id(&p.id)
                || p.expected_fingerprint
                    .as_ref()
                    .is_some_and(|fingerprint| !valid_fingerprint(fingerprint))
            {
                return Err(anyhow!("invalid_request"));
            }
        }
        "quickLaunch.repo.trust" => {
            let p: TrustParams = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
            bounded_operation(&p.operation_id)?;
            if !valid_id(&p.id) || !valid_fingerprint(&p.fingerprint) {
                return Err(anyhow!("invalid_request"));
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
fn config_path(root: &Path) -> PathBuf {
    root.join(".threadterm").join("run.json")
}

fn checked_read_path(root: &Path) -> Result<Option<PathBuf>> {
    let canonical_root = root.canonicalize().map_err(|_| invalid_config_path())?;
    let directory = root.join(".threadterm");
    let directory_metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(invalid_config_path());
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| invalid_config_path())?;
    if canonical_directory.parent() != Some(canonical_root.as_path())
        || !canonical_directory.starts_with(&canonical_root)
    {
        return Err(invalid_config_path());
    }
    let target = canonical_directory.join("run.json");
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_config_path());
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(anyhow!("file exceeds 256 KiB"));
    }
    let canonical_target = target.canonicalize().map_err(|_| invalid_config_path())?;
    if canonical_target.parent() != Some(canonical_directory.as_path())
        || !canonical_target.starts_with(&canonical_root)
    {
        return Err(invalid_config_path());
    }
    Ok(Some(canonical_target))
}

fn read_raw(root: &Path) -> Result<Option<RawConfig>> {
    let Some(path) = checked_read_path(root)? else {
        return Ok(None);
    };
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(anyhow!("file exceeds 256 KiB"));
    }
    Ok(Some(RawConfig { bytes }))
}

fn file_fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_document(document: &Value) -> Result<()> {
    let root = document
        .as_object()
        .ok_or_else(|| anyhow!("root is not an object"))?;
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(anyhow!("unsupported version"));
    }
    let entries = root
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("entries is not an array"))?;
    if entries.len() > MAX_ENTRIES {
        return Err(anyhow!("too many entries"));
    }
    let mut ids = HashSet::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| anyhow!("entry is not an object"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or_else(|| anyhow!("invalid entry id"))?;
        if !ids.insert(id.to_owned()) {
            return Err(anyhow!("duplicate entry id"));
        }
        let raw_env = object
            .get("env")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("env is not an array"))?;
        let mut env = Vec::with_capacity(raw_env.len());
        for item in raw_env {
            let item = item
                .as_object()
                .ok_or_else(|| anyhow!("env is not an object"))?;
            let secret = match item.get("secret") {
                Some(value) => value
                    .as_bool()
                    .ok_or_else(|| anyhow!("invalid secret marker"))?,
                None => false,
            };
            if secret && item.contains_key("value") {
                return Err(anyhow!("secret value in repo file"));
            }
            let value = if secret {
                ""
            } else {
                item.get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing env value"))?
            };
            env.push(json!({"name":item.get("name"),"value":value}));
        }
        let mut save = json!({
            "projectId":"project", "name":object.get("name"),
            "command":object.get("command"), "shell":object.get("shell"),
            "cwd":object.get("cwd"), "kind":object.get("kind"), "env":env,
            "operationId":"operation"
        });
        if let Some(preview) = object.get("previewUrl") {
            save["previewUrl"] = preview.clone();
        }
        crate::quick_launch::validate("quickLaunch.save", &save)?;
    }
    Ok(())
}

fn decode(raw: &RawConfig) -> Result<Value> {
    let document: Value = serde_json::from_slice(&raw.bytes)?;
    validate_document(&document)?;
    Ok(document)
}

fn read_document(root: &Path) -> Result<Option<(RawConfig, Value)>> {
    let Some(raw) = read_raw(root).map_err(|error| anyhow!("repo_config_invalid: {error}"))? else {
        return Ok(None);
    };
    let document = decode(&raw).map_err(|error| anyhow!("repo_config_invalid: {error}"))?;
    Ok(Some((raw, document)))
}

fn entries(document: &Value) -> Result<&Vec<Value>> {
    document
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("repo_config_invalid: entries is not an array"))
}

fn entry_id(entry: &Value) -> Result<&str> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("repo_config_invalid: invalid entry id"))
}

fn find_entry<'a>(document: &'a Value, id: &str) -> Result<&'a Value> {
    entries(document)?
        .iter()
        .find(|entry| entry_id(entry).is_ok_and(|entry_id| entry_id == id))
        .ok_or_else(|| anyhow!("repo_entry_not_found"))
}

fn canonical_launch(entry: &Value) -> Result<Value> {
    let object = entry
        .as_object()
        .ok_or_else(|| anyhow!("repo_config_invalid: entry is not an object"))?;
    let env = object
        .get("env")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("repo_config_invalid: env is not an array"))?
        .iter()
        .map(|item| {
            let item = item.as_object().ok_or_else(|| anyhow!("invalid env"))?;
            let name = item.get("name").cloned().unwrap_or(Value::Null);
            if item.get("secret").and_then(Value::as_bool) == Some(true) {
                Ok(json!({"name":name,"secret":true}))
            } else {
                Ok(json!({"name":name,"value":item.get("value").cloned().unwrap_or(Value::Null)}))
            }
        })
        .collect::<Result<Vec<_>>>()?;
    let mut launch = Map::new();
    for key in ["command", "shell", "cwd", "kind"] {
        launch.insert(key.into(), object.get(key).cloned().unwrap_or(Value::Null));
    }
    launch.insert("env".into(), Value::Array(env));
    if let Some(preview) = object.get("previewUrl") {
        launch.insert("previewUrl".into(), preview.clone());
    }
    Ok(Value::Object(launch))
}

fn launch_fingerprint(launch: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(launch)?)))
}

pub(crate) fn repo_move_source(
    tx: &Transaction<'_>,
    project: &str,
    root: &Path,
    id: &str,
    expected_fingerprint: &str,
) -> Result<HashMap<String, String>> {
    validate_repo_source(id, expected_fingerprint)?;
    let Some((raw, document)) = read_document(root)? else {
        return Err(anyhow!("repo_entry_not_found"));
    };
    if file_fingerprint(&raw.bytes) != expected_fingerprint {
        return Err(anyhow!("repo_config_conflict"));
    }
    let entry = find_entry(&document, id)?;
    canonical_launch(entry)?;
    secret_source(tx, project, &repo_secret_key(id))
}

fn secret_values(tx: &Transaction<'_>, project: &str, id: &str) -> Result<HashMap<String, String>> {
    let mut statement = tx.prepare(
        "SELECT env_name,value FROM quick_launch_repo_secrets WHERE project_id=? AND entry_id=?",
    )?;
    let values = statement
        .query_map(params![project, id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(values)
}

fn case_insensitive_values(values: HashMap<String, String>) -> HashMap<String, String> {
    values
        .into_iter()
        .map(|(name, value)| (name.to_ascii_uppercase(), value))
        .collect()
}

pub(crate) fn secret_source(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
) -> Result<HashMap<String, String>> {
    Ok(case_insensitive_values(secret_values(tx, project, id)?))
}

pub(crate) fn resolve_secret(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    name: &str,
) -> Result<Option<String>> {
    let mut values = secret_source(tx, project, id)?;
    Ok(values.remove(&name.to_ascii_uppercase()))
}

pub(crate) fn replace_secret_env(
    tx: &Transaction<'_>,
    project: &str,
    destination_id: &str,
    env: &[SaveEnv],
    source: &HashMap<String, String>,
) -> Result<Vec<EnvVar>> {
    let previous = secret_source(tx, project, destination_id)?;
    tx.execute(
        "DELETE FROM quick_launch_repo_secrets WHERE project_id=? AND entry_id=?",
        params![project, destination_id],
    )?;
    let mut stored = Vec::with_capacity(env.len());
    for item in env {
        if item.secret == Some(true) {
            let key = item.name.to_ascii_uppercase();
            let value = item
                .value
                .clone()
                .or_else(|| previous.get(&key).cloned())
                .or_else(|| source.get(&key).cloned());
            if let Some(value) = value {
                tx.execute(
                    "INSERT INTO quick_launch_repo_secrets(project_id,entry_id,env_name,value) VALUES(?,?,?,?)",
                    params![project,destination_id,item.name,value],
                )?;
            }
            stored.push(EnvVar {
                name: item.name.clone(),
                value: SECRET_REFERENCE.to_owned(),
            });
        } else {
            stored.push(EnvVar {
                name: item.name.clone(),
                value: item.value.clone().ok_or_else(|| anyhow!("invalid_request"))?,
            });
        }
    }
    Ok(stored)
}

pub(crate) fn public_env(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    env: &[EnvVar],
) -> Result<Vec<Value>> {
    let secrets = secret_source(tx, project, id)?;
    Ok(env
        .iter()
        .map(|item| {
            if is_secret_reference(&item.value) {
                json!({
                    "name":item.name,
                    "secret":true,
                    "hasValue":secrets.contains_key(&item.name.to_ascii_uppercase())
                })
            } else {
                json!({"name":item.name,"value":item.value})
            }
        })
        .collect())
}

fn accepted(tx: &Transaction<'_>, project: &str, id: &str) -> Result<Option<(String, Value)>> {
    tx.query_row(
        "SELECT fingerprint,snapshot_json FROM quick_launch_repo_trust WHERE project_id=? AND entry_id=?",
        params![project, id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()?
    .map(|(fingerprint, raw)| Ok((fingerprint, serde_json::from_str(&raw)?)))
    .transpose()
}

fn merged_env(
    entry: &Value,
    secrets: &HashMap<String, String>,
) -> Result<(Vec<EnvVar>, Vec<String>)> {
    let mut result = Vec::new();
    let mut missing = Vec::new();
    for item in entry
        .get("env")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("repo_config_invalid: env is not an array"))?
    {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid env name"))?
            .to_owned();
        let secret = item.get("secret").and_then(Value::as_bool) == Some(true);
        let value = if secret {
            SECRET_REFERENCE.to_owned()
        } else {
            item.get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("repo_config_invalid: missing env value"))?
                .to_owned()
        };
        if secret && !secrets.contains_key(&name.to_ascii_uppercase()) {
            missing.push(name.clone());
        }
        result.push(EnvVar { name, value });
    }
    Ok((result, missing))
}

fn entry_value(tx: &Transaction<'_>, project: &str, entry: &Value) -> Result<Value> {
    let id = entry_id(entry)?;
    let secret_key = repo_secret_key(id);
    let secrets = secret_source(tx, project, &secret_key)?;
    let (env, missing) = merged_env(entry, &secrets)?;
    let raw_env = entry
        .get("env")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("repo_config_invalid: env is not an array"))?;
    let env = env
        .into_iter()
        .zip(raw_env)
        .map(|(item, raw)| {
            if raw.get("secret").and_then(Value::as_bool) == Some(true) {
                json!({
                    "name":item.name,
                    "secret":true,
                    "hasValue":secrets.contains_key(&item.name.to_ascii_uppercase())
                })
            } else {
                json!({"name":item.name,"value":item.value})
            }
        })
        .collect::<Vec<_>>();
    let launch = canonical_launch(entry)?;
    let fingerprint = launch_fingerprint(&launch)?;
    let accepted = accepted(tx, project, id)?;
    let trusted = accepted
        .as_ref()
        .is_some_and(|(stored, _)| stored == &fingerprint);
    let changed = accepted
        .as_ref()
        .is_some_and(|(stored, _)| stored != &fingerprint);
    let mut value = Map::new();
    for key in ["id", "name", "command", "shell", "cwd", "kind"] {
        value.insert(key.into(), entry.get(key).cloned().unwrap_or(Value::Null));
    }
    value.insert("env".into(), Value::Array(env));
    if let Some(preview) = entry.get("previewUrl") {
        value.insert("previewUrl".into(), preview.clone());
    }
    value.insert("fingerprint".into(), json!(fingerprint));
    value.insert("trusted".into(), json!(trusted));
    value.insert("changed".into(), json!(changed));
    value.insert("missingSecrets".into(), json!(missing));
    if let Some((_, accepted)) = accepted {
        value.insert("accepted".into(), accepted);
    }
    Ok(Value::Object(value))
}

pub(crate) fn list(db: &Database, project: &str, root: &Path) -> Result<Value> {
    let raw = match read_raw(root) {
        Ok(raw) => raw,
        Err(error) => {
            return Ok(json!({
                "exists":true, "entries":[], "error":format!("repo_config_invalid: {error}")
            }));
        }
    };
    let Some(raw) = raw else {
        return Ok(json!({"exists":false,"entries":[]}));
    };
    let fingerprint = file_fingerprint(&raw.bytes);
    let document = match decode(&raw) {
        Ok(document) => document,
        Err(error) => {
            return Ok(json!({
                "exists":true, "fileFingerprint":fingerprint, "entries":[],
                "error":format!("repo_config_invalid: {error}")
            }));
        }
    };
    db.transaction(|tx| {
        let entries = entries(&document)?
            .iter()
            .map(|entry| entry_value(tx, project, entry))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"exists":true,"fileFingerprint":fingerprint,"entries":entries}))
    })
}

fn plain_entry_id(id: &str) -> &str {
    id.strip_prefix("repo:").unwrap_or(id)
}

pub(crate) fn snapshot(
    db: &Database,
    project: &str,
    root: &Path,
    id: &str,
) -> Result<QuickLaunchCommand> {
    let id = plain_entry_id(id);
    if !valid_id(id) {
        return Err(anyhow!("repo_entry_not_found"));
    }
    let Some((_, document)) = read_document(root)? else {
        return Err(anyhow!("repo_entry_not_found"));
    };
    let entry = find_entry(&document, id)?;
    db.transaction(|tx| snapshot_entry(tx, project, id, entry))
}

fn snapshot_entry(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    entry: &Value,
) -> Result<QuickLaunchCommand> {
    let secrets = secret_source(tx, project, &repo_secret_key(id))?;
    let (env, missing) = merged_env(entry, &secrets)?;
    if let Some(name) = missing.first() {
        return Err(anyhow!("secret_missing: {name}"));
    }
    let now = Utc::now().to_rfc3339();
    Ok(QuickLaunchCommand {
        id: format!("repo:{id}"),
        project_id: project.to_owned(),
        revision: 1,
        name: entry
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid name"))?
            .to_owned(),
        command: entry
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid command"))?
            .to_owned(),
        shell: entry
            .get("shell")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid shell"))?
            .to_owned(),
        cwd: entry
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid cwd"))?
            .to_owned(),
        kind: entry
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("repo_config_invalid: invalid kind"))?
            .to_owned(),
        env,
        preview_url: entry
            .get("previewUrl")
            .and_then(Value::as_str)
            .map(str::to_owned),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Read one repository document and bind the command snapshot, fingerprint, and
/// local trust decision to that exact document.  Agent callers must use this
/// rather than pairing independent `snapshot` and `list` reads: a repo writer
/// could otherwise make an untrusted command appear to have a trusted hash.
pub(crate) fn agent_snapshot(
    db: &Database,
    project: &str,
    root: &Path,
    id: &str,
) -> Result<(QuickLaunchCommand, String, bool, Value)> {
    let id = plain_entry_id(id);
    if !valid_id(id) {
        return Err(anyhow!("repo_entry_not_found"));
    }
    let Some((_, document)) = read_document(root)? else {
        return Err(anyhow!("repo_entry_not_found"));
    };
    let entry = find_entry(&document, id)?;
    let launch = canonical_launch(entry)?;
    let fingerprint = launch_fingerprint(&launch)?;
    db.transaction(|tx| {
        let trusted = accepted(tx, project, id)?.is_some_and(|(stored, _)| stored == fingerprint);
        let snapshot = snapshot_entry(tx, project, id, entry)?;
        Ok((snapshot, fingerprint, trusted, launch))
    })
}

pub(crate) fn verify_snapshot(
    db: &Database,
    project: &str,
    root: &Path,
    approved: &QuickLaunchCommand,
    expected_fingerprint: &str,
) -> Result<()> {
    // `QuickLaunchCommand` contains local secret references rather than marker
    // metadata. Its fields alone therefore cannot distinguish a repo env changing
    // from secret to public. The fingerprint is the canonical, marker-preserving
    // launch document captured with this snapshot.
    verify_fingerprint(db, project, root, &approved.id, expected_fingerprint)
}

pub(crate) fn verify_fingerprint(
    db: &Database,
    project: &str,
    root: &Path,
    id: &str,
    expected: &str,
) -> Result<()> {
    let id = plain_entry_id(id);
    let document = match read_document(root) {
        Ok(Some((_, document))) => document,
        Ok(None) | Err(_) => return Err(anyhow!("repo_entry_changed")),
    };
    let entry = match entries(&document).and_then(|entries| {
        entries
            .iter()
            .find(|entry| entry_id(entry).is_ok_and(|entry_id| entry_id == id))
            .ok_or_else(|| anyhow!("repo_entry_changed"))
    }) {
        Ok(entry) => entry,
        Err(_) => return Err(anyhow!("repo_entry_changed")),
    };
    let launch = canonical_launch(entry).map_err(|_| anyhow!("repo_entry_changed"))?;
    if launch_fingerprint(&launch)? != expected {
        return Err(anyhow!("repo_entry_changed"));
    }
    let secrets = db.transaction(|tx| secret_source(tx, project, &repo_secret_key(id)))?;
    let (_, missing) = merged_env(entry, &secrets)?;
    if let Some(name) = missing.first() {
        return Err(anyhow!("secret_missing: {name}"));
    }
    Ok(())
}

fn operation_tx(tx: &Transaction<'_>, id: &str, method: &str) -> Result<Option<Value>> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT method,result FROM operations WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match row {
        Some((recorded, result)) if recorded == method => {
            let mut value: Value = serde_json::from_str(&result)?;
            if redact_legacy_secret_values(&mut value) {
                tx.execute(
                    "UPDATE operations SET result=? WHERE id=?",
                    params![value.to_string(), id],
                )?;
            }
            Ok(Some(value))
        }
        _ => Ok(None),
    }
}

fn complete(tx: &Transaction<'_>, id: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![id, method, result.to_string(), Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn changed(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            json!({"kind":"quickLaunch.repo"}).to_string(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

struct PartialConfig(PathBuf);

impl Drop for PartialConfig {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn publish(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source = source
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let target = target
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, target)?;
    Ok(())
}

fn invalid_config_path() -> anyhow::Error {
    anyhow!("repo_config_invalid: unsafe config path")
}

fn write_paths(root: &Path) -> Result<(PathBuf, PathBuf)> {
    let canonical_root = root.canonicalize().map_err(|_| invalid_config_path())?;
    let directory = root.join(".threadterm");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(invalid_config_path());
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if let Err(error) = fs::create_dir(&directory) {
                if error.kind() != ErrorKind::AlreadyExists {
                    return Err(error.into());
                }
            }
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| invalid_config_path())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_config_path());
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| invalid_config_path())?;
    if canonical_directory.parent() != Some(canonical_root.as_path())
        || !canonical_directory.starts_with(&canonical_root)
    {
        return Err(invalid_config_path());
    }
    let target = canonical_directory.join("run.json");
    match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(invalid_config_path());
            }
            let canonical_target = target.canonicalize().map_err(|_| invalid_config_path())?;
            if canonical_target.parent() != Some(canonical_directory.as_path())
                || !canonical_target.starts_with(&canonical_root)
            {
                return Err(invalid_config_path());
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok((canonical_directory, target))
}

fn write_document(
    root: &Path,
    document: &Value,
    expected_current_fingerprint: Option<&str>,
) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(document)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(anyhow!("repo_config_invalid: file exceeds 256 KiB"));
    }
    let (directory, target) = write_paths(root)?;
    let temporary =
        PartialConfig(directory.join(format!(".run.json.{}.tmp", uuid::Uuid::new_v4())));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.0)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    // Another process may have replaced the config while this mutation was being
    // prepared.  Detect that common race immediately before the atomic publish.
    // A writer that races the final OS rename still cannot be coordinated with.
    let current = read_raw(root).map_err(|error| anyhow!("repo_config_invalid: {error}"))?;
    let current_fingerprint = current.as_ref().map(|raw| file_fingerprint(&raw.bytes));
    if current_fingerprint.as_deref() != expected_current_fingerprint {
        return Err(anyhow!("repo_config_conflict"));
    }
    publish(&temporary.0, &target)?;
    Ok(bytes)
}

fn check_expected(raw: Option<&RawConfig>, expected: Option<&str>) -> Result<()> {
    match (raw, expected) {
        (None, None) => Ok(()),
        (Some(raw), Some(expected)) if file_fingerprint(&raw.bytes) == expected => Ok(()),
        (Some(_), None) => Ok(()),
        _ => Err(anyhow!("repo_config_conflict")),
    }
}

fn unique_slug(entries: &[Value], name: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in trim_wire(name).chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    if slug.is_empty() {
        slug.push_str("command");
    }
    slug.truncate(64);
    let used = entries
        .iter()
        .filter_map(|entry| entry_id(entry).ok())
        .collect::<HashSet<_>>();
    if !used.contains(slug.as_str()) {
        return slug;
    }
    for suffix in 2.. {
        let suffix = format!("-{suffix}");
        let mut candidate = slug.clone();
        candidate.truncate(64 - suffix.len());
        candidate.push_str(&suffix);
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!()
}

fn save_entry_value(p: &SaveEntry, id: &str, previous: Option<&Value>) -> Result<Value> {
    let mut object = previous
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    object.insert("id".into(), json!(id));
    object.insert("name".into(), json!(trim_wire(&p.name)));
    object.insert("command".into(), json!(p.command));
    object.insert("shell".into(), json!(p.shell));
    object.insert("cwd".into(), json!(p.cwd));
    object.insert("kind".into(), json!(p.kind));
    match &p.preview_url {
        Some(preview) => {
            object.insert("previewUrl".into(), json!(preview));
        }
        None => {
            object.remove("previewUrl");
        }
    }
    let previous_env = previous
        .and_then(|entry| entry.get("env"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let env = p
        .env
        .iter()
        .map(|item| {
            let mut object = previous_env
                .iter()
                .find(|old| {
                    old.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(&item.name))
                })
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            object.insert("name".into(), json!(item.name));
            if item.secret == Some(true) {
                object.remove("value");
                object.insert("secret".into(), Value::Bool(true));
            } else {
                object.insert(
                    "value".into(),
                    json!(item.value.as_ref().ok_or_else(|| anyhow!("invalid_request"))?),
                );
                object.remove("secret");
            }
            Ok(Value::Object(object))
        })
        .collect::<Result<Vec<_>>>()?;
    object.insert("env".into(), Value::Array(env));
    Ok(Value::Object(object))
}

fn store_trust(tx: &Transaction<'_>, project: &str, id: &str, entry: &Value) -> Result<String> {
    let launch = canonical_launch(entry)?;
    let fingerprint = launch_fingerprint(&launch)?;
    tx.execute(
        "INSERT INTO quick_launch_repo_trust(project_id,entry_id,fingerprint,snapshot_json) VALUES(?,?,?,?)
         ON CONFLICT(project_id,entry_id) DO UPDATE SET fingerprint=excluded.fingerprint,snapshot_json=excluded.snapshot_json",
        params![project,id,fingerprint,launch.to_string()],
    )?;
    Ok(fingerprint)
}

fn save(db: &Database, project: &str, root: &Path, p: SaveParams) -> Result<Value> {
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id, "quickLaunch.repo.save")? {
            return Ok(result);
        }
        let source = match &p.local_source {
            Some(source) => {
                let command = crate::quick_launch::local_move_source(
                    tx,
                    project,
                    &source.id,
                    source.revision,
                )?;
                secret_source(tx, project, &command.id)?
            }
            None => HashMap::new(),
        };
        let raw = read_raw(root).map_err(|error| anyhow!("repo_config_invalid: {error}"))?;
        check_expected(raw.as_ref(), p.expected_fingerprint.as_deref())?;
        let current_fingerprint = raw.as_ref().map(|raw| file_fingerprint(&raw.bytes));
        let mut document = match raw {
            Some(raw) => decode(&raw).map_err(|error| anyhow!("repo_config_invalid: {error}"))?,
            None => json!({"version":1,"entries":[]}),
        };
        let position = p.entry.id.as_ref().map(|id| {
            entries(&document)
                .and_then(|entries| {
                    entries
                        .iter()
                        .position(|entry| entry_id(entry).is_ok_and(|entry_id| entry_id == id))
                        .ok_or_else(|| anyhow!("repo_entry_not_found"))
                })
        }).transpose()?;
        let current_entries = entries(&document)?;
        if position.is_none() && current_entries.len() >= MAX_ENTRIES {
            return Err(anyhow!("too_many_commands"));
        }
        let id = p.entry.id.clone().unwrap_or_else(|| unique_slug(current_entries, &p.entry.name));
        let previous = position.map(|position| current_entries[position].clone());
        let entry = save_entry_value(&p.entry, &id, previous.as_ref())?;
        validate_document(&json!({"version":1,"entries":[entry.clone()]}))?;
        let mutable = document
            .get_mut("entries")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("repo_config_invalid: entries is not an array"))?;
        if let Some(position) = position {
            mutable[position] = entry.clone();
        } else {
            mutable.push(entry.clone());
        }
        write_document(root, &document, current_fingerprint.as_deref())?;
        replace_secret_env(tx, project, &repo_secret_key(&id), &p.entry.env, &source)?;
        store_trust(tx, project, &id, &entry)?;
        let result = entry_value(tx, project, &entry)?;
        complete(tx, &p.operation_id, "quickLaunch.repo.save", &result)?;
        changed(tx)?;
        Ok(result)
    })
}

fn delete(db: &Database, project: &str, root: &Path, p: DeleteParams) -> Result<Value> {
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id, "quickLaunch.repo.delete")? {
            return Ok(result);
        }
        let Some((raw, mut document)) = read_document(root)? else {
            return Err(anyhow!("repo_entry_not_found"));
        };
        check_expected(Some(&raw), p.expected_fingerprint.as_deref())?;
        let current_fingerprint = file_fingerprint(&raw.bytes);
        let entries = document
            .get_mut("entries")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("repo_config_invalid: entries is not an array"))?;
        let position = entries
            .iter()
            .position(|entry| entry_id(entry).is_ok_and(|id| id == p.id))
            .ok_or_else(|| anyhow!("repo_entry_not_found"))?;
        entries.remove(position);
        write_document(root, &document, Some(&current_fingerprint))?;
        tx.execute(
            "DELETE FROM quick_launch_repo_secrets WHERE project_id=? AND entry_id=?",
            params![project, repo_secret_key(&p.id)],
        )?;
        tx.execute(
            "DELETE FROM quick_launch_repo_trust WHERE project_id=? AND entry_id=?",
            params![project, p.id],
        )?;
        complete(tx, &p.operation_id, "quickLaunch.repo.delete", &Value::Null)?;
        changed(tx)?;
        Ok(Value::Null)
    })
}

fn trust(db: &Database, project: &str, root: &Path, p: TrustParams) -> Result<Value> {
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id, "quickLaunch.repo.trust")? {
            return Ok(result);
        }
        let Some((_, document)) = read_document(root)? else {
            return Err(anyhow!("repo_entry_not_found"));
        };
        let entry = find_entry(&document, &p.id)?;
        let launch = canonical_launch(entry)?;
        let fingerprint = launch_fingerprint(&launch)?;
        if fingerprint != p.fingerprint {
            return Err(anyhow!("repo_config_conflict"));
        }
        store_trust(tx, project, &p.id, entry)?;
        let result = entry_value(tx, project, entry)?;
        complete(tx, &p.operation_id, "quickLaunch.repo.trust", &result)?;
        changed(tx)?;
        Ok(result)
    })
}

pub(crate) fn dispatch(
    db: &Database,
    project: &str,
    root: &Path,
    method: &str,
    value: &Value,
) -> Result<Value> {
    validate(method, value)?;
    match method {
        "quickLaunch.repo.list" => {
            let _: ListParams = serde_json::from_value(value.clone())?;
            list(db, project, root)
        }
        "quickLaunch.repo.save" => save(db, project, root, serde_json::from_value(value.clone())?),
        "quickLaunch.repo.delete" => {
            delete(db, project, root, serde_json::from_value(value.clone())?)
        }
        "quickLaunch.repo.trust" => {
            trust(db, project, root, serde_json::from_value(value.clone())?)
        }
        _ => Err(anyhow!("unknown_method")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        db: Database,
        project: String,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("worktree");
            fs::create_dir_all(&root).unwrap();
            let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
            db.transaction(|tx| initialize_connection(tx)).unwrap();
            let project = db
                .add_project(&root.to_string_lossy(), Some("Repo"), "repo-project")
                .unwrap()
                .id;
            Self {
                _temp: temp,
                root,
                db,
                project,
            }
        }

        fn write(&self, value: Value) {
            let directory = self.root.join(".threadterm");
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("run.json"),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }

        fn write_bytes(&self, bytes: &[u8]) {
            let directory = self.root.join(".threadterm");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("run.json"), bytes).unwrap();
        }

        fn dispatch(&self, method: &str, value: Value) -> Result<Value> {
            dispatch(&self.db, &self.project, &self.root, method, &value)
        }

        fn list(&self) -> Value {
            list(&self.db, &self.project, &self.root).unwrap()
        }
    }

    fn entry(id: &str, command: &str) -> Value {
        json!({
            "id":id, "name":"Development", "command":command, "shell":"cmd",
            "cwd":"", "kind":"service", "env":[], "previewUrl":"http://localhost:3000"
        })
    }

    fn document(entries: Vec<Value>) -> Value {
        json!({"version":1,"entries":entries})
    }

    fn save_value(id: Option<&str>, operation: &str) -> Value {
        let mut entry = json!({
            "name":"Development", "command":"echo ready", "shell":"cmd", "cwd":"",
            "kind":"service", "env":[{"name":"TOKEN","value":"local-secret","secret":true}],
            "previewUrl":"http://localhost:3000"
        });
        if let Some(id) = id {
            entry["id"] = json!(id);
        }
        json!({"projectId":"project","cwd":"root","entry":entry,"operationId":operation})
    }

    #[test]
    fn initialization_scrubs_legacy_private_receipts_bindings_and_repo_run_snapshots() {
        let fixture = Fixture::new();
        let secret = "legacy-private-secret";
        let now = Utc::now().to_rfc3339();
        let legacy_request = json!({
            "operationId":"legacy-request",
            "entry":{"env":[{"name":"TOKEN","secret":true,"value":secret}]}
        })
        .to_string();
        let legacy_result = json!({
            "env":[{"name":"TOKEN","secret":true,"value":secret}]
        })
        .to_string();
        let legacy_snapshot = json!({
            "id":"repo:development","projectId":fixture.project,"revision":1,
            "name":"Development","command":"echo ready","shell":"cmd","cwd":"",
            "kind":"task","env":[{"name":"TOKEN","value":secret}],
            "createdAt":now,"updatedAt":now
        })
        .to_string();
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO operation_requests(id,method,params) VALUES('legacy-request','quickLaunch.repo.save',?)",
                    [&legacy_request],
                )?;
                tx.execute(
                    "INSERT INTO operations(id,method,result,created_at) VALUES('legacy-receipt','quickLaunch.repo.save',?,?)",
                    params![legacy_result,now],
                )?;
                tx.execute(
                    "INSERT INTO quick_launch_repo_secrets(project_id,entry_id,env_name,value) VALUES(?,'repo:development','TOKEN',?)",
                    params![fixture.project,secret],
                )?;
                tx.execute(
                    "INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed)
                     VALUES('legacy-run',?,?,'Legacy','custom','terminal','exited',?,?,0)",
                    params![fixture.project,fixture.root.to_string_lossy(),now,now],
                )?;
                tx.execute(
                    "INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,stop_requested,started_at)
                     VALUES('legacy-run','repo:development',?,?,?,0,?)",
                    params![fixture.project,fixture.root.to_string_lossy(),legacy_snapshot,now],
                )?;
                initialize_connection(tx)
            })
            .unwrap();
        let (request, result, snapshot): (String, String, String) = fixture
            .db
            .transaction(|tx| {
                Ok((
                    tx.query_row(
                        "SELECT params FROM operation_requests WHERE id='legacy-request'",
                        [],
                        |row| row.get(0),
                    )?,
                    tx.query_row(
                        "SELECT result FROM operations WHERE id='legacy-receipt'",
                        [],
                        |row| row.get(0),
                    )?,
                    tx.query_row(
                        "SELECT snapshot_json FROM quick_launch_runs WHERE session_id='legacy-run'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert!(!request.contains(secret));
        assert_eq!(
            serde_json::from_str::<Value>(&request).unwrap(),
            json!({"requestSha256":hex::encode(Sha256::digest(
                format!("quickLaunch.repo.save\0{legacy_request}").as_bytes()
            ))})
        );
        assert!(!result.contains(secret));
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["env"][0],
            json!({"name":"TOKEN","secret":true,"hasValue":true})
        );
        assert!(!snapshot.contains(secret));
        assert!(snapshot.contains("threadterm-local-secret"));
    }

    #[test]
    fn an_explicit_empty_secret_is_present_and_stays_local() {
        let fixture = Fixture::new();
        let mut value = save_value(None, "empty-secret");
        value["entry"]["env"][0]["value"] = json!("");
        let saved = fixture.dispatch("quickLaunch.repo.save", value).unwrap();
        assert_eq!(saved["missingSecrets"], json!([]));
        assert_eq!(
            saved["env"][0],
            json!({"name":"TOKEN","secret":true,"hasValue":true})
        );
        let command =
            snapshot(&fixture.db, &fixture.project, &fixture.root, "development").unwrap();
        assert!(is_secret_reference(&command.env[0].value));
        assert_eq!(
            fixture
                .db
                .transaction(|tx| resolve_secret(
                    tx,
                    &fixture.project,
                    "repo:development",
                    "TOKEN"
                ))
                .unwrap(),
            Some(String::new())
        );
        let raw: Value =
            serde_json::from_slice(&fs::read(config_path(&fixture.root)).unwrap()).unwrap();
        assert!(raw["entries"][0]["env"][0].get("value").is_none());
    }

    #[test]
    fn valid_list_merges_local_state_and_malformed_files_are_diagnostic() {
        let fixture = Fixture::new();
        assert_eq!(fixture.list(), json!({"exists":false,"entries":[]}));
        fixture.write(document(vec![entry("dev", "echo dev")]));
        let listed = fixture.list();
        assert_eq!(listed["exists"], true);
        assert_eq!(
            listed["entries"][0]["fingerprint"].as_str().unwrap().len(),
            64
        );
        assert_eq!(listed["entries"][0]["trusted"], false);
        assert_eq!(listed["entries"][0]["changed"], false);
        assert_eq!(listed["entries"][0]["missingSecrets"], json!([]));
        assert!(listed["fileFingerprint"].as_str().is_some());

        fixture.write_bytes(b"{not json");
        let malformed = fixture.list();
        assert_eq!(malformed["entries"], json!([]));
        assert!(malformed["error"]
            .as_str()
            .unwrap()
            .starts_with("repo_config_invalid: "));
        assert!(malformed["fileFingerprint"].as_str().is_some());

        let mut secret = entry("dev", "echo dev");
        secret["env"] = json!([{"name":"TOKEN","secret":true,"value":"must-not-exist"}]);
        fixture.write(document(vec![secret]));
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("secret value"));

        let mut invalid_shell = entry("dev", "echo dev");
        invalid_shell["shell"] = json!("bash");
        fixture.write(document(vec![invalid_shell]));
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("invalid"));

        let mut duplicate_env = entry("dev", "echo dev");
        duplicate_env["env"] = json!([
            {"name":"DUPLICATE","value":"one"},
            {"name":"duplicate","value":"two"}
        ]);
        fixture.write(document(vec![duplicate_env]));
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("invalid"));

        let mut caps = Vec::new();
        for index in 0..=MAX_ENTRIES {
            caps.push(entry(&format!("entry-{index}"), "echo entry"));
        }
        fixture.write(document(caps));
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("too many entries"));
        fixture.write_bytes(&vec![b' '; MAX_CONFIG_BYTES + 1]);
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("256 KiB"));
    }

    #[test]
    fn save_is_atomic_slugged_and_preserves_unknown_json_without_secret_bytes() {
        let fixture = Fixture::new();
        let mut first = entry("dev", "echo old");
        first["futureEntry"] = json!({"keep":true});
        first["env"] = json!([
            {"name":"TOKEN","secret":true,"futureEnv":"kept"},
            {"name":"PUBLIC","value":"visible"}
        ]);
        let mut initial = document(vec![first, entry("other", "echo other")]);
        initial["futureRoot"] = json!([1, 2, 3]);
        fixture.write(initial.clone());
        let fingerprint = fixture.list()["fileFingerprint"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut save = save_value(Some("dev"), "save-dev");
        save["expectedFingerprint"] = json!(fingerprint);
        save["entry"]["env"] = json!([
            {"name":"TOKEN","value":"local-secret","secret":true},
            {"name":"PUBLIC","value":"changed"}
        ]);
        let saved = fixture.dispatch("quickLaunch.repo.save", save).unwrap();
        assert_eq!(saved["id"], "dev");
        assert_eq!(saved["trusted"], true);
        assert_eq!(
            saved["env"][0],
            json!({"name":"TOKEN","secret":true,"hasValue":true})
        );
        assert_eq!(
            saved["accepted"]["env"][0],
            json!({"name":"TOKEN","secret":true})
        );
        let bytes = fs::read(config_path(&fixture.root)).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("local-secret"));
        let written: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(written["futureRoot"], initial["futureRoot"]);
        assert_eq!(written["entries"][0]["futureEntry"], json!({"keep":true}));
        assert_eq!(written["entries"][0]["env"][0]["futureEnv"], "kept");
        assert_eq!(written["entries"][0]["env"][0].get("value"), None);
        assert_eq!(written["entries"][1]["id"], "other");
        assert!(!text.contains(".tmp"));

        let replay = fixture
            .dispatch("quickLaunch.repo.save", save_value(Some("dev"), "save-dev"))
            .unwrap();
        assert_eq!(replay, saved);
        let mut preserve = save_value(Some("dev"), "preserve-secret");
        preserve["expectedFingerprint"] = fixture.list()["fileFingerprint"].clone();
        preserve["entry"]["env"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        preserve["entry"]["env"].as_array_mut().unwrap().push(json!({"name":"PUBLIC","value":"changed"}));
        let preserved = fixture.dispatch("quickLaunch.repo.save", preserve).unwrap();
        assert_eq!(
            preserved["env"][0],
            json!({"name":"TOKEN","secret":true,"hasValue":true})
        );
        assert_eq!(
            fixture
                .db
                .transaction(|tx| resolve_secret(tx, &fixture.project, "repo:dev", "TOKEN"))
                .unwrap()
                .as_deref(),
            Some("local-secret")
        );
        let stale = fixture.dispatch("quickLaunch.repo.save", json!({
            "projectId":"project","cwd":"root","expectedFingerprint":"0000000000000000000000000000000000000000000000000000000000000000",
            "entry":save_value(None, "unused")["entry"],"operationId":"stale-save"
        })).unwrap_err();
        assert_eq!(stale.to_string(), "repo_config_conflict");
        let after_conflict = fs::read_to_string(config_path(&fixture.root)).unwrap();
        assert_eq!(after_conflict, text);

        let slugged = fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "save-slug"))
            .unwrap();
        assert_eq!(slugged["id"], "development");
        let second = fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "save-slug-2"))
            .unwrap();
        assert_eq!(second["id"], "development-2");
        let temporary_files = fs::read_dir(fixture.root.join(".threadterm"))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn absent_file_fingerprint_semantics_are_explicit() {
        let fixture = Fixture::new();
        let mut stale = save_value(None, "absent-stale");
        stale["expectedFingerprint"] = json!(Sha256::digest(b"")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>());
        assert_eq!(
            fixture
                .dispatch("quickLaunch.repo.save", stale)
                .unwrap_err()
                .to_string(),
            "repo_config_conflict"
        );
        fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "absent-create"))
            .unwrap();
        assert_eq!(fixture.list()["exists"], true);
    }

    #[test]
    fn snapshot_merges_secrets_and_run_verification_rereads_the_file() {
        let fixture = Fixture::new();
        fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "snapshot-save"))
            .unwrap();
        let snapshot =
            snapshot(&fixture.db, &fixture.project, &fixture.root, "development").unwrap();
        let fingerprint = fixture.list()["entries"][0]["fingerprint"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(snapshot.id, "repo:development");
        assert_eq!(snapshot.revision, 1);
        assert!(is_secret_reference(&snapshot.env[0].value));
        assert_eq!(snapshot.created_at, snapshot.updated_at);
        verify_snapshot(
            &fixture.db,
            &fixture.project,
            &fixture.root,
            &snapshot,
            &fingerprint,
        )
        .unwrap();

        let mut changed = entry("development", "echo changed");
        changed["env"] = json!([{"name":"TOKEN","secret":true}]);
        fixture.write(document(vec![changed]));
        assert_eq!(
            verify_snapshot(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                &snapshot,
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "repo_entry_changed"
        );
        fixture
            .db
            .transaction(|tx| {
                tx.execute("DELETE FROM quick_launch_repo_secrets", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            super::snapshot(&fixture.db, &fixture.project, &fixture.root, "development")
                .unwrap_err()
                .to_string(),
            "secret_missing: TOKEN"
        );
        assert_eq!(
            super::snapshot(&fixture.db, &fixture.project, &fixture.root, "missing")
                .unwrap_err()
                .to_string(),
            "repo_entry_not_found"
        );

        fixture.write_bytes(b"{not json");
        assert_eq!(
            verify_snapshot(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                &snapshot,
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "repo_entry_changed"
        );
    }

    #[test]
    fn agent_snapshot_binds_trust_to_the_same_file_entry() {
        let fixture = Fixture::new();
        fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "agent-snapshot"))
            .unwrap();
        let (snapshot, fingerprint, trusted, launch) = agent_snapshot(
            &fixture.db,
            &fixture.project,
            &fixture.root,
            "repo:development",
        )
        .unwrap();
        assert_eq!(snapshot.id, "repo:development");
        assert_eq!(snapshot.command, "echo ready");
        assert!(trusted);
        assert_eq!(launch["env"][0], json!({"name":"TOKEN","secret":true}));

        let mut changed = entry("development", "echo changed");
        changed["env"] = json!([{"name":"TOKEN","secret":true}]);
        fixture.write(document(vec![changed]));
        let (changed_snapshot, changed_fingerprint, changed_trusted, _) =
            agent_snapshot(&fixture.db, &fixture.project, &fixture.root, "development").unwrap();
        assert_eq!(changed_snapshot.command, "echo changed");
        assert_ne!(changed_fingerprint, fingerprint);
        assert!(!changed_trusted);
    }

    #[test]
    fn fingerprint_verification_catches_file_env_and_secretness_changes() {
        let fixture = Fixture::new();
        let saved = fixture
            .dispatch(
                "quickLaunch.repo.save",
                save_value(None, "fingerprint-save"),
            )
            .unwrap();
        let fingerprint = saved["fingerprint"].as_str().unwrap().to_owned();
        verify_fingerprint(
            &fixture.db,
            &fixture.project,
            &fixture.root,
            "repo:development",
            &fingerprint,
        )
        .unwrap();

        let mut changed = entry("development", "echo ready");
        changed["env"] = json!([{"name":"TOKEN","value":"local-secret"}]);
        fixture.write(document(vec![changed.clone()]));
        assert_eq!(
            verify_fingerprint(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                "development",
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "repo_entry_changed"
        );

        changed["env"] = json!([{"name":"TOKEN","secret":true}]);
        fixture.write(document(vec![changed]));
        fixture
            .db
            .transaction(|tx| {
                tx.execute("DELETE FROM quick_launch_repo_secrets", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            verify_fingerprint(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                "development",
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "secret_missing: TOKEN"
        );
        assert_eq!(
            verify_fingerprint(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                "missing",
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "repo_entry_changed"
        );
        fs::remove_file(config_path(&fixture.root)).unwrap();
        assert_eq!(
            verify_fingerprint(
                &fixture.db,
                &fixture.project,
                &fixture.root,
                "development",
                &fingerprint,
            )
            .unwrap_err()
            .to_string(),
            "repo_entry_changed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writes_reject_symlinked_directory_and_config() {
        let fixture = Fixture::new();
        let outside = tempfile::tempdir().unwrap();
        let directory = fixture.root.join(".threadterm");
        std::os::unix::fs::symlink(outside.path(), &directory).unwrap();
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("unsafe config path"));
        assert_eq!(
            fixture
                .dispatch(
                    "quickLaunch.repo.save",
                    save_value(None, "symlink-directory")
                )
                .unwrap_err()
                .to_string(),
            "repo_config_invalid: unsafe config path"
        );
        assert!(!outside.path().join("run.json").exists());

        fs::remove_file(&directory).unwrap();
        fs::create_dir(&directory).unwrap();
        let target = outside.path().join("run.json");
        fs::write(
            &target,
            serde_json::to_vec_pretty(&document(vec![entry("dev", "echo dev")])).unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&target, config_path(&fixture.root)).unwrap();
        let before = fs::read(&target).unwrap();
        assert!(fixture.list()["error"]
            .as_str()
            .unwrap()
            .contains("unsafe config path"));
        assert_eq!(
            fixture
                .dispatch("quickLaunch.repo.save", save_value(None, "symlink-config"))
                .unwrap_err()
                .to_string(),
            "repo_config_invalid: unsafe config path"
        );
        assert_eq!(fs::read(&target).unwrap(), before);
    }

    #[test]
    fn trust_detects_launch_changes_and_requires_the_reviewed_fingerprint() {
        let fixture = Fixture::new();
        let saved = fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "trust-save"))
            .unwrap();
        let original = saved["fingerprint"].as_str().unwrap().to_owned();
        let mut changed_entry = entry("development", "echo changed");
        changed_entry["env"] = json!([{"name":"TOKEN","secret":true}]);
        fixture.write(document(vec![changed_entry.clone()]));
        let changed = fixture.list();
        assert_eq!(changed["entries"][0]["changed"], true);
        assert_eq!(changed["entries"][0]["trusted"], false);
        assert_eq!(changed["entries"][0]["accepted"]["command"], "echo ready");
        assert!(!changed["entries"][0]["accepted"]
            .to_string()
            .contains("local-secret"));
        let current = changed["entries"][0]["fingerprint"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(current, original);
        assert_eq!(fixture.dispatch("quickLaunch.repo.trust", json!({
            "projectId":"project","cwd":"root","id":"development","fingerprint":original,"operationId":"stale-trust"
        })).unwrap_err().to_string(), "repo_config_conflict");
        let trusted = fixture.dispatch("quickLaunch.repo.trust", json!({
            "projectId":"project","cwd":"root","id":"development","fingerprint":current,"operationId":"current-trust"
        })).unwrap();
        assert_eq!(trusted["trusted"], true);
        assert_eq!(trusted["changed"], false);

        changed_entry["env"] = json!([{"name":"TOKEN","value":"local-secret"}]);
        fixture.write(document(vec![changed_entry]));
        let secretness = fixture.list();
        assert_ne!(
            secretness["entries"][0]["fingerprint"].as_str().unwrap(),
            current
        );
        assert_eq!(secretness["entries"][0]["changed"], true);
    }

    #[test]
    fn delete_removes_local_state_and_all_mutations_emit_receipts_and_events() {
        let fixture = Fixture::new();
        fixture
            .dispatch("quickLaunch.repo.save", save_value(None, "delete-save"))
            .unwrap();
        let fingerprint = fixture.list()["fileFingerprint"]
            .as_str()
            .unwrap()
            .to_owned();
        let deleted = fixture.dispatch("quickLaunch.repo.delete", json!({
            "projectId":"project","cwd":"root","id":"development","expectedFingerprint":fingerprint,"operationId":"delete-entry"
        })).unwrap();
        assert!(deleted.is_null());
        assert_eq!(fixture.list()["entries"], json!([]));
        assert!(fixture.dispatch("quickLaunch.repo.delete", json!({
            "projectId":"project","cwd":"root","id":"development","operationId":"delete-entry"
        })).unwrap().is_null());
        let (secrets, trust, operations, events): (i64, i64, i64, i64) = fixture.db.transaction(|tx| {
            Ok((
                tx.query_row("SELECT COUNT(*) FROM quick_launch_repo_secrets", [], |row| row.get(0))?,
                tx.query_row("SELECT COUNT(*) FROM quick_launch_repo_trust", [], |row| row.get(0))?,
                tx.query_row("SELECT COUNT(*) FROM operations WHERE method LIKE 'quickLaunch.repo.%'", [], |row| row.get(0))?,
                tx.query_row("SELECT COUNT(*) FROM outbox WHERE event='state.changed' AND json_extract(data,'$.kind')='quickLaunch.repo'", [], |row| row.get(0))?,
            ))
        }).unwrap();
        assert_eq!((secrets, trust, operations, events), (0, 0, 2, 2));
        assert_eq!(
            fs::read_to_string(config_path(&fixture.root))
                .unwrap()
                .contains("local-secret"),
            false
        );
    }

    #[test]
    fn request_validation_is_strict_and_bounds_ids_operations_and_fingerprints() {
        assert!(validate("quickLaunch.repo.list", &json!({"projectId":"p","cwd":"r"})).is_ok());
        assert!(validate(
            "quickLaunch.repo.list",
            &json!({"projectId":"p","cwd":"r","extra":true})
        )
        .is_err());
        assert!(validate(
            "quickLaunch.repo.save",
            &save_value(Some("Bad ID"), "operation")
        )
        .is_err());
        assert!(validate("quickLaunch.repo.save", &save_value(None, &"x".repeat(513))).is_err());
        assert!(validate(
            "quickLaunch.repo.trust",
            &json!({
                "projectId":"p","cwd":"r","id":"entry","fingerprint":"ABC","operationId":"operation"
            })
        )
        .is_err());
        let mut secret = save_value(None, "secret-null");
        secret["entry"]["env"][0]["value"] = Value::Null;
        assert!(validate("quickLaunch.repo.save", &secret).is_err());
        let mut preserve = save_value(None, "secret-preserve");
        preserve["entry"]["env"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        assert!(validate("quickLaunch.repo.save", &preserve).is_ok());
        let mut unknown = save_value(None, "unknown-env");
        unknown["entry"]["env"][0]["future"] = Value::Bool(true);
        assert!(validate("quickLaunch.repo.save", &unknown).is_err());
        assert_eq!(
            dispatch(
                &Fixture::new().db,
                "project",
                Path::new("unused"),
                "quickLaunch.repo.unknown",
                &json!({})
            )
            .unwrap_err()
            .to_string(),
            "unknown_method"
        );
    }
}
