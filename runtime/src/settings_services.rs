//! Settings, backup, preset, and usage operations. These remain in the
//! runtime so the renderer never reads or writes the SQLite database directly.
use crate::{config::RuntimeConfig, db::Database};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

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
/// Called by RuntimeService while dispatching a request; mutating requests stay
/// fenced between prepare and explicit cancel/shutdown.
pub fn relocation_blocks(config: &RuntimeConfig, method: &str) -> Result<bool> {
    let pure = matches!(
        method,
        "runtime.health"
            | "runtime.snapshot"
            | "catalog.visibility.list"
            | "data.status"
            | "data.relocation.status"
            | "data.relocation.cancel"
            | "data.relocation.prepare"
            | "runtime.shutdown"
            | "provider.list"
            | "history.list"
            | "history.read"
            | "chat.read"
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
            | "data.relocation.status"
            | "data.relocation.prepare"
            | "data.relocation.cancel"
            | "settings.export"
            | "settings.import.preview"
            | "settings.import.apply"
            | "preset.list"
            | "preset.save"
            | "preset.delete"
            | "usage.query"
    ) {
        return Ok(None);
    }
    let result = match method {
        "data.status" => data_status(config, db)?,
        "data.backup" => data_backup(db, object(params)?)?,
        "data.relocation.status" => relocation_status(config)?,
        "data.relocation.prepare" => relocation_prepare(config, db, object(params)?)?,
        "data.relocation.cancel" => relocation_cancel(config, db, object(params)?)?,
        "settings.export" => settings_export(db)?,
        "settings.import.preview" => settings_preview(db, object(params)?)?,
        "settings.import.apply" => settings_apply(db, object(params)?)?,
        "preset.list" => preset_list(db)?,
        "preset.save" => preset_save(db, object(params)?)?,
        "preset.delete" => preset_delete(db, object(params)?)?,
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
        "presets": count(tx, "presets")?, "drafts": count(tx, "drafts")?, "usageRecords": count(tx, "usage_records")?
    })))?;
    Ok(
        json!({"root":config.data_dir,"database":{"path":db.path(),"sizeBytes":database_size},"counts":counts}),
    )
}

fn data_backup(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    let target = Path::new(string(values, "targetPath")?);
    let operation_id = string(values, "operationId")?;
    if let Some(value) = db.operation(operation_id)? {
        return Ok(value);
    }
    if target
        .extension()
        .and_then(|x| x.to_str())
        .is_none_or(|x| !x.eq_ignore_ascii_case("sqlite3"))
    {
        return Err(anyhow!("invalid_backup_path"));
    }
    let parent = target.parent().filter(|parent| parent.is_dir());
    if !target.is_absolute()
        || target == db.path()
        || parent.is_none()
        || target.file_name().is_none()
    {
        return Err(anyhow!("invalid_backup_path"));
    }
    // A save-dialog-selected absolute file is explicit user intent. The runtime
    // never derives a backup destination from settings or a relative cwd.
    db.backup_to(target)?;
    let result = json!({"path":target,"sizeBytes":fs::metadata(target)?.len()});
    db.transaction(|tx| complete(tx, operation_id, "data.backup", &result))?;
    Ok(result)
}

fn relocation_status(config: &RuntimeConfig) -> Result<Value> {
    let key = relocation_key(config)?;
    let slots = relocations()
        .lock()
        .map_err(|_| anyhow!("relocation_lock"))?;
    let slot = slots.get(&key);
    let mut status = json!({"frozen":slot.is_some(),"sourceRoot":config.data_dir});
    if let Some(target_root) = slot.map(|item| &item.target_root) {
        status["targetRoot"] = Value::String(target_root.to_owned());
    }
    Ok(status)
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
        return Ok(result);
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
        let database = canonical.join("threadterm-v3.sqlite3");
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
        match (cert.exists(), private_key.exists()) {
            (false, false) => {}
            (true, true) => {
                let target_cert = canonical.join(crate::remote_access::REMOTE_CERTIFICATE_FILE);
                let target_key = canonical.join(crate::remote_access::REMOTE_PRIVATE_KEY_FILE);
                fs::copy(&cert, &target_cert)?;
                fs::copy(&private_key, &target_key)?;
                #[cfg(windows)]
                crate::windows_security::restrict_file_to_current_user(&target_key)?;
            }
            _ => return Err(anyhow!("remote_access_identity_incomplete")),
        }
        fs::write(
            canonical.join("relocation.ready.json"),
            serde_json::to_vec(
                &json!({"sourceRoot":config.data_dir,"targetRoot":canonical,"activationToken":token}),
            )?,
        )?;
        Ok(json!({"sourceRoot":config.data_dir,"targetRoot":canonical,"activationToken":token}))
    })();
    match result {
        Ok(result) => {
            db.transaction(|tx| complete(tx, operation_id, "data.relocation.prepare", &result))?;
            Ok(result)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&canonical);
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

fn preset_list(db: &Database) -> Result<Value> {
    db.transaction(|tx| {
        let mut statement = tx.prepare("SELECT id,name,revision,sessions,layout,commands FROM presets ORDER BY updated_at DESC")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)))?;
        let records = rows.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().map(|(id,name,revision,sessions,layout,commands)| Ok(json!({"id":id,"name":name,"revision":revision,"sessions":serde_json::from_str::<Value>(&sessions)?,"layout":serde_json::from_str::<Value>(&layout)?,"commands":serde_json::from_str::<Value>(&commands)?}))).collect::<Result<Vec<_>>>()?;
        Ok(json!(records))
    })
}

fn preset_save(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    let operation_id = string(values, "operationId")?;
    if let Some(value) = db.operation(operation_id)? {
        return Ok(value);
    }
    let name = string(values, "name")?;
    let expected = integer(values, "expectedRevision")?;
    let sessions = values
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let layout = values
        .get("layout")
        .ok_or_else(|| anyhow!("invalid_request"))?;
    crate::workspace_services::validate_layout(layout)?;
    let commands = values
        .get("commands")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if commands.iter().any(|command| command.as_str().is_none()) {
        return Err(anyhow!("invalid_request"));
    }
    let id = values
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    db.transaction(|tx| { let revision:Option<i64>=tx.query_row("SELECT revision FROM presets WHERE id=?",[&id],|row|row.get(0)).optional()?; if revision.unwrap_or(0)!=expected{return Err(anyhow!("revision_conflict"))}; let next=expected+1; let result=json!({"id":id,"name":name,"revision":next,"sessions":sessions,"layout":layout,"commands":commands}); tx.execute("INSERT INTO presets(id,name,revision,sessions,layout,commands,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,sessions=excluded.sessions,layout=excluded.layout,commands=excluded.commands,updated_at=excluded.updated_at",params![id,name,next,serde_json::to_string(sessions)?,serde_json::to_string(layout)?,serde_json::to_string(commands)?,Utc::now().to_rfc3339()])?; complete(tx,operation_id,"preset.save",&result)?; emit(tx,"preset")?; Ok(result) })
}

fn preset_delete(db: &Database, values: &Map<String, Value>) -> Result<Value> {
    let operation_id = string(values, "operationId")?;
    if let Some(value) = db.operation(operation_id)? {
        return Ok(value);
    }
    let id = string(values, "id")?;
    let expected = integer(values, "expectedRevision")?;
    db.transaction(|tx| {
        let revision: i64 =
            tx.query_row("SELECT revision FROM presets WHERE id=?", [id], |row| {
                row.get(0)
            })?;
        if revision != expected {
            return Err(anyhow!("revision_conflict"));
        };
        tx.execute("DELETE FROM presets WHERE id=?", [id])?;
        complete(tx, operation_id, "preset.delete", &Value::Null)?;
        emit(tx, "preset")?;
        Ok(Value::Null)
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
fn valid_custom_themes(value: &Value) -> bool {
    const TOKENS: &[&str] = &["background", "surface", "text", "muted", "accent", "border"];
    value.as_object().is_some_and(|themes| {
        themes.iter().all(|(name, tokens)| {
            !name.is_empty()
                && name.len() <= 64
                && tokens.as_object().is_some_and(|map| {
                    !map.is_empty()
                        && map.iter().all(|(key, color)| {
                            TOKENS.contains(&key.as_str())
                                && color.as_str().is_some_and(|text| {
                                    text.len() == 7
                                        && text.starts_with('#')
                                        && text[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
                                })
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
                name == "light" || name == "dark" || name == "system" || name.starts_with("custom:")
            }) =>
        {
            Ok(())
        }
        "customThemes" if valid_custom_themes(value) => Ok(()),
        "lightweightMode" if value.is_boolean() => Ok(()),
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
        "providerNetwork"
            if value
                .as_object()
                .is_some_and(|providers| providers.keys().all(|key| key == "grok")) =>
        {
            crate::providers::network::validate_settings(&json!({"providerNetwork":value}))
                .map_err(Into::into)
        }
        "modelPrices" if valid_model_prices(value) => Ok(()),
        "electronCacheCleanup" if valid_cache_cleanup(value) => Ok(()),
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
    use std::path::PathBuf;

    fn config(root: &Path) -> RuntimeConfig {
        RuntimeConfig {
            data_dir: root.to_owned(),
            database_path: root.join("db.sqlite3"),
            credential_path: root.join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-test".into(),
        }
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
            "supervision":{"enabled":false,"rangeMinutes":15,"threshold":3}
        }))
        .is_ok());
        assert!(valid_runtime_patch(&json!({"unknown":true})).is_err());
        assert!(valid_runtime_patch(&json!({"lightweightMode":"true"})).is_err());
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
        let bundle = json!({"marker":SETTINGS_MARKER,"version":1,"exportedAt":"2026-01-01T00:00:00Z","settings":{"theme":"light","language":"en","terminalCompatibility":{"aiCompletionHints":true},"sessions":["must-not-import"]}}).to_string();
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
        assert!(dispatch(&config, &db, "settings.import.apply", &json!({"bundle":bundle,"selected":["theme"],"expectedRevision":0,"operationId":"stale"})).is_err());
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
    fn presets_are_revision_fenced_and_backups_are_sqlite_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let db = Database::open(&config.database_path).unwrap();
        initialize(&db).unwrap();
        assert!(dispatch(
            &config,
            &db,
            "preset.save",
            &json!({"name":"Malformed","sessions":[],"layout":{},"commands":[],"expectedRevision":0,"operationId":"malformed-preset"})
        )
        .is_err());
        assert_eq!(
            dispatch(&config, &db, "preset.list", &json!({}))
                .unwrap()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let layout = json!({"kind":"pane","id":"main","tabs":[],"activeTabId":null});
        let saved = dispatch(&config, &db, "preset.save", &json!({"name":"Daily","sessions":[],"layout":layout,"commands":[],"expectedRevision":0,"operationId":"preset"})).unwrap().unwrap();
        assert_eq!(
            dispatch(&config, &db, "preset.list", &json!({}))
                .unwrap()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(dispatch(
            &config,
            &db,
            "preset.delete",
            &json!({"id":saved["id"],"expectedRevision":0,"operationId":"bad-delete"})
        )
        .is_err());
        let backup = root.path().join("backup.sqlite3");
        let result = dispatch(
            &config,
            &db,
            "data.backup",
            &json!({"targetPath":backup,"operationId":"backup"}),
        )
        .unwrap()
        .unwrap();
        assert!(PathBuf::from(result["path"].as_str().unwrap()).exists());
        assert!(result["sizeBytes"].as_u64().unwrap() > 0);
        assert!(dispatch(
            &config,
            &db,
            "data.backup",
            &json!({"targetPath":"relative.sqlite3","operationId":"relative"})
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
}
