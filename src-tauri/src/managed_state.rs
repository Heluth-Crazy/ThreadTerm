use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::Emitter;

const MANAGED_STATE_FORMAT_VERSION: u32 = 1;
pub const MANAGED_STATE_CHANGED_EVENT: &str = "managed-state://changed";

pub(crate) const TERMINAL_STORE_KEY: &str = "threadterm-terminal-store";
pub(crate) const TERMINAL_STARTUP_EFFECTS_BACKEND_SOURCE_ID: &str =
    "backend:terminal-startup-effects";
const WORKBENCH_STORE_KEY: &str = "threadterm-workbench-store";
const OVERLAY_STORE_KEY: &str = "threadterm-overlay";

const PREFERENCE_KEYS: [&str; 8] = [
    "userLanguage",
    "themeMode",
    "themePackId",
    "theme",
    "threadterm-custom-theme-packs",
    "threadterm-html-preview-service-urls",
    "threadterm-shortcut-hint-dismissed",
    "threadterm-workspace-sidebar-disclosure",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedStateDocument {
    format_version: u32,
    initialized_keys: HashSet<String>,
    values: HashMap<String, String>,
}

impl Default for ManagedStateDocument {
    fn default() -> Self {
        Self {
            format_version: MANAGED_STATE_FORMAT_VERSION,
            initialized_keys: HashSet::new(),
            values: HashMap::new(),
        }
    }
}

impl ManagedStateDocument {
    fn validate(&self, path: &Path) -> Result<(), String> {
        if self.format_version != MANAGED_STATE_FORMAT_VERSION {
            return Err(format!(
                "Unsupported managed-state version {} in {}.",
                self.format_version,
                path.display()
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStateRead {
    pub initialized: bool,
    pub value: Option<String>,
    pub recovered_backup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStateWrite {
    pub imported: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStateSetOutcome {
    pub reconciled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedStateChanged {
    key: String,
    source_id: String,
}

struct ManagedStateStoreInner {
    state_dir: PathBuf,
    lock: Mutex<()>,
}

#[derive(Clone)]
pub struct ManagedStateStore {
    inner: Arc<ManagedStateStoreInner>,
}

impl ManagedStateStore {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(ManagedStateStoreInner {
                state_dir,
                lock: Mutex::new(()),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.inner
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn bucket_path(&self, key: &str) -> Result<PathBuf, String> {
        let file = bucket_file_for_key(key)?;
        Ok(self.inner.state_dir.join(file))
    }

    pub fn get(&self, key: &str) -> Result<ManagedStateRead, String> {
        let _guard = self.lock();
        let path = self.bucket_path(key)?;
        let (document, recovered_backup) = read_document(&path)?;
        Ok(ManagedStateRead {
            initialized: document.initialized_keys.contains(key),
            value: document.values.get(key).cloned(),
            recovered_backup,
        })
    }

    /// Update one managed value while holding the same process-local lock for
    /// the read, backup repair, callback, and atomic replacement.
    ///
    /// The callback receives the current value and returns the replacement
    /// value together with its result. A callback error returns before any
    /// repair or write, so callers can fail closed without changing state.
    pub fn update_value<T>(
        &self,
        key: &str,
        update: impl FnOnce(Option<&str>) -> Result<(Option<String>, T), String>,
    ) -> Result<T, String> {
        let _guard = self.lock();
        let path = self.bucket_path(key)?;
        let (mut document, recovered_backup) = read_document(&path)?;
        let current = document.values.get(key).map(String::as_str);
        let (next_value, result) = update(current)?;

        if recovered_backup {
            restore_valid_backup_before_write(&path)?;
        }
        document.initialized_keys.insert(key.to_string());
        match next_value {
            Some(value) => {
                document.values.insert(key.to_string(), value);
            }
            None => {
                document.values.remove(key);
            }
        }
        write_document_atomic(&path, &document)?;
        Ok(result)
    }

    pub fn set(&self, key: &str, value: String) -> Result<(), String> {
        self.update_value(key, |_| Ok((Some(value), ())))
    }

    pub fn remove(&self, key: &str) -> Result<(), String> {
        self.mutate(key, |document| {
            document.initialized_keys.insert(key.to_string());
            document.values.remove(key);
        })
    }

    pub fn import_legacy(&self, key: &str, value: Option<String>) -> Result<bool, String> {
        self.mutate(key, |document| {
            if document.initialized_keys.contains(key) {
                return false;
            }
            document.initialized_keys.insert(key.to_string());
            if let Some(value) = value {
                document.values.insert(key.to_string(), value);
            } else {
                document.values.remove(key);
            }
            true
        })
    }

    fn mutate<T>(
        &self,
        key: &str,
        mutation: impl FnOnce(&mut ManagedStateDocument) -> T,
    ) -> Result<T, String> {
        let _guard = self.lock();
        let path = self.bucket_path(key)?;
        let (mut document, recovered_backup) = read_document(&path)?;
        if recovered_backup {
            restore_valid_backup_before_write(&path)?;
        }
        let result = mutation(&mut document);
        write_document_atomic(&path, &document)?;
        Ok(result)
    }
}

fn bucket_file_for_key(key: &str) -> Result<&'static str, String> {
    match key {
        TERMINAL_STORE_KEY => Ok("terminal.json"),
        WORKBENCH_STORE_KEY => Ok("workbench.json"),
        OVERLAY_STORE_KEY => Ok("overlay.json"),
        preference if PREFERENCE_KEYS.contains(&preference) => Ok("preferences.json"),
        _ => Err(format!(
            "Managed state key is not owned by ThreadTerm: {key}"
        )),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("state");
    path.with_file_name(format!("{stem}.previous.json"))
}

fn unique_temp_path(target: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state.json");
    target.with_file_name(format!(".{file_name}.{}-{nonce}.tmp", std::process::id()))
}

fn parse_document(path: &Path) -> Result<ManagedStateDocument, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let document: ManagedStateDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    document.validate(path)?;
    Ok(document)
}

fn read_document(path: &Path) -> Result<(ManagedStateDocument, bool), String> {
    if !path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            return parse_document(&backup).map(|document| (document, true));
        }
        return Ok((ManagedStateDocument::default(), false));
    }
    match parse_document(path) {
        Ok(document) => Ok((document, false)),
        Err(primary_error) => {
            let backup = backup_path(path);
            if !backup.exists() {
                return Err(primary_error);
            }
            parse_document(&backup)
                .map(|document| (document, true))
                .map_err(|_| primary_error)
        }
    }
}

pub(crate) fn validate_state_directory(state_dir: &Path) -> Result<(), String> {
    for file_name in [
        "terminal.json",
        "workbench.json",
        "overlay.json",
        "preferences.json",
    ] {
        let path = state_dir.join(file_name);
        read_document(&path).map_err(|error| {
            format!(
                "ThreadTerm interface state failed validation at {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn restore_valid_backup_before_write(path: &Path) -> Result<(), String> {
    let backup = backup_path(path);
    let corrupt = if path.exists() {
        let corrupt = path.with_extension(format!(
            "corrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        fs::rename(path, &corrupt).map_err(|error| {
            format!(
                "Could not quarantine corrupted managed state {}: {error}",
                path.display()
            )
        })?;
        Some(corrupt)
    } else {
        None
    };
    fs::copy(&backup, path).map_err(|error| {
        if let Some(corrupt) = &corrupt {
            let _ = fs::rename(corrupt, path);
        }
        format!(
            "Could not restore managed-state backup {}: {error}",
            backup.display()
        )
    })?;
    Ok(())
}

fn write_document_atomic(path: &Path, document: &ManagedStateDocument) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Managed-state file has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temp_path = unique_temp_path(path);
    let bytes = serde_json::to_vec(document)
        .map_err(|error| format!("Could not serialize managed state: {error}"))?;
    let mut temp = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("Could not create {}: {error}", temp_path.display()))?;
    temp.write_all(&bytes)
        .and_then(|_| temp.sync_all())
        .map_err(|error| format!("Could not persist {}: {error}", temp_path.display()))?;
    drop(temp);

    let backup = backup_path(path);
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                format!("Could not replace {}: {error}", backup.display())
            })?;
        }
        fs::rename(path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Could not preserve previous managed state {}: {error}",
                path.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temp_path, path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not activate managed state {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Managed-state worker failed: {error}"))?
}

fn set_managed_state_value(
    store: ManagedStateStore,
    key: String,
    value: String,
) -> Result<ManagedStateSetOutcome, String> {
    if key == TERMINAL_STORE_KEY {
        let startup_store =
            crate::terminal_startup_effect_store::TerminalStartupEffectStore::new(store);
        let outcome: crate::terminal_startup_effect_store::TerminalSnapshotMergeOutcome =
            startup_store.merge_webview_snapshot(value)?;
        return Ok(ManagedStateSetOutcome {
            reconciled: outcome.reconciled,
        });
    }
    store.set(&key, value)?;
    Ok(ManagedStateSetOutcome { reconciled: false })
}

fn emit_managed_state_changed(
    app: &tauri::AppHandle,
    key: String,
    source_id: String,
) -> Result<(), String> {
    app.emit(
        MANAGED_STATE_CHANGED_EVENT,
        ManagedStateChanged { key, source_id },
    )
    .map_err(|error| format!("Could not publish managed-state update: {error}"))
}

pub(crate) fn emit_terminal_startup_effects_changed(app: &tauri::AppHandle) -> Result<(), String> {
    emit_managed_state_changed(
        app,
        TERMINAL_STORE_KEY.to_string(),
        TERMINAL_STARTUP_EFFECTS_BACKEND_SOURCE_ID.to_string(),
    )
}

#[tauri::command]
pub async fn managed_state_get(
    state: tauri::State<'_, ManagedStateStore>,
    key: String,
) -> Result<ManagedStateRead, String> {
    let store = state.inner().clone();
    run_blocking(move || store.get(&key)).await
}

#[tauri::command]
pub async fn managed_state_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedStateStore>,
    key: String,
    value: String,
    source_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    let event_key = key.clone();
    let outcome = run_blocking(move || set_managed_state_value(store, key, value)).await?;
    let event_source = if outcome.reconciled {
        TERMINAL_STARTUP_EFFECTS_BACKEND_SOURCE_ID.to_string()
    } else {
        source_id
    };
    emit_managed_state_changed(&app, event_key, event_source)
}

#[tauri::command]
pub async fn managed_state_set_v2(
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedStateStore>,
    key: String,
    value: String,
    source_id: String,
) -> Result<ManagedStateSetOutcome, String> {
    let store = state.inner().clone();
    let event_key = key.clone();
    let outcome = run_blocking(move || set_managed_state_value(store, key, value)).await?;
    let event_source = if outcome.reconciled {
        TERMINAL_STARTUP_EFFECTS_BACKEND_SOURCE_ID.to_string()
    } else {
        source_id
    };
    emit_managed_state_changed(&app, event_key, event_source)?;
    Ok(outcome)
}

#[tauri::command]
pub async fn managed_state_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedStateStore>,
    key: String,
    source_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    let event_key = key.clone();
    run_blocking(move || store.remove(&key)).await?;
    app.emit(
        MANAGED_STATE_CHANGED_EVENT,
        ManagedStateChanged {
            key: event_key,
            source_id,
        },
    )
    .map_err(|error| format!("Could not publish managed-state removal: {error}"))
}

#[tauri::command]
pub async fn managed_state_import_legacy(
    app: tauri::AppHandle,
    state: tauri::State<'_, ManagedStateStore>,
    key: String,
    value: Option<String>,
    source_id: String,
) -> Result<ManagedStateWrite, String> {
    let store = state.inner().clone();
    let event_key = key.clone();
    let imported = run_blocking(move || store.import_legacy(&key, value)).await?;
    if imported {
        app.emit(
            MANAGED_STATE_CHANGED_EVENT,
            ManagedStateChanged {
                key: event_key,
                source_id,
            },
        )
        .map_err(|error| format!("Could not publish managed-state import: {error}"))?;
    }
    Ok(ManagedStateWrite { imported })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDirectory {
        path: PathBuf,
    }

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "threadterm-managed-state-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn only_threadterm_owned_keys_are_accepted() {
        assert_eq!(
            bucket_file_for_key(TERMINAL_STORE_KEY).expect("terminal key"),
            "terminal.json"
        );
        assert_eq!(
            bucket_file_for_key("userLanguage").expect("preference key"),
            "preferences.json"
        );
        assert_eq!(
            bucket_file_for_key("threadterm-workspace-sidebar-disclosure")
                .expect("workspace sidebar disclosure preference"),
            "preferences.json"
        );
        for rejected in [
            "C:/project/repo",
            ".codex",
            ".claude",
            "provider-session",
            "../escape",
        ] {
            assert!(bucket_file_for_key(rejected).is_err());
        }
    }

    #[test]
    fn set_read_and_remove_preserve_initialized_tombstone() {
        let fixture = TempDirectory::new("round-trip");
        let store = ManagedStateStore::new(fixture.path.clone());

        let initial = store.get(TERMINAL_STORE_KEY).expect("initial read");
        assert!(!initial.initialized);
        assert_eq!(initial.value, None);

        store
            .set(TERMINAL_STORE_KEY, "{\"state\":1}".to_string())
            .expect("set state");
        let stored = store.get(TERMINAL_STORE_KEY).expect("stored read");
        assert!(stored.initialized);
        assert_eq!(stored.value.as_deref(), Some("{\"state\":1}"));

        store.remove(TERMINAL_STORE_KEY).expect("remove state");
        let removed = store.get(TERMINAL_STORE_KEY).expect("removed read");
        assert!(removed.initialized);
        assert_eq!(removed.value, None);
    }

    #[test]
    fn update_value_returns_typed_result_and_replaces_atomically() {
        let fixture = TempDirectory::new("update-value");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(TERMINAL_STORE_KEY, "before".to_string())
            .expect("initial value");

        let result = store
            .update_value(TERMINAL_STORE_KEY, |current| {
                assert_eq!(current, Some("before"));
                Ok((Some("after".to_string()), 42_u32))
            })
            .expect("update value");

        assert_eq!(result, 42);
        assert_eq!(
            store
                .get(TERMINAL_STORE_KEY)
                .expect("read updated value")
                .value
                .as_deref(),
            Some("after")
        );
    }

    #[test]
    fn update_value_none_removes_value_but_keeps_initialized_tombstone() {
        let fixture = TempDirectory::new("update-remove");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(TERMINAL_STORE_KEY, "present".to_string())
            .expect("initial value");

        store
            .update_value(TERMINAL_STORE_KEY, |current| {
                assert_eq!(current, Some("present"));
                Ok((None, ()))
            })
            .expect("remove value");

        let read = store.get(TERMINAL_STORE_KEY).expect("read tombstone");
        assert!(read.initialized);
        assert_eq!(read.value, None);
    }

    #[test]
    fn update_value_error_does_not_change_value_or_file() {
        let fixture = TempDirectory::new("update-error");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(TERMINAL_STORE_KEY, "stable".to_string())
            .expect("initial value");
        let path = fixture.path.join("terminal.json");
        let before = fs::read(&path).expect("read before");

        let error = store
            .update_value(TERMINAL_STORE_KEY, |_current| {
                Err::<(Option<String>, ()), String>("reject update".to_string())
            })
            .expect_err("closure error");

        assert_eq!(error, "reject update");
        assert_eq!(fs::read(&path).expect("read after"), before);
        assert_eq!(
            store
                .get(TERMINAL_STORE_KEY)
                .expect("read unchanged value")
                .value
                .as_deref(),
            Some("stable")
        );
    }

    #[test]
    fn update_value_repairs_a_valid_backup_before_committing() {
        let fixture = TempDirectory::new("update-backup");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(TERMINAL_STORE_KEY, "first".to_string())
            .expect("first value");
        store
            .set(TERMINAL_STORE_KEY, "second".to_string())
            .expect("second value");
        fs::write(fixture.path.join("terminal.json"), b"{ interrupted").expect("corrupt primary");

        store
            .update_value(TERMINAL_STORE_KEY, |current| {
                assert_eq!(current, Some("first"));
                Ok((Some("third".to_string()), ()))
            })
            .expect("repair and update");

        let read = store.get(TERMINAL_STORE_KEY).expect("read repaired value");
        assert!(!read.recovered_backup);
        assert_eq!(read.value.as_deref(), Some("third"));
    }

    #[test]
    fn update_value_serializes_concurrent_read_modify_writes() {
        let fixture = TempDirectory::new("update-concurrent");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(TERMINAL_STORE_KEY, "0".to_string())
            .expect("initial counter");
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let worker_store = store.clone();
            let worker_barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                worker_barrier.wait();
                worker_store
                    .update_value(TERMINAL_STORE_KEY, |current| {
                        let value = current
                            .unwrap_or("0")
                            .parse::<u32>()
                            .expect("counter value");
                        Ok((Some((value + 1).to_string()), ()))
                    })
                    .expect("increment counter");
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().expect("worker completed");
        }

        assert_eq!(
            store
                .get(TERMINAL_STORE_KEY)
                .expect("read counter")
                .value
                .as_deref(),
            Some("2")
        );
    }

    #[test]
    fn legacy_import_is_once_only_and_never_overwrites_managed_state() {
        let fixture = TempDirectory::new("import");
        let store = ManagedStateStore::new(fixture.path.clone());
        assert!(store
            .import_legacy(WORKBENCH_STORE_KEY, Some("legacy".to_string()))
            .expect("first import"));
        assert!(!store
            .import_legacy(WORKBENCH_STORE_KEY, Some("stale".to_string()))
            .expect("second import"));
        assert_eq!(
            store
                .get(WORKBENCH_STORE_KEY)
                .expect("read imported")
                .value
                .as_deref(),
            Some("legacy")
        );
    }

    #[test]
    fn missing_legacy_value_becomes_an_initialized_tombstone() {
        let fixture = TempDirectory::new("missing-legacy");
        let store = ManagedStateStore::new(fixture.path.clone());

        assert!(store
            .import_legacy(WORKBENCH_STORE_KEY, None)
            .expect("record missing legacy value"));

        let read = store.get(WORKBENCH_STORE_KEY).expect("read tombstone");
        assert!(read.initialized);
        assert_eq!(read.value, None);

        assert!(!store
            .import_legacy(WORKBENCH_STORE_KEY, Some("stale".to_string()))
            .expect("repeat import"));
        assert_eq!(
            store
                .get(WORKBENCH_STORE_KEY)
                .expect("read unchanged tombstone")
                .value,
            None
        );
    }

    #[test]
    fn corrupted_primary_reads_the_last_valid_backup_instead_of_empty_state() {
        let fixture = TempDirectory::new("backup");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(OVERLAY_STORE_KEY, "first".to_string())
            .expect("first state");
        store
            .set(OVERLAY_STORE_KEY, "second".to_string())
            .expect("second state");
        fs::write(fixture.path.join("overlay.json"), b"{ interrupted").expect("corrupt primary");

        let recovered = store.get(OVERLAY_STORE_KEY).expect("recover backup");
        assert!(recovered.recovered_backup);
        assert_eq!(recovered.value.as_deref(), Some("first"));

        store
            .set(OVERLAY_STORE_KEY, "third".to_string())
            .expect("repair on next write");
        let repaired = store.get(OVERLAY_STORE_KEY).expect("read repaired");
        assert!(!repaired.recovered_backup);
        assert_eq!(repaired.value.as_deref(), Some("third"));
    }

    #[test]
    fn missing_primary_after_interrupted_switch_recovers_backup() {
        let fixture = TempDirectory::new("missing-primary");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set(OVERLAY_STORE_KEY, "first".to_string())
            .expect("first state");
        store
            .set(OVERLAY_STORE_KEY, "second".to_string())
            .expect("second state");
        fs::remove_file(fixture.path.join("overlay.json")).expect("simulate interrupted switch");

        let recovered = store.get(OVERLAY_STORE_KEY).expect("recover backup");
        assert!(recovered.recovered_backup);
        assert_eq!(recovered.value.as_deref(), Some("first"));

        store
            .set(OVERLAY_STORE_KEY, "third".to_string())
            .expect("repair on write");
        assert_eq!(
            store
                .get(OVERLAY_STORE_KEY)
                .expect("read repaired state")
                .value
                .as_deref(),
            Some("third")
        );
    }

    #[test]
    fn preference_keys_share_one_document_without_overwriting_each_other() {
        let fixture = TempDirectory::new("preferences");
        let store = ManagedStateStore::new(fixture.path.clone());
        store
            .set("userLanguage", "zh-CN".to_string())
            .expect("language");
        store.set("themeMode", "dark".to_string()).expect("theme");

        assert_eq!(
            store
                .get("userLanguage")
                .expect("read language")
                .value
                .as_deref(),
            Some("zh-CN")
        );
        assert_eq!(
            store.get("themeMode").expect("read theme").value.as_deref(),
            Some("dark")
        );
    }
}
