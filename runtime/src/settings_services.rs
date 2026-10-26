//! Settings, backup, and usage operations. These remain in the
//! runtime so the renderer never reads or writes the SQLite database directly.
use crate::{config::RuntimeConfig, db::Database};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

/// Runtime-owned folders in the data root. Relocation copies every one of them;
/// the review stores keep checkpoints readable after the source goes away.
const RELOCATED_FOLDERS: &[&str] = &["review-objects", "review-indexes", "review-git", "plugins"];
const RELOCATED_DATABASE: &str = "threadterm-v3.sqlite3";

const SETTINGS_MARKER: &str = "threadterm-v3-settings";
const SETTINGS_VERSION: i64 = 1;
const ALLOWED_SETTINGS: &[&str] = &[
    "theme",
    "language",
    "shortcuts",
    "notifications",
    "customThemes",
    "themeSelection",
    "terminalCompatibility",
    "quickMessages",
    "chatTools.ask",
    "chatTools.sessionInfo",
    "chatTools.feedback",
    "chatTools.delegation",
];
const RUNTIME_SETTINGS: &[&str] = &[
    "theme",
    "language",
    "shortcuts",
    "notifications",
    "customThemes",
    "themeSelection",
    "lightweightMode",
    "desktopCompanion",
    "modelPrices",
    "terminalCompatibility",
    "electronCacheCleanup",
    "floatMode",
    "supervision",
    "providerNetwork",
    // Local execution opt-in; portable settings must never enable it.
    "browserEvalEnabled",
    "quickMessages",
    "chatTools.ask",
    "chatTools.sessionInfo",
    "chatTools.feedback",
    "chatTools.delegation",
    "chatTools",
    // Machine-specific (not exported): the console host for Windows terminals (conpty.rs); read at runtime start.
    "conptyHost",
];
struct RelocationReservation {
    operation_id: String,
    target_root: String,
}
static RELOCATIONS: OnceLock<Mutex<HashMap<PathBuf, RelocationReservation>>> = OnceLock::new();
fn relocations() -> &'static Mutex<HashMap<PathBuf, RelocationReservation>> {
    RELOCATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn relocation_key(config: &RuntimeConfig) -> Result<PathBuf> {
    fs::canonicalize(&config.data_dir).with_context(|| {
        format!(
            "canonicalizing runtime data directory {}",
            config.data_dir.display()
        )
    })
}

/// Paths leave the runtime in their plain form; `fs::canonicalize` returns `\\?\` paths on Windows.
fn wire_display_path(path: &Path) -> String {
    crate::git_read::plain_path(path).to_string_lossy().into_owned()
}

fn wire_relocation_result(mut result: Value) -> Value {
    for key in ["sourceRoot", "targetRoot"] {
        if let Some(path) = result.get(key).and_then(Value::as_str) {
            result[key] = Value::String(wire_display_path(Path::new(path)));
        }
    }
    result
}
/// Called by RuntimeService while dispatching a request; mutating requests stay
/// fenced between prepare and explicit cancel/shutdown.
pub fn relocation_blocks(config: &RuntimeConfig, method: &str) -> Result<bool> {
    let pure = matches!(
        method,
        "runtime.health"
            | "terminal.host"
            | "runtime.snapshot"
            | "catalog.visibility.list"
            | "data.status"
            | "data.relocation.status"
            | "data.relocation.cancel"
            | "data.relocation.prepare"
            | "runtime.shutdown"
            | "provider.list"
            | "plugin.list"
            | "history.list"
            | "history.read"
            | "chat.read"
            | "chat.subagent.read"
            | "terminal.read"
            | "session.lookup"
    );
    let key = relocation_key(config)?;
    relocations()
        .lock()
        .map(|slots| slots.contains_key(&key) && !pure)
        .map_err(|_| anyhow!("relocation_lock"))
}

pub fn release_relocation(config: &RuntimeConfig) -> Result<()> {
    let key = relocation_key(config)?;
    relocations()
        .lock()
        .map_err(|_| anyhow!("relocation_lock"))?
        .remove(&key);
    Ok(())
}

pub fn initialize(db: &Database) -> Result<()> {
    // Schema belongs to Database::open so snapshot is always available. Keep
    // this initialization point for future settings-service migrations.
    let _ = db;
    Ok(())
}

/// Validates the mutable runtime settings surface before it reaches the
/// database. Imports use their narrower portable-settings allowlist below.
pub fn valid_runtime_patch(value: &Value) -> Result<()> {
    let patch = value
        .as_object()
        .filter(|patch| !patch.is_empty())
        .ok_or_else(|| anyhow!("invalid_settings_patch"))?;
    for (key, value) in patch {
        if !RUNTIME_SETTINGS.contains(&key.as_str()) {
            return Err(anyhow!("invalid_settings_patch"));
        }
        valid_setting(key, value)?;
    }
    Ok(())
}

pub fn dispatch(
    config: &RuntimeConfig,
    db: &Database,
    method: &str,
    params: &Value,
) -> Result<Option<Value>> {
    if !matches!(
        method,
        "data.status"
            | "data.backup"
            | "data.backup.verify"
            | "data.relocation.status"
            | "data.relocation.prepare"
            | "data.relocation.cancel"
            | "settings.export"
            | "settings.import.preview"
            | "settings.import.apply"
            | "usage.query"
    ) {
        return Ok(None);
    }
    let result = match method {
        "data.status" => data_status(config, db)?,
        "data.backup" => data_backup(config, db, object(params)?)?,
        "data.backup.verify" => crate::data_backup::verify(Path::new(string(object(params)?, "path")?))?,
        "data.relocation.status" => relocation_status(config)?,
        "data.relocation.prepare" => relocation_prepare(config, db, object(params)?)?,
        "data.relocation.cancel" => relocation_cancel(config, db, object(params)?)?,
        "settings.export" => settings_export(db)?,
        "settings.import.preview" => settings_preview(db, object(params)?)?,
        "settings.import.apply" => settings_apply(db, object(params)?)?,
        "usage.query" => usage_query(db, object(params)?)?,
        _ => unreachable!(),
    };
    Ok(Some(result))
}

fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or_else(|| anyhow!("invalid_request"))
}
fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn integer(object: &Map<String, Value>, key: &str) -> Result<i64> {
    object
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn data_status(config: &RuntimeConfig, db: &Database) -> Result<Value> {
    let database_size = fs::metadata(db.path()).map(|meta| meta.len()).unwrap_or(0);
    let counts = db.transaction(|tx| Ok(json!({
        "projects": count(tx, "projects")?, "sessions": count(tx, "sessions")?, "workspaces": count(tx, "workspaces")?,
        "drafts": count(tx, "drafts")?, "usageRecords": count(tx, "usage_records")?
    })))?;
    Ok(
        json!({"root":wire_display_path(&config.data_dir),"database":{"path":wire_display_path(db.path()),"sizeBytes":database_size},"counts":counts}),
    )
}

fn data_backup(
    config: &RuntimeConfig,
    db: &Database,
    values: &Map<String, Value>,
) -> Result<Value> {
    let target = Path::new(string(values, "targetPath")?);
    let operation_id = string(values, "operationId")?;
    if let Some(value) = db.operation(operation_id)? {
        return Ok(value);
    }
    let desktop_root = Path::new(string(values, "desktopDataRoot")?);
    let result = crate::data_backup::create(config, db, target, desktop_root)?;
    db.transaction(|tx| complete(tx, operation_id, "data.backup", &result))?;
    Ok(result)
}

fn relocation_status(config: &RuntimeConfig) -> Result<Value> {
    let key = relocation_key(config)?;
    let slots = relocations()
        .lock()
        .map_err(|_| anyhow!("relocation_lock"))?;
    let slot = slots.get(&key);
    let mut status =
        json!({"frozen":slot.is_some(),"sourceRoot":wire_display_path(&config.data_dir)});
    if let Some(target_root) = slot.map(|item| &item.target_root) {
        status["targetRoot"] = Value::String(wire_display_path(Path::new(target_root)));
    }
    Ok(status)
}

/// Recursive copy that refuses links and other non-regular entries instead of
/// following them out of the data root.
fn copy_folder_entries(source: &Path, target: &Path) -> Result<u64> {
    let mut files = 0;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir_all(&destination)?;
            files += copy_folder_entries(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &destination)?;
            files += 1;
        } else {
            return Err(anyhow!("relocation_unsupported_entry"));
        }
    }
    Ok(files)
}

fn copy_folder(source: &Path, target: &Path) -> Result<u64> {
    if !source.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(target)?;
    copy_folder_entries(source, target)
}

/// Content digest over relative names, sizes and bytes. Verification reads both
/// trees, so a truncated or racing copy fails before activation.
fn folder_digest(root: &Path) -> Result<(u64, String)> {
    fn walk(root: &Path, directory: &Path, files: &mut u64, digest: &mut Sha256) -> Result<()> {
        let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry.file_type()?;
            let relative = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            if kind.is_dir() {
                digest.update(b"d");
                digest.update(relative.as_bytes());
                walk(root, &path, files, digest)?;
            } else if kind.is_file() {
                let mut file = fs::File::open(&path)?;
                let length = file.metadata()?.len();
                digest.update(b"f");
                digest.update(relative.as_bytes());
                digest.update(length.to_le_bytes());
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let read = file.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    digest.update(&buffer[..read]);
                }
                *files += 1;
            } else {
                return Err(anyhow!("relocation_unsupported_entry"));
            }
        }
        Ok(())
    }
    let mut files = 0;
    let mut digest = Sha256::new();
    if root.is_dir() {
        walk(root, root, &mut files, &mut digest)?;
    }
    Ok((files, hex::encode(digest.finalize())))
}

fn verify_folder_copy(source: &Path, target: &Path) -> Result<()> {
    if folder_digest(source)? != folder_digest(target)? {
        return Err(anyhow!("relocation_verification_failed"));
    }
    Ok(())
}

/// Windows path spellings may differ only by case (realpath vs. the root the
/// app passed in), so the store root is matched without assuming one spelling.
fn strip_store_root(store: &Path, root: &Path) -> Option<PathBuf> {
    let stored: Vec<_> = store.components().collect();
    let wanted: Vec<_> = root.components().collect();
    if stored.len() < wanted.len() {
        return None;
    }
    let matches = stored.iter().zip(&wanted).all(|(left, right)| {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    });
    if !matches {
        return None;
    }
    let mut relative = PathBuf::new();
    for component in &stored[wanted.len()..] {
        relative.push(component.as_os_str());
    }
    Some(relative)
}

/// Rewrites the checkpoint store paths recorded in the prepared database. Rows
/// that already point outside the current object root are counted, not guessed.
fn rewrite_review_store_paths(
    database: &Path,
    source_objects: &Path,
    target_objects: &Path,
) -> Result<(u64, u64)> {
    let mut connection = rusqlite::Connection::open(database)?;
    let present: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='review_checkpoints'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if present.is_none() {
        return Ok((0, 0));
    }
    let rows = {
        let mut statement =
            connection.prepare("SELECT id, store FROM review_checkpoints WHERE store IS NOT NULL")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut updates = Vec::new();
    let mut unmapped = 0_u64;
    for (id, store) in rows {
        match strip_store_root(Path::new(&store), source_objects) {
            Some(relative) => updates.push((
                id,
                target_objects.join(relative).to_string_lossy().into_owned(),
            )),
            None => unmapped += 1,
        }
    }
    if !updates.is_empty() {
        let transaction = connection.transaction()?;
        {
            let mut update = transaction.prepare("UPDATE review_checkpoints SET store=? WHERE id=?")?;
            for (id, store) in &updates {
                update.execute(params![store, id])?;
            }
        }
        transaction.commit()?;
    }
    Ok((updates.len() as u64, unmapped))
}

/// Copies the runtime-owned folders, rewrites the prepared database's review
/// store paths and verifies every copy before the target can be activated.
fn relocate_runtime_folders(db: &Database, target: &Path) -> Result<Value> {
    let base = db
        .path()
        .parent()
        .ok_or_else(|| anyhow!("invalid_relocation_target"))?;
    let mut folders = Vec::new();
    let mut files = 0_u64;
    for name in RELOCATED_FOLDERS {
        let source = base.join(name);
        if !source.is_dir() {
            continue;
        }
        let destination = target.join(name);
        files += copy_folder(&source, &destination)
            .with_context(|| format!("copying {name}"))?;
        verify_folder_copy(&source, &destination)
            .with_context(|| format!("verifying {name}"))?;
        folders.push(*name);
    }
    let (checkpoints, unmapped) = rewrite_review_store_paths(
        &target.join(RELOCATED_DATABASE),
        &crate::git_read::plain_path(&base.join("review-objects")),
        &crate::git_read::plain_path(&target.join("review-objects")),
    )
    .context("rewriting review store paths")?;
    Ok(json!({"folders":folders,"files":files,"checkpoints":checkpoints,"unmappedCheckpoints":unmapped}))
}
fn relocation_prepare(
    config: &RuntimeConfig,
    db: &Database,
    values: &Map<String, Value>,
) -> Result<Value> {
    let source_key = relocation_key(config)?;
    let target = Path::new(string(values, "targetPath")?);
    let operation_id = string(values, "operationId")?;
    if let Some(result) = db.operation(operation_id)? {
        let replay_target = result
            .get("targetRoot")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("stale_relocation_preparation"))?;
        let replay_token = result
            .get("activationToken")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("stale_relocation_preparation"))?;
        let ready: Value = serde_json::from_slice(&fs::read(
            Path::new(replay_target).join("relocation.ready.json"),
        )?)
        .map_err(|_| anyhow!("stale_relocation_preparation"))?;
        if ready.get("targetRoot").and_then(Value::as_str) != Some(replay_target)
            || ready.get("activationToken").and_then(Value::as_str) != Some(replay_token)
        {
            return Err(anyhow!("stale_relocation_preparation"));
        }
        let mut slots = relocations()
            .lock()
            .map_err(|_| anyhow!("relocation_lock"))?;
        match slots.get(&source_key) {
            Some(active) if active.operation_id == operation_id => {}
            Some(_) => return Err(anyhow!("relocation_pending")),
            None => {
                slots.insert(
                    source_key.clone(),
                    RelocationReservation {
                        operation_id: operation_id.to_owned(),
                        target_root: replay_target.to_owned(),
                    },
                );
            }
        }
        return Ok(wire_relocation_result(result));
    }
    if !target.is_absolute()
        || target == config.data_dir
        || !target.is_dir()
        || fs::read_dir(target)?.next().is_some()
    {
        return Err(anyhow!("invalid_relocation_target"));
    }
    let snapshot = db.snapshot()?;
    if snapshot.sessions.iter().any(|session| {
        !session.read_only
            && matches!(
                session.status.as_str(),
                "starting" | "running" | "idle" | "waiting"
            )
    }) {
        return Err(anyhow!("active_sessions_must_end_before_relocation"));
    }
    let canonical = fs::canonicalize(target)?;
    let token = Uuid::new_v4().to_string();
    {
        let mut slots = relocations()
            .lock()
            .map_err(|_| anyhow!("relocation_lock"))?;
        if slots.contains_key(&source_key) {
            return Err(anyhow!("relocation_pending"));
        }
        slots.insert(
            source_key.clone(),
            RelocationReservation {
                operation_id: operation_id.to_owned(),
                target_root: canonical.to_string_lossy().into_owned(),
            },
        );
    }
    let result = (|| -> Result<Value> {
        let database = canonical.join(RELOCATED_DATABASE);
        db.backup_to(&database)?;
        fs::copy(
            &config.credential_path,
            canonical.join("runtime.credential"),
        )?;
        #[cfg(windows)]
        crate::windows_security::restrict_file_to_current_user(
            &canonical.join("runtime.credential"),
        )?;
        // Remote access is disabled when neither identity file exists. When it
        // is enabled, relocate both halves atomically in the prepared target.
        let cert = config
            .data_dir
            .join(crate::remote_access::REMOTE_CERTIFICATE_FILE);
        let private_key = config
            .data_dir
            .join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE);
        let mut includes = vec!["database", "credentials"];
        match (cert.exists(), private_key.exists()) {
            (false, false) => {}
            (true, true) => {
                let target_cert = canonical.join(crate::remote_access::REMOTE_CERTIFICATE_FILE);
                let target_key = canonical.join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE);
                fs::copy(&cert, &target_cert)?;
                fs::copy(&private_key, &target_key)?;
                #[cfg(windows)]
                crate::windows_security::restrict_file_to_current_user(&target_key)?;
                includes.push("remoteIdentity");
            }
            _ => return Err(anyhow!("remote_access_identity_incomplete")),
        }
        let relocated = relocate_runtime_folders(db, &canonical)?;
        includes.push("reviewCheckpoints");
        if relocated["folders"]
            .as_array()
            .is_some_and(|folders| folders.iter().any(|folder| folder == "plugins"))
        {
            includes.push("plugins");
        }
        fs::write(
            canonical.join("relocation.ready.json"),
            serde_json::to_vec(
                &json!({"sourceRoot":config.data_dir,"targetRoot":canonical,"activationToken":token}),
            )?,
        )?;
        Ok(json!({"sourceRoot":config.data_dir,"targetRoot":canonical,"activationToken":token,"includes":includes}))
    })();
    match result {
        Ok(result) => {
            db.transaction(|tx| complete(tx, operation_id, "data.relocation.prepare", &result))?;
            Ok(wire_relocation_result(result))
        }
        Err(error) => {
            // Keep the user's target folder for a retry, but discard every
            // prepared file so activation can never see a partial copy.
            if let Ok(entries) = fs::read_dir(&canonical) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let _ = match entry.file_type() {
                        Ok(kind) if kind.is_dir() => fs::remove_dir_all(&path),
                        Ok(_) => fs::remove_file(&path),
                        Err(error) => Err(error),
                    };
                }
            }
            relocations()
                .lock()
                .map_err(|_| anyhow!("relocation_lock"))?
                .remove(&source_key);
            Err(error)
        }
    }
}
fn relocation_cancel(
    config: &RuntimeConfig,
    db: &Database,
    values: &Map<String, Value>,
) -> Result<Value> {
    let prepared_operation_id = string(values, "preparedOperationId")?;
    let operation_id = string(values, "operationId")?;
    if prepared_operation_id == operation_id {
        return Err(anyhow!("relocation_cancel_requires_a_new_operation"));
    }
    let key = relocation_key(config)?;
    let mut slots = relocations()
        .lock()
        .map_err(|_| anyhow!("relocation_lock"))?;
    match slots.get(&key) {
        Some(active) if active.operation_id == prepared_operation_id => {
            slots.remove(&key);
            db.complete_null_operation(operation_id, "data.relocation.cancel")?;
            Ok(Value::Null)
        }
        Some(_) => Err(anyhow!("relocation_operation_mismatch")),
        None => {
            db.complete_null_operation(operation_id, "data.relocation.cancel")?;
            Ok(Value::Null)
        }
    }
}

fn settings_export(db: &Database) -> Result<Value> {
    let settings = settings(db)?;
    Ok(
        json!({"marker":SETTINGS_MARKER,"version":SETTINGS_VERSION,"exportedAt":Utc::now().to_rfc3339(),"settings":whitelisted(&settings.value)}),
    )
}

fn settings_preview(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    let current = settings(db)?;
    let incoming = match parse_bundle(string(values, "bundle")?) {
        Ok(incoming) => incoming,
        Err(error) => {
            return Ok(
                json!({"valid":false,"issues":[error.to_string()],"currentRevision":current.revision,"changes":[]}),
            )
        }
    };
    let current_values = whitelisted(&current.value);
    let mut changes = Vec::new();
    for (key, incoming_value) in incoming {
        if current_values.get(&key) != Some(&incoming_value) {
            changes.push(json!({"key":key,"current":current_values.get(&key).cloned().unwrap_or(Value::Null),"incoming":incoming_value}));
        }
    }
    Ok(json!({"valid":true,"issues":[],"currentRevision":current.revision,"changes":changes}))
}

fn settings_apply(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    let operation_id = string(values, "operationId")?;
    if let Some(value) = db.operation(operation_id)? {
        return Ok(value);
    }
    let expected = integer(values, "expectedRevision")?;
    let selected = values
        .get("selected")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let incoming = parse_bundle(string(values, "bundle")?)?;
    let selected: Vec<&str> = selected
        .iter()
        .map(Value::as_str)
        .collect::<Option<_>>()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if selected
        .iter()
        .any(|key| !ALLOWED_SETTINGS.contains(key) || !incoming.contains_key(*key))
    {
        return Err(anyhow!("invalid_settings_selection"));
    }
    db.transaction(|tx| {
        let current = settings_tx(tx)?;
        if current.revision != expected {
            return Err(anyhow!("revision_conflict"));
        }
        let mut next_value = current.value;
        let values = next_value
            .as_object_mut()
            .ok_or_else(|| anyhow!("invalid_settings"))?;
        for key in selected {
            values.insert(key.to_owned(), incoming[key].clone());
        }
        let next = StoredSettings {
            revision: current.revision + 1,
            value: next_value,
        };
        tx.execute(
            "UPDATE settings SET revision=?,value=? WHERE singleton=1",
            params![next.revision, serde_json::to_string(&next.value)?],
        )?;
        let mut result = next.value;
        result["revision"] = json!(next.revision);
        complete(tx, operation_id, "settings.import.apply", &result)?;
        emit(tx, "settings")?;
        Ok(result)
    })
}

fn usage_query(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    // Lifecycle metadata deliberately ignores the date range: that range
    // describes usage facts, while source/status belong to the session for its
    // full lifetime. This also avoids reporting a record without the filters
    // used to select its owning session.
    let sessions = crate::session_metrics::lifecycle(db, values)?;
    let metadata: std::collections::HashMap<&str, &Value> = sessions
        .iter()
        .filter_map(|session| session["sessionId"].as_str().map(|id| (id, session)))
        .collect();
    let mut records = db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT session_id,provider,recorded_at,input_tokens,output_tokens,estimated_cost,currency,model
             FROM usage_records
             WHERE (?1 IS NULL OR recorded_at>=?1)
               AND (?2 IS NULL OR recorded_at<=?2)
               AND (?3 IS NULL OR session_id=?3)
               AND (?4 IS NULL OR provider=?4)
             ORDER BY recorded_at DESC",
        )?;
        let records = statement
            .query_map(
                params![
                    values.get("from").and_then(Value::as_str),
                    values.get("to").and_then(Value::as_str),
                    values.get("sessionId").and_then(Value::as_str),
                    values.get("provider").and_then(Value::as_str),
                ],
                |row| {
                    let mut record = Map::new();
                    record.insert("sessionId".into(), json!(row.get::<_, String>(0)?));
                    record.insert("provider".into(), json!(row.get::<_, String>(1)?));
                    record.insert("recordedAt".into(), json!(row.get::<_, String>(2)?));
                    if let Some(value) = row.get::<_, Option<i64>>(3)? { record.insert("inputTokens".into(), json!(value)); }
                    if let Some(value) = row.get::<_, Option<i64>>(4)? { record.insert("outputTokens".into(), json!(value)); }
                    if let Some(value) = row.get::<_, Option<f64>>(5)? { record.insert("estimatedCost".into(), json!(value)); }
                    if let Some(value) = row.get::<_, Option<String>>(6)? { record.insert("currency".into(), json!(value)); }
                    if let Some(value) = row.get::<_, Option<String>>(7)? { record.insert("model".into(), json!(value)); }
                    Ok(Value::Object(record))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        Ok(records)
    })?;
    records.retain(|record| {
        record["sessionId"]
            .as_str()
            .is_some_and(|id| metadata.contains_key(id))
    });
    for record in &mut records {
        if let Some(session) = record["sessionId"].as_str().and_then(|id| metadata.get(id)) {
            record["status"] = session["status"].clone();
            record["source"] = session["source"].clone();
        }
    }
    let summary = crate::session_metrics::summary(&sessions);
    Ok(json!({"records":records,"sessions":sessions,"summary":summary,"pricing":"unknown"}))
}

struct StoredSettings {
    revision: i64,
    value: Value,
}
fn settings(db: &Database) -> Result<StoredSettings> {
    db.transaction(settings_tx)
}
fn settings_tx(tx: &Transaction<'_>) -> Result<StoredSettings> {
    let (revision, raw): (i64, String) = tx.query_row(
        "SELECT revision,value FROM settings WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(StoredSettings {
        revision,
        value: serde_json::from_str(&raw)?,
    })
}
fn whitelisted(value: &Value) -> Map<String, Value> {
    let source = value.as_object();
    ALLOWED_SETTINGS
        .iter()
        .filter_map(|key| {
            source
                .and_then(|source| source.get(*key))
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect()
}
fn parse_bundle(raw: &str) -> Result<Map<String, Value>> {
    let root: Value =
        serde_json::from_str(raw).map_err(|_| anyhow!("Settings file is not valid JSON."))?;
    let object = object(&root)?;
    if object.get("marker").and_then(Value::as_str) != Some(SETTINGS_MARKER)
        || object.get("version").and_then(Value::as_i64) != Some(SETTINGS_VERSION)
    {
        return Err(anyhow!(
            "Settings file is not a supported ThreadTerm V3 bundle."
        ));
    };
    let settings = object
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("Settings bundle is missing settings."))?;
    let mut result = Map::new();
    for key in ALLOWED_SETTINGS {
        if let Some(value) = settings.get(*key) {
            valid_setting(key, value)?;
            result.insert((*key).to_owned(), value.clone());
        }
    }
    Ok(result)
}
/// Theme preset and family ids: `[a-z0-9-]{1,40}`. An unknown but well-formed id is valid; the renderer falls back.
fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_theme_colour(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 7
            && text.starts_with('#')
            && text[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// Theme background regions and the integer range of each layer number (phase D: one picture per region).
fn valid_theme_background_layer(region: &str, layer: &Value) -> bool {
    const REGIONS: &[&str] = &[
        "window",
        "sidebar",
        "sidebar2",
        "chat",
        "editor",
        "terminal",
        "browser",
    ];
    const KEYS: &[&str] = &[
        "image",
        "opacity",
        "blur",
        "overlay",
        "fit",
        "focusX",
        "focusY",
        "scale",
    ];
    if !REGIONS.contains(&region) {
        return false;
    }
    let Some(map) = layer.as_object() else {
        return false;
    };
    // Exactly the eight keys: an unknown key or a missing one rejects the theme.
    if map.len() != KEYS.len() || !KEYS.iter().all(|key| map.contains_key(*key)) {
        return false;
    }
    let integer = |key: &str, low: u64, high: u64| {
        map.get(key)
            .and_then(Value::as_u64)
            .is_some_and(|value| value >= low && value <= high)
    };
    map.get("image").and_then(Value::as_str).is_some_and(|id| {
        // `inherit` shows the window picture; it is meaningless for the window region itself.
        (id == "inherit" && region != "window")
            || (id.len() == 64
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    }) && matches!(
        map.get("fit").and_then(Value::as_str),
        Some("cover" | "contain" | "tile")
    ) && integer("opacity", 0, 100)
        && integer("blur", 0, 40)
        && integer("overlay", 0, 100)
        && integer("focusX", 0, 100)
        && integer("focusY", 0, 100)
        && integer("scale", 50, 200)
}

fn valid_theme_backgrounds(value: &Value) -> bool {
    value.as_object().is_some_and(|regions| {
        regions
            .iter()
            .all(|(region, layer)| valid_theme_background_layer(region, layer))
    })
}

fn valid_custom_themes(value: &Value) -> bool {
    // `sidebar`/`editor` are optional role colours; `base` names the preset that supplies syntax/ANSI/status colours;
    // `backgrounds` holds one image layer per region. An unknown key still rejects the pack.
    const TOKENS: &[&str] = &[
        "background",
        "surface",
        "text",
        "muted",
        "accent",
        "border",
        "sidebar",
        "editor",
    ];
    value.as_object().is_some_and(|themes| {
        themes.iter().all(|(name, tokens)| {
            !name.is_empty()
                && name.len() <= 64
                && tokens.as_object().is_some_and(|map| {
                    !map.is_empty()
                        && map.iter().all(|(key, token)| {
                            if key == "base" {
                                token.as_str().is_some_and(valid_theme_id)
                            } else if key == "backgrounds" {
                                valid_theme_backgrounds(token)
                            } else {
                                TOKENS.contains(&key.as_str()) && valid_theme_colour(token)
                            }
                        })
                })
        })
    })
}

fn valid_model_prices(value: &Value) -> bool {
    value.as_object().is_some_and(|prices| {
        prices.iter().all(|(key, price)| {
            let Some((provider, model)) = key.split_once('/') else {
                return false;
            };
            !provider.is_empty()
                && !model.is_empty()
                && provider.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                })
                && model.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                })
                && price.as_object().is_some_and(|values| {
                    !values.is_empty()
                        && values.iter().all(|(key, value)| {
                            matches!(key.as_str(), "input" | "output")
                                && value
                                    .as_f64()
                                    .is_some_and(|number| number.is_finite() && number >= 0.0)
                        })
                })
        })
    })
}

fn valid_quick_messages(value: &Value) -> bool {
    const MAX_QUICK_MESSAGES: usize = 50;
    let Some(items) = value.as_array() else {
        return false;
    };
    if items.len() > MAX_QUICK_MESSAGES {
        return false;
    }
    let mut ids: Vec<&str> = Vec::with_capacity(items.len());
    items.iter().all(|item| {
        let Some(record) = item.as_object() else {
            return false;
        };
        if record.len() != 3 {
            return false;
        }
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(title) = record.get("title").and_then(Value::as_str) else {
            return false;
        };
        let Some(text) = record.get("text").and_then(Value::as_str) else {
            return false;
        };
        if id.is_empty()
            || id.chars().count() > 128
            || id.chars().any(char::is_control)
            || title.trim().is_empty()
            || title.chars().count() > 200
            || text.trim().is_empty()
            || text.chars().count() > 4000
            || ids.contains(&id)
        {
            return false;
        }
        ids.push(id);
        true
    })
}

fn valid_setting(key: &str, value: &Value) -> Result<()> {
    match key {
        "theme" if matches!(value.as_str(), Some("light" | "dark" | "system")) => Ok(()),
        "language" if matches!(value.as_str(), Some("en" | "zh-CN")) => Ok(()),
        "shortcuts"
            if value
                .as_object()
                .is_some_and(|map| map.values().all(Value::is_string)) =>
        {
            Ok(())
        }
        "notifications"
            if value
                .as_object()
                .is_some_and(|map| map.values().all(Value::is_boolean)) =>
        {
            Ok(())
        }
        "themeSelection"
            if value.as_str().is_some_and(|name| {
                matches!(name, "light" | "dark" | "system")
                    || name.starts_with("custom:")
                    || name.strip_prefix("preset:").is_some_and(valid_theme_id)
                    || name.strip_prefix("system:").is_some_and(valid_theme_id)
            }) =>
        {
            Ok(())
        }
        "customThemes" if valid_custom_themes(value) => Ok(()),
        "lightweightMode" if value.is_boolean() => Ok(()),
        "browserEvalEnabled" if value.is_boolean() => Ok(()),
        "desktopCompanion"
            if value.as_object().is_some_and(|companion| {
                companion.len() == 1 && companion.get("enabled").is_some_and(Value::is_boolean)
            }) =>
        {
            Ok(())
        }
        "terminalCompatibility"
            if value.as_object().is_some_and(|compatibility| {
                compatibility.len() == 1
                    && compatibility
                        .get("aiCompletionHints")
                        .is_some_and(Value::is_boolean)
            }) =>
        {
            Ok(())
        }
        "chatTools.ask"
        | "chatTools.sessionInfo"
        | "chatTools.feedback"
        | "chatTools.delegation"
            if value.is_boolean() =>
        {
            Ok(())
        }
        "quickMessages" if valid_quick_messages(value) => Ok(()),
        "providerNetwork"
            if value
                .as_object()
                .is_some_and(|providers| providers.keys().all(|key| key == "grok")) =>
        {
            crate::providers::network::validate_settings(&json!({"providerNetwork":value}))
                .map_err(Into::into)
        }
        "chatTools"
            if value.as_object().is_some_and(|tools| {
                tools.len() == 1 && tools.get("generatedUi").is_some_and(Value::is_boolean)
            }) =>
        {
            Ok(())
        }
        "modelPrices" if valid_model_prices(value) => Ok(()),
        "electronCacheCleanup" if valid_cache_cleanup(value) => Ok(()),
        "conptyHost" if matches!(value.as_str(), Some("system" | "bundled")) => Ok(()),
        "floatMode" if matches!(value.as_str(), Some("manual" | "tile" | "cycle")) => Ok(()),
        "supervision"
            if value.as_object().is_some_and(|supervision| {
                supervision.len() == 3
                    && supervision.get("enabled").is_some_and(Value::is_boolean)
                    && supervision
                        .get("rangeMinutes")
                        .and_then(Value::as_i64)
                        .is_some_and(|minutes| (5..=60).contains(&minutes))
                    && supervision
                        .get("threshold")
                        .and_then(Value::as_i64)
                        .is_some_and(|threshold| (1..=8).contains(&threshold))
            }) =>
        {
            Ok(())
        }
        _ => Err(anyhow!(
            "Settings bundle contains an invalid {key} section."
        )),
    }
}
fn valid_cache_cleanup(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(record) = value.as_object() else {
        return false;
    };
    let timestamp = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
    };
    match record.get("state").and_then(Value::as_str) {
        Some("scheduled") => record.len() == 2 && timestamp("scheduledAt"),
        Some("completed") => record.len() == 2 && timestamp("completedAt"),
        Some("failed") => {
            record.len() == 3
                && timestamp("failedAt")
                && record
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|message| message.len() <= 2048)
        }
        _ => false,
    }
}
fn count(tx: &Transaction<'_>, table: &str) -> Result<i64> {
    Ok(
        tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })?,
    )
}
fn complete(tx: &Transaction<'_>, id: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            id,
            method,
            serde_json::to_string(result)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}
fn emit(tx: &Transaction<'_>, kind: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            serde_json::to_string(&json!({"kind":kind}))?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_eval_setting_is_boolean_local_and_preserved_by_portable_import() {
        for enabled in [false, true] {
            assert!(valid_runtime_patch(&json!({"browserEvalEnabled":enabled})).is_ok());
        }
        for invalid in [
            json!(null),
            json!("true"),
            json!(1),
            json!({"enabled":true}),
            json!([]),
        ] {
            assert!(valid_runtime_patch(&json!({"browserEvalEnabled":invalid})).is_err());
        }
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite3")).unwrap();
        assert!(settings(&db)
            .unwrap()
            .value
            .get("browserEvalEnabled")
            .is_none());
        let incoming_opt_in = json!({"marker":SETTINGS_MARKER,"version":SETTINGS_VERSION,
            "settings":{"theme":"light","browserEvalEnabled":true}})
        .to_string();
        let imported_default = settings_apply(
            &db,
            object(&json!({"operationId":"cannot-import-opt-in",
            "expectedRevision":0,"bundle":incoming_opt_in,"selected":["theme"]}))
            .unwrap(),
        )
        .unwrap();
        assert!(imported_default.get("browserEvalEnabled").is_none());
        db.update_settings(&json!({"browserEvalEnabled":true}), 1, "eval-local-opt-in")
            .unwrap();
        assert!(settings_export(&db).unwrap()["settings"]
            .get("browserEvalEnabled")
            .is_none());
        let bundle = json!({"marker":SETTINGS_MARKER,"version":SETTINGS_VERSION,
            "settings":{"theme":"dark","browserEvalEnabled":false}})
        .to_string();
        assert!(settings_apply(
            &db,
            object(&json!({"operationId":"eval-import-rejected",
            "expectedRevision":2,"bundle":bundle,"selected":["browserEvalEnabled"]}))
            .unwrap()
        )
        .is_err());
        let imported = settings_apply(
            &db,
            object(&json!({"operationId":"theme-import",
            "expectedRevision":2,"bundle":bundle,"selected":["theme"]}))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(imported["browserEvalEnabled"], true);
        assert_eq!(imported["theme"], "dark");
        assert!(settings_export(&db).unwrap()["settings"]
            .get("browserEvalEnabled")
            .is_none());
    }
    #[test]
    fn theme_selection_accepts_presets_and_families_and_custom_role_keys() {
        // Old values and old six-key packs stay valid.
        for selection in ["light", "dark", "system", "custom:ocean", "custom:"] {
            assert!(
                valid_runtime_patch(&json!({ "themeSelection": selection })).is_ok(),
                "{selection}"
            );
        }
        let legacy = json!({ "background":"#07111f", "surface":"#10233c", "text":"#ffffff", "muted":"#91a4bf", "accent":"#3b82f6", "border":"#274768" });
        assert!(valid_runtime_patch(&json!({ "customThemes": { "ocean": legacy } })).is_ok());
        // New selection forms: any well-formed id is accepted, known or not (the renderer falls back).
        for selection in [
            "preset:github-dark",
            "preset:threadterm-light",
            "preset:unknown-but-well-formed",
            "system:rose-pine",
            "system:nord",
            "system:nope",
        ] {
            assert!(
                valid_runtime_patch(&json!({ "themeSelection": selection })).is_ok(),
                "{selection}"
            );
        }
        for selection in [
            "preset:",
            "preset:GitHub-Dark",
            "preset:to_kyo",
            "preset: spaced",
            "preset:abcdefghijklmnopqrstuvwxyzabcdefghijklmnop",
            "system:",
            "presetx:github",
            "purple",
            "",
        ] {
            assert!(
                valid_runtime_patch(&json!({ "themeSelection": selection })).is_err(),
                "{selection}"
            );
        }
        // Custom themes may add the sidebar/editor role colours and a base preset id.
        let mut extended = legacy.clone();
        extended["sidebar"] = json!("#050a13");
        extended["editor"] = json!("#0b1a2b");
        extended["base"] = json!("tokyo-night");
        assert!(valid_runtime_patch(&json!({ "customThemes": { "ocean": extended } })).is_ok());
        let mut partial = json!({ "background":"#07111f" });
        partial["base"] = json!("unknown-but-well-formed");
        assert!(valid_runtime_patch(&json!({ "customThemes": { "ocean": partial } })).is_ok());
        for broken in [
            json!({ "sidebar": "#12345" }),
            json!({ "sidebar": "red" }),
            json!({ "editor": "#1234567" }),
            json!({ "base": "Tokyo Night" }),
            json!({ "base": "" }),
            json!({ "base": 7 }),
            json!({ "backgrounds": "none" }),
            json!({ "backgrounds": [] }),
            json!({ "backgrounds": { "window": null } }),
            json!({ "extra": "#112233" }),
        ] {
            let mut token = legacy.clone();
            for (key, value) in broken.as_object().unwrap() {
                token[key] = value.clone();
            }
            assert!(
                valid_runtime_patch(&json!({ "customThemes": { "ocean": token } })).is_err(),
                "{broken}"
            );
        }
    }

    #[test]
    fn theme_backgrounds_accept_exact_layers_and_reject_anything_else() {
        let legacy = json!({ "background":"#07111f", "surface":"#10233c", "text":"#ffffff", "muted":"#91a4bf", "accent":"#3b82f6", "border":"#274768" });
        let id = "a".repeat(64);
        let layer = |image: &str| {
            json!({
                "image": image,
                "opacity": 100,
                "blur": 8,
                "overlay": 35,
                "fit": "cover",
                "focusX": 50,
                "focusY": 50,
                "scale": 100
            })
        };
        let patch = |backgrounds: Value| {
            let mut token = legacy.clone();
            token["backgrounds"] = backgrounds;
            json!({ "customThemes": { "ocean (custom)": token } })
        };
        // An empty map means "no backgrounds" and every region may be used at the edges of its range.
        assert!(valid_runtime_patch(&patch(json!({}))).is_ok());
        for region in [
            "window",
            "sidebar",
            "sidebar2",
            "chat",
            "editor",
            "terminal",
            "browser",
        ] {
            let mut token = legacy.clone();
            token["backgrounds"] = json!({});
            token["backgrounds"][region] = layer(&id);
            assert!(
                valid_runtime_patch(&json!({ "customThemes": { "ocean": token } })).is_ok(),
                "{region}"
            );
        }
        // A layer may show the window picture (`inherit`) on every region except the window itself.
        for region in ["sidebar", "sidebar2", "chat", "editor", "terminal", "browser"] {
            let mut token = legacy.clone();
            token["backgrounds"] = json!({});
            token["backgrounds"][region] = {
                let mut inherit = layer(&id);
                inherit["image"] = json!("inherit");
                inherit
            };
            assert!(
                valid_runtime_patch(&json!({ "customThemes": { "ocean": token } })).is_ok(),
                "{region}"
            );
        }
        // The window region has nothing to inherit from.
        {
            let mut token = legacy.clone();
            let mut inherit = layer(&id);
            inherit["image"] = json!("inherit");
            token["backgrounds"] = json!({ "window": inherit });
            assert!(valid_runtime_patch(&json!({ "customThemes": { "ocean": token } })).is_err());
        }
        let all = json!({
            "window": layer(&id),
            "sidebar": {"image": id.clone(), "opacity": 0, "blur": 0, "overlay": 0, "fit": "contain", "focusX": 0, "focusY": 100, "scale": 50},
            "editor": {"image": id.clone(), "opacity": 100, "blur": 40, "overlay": 100, "fit": "tile", "focusX": 100, "focusY": 0, "scale": 200}
        });
        assert!(valid_runtime_patch(&patch(all)).is_ok());

        let mut broken_layers = Vec::new();
        for (key, value) in [
            ("image", json!("Inherit")),
            ("image", json!("inherit ")),
            ("image", json!("inherited")),
            ("image", json!("A".repeat(64))),
            ("image", json!("a".repeat(63))),
            ("image", json!("g".repeat(64))),
            ("image", json!("a".repeat(65))),
            ("image", json!(7)),
            ("opacity", json!(101)),
            ("opacity", json!(-1)),
            ("opacity", json!(50.5)),
            ("blur", json!(41)),
            ("blur", json!(-1)),
            ("overlay", json!(101)),
            ("overlay", json!("40")),
            ("fit", json!("fill")),
            ("fit", json!("COVER")),
            ("focusX", json!(101)),
            ("focusY", json!(-1)),
            ("scale", json!(49)),
            ("scale", json!(201)),
            ("scale", json!(true)),
            ("extra", json!(1)),
        ] {
            let mut broken = layer(&id);
            broken[key] = value.clone();
            broken_layers.push(json!({ "window": broken }));
        }
        let mut missing_key = layer(&id);
        missing_key.as_object_mut().unwrap().remove("blur");
        broken_layers.push(json!({ "window": missing_key }));
        let mut extra_key = layer(&id);
        extra_key["extra"] = json!(1);
        broken_layers.push(json!({ "window": extra_key }));
        // Unknown regions, non-object layers and a layer that is not a map at all.
        broken_layers.push(json!({ "inspector": layer(&id) }));
        broken_layers.push(json!({ "window": [layer(&id)] }));
        broken_layers.push(json!({ "window": { "image": id } }));
        broken_layers.push(json!({ "window": layer(&id), "chat": layer("short") }));
        for backgrounds in broken_layers {
            assert!(valid_runtime_patch(&patch(backgrounds.clone())).is_err(), "{backgrounds}");
        }
        assert!(valid_runtime_patch(&patch(json!({ "window": layer(&id) }))).is_ok());
    }

    #[test]
    fn cache_cleanup_settings_are_validated_and_not_portable() {
        for record in [
            json!(null),
            json!({"state":"scheduled","scheduledAt":"2026-09-10T00:00:00Z"}),
            json!({"state":"completed","completedAt":"2026-09-10T00:00:00Z"}),
            json!({"state":"failed","failedAt":"2026-09-10T00:00:00Z","message":"cache unavailable"}),
        ] {
            assert!(valid_runtime_patch(&json!({"electronCacheCleanup":record})).is_ok());
        }
        assert!(valid_runtime_patch(
            &json!({"electronCacheCleanup":{"state":"scheduled","scheduledAt":"invalid"}})
        )
        .is_err());
        assert!(valid_runtime_patch(&json!({"electronCacheCleanup":{"state":"scheduled","scheduledAt":"2026-09-10T00:00:00Z","path":"C:\\"}})).is_err());
        assert!(!ALLOWED_SETTINGS.contains(&"electronCacheCleanup"));
        assert!(valid_runtime_patch(&json!({"floatMode":"tile"})).is_ok());
        assert!(valid_runtime_patch(&json!({"floatMode":"random"})).is_err());
        assert!(!ALLOWED_SETTINGS.contains(&"floatMode"));
    }
    fn config(root: &Path) -> RuntimeConfig {
        RuntimeConfig {
            data_dir: root.to_owned(),
            database_path: root.join("db.sqlite3"),
            credential_path: root.join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-test".into(),
        }
    }

    #[test]
    #[cfg(windows)]
    fn wire_display_path_removes_windows_verbatim_prefixes() {
        assert_eq!(
            wire_display_path(Path::new(r"\\?\C:\data\ThreadTerm")),
            r"C:\data\ThreadTerm"
        );
        assert_eq!(
            wire_display_path(Path::new(r"\\?\UNC\server\share\data")),
            r"\\server\share\data"
        );
        assert_eq!(
            wire_display_path(Path::new(r"C:\data\ThreadTerm")),
            r"C:\data\ThreadTerm"
        );
        let result = wire_relocation_result(
            json!({"sourceRoot":r"\\?\C:\source","targetRoot":r"\\?\UNC\server\share\target"}),
        );
        assert_eq!(result["sourceRoot"], r"C:\source");
        assert_eq!(result["targetRoot"], r"\\server\share\target");
    }

    #[test]
    fn runtime_settings_patch_is_strict_but_accepts_the_renderer_surface() {
        assert!(valid_runtime_patch(&json!({
            "theme":"dark",
            "language":"en",
            "lightweightMode":true,
            "desktopCompanion":{"enabled":true},
            "terminalCompatibility":{"aiCompletionHints":true},
            "notifications":{"native":true},
            "shortcuts":{"showMainWindow":"Ctrl+Shift+T"},
            "customThemes":{},
            "themeSelection":"system",
            "modelPrices":{"codex/gpt-5":{"input":1.0,"output":4.0}},
            "supervision":{"enabled":false,"rangeMinutes":15,"threshold":3},
            "chatTools":{"generatedUi":true}
        }))
        .is_ok());
        assert!(valid_runtime_patch(&json!({"unknown":true})).is_err());
        assert!(valid_runtime_patch(&json!({"lightweightMode":"true"})).is_err());
        assert!(valid_runtime_patch(&json!({"chatTools":{"generatedUi":false}})).is_ok());
        for invalid in [
            json!({}),
            json!({"generatedUi":"true"}),
            json!({"generatedUi":true,"extra":false}),
            json!({"extra":true}),
            json!(true),
        ] {
            assert!(valid_runtime_patch(&json!({"chatTools":invalid})).is_err());
        }
        assert!(
            valid_runtime_patch(&json!({"desktopCompanion":{"enabled":true,"extra":false}}))
                .is_err()
        );
        assert!(valid_runtime_patch(
            &json!({"terminalCompatibility":{"aiCompletionHints":true,"extra":false}})
        )
        .is_err());
        assert!(valid_runtime_patch(
            &json!({"terminalCompatibility":{"aiCompletionHints":"true"}})
        )
        .is_err());
        assert!(valid_runtime_patch(&json!({"modelPrices":{"codex/gpt-5":{"input":-1}}})).is_err());
        assert!(valid_runtime_patch(&json!({"conptyHost":"bundled"})).is_ok());
        assert!(valid_runtime_patch(&json!({"conptyHost":"system"})).is_ok());
        assert!(valid_runtime_patch(&json!({"conptyHost":"winpty"})).is_err());
        assert!(valid_runtime_patch(&json!({"conptyHost":true})).is_err());
        assert!(valid_runtime_patch(
            &json!({"supervision":{"enabled":true,"rangeMinutes":5,"threshold":1}})
        )
        .is_ok());
        for invalid in [
            json!({"enabled":true,"rangeMinutes":4,"threshold":3}),
            json!({"enabled":true,"rangeMinutes":61,"threshold":3}),
            json!({"enabled":true,"rangeMinutes":15,"threshold":0}),
            json!({"enabled":true,"rangeMinutes":15,"threshold":9}),
            json!({"enabled":"true","rangeMinutes":15,"threshold":3}),
            json!({"enabled":true,"rangeMinutes":15,"threshold":3,"extra":false}),
        ] {
            assert!(valid_runtime_patch(&json!({"supervision":invalid})).is_err());
        }
    }

    #[test]
    fn chat_tool_switches_are_boolean_and_portable() {
        let patch = json!({"chatTools.ask":false,"chatTools.sessionInfo":true,"chatTools.feedback":false,"chatTools.delegation":true});
        assert!(valid_runtime_patch(&patch).is_ok());
        assert!(valid_runtime_patch(&json!({"chatTools.ask":"false"})).is_err());
        for key in [
            "chatTools.ask",
            "chatTools.sessionInfo",
            "chatTools.feedback",
            "chatTools.delegation",
        ] {
            assert!(ALLOWED_SETTINGS.contains(&key));
        }
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("settings.sqlite")).unwrap();
        db.update_settings(&patch, 0, "chat-tool-settings").unwrap();
        let exported = settings_export(&db).unwrap();
        assert_eq!(exported["settings"]["chatTools.ask"], false);
        assert_eq!(exported["settings"]["chatTools.sessionInfo"], true);
        assert_eq!(exported["settings"]["chatTools.feedback"], false);
        assert_eq!(exported["settings"]["chatTools.delegation"], true);
    }

    #[test]
    fn quick_messages_are_bounded_and_portable() {
        let valid = json!({"quickMessages":[
            {"id":"summarize","title":"Summarize","text":"Summarize the current diff."},
            {"id":"tests","title":"Run tests","text":"Run the test suite."}
        ]});
        assert!(valid_runtime_patch(&valid).is_ok());
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("settings.sqlite")).unwrap();
        db.update_settings(&valid, 0, "quick-messages").unwrap();
        let exported = settings_export(&db).unwrap();
        assert_eq!(exported["settings"]["quickMessages"][0]["id"], "summarize");
        assert!(ALLOWED_SETTINGS.contains(&"quickMessages"));
        assert!(valid_runtime_patch(&json!({"quickMessages":[]})).is_ok());
        for invalid in [
            json!([{"id":"a","title":"A","text":"T","extra":1}]),
            json!([{"id":"","title":"A","text":"T"}]),
            json!([{"id":"a","title":"  ","text":"T"}]),
            json!([{"id":"a","title":"A","text":""}]),
            json!([{"id":"a","title":"A"}]),
            json!("not-an-array"),
        ] {
            assert!(
                valid_runtime_patch(&json!({"quickMessages":invalid})).is_err(),
                "{invalid}"
            );
        }
        assert!(valid_runtime_patch(&json!({"quickMessages":[{"id":"a","title":"A","text":"T"},{"id":"a","title":"B","text":"U"}]})).is_err());
        let overflow = (0..51)
            .map(|index| json!({"id":format!("m{index}"),"title":"T","text":"body"}))
            .collect::<Vec<_>>();
        assert!(valid_runtime_patch(&json!({"quickMessages":overflow})).is_err());
        assert!(valid_runtime_patch(
            &json!({"quickMessages":[{"id":"a","title":"A","text":"x".repeat(4000)}]})
        )
        .is_ok());
        assert!(valid_runtime_patch(
            &json!({"quickMessages":[{"id":"a","title":"A","text":"x".repeat(4001)}]})
        )
        .is_err());
    }

    #[test]
    fn provider_proxy_settings_are_validated_at_the_runtime_boundary() {
        assert!(valid_runtime_patch(&json!({"providerNetwork":{"grok":{"mode":"custom","proxyUrl":"http://proxy.example:3128","noProxy":"localhost,.example.test"}}})).is_ok());
        assert!(
            valid_runtime_patch(&json!({"providerNetwork":{"grok":{"mode":"inherit"}}})).is_ok()
        );
        for value in [
            json!({"unknown":{"mode":"custom","proxyUrl":"http://proxy.example:3128"}}),
            json!({"grok":{"mode":"custom","proxyUrl":"file:///not-a-proxy"}}),
            json!({"grok":{"mode":"custom","proxyUrl":"http://user:secret@proxy.example"}}),
            json!({"grok":{"mode":"custom","proxyUrl":"http://proxy.example","arbitraryEnv":"secret"}}),
            json!(true),
        ] {
            assert!(valid_runtime_patch(&json!({"providerNetwork":value})).is_err());
        }
    }

    #[test]
    fn settings_import_is_whitelisted_previewed_and_fenced() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let db = Database::open(&config.database_path).unwrap();
        initialize(&db).unwrap();
        let bundle = json!({"marker":SETTINGS_MARKER,"version":1,"exportedAt":"2026-01-01T00:00:00Z","settings":{"theme":"light","language":"en","terminalCompatibility":{"aiCompletionHints":true},"presets":["must-not-import"],"sessions":["must-not-import"]}}).to_string();
        let preview = dispatch(
            &config,
            &db,
            "settings.import.preview",
            &json!({"bundle":bundle}),
        )
        .unwrap()
        .unwrap();
        assert!(preview["valid"].as_bool().unwrap());
        assert_eq!(preview["changes"].as_array().unwrap().len(), 3);
        let applied = dispatch(&config, &db, "settings.import.apply", &json!({"bundle":bundle,"selected":["theme","terminalCompatibility"],"expectedRevision":0,"operationId":"apply"})).unwrap().unwrap();
        assert_eq!(applied["theme"], "light");
        assert_eq!(applied["terminalCompatibility"]["aiCompletionHints"], true);
        assert!(applied.get("sessions").is_none());
        assert!(applied.get("presets").is_none());
        assert!(dispatch(&config, &db, "settings.import.apply", &json!({"bundle":bundle,"selected":["theme"],"expectedRevision":0,"operationId":"stale"})).is_err());
    }

    #[test]
    fn retired_preset_methods_are_rejected_as_unknown() {
        use crate::{domain::RpcRequest, service::RuntimeService};
        use std::sync::Arc;

        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        assert!(dispatch(&config, &db, "preset.list", &json!({})).unwrap().is_none());
        let service = RuntimeService::new(config, db);
        let error = service
            .dispatch(
                "legacy-client",
                RpcRequest {
                    v: 1,
                    id: "legacy-preset-list".into(),
                    method: "preset.list".into(),
                    params: json!({}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "unknown_method");
    }

    #[test]
    fn opening_a_legacy_preset_database_drops_its_rows_and_snapshot_field() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let legacy = rusqlite::Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, sessions TEXT NOT NULL, layout TEXT NOT NULL, commands TEXT NOT NULL, updated_at TEXT NOT NULL);
                 INSERT INTO presets VALUES ('legacy','Daily',1,'[]','{}','[]','now');",
            )
            .unwrap();
        drop(legacy);

        let db = Database::open(&path).unwrap();
        let presets_table: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='presets'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(presets_table, 0);
        assert!(serde_json::to_value(db.snapshot().unwrap())
            .unwrap()
            .get("presets")
            .is_none());
    }

    #[test]
    fn relocation_uses_sqlite_backup_preserves_source_and_requires_no_live_jobs() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let db = Database::open(&config.database_path).unwrap();
        config.credential().unwrap();
        std::fs::write(
            config
                .data_dir
                .join(crate::remote_access::REMOTE_CERTIFICATE_FILE),
            b"cert-fixture",
        )
        .unwrap();
        std::fs::write(
            config
                .data_dir
                .join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE),
            b"key-fixture",
        )
        .unwrap();
        let target = root.path().join("new-data");
        std::fs::create_dir(&target).unwrap();
        let prepared = dispatch(
            &config,
            &db,
            "data.relocation.prepare",
            &json!({"targetPath":target,"operationId":"move"}),
        )
        .unwrap()
        .unwrap();
        assert!(target.join("threadterm-v3.sqlite3").is_file());
        assert!(target.join("runtime.credential").is_file());
        assert_eq!(
            std::fs::read(target.join(crate::remote_access::REMOTE_CERTIFICATE_FILE)).unwrap(),
            b"cert-fixture"
        );
        assert_eq!(
            std::fs::read(target.join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE)).unwrap(),
            b"key-fixture"
        );
        assert_eq!(
            std::fs::read(
                config
                    .data_dir
                    .join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE)
            )
            .unwrap(),
            b"key-fixture"
        );
        assert_eq!(prepared["sourceRoot"], json!(root.path()));
        assert!(relocation_blocks(&config, "settings.update").unwrap());
        dispatch(
            &config,
            &db,
            "data.relocation.cancel",
            &json!({"preparedOperationId":"move","operationId":"cancel-move"}),
        )
        .unwrap();
        assert!(!relocation_blocks(&config, "settings.update").unwrap());
        assert!(config.database_path.is_file());
    }

    #[test]
    fn relocation_freeze_and_cancel_are_scoped_to_the_canonical_data_root() {
        use crate::{domain::RpcRequest, service::RuntimeService};
        use std::sync::Arc;

        fn request(
            service: &RuntimeService,
            id: &str,
            method: &str,
            params: Value,
        ) -> std::result::Result<Value, crate::domain::RpcError> {
            service.dispatch(
                "relocation-scope-test",
                RpcRequest {
                    v: 1,
                    id: id.to_owned(),
                    method: method.to_owned(),
                    params,
                },
            )
        }

        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        let config_a = config(root_a.path());
        let config_b = config(root_b.path());
        config_a.credential().unwrap();
        config_b.credential().unwrap();
        let db_a = Arc::new(Database::open(&config_a.database_path).unwrap());
        let db_b = Arc::new(Database::open(&config_b.database_path).unwrap());
        crate::workspace_services::initialize(&db_a).unwrap();
        crate::workspace_services::initialize(&db_b).unwrap();
        crate::project_catalog::initialize(&db_a).unwrap();
        crate::project_catalog::initialize(&db_b).unwrap();
        let service_a = RuntimeService::new(config_a.clone(), db_a);
        let service_b = RuntimeService::new(config_b.clone(), db_b);
        let target_a = root_a.path().join("target-a");
        let target_b = root_b.path().join("target-b");
        fs::create_dir(&target_a).unwrap();
        fs::create_dir(&target_b).unwrap();

        request(
            &service_a,
            "prepare-a-request",
            "data.relocation.prepare",
            json!({"targetPath":target_a,"operationId":"prepare-a"}),
        )
        .unwrap();
        assert!(relocation_blocks(&config_a, "settings.update").unwrap());
        assert!(!relocation_blocks(&config_a, "catalog.visibility.list").unwrap());
        assert!(relocation_blocks(&config_a, "catalog.visibility.update").unwrap());
        assert!(request(
            &service_a,
            "catalog-list-a-request",
            "catalog.visibility.list",
            json!({}),
        )
        .unwrap()
        .is_array());
        let blocked_catalog_update = request(
            &service_a,
            "catalog-update-a-request",
            "catalog.visibility.update",
            json!({"kind":"session","id":"missing","visibility":"archived","expectedRevision":0,"operationId":"catalog-update-a"}),
        )
        .unwrap_err();
        assert_eq!(blocked_catalog_update.code, "relocation_pending");
        let mut alias_a = config_a.clone();
        alias_a.data_dir = config_a.data_dir.join(".");
        assert!(relocation_blocks(&alias_a, "settings.update").unwrap());
        assert!(!relocation_blocks(&config_b, "settings.update").unwrap());
        request(
            &service_b,
            "update-b-request",
            "settings.update",
            json!({"patch":{"theme":"dark"},"expectedRevision":0,"operationId":"update-b"}),
        )
        .unwrap();

        // A cancellation request in B cannot clear A's reservation.
        request(
            &service_b,
            "cancel-other-request",
            "data.relocation.cancel",
            json!({"preparedOperationId":"prepare-a","operationId":"cancel-other"}),
        )
        .unwrap();
        assert!(relocation_blocks(&config_a, "settings.update").unwrap());

        request(
            &service_b,
            "prepare-b-request",
            "data.relocation.prepare",
            json!({"targetPath":target_b,"operationId":"prepare-b"}),
        )
        .unwrap();
        request(
            &service_b,
            "cancel-b-request",
            "data.relocation.cancel",
            json!({"preparedOperationId":"prepare-b","operationId":"cancel-b"}),
        )
        .unwrap();
        assert!(relocation_blocks(&config_a, "settings.update").unwrap());
        assert!(!relocation_blocks(&config_b, "settings.update").unwrap());
        let blocked = request(
            &service_a,
            "blocked-a-request",
            "settings.update",
            json!({"patch":{"theme":"light"},"expectedRevision":0,"operationId":"blocked-a"}),
        )
        .unwrap_err();
        assert_eq!(blocked.code, "relocation_pending");

        request(
            &service_a,
            "cancel-a-request",
            "data.relocation.cancel",
            json!({"preparedOperationId":"prepare-a","operationId":"cancel-a"}),
        )
        .unwrap();
        request(
            &service_a,
            "update-a-request",
            "settings.update",
            json!({"patch":{"theme":"light"},"expectedRevision":0,"operationId":"update-a"}),
        )
        .unwrap();
        let shutdown_target = root_a.path().join("target-shutdown");
        fs::create_dir(&shutdown_target).unwrap();
        request(
            &service_a,
            "prepare-shutdown-request",
            "data.relocation.prepare",
            json!({"targetPath":shutdown_target,"operationId":"prepare-shutdown"}),
        )
        .unwrap();
        service_a.shutdown();
        assert!(!relocation_blocks(&config_a, "settings.update").unwrap());
        service_b.shutdown();
    }


    #[test]
    fn backups_are_sqlite_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let config = config(&data);
        let db = Database::open(&config.database_path).unwrap();
        initialize(&db).unwrap();
        let backup = root.path().join("backup.sqlite3");
        let profile = root.path().join("profile");
        fs::create_dir(&profile).unwrap();
        let result = dispatch(
            &config,
            &db,
            "data.backup",
            &json!({"targetPath":backup,"operationId":"backup","desktopDataRoot":profile}),
        )
        .unwrap()
        .unwrap();
        assert!(PathBuf::from(result["path"].as_str().unwrap()).exists());
        assert!(result["sizeBytes"].as_u64().unwrap() > 0);
        assert_eq!(result["verification"]["verified"], true);
        assert!(dispatch(
            &config,
            &db,
            "data.backup",
            &json!({"targetPath":"relative.sqlite3","operationId":"relative","desktopDataRoot":profile})
        )
        .is_err());
    }

    #[test]
    fn usage_query_omits_unknown_optional_record_fields() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite3")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(crate::db::CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "usage-session",
            })
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO usage_records(id,session_id,provider,recorded_at) VALUES(?,?,?,?)",
                params!["usage-record", session.id, "shell", "2026-09-10T00:00:00Z"],
            )?;
            Ok(())
        })
        .unwrap();

        let result = usage_query(&db, &Map::new()).unwrap();
        let record = &result["records"][0];
        for field in [
            "inputTokens",
            "outputTokens",
            "estimatedCost",
            "currency",
            "model",
        ] {
            assert!(
                record.get(field).is_none(),
                "{field} must be omitted instead of null"
            );
        }
    }

    fn review_fixture(root: &Path) -> (RuntimeConfig, Database, String, PathBuf) {
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        let git = crate::workspace_services::git;
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(&repo, &["config", "user.email", "qa@example.test"]).unwrap();
        git(&repo, &["config", "user.name", "QA"]).unwrap();
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "init"]).unwrap();
        let data = root.join("data");
        fs::create_dir(&data).unwrap();
        let config = config(&data);
        config.credential().unwrap();
        let db = Database::open(&config.database_path).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        crate::review::initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s1',?,'t','codex','chat','exited','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [&project.id],
            )?;
            Ok(())
        })
        .unwrap();
        (config, db, "s1".to_owned(), repo)
    }

    #[test]
    fn relocation_carries_review_checkpoints_and_rewrites_their_store_paths() {
        let root = tempfile::tempdir().unwrap();
        let (config, db, session, repo) = review_fixture(root.path());
        fs::write(repo.join("a.txt"), "uncommitted baseline\n").unwrap();
        let checkpoint =
            crate::review::capture_before_turn(&db, &session, "send-relocate", "change").unwrap();
        fs::write(repo.join("a.txt"), "later content\n").unwrap();
        let before = crate::review::dispatch(
            &db,
            "review.diff",
            &json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(before["oldText"], "uncommitted baseline\n");
        fs::create_dir_all(config.data_dir.join("plugins").join("example")).unwrap();
        fs::write(
            config.data_dir.join("plugins").join("example").join("plugin.json"),
            b"{}",
        )
        .unwrap();

        let target = root.path().join("target");
        fs::create_dir(&target).unwrap();
        let prepared = dispatch(
            &config,
            &db,
            "data.relocation.prepare",
            &json!({"targetPath":target,"operationId":"move-review"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            prepared["includes"],
            json!(["database", "credentials", "reviewCheckpoints", "plugins"])
        );
        assert!(target.join("review-objects").is_dir());
        assert!(target.join("plugins").join("example").join("plugin.json").is_file());

        // The prepared copy must stand alone once the source store is unavailable.
        fs::rename(
            config.data_dir.join("review-objects"),
            root.path().join("source-review-objects"),
        )
        .unwrap();
        let moved = RuntimeConfig {
            data_dir: target.clone(),
            database_path: target.join("threadterm-v3.sqlite3"),
            credential_path: target.join("runtime.credential"),
            pipe_base: config.pipe_base.clone(),
        };
        let moved_db = Database::open(&moved.database_path).unwrap();
        let after = crate::review::dispatch(
            &moved_db,
            "review.diff",
            &json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(after, before);
        let fingerprint = after["fingerprint"].as_str().unwrap().to_owned();
        let restored = crate::review::dispatch(
            &moved_db,
            "review.revert",
            &json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":fingerprint},"operationId":"restore-after-move"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(restored["restored"], json!(["a.txt"]));
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "uncommitted baseline\n");
        let stores = moved_db
            .transaction(|tx| {
                let mut statement = tx.prepare("SELECT store FROM review_checkpoints WHERE store IS NOT NULL")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            })
            .unwrap();
        assert!(!stores.is_empty());
        let target_objects = crate::git_read::plain_path(&target.join("review-objects"));
        assert!(stores
            .iter()
            .all(|store| strip_store_root(Path::new(store), &target_objects).is_some()));
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_store_copy_rolls_back_and_keeps_the_source() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempfile::tempdir().unwrap();
        let (config, db, session, repo) = review_fixture(root.path());
        fs::write(repo.join("a.txt"), "uncommitted baseline\n").unwrap();
        crate::review::capture_before_turn(&db, &session, "send-locked", "change").unwrap();
        // Plugins are copied last: the review objects are already in the
        // prepared target when this copy fails, so rollback must remove them.
        let plugin = config.data_dir.join("plugins").join("example").join("plugin.json");
        fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        fs::write(&plugin, b"{}").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&plugin)
            .unwrap();
        let target = root.path().join("target");
        fs::create_dir(&target).unwrap();
        dispatch(
            &config,
            &db,
            "data.relocation.prepare",
            &json!({"targetPath":target,"operationId":"move-locked"}),
        )
        .unwrap_err();
        drop(locked);
        // The freeze is released, the prepared copy is discarded and the source
        // database and stores are untouched.
        assert!(!relocation_blocks(&config, "settings.update").unwrap());
        assert!(target.is_dir(), "the chosen target folder stays for a retry");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        assert!(!target.join("relocation.ready.json").exists());
        assert!(!target.join("threadterm-v3.sqlite3").exists());
        assert!(!target.join("review-objects").exists());
        assert!(config.database_path.is_file());
        assert!(config.data_dir.join("review-objects").is_dir());
        assert!(plugin.is_file());
        assert_eq!(dispatch(&config, &db, "data.status", &json!({})).unwrap().unwrap()["root"], json!(config.data_dir));
    }

    #[test]
    fn plugin_list_is_pure_during_relocation_but_plugin_mutations_are_fenced() {
        let root = tempfile::tempdir().unwrap();
        let config = RuntimeConfig {
            data_dir: root.path().to_owned(),
            database_path: root.path().join("db"),
            credential_path: root.path().join("credential"),
            pipe_base: "plugins-relocation".into(),
        };
        let key = relocation_key(&config).unwrap();
        relocations().lock().unwrap().insert(
            key,
            RelocationReservation {
                operation_id: "prepare".into(),
                target_root: "target".into(),
            },
        );
        assert!(!relocation_blocks(&config, "plugin.list").unwrap());
        // Both interaction responses are mutations, never relocation-safe reads.
        assert!(relocation_blocks(&config, "chat.approve").unwrap());
        assert!(relocation_blocks(&config, "chat.answer").unwrap());
        assert!(relocation_blocks(&config, "plugin.setEnabled").unwrap());
        assert!(relocation_blocks(&config, "plugin.reload").unwrap());
        release_relocation(&config).unwrap();
    }
}
