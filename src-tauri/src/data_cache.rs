use crate::data_directory::ResolvedDataRoot;
use fs2::FileExt;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const CACHE_CLEANUP_MARKER: &str = "cache-cleanup.request";
const CACHE_CLEANUP_LOCK: &str = "cache-cleanup.lock";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheCleanupStatus {
    pub supported: bool,
    pub scheduled: bool,
    pub restart_required: bool,
    pub bytes: u64,
    pub paths: Vec<PathBuf>,
}

#[derive(Default)]
struct DataCacheRuntimeInner {
    scheduled_lock: Mutex<Option<File>>,
}

#[derive(Clone, Default)]
pub struct DataCacheRuntime {
    inner: Arc<DataCacheRuntimeInner>,
}

impl DataCacheRuntime {
    fn lock_slot(&self) -> MutexGuard<'_, Option<File>> {
        self.inner
            .scheduled_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn hold(&self, lock: File) -> Result<(), String> {
        let mut slot = self.lock_slot();
        if slot.is_some() {
            return Err("Rebuildable cache cleanup is already scheduled.".to_string());
        }
        *slot = Some(lock);
        Ok(())
    }

    fn release(&self) {
        self.lock_slot().take();
    }
}

fn request_directory(active: &ResolvedDataRoot) -> Result<PathBuf, String> {
    if let Some(root) = active.root.as_ref() {
        return Ok(root.join("migration"));
    }
    active
        .state_dir
        .as_ref()
        .map(|state| state.join("migration"))
        .ok_or_else(|| "ThreadTerm has no writable state directory for cache cleanup.".to_string())
}

fn marker_path(active: &ResolvedDataRoot) -> Result<PathBuf, String> {
    request_directory(active).map(|path| path.join(CACHE_CLEANUP_MARKER))
}

fn lock_path(active: &ResolvedDataRoot) -> Result<PathBuf, String> {
    request_directory(active).map(|path| path.join(CACHE_CLEANUP_LOCK))
}

fn cache_paths(active: &ResolvedDataRoot) -> Vec<PathBuf> {
    let Some(webview) = active.webview_dir.as_ref() else {
        return Vec::new();
    };
    [
        webview.join("Default").join("Cache"),
        webview.join("Default").join("Code Cache"),
        webview.join("Default").join("GPUCache"),
        webview.join("Default").join("DawnCache"),
        webview
            .join("Default")
            .join("Service Worker")
            .join("CacheStorage"),
        webview
            .join("Default")
            .join("Service Worker")
            .join("ScriptCache"),
        webview.join("GrShaderCache"),
        webview.join("GraphiteDawnCache"),
        webview.join("ShaderCache"),
    ]
    .into_iter()
    .collect()
}

fn path_bytes(path: &Path) -> u64 {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return 0,
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let entry_metadata = match fs::symlink_metadata(&entry_path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if entry_metadata.file_type().is_symlink() {
                continue;
            }
            if entry_metadata.is_dir() {
                pending.push(entry_path);
            } else if entry_metadata.is_file() {
                total = total.saturating_add(entry_metadata.len());
            }
        }
    }
    total
}

fn status(active: &ResolvedDataRoot) -> Result<DataCacheCleanupStatus, String> {
    let paths = cache_paths(active);
    let supported = active.webview_dir.is_some();
    let scheduled = supported && marker_path(active)?.exists();
    let bytes = paths
        .iter()
        .fold(0_u64, |total, path| total.saturating_add(path_bytes(path)));
    Ok(DataCacheCleanupStatus {
        supported,
        scheduled,
        restart_required: scheduled,
        bytes,
        paths,
    })
}

fn open_lock(active: &ResolvedDataRoot) -> Result<File, String> {
    let path = lock_path(active)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Cache-cleanup lock has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn write_marker(active: &ResolvedDataRoot) -> Result<(), String> {
    let marker = marker_path(active)?;
    let parent = marker
        .parent()
        .ok_or_else(|| "Cache-cleanup request has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temp = marker.with_file_name(format!(
        ".{CACHE_CLEANUP_MARKER}.{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("Could not create {}: {error}", temp.display()))?;
    file.write_all(b"threadterm-cache-cleanup-v1")
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not persist {}: {error}", temp.display()))?;
    drop(file);
    fs::rename(&temp, &marker).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Could not schedule cache cleanup: {error}")
    })
}

fn schedule(
    active: &ResolvedDataRoot,
    runtime: &DataCacheRuntime,
) -> Result<DataCacheCleanupStatus, String> {
    if active.webview_dir.is_none() {
        return Err(
            "This platform keeps WebKit engine caches in a system-managed location.".to_string(),
        );
    }
    let lock = open_lock(active)?;
    lock.try_lock_exclusive().map_err(|_| {
        "Another ThreadTerm process is using the cache-cleanup request.".to_string()
    })?;
    runtime.hold(lock)?;
    if let Err(error) = write_marker(active) {
        runtime.release();
        return Err(error);
    }
    status(active)
}

fn cancel(
    active: &ResolvedDataRoot,
    runtime: &DataCacheRuntime,
) -> Result<DataCacheCleanupStatus, String> {
    let marker = marker_path(active)?;
    match fs::remove_file(&marker) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not remove {}: {error}", marker.display())),
    }
    runtime.release();
    status(active)
}

pub fn process_scheduled_cleanup(active: &ResolvedDataRoot) -> Result<(), String> {
    if active.webview_dir.is_none() {
        return Ok(());
    }
    let marker = marker_path(active)?;
    if !marker.exists() {
        return Ok(());
    }
    let lock = open_lock(active)?;
    lock.try_lock_exclusive().map_err(|_| {
        "Another ThreadTerm process is still using the rebuildable WebView cache.".to_string()
    })?;

    for path in cache_paths(active) {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "ThreadTerm refused to clean a symbolic-link cache path at {}.",
                path.display()
            ));
        }
        if metadata.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("Could not clean {}: {error}", path.display()))?;
        } else if metadata.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not clean {}: {error}", path.display()))?;
        }
    }
    fs::remove_file(&marker).map_err(|error| format!("Could not complete cache cleanup: {error}"))
}

#[tauri::command]
pub async fn data_cache_cleanup_status(
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<DataCacheCleanupStatus, String> {
    let active = active.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status(&active))
        .await
        .map_err(|error| format!("Could not inspect rebuildable cache: {error}"))?
}

#[tauri::command]
pub async fn data_cache_cleanup_schedule(
    active: tauri::State<'_, ResolvedDataRoot>,
    runtime: tauri::State<'_, DataCacheRuntime>,
) -> Result<DataCacheCleanupStatus, String> {
    let active = active.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || schedule(&active, &runtime))
        .await
        .map_err(|error| format!("Could not schedule rebuildable cache cleanup: {error}"))?
}

#[tauri::command]
pub async fn data_cache_cleanup_cancel(
    active: tauri::State<'_, ResolvedDataRoot>,
    runtime: tauri::State<'_, DataCacheRuntime>,
) -> Result<DataCacheCleanupStatus, String> {
    let active = active.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cancel(&active, &runtime))
        .await
        .map_err(|error| format!("Could not cancel rebuildable cache cleanup: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_directory::{DataDirectoryMode, DataRootLayout};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirectory {
        path: PathBuf,
    }

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "threadterm-data-cache-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("fixture");
            Self { path }
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn active(fixture: &TempDirectory) -> ResolvedDataRoot {
        let root = fixture.path.join("managed");
        let layout = DataRootLayout::new(&root);
        fs::create_dir_all(&layout.webview_dir).expect("webview");
        ResolvedDataRoot {
            mode: DataDirectoryMode::Managed,
            root: Some(root),
            database_file: layout.database_file,
            state_dir: Some(layout.state_dir),
            window_state_file: layout.window_state_file,
            webview_dir: Some(layout.webview_dir),
            bootstrap_pointer_path: fixture.path.join("config").join("data-location.json"),
            recovered_pointer_backup: false,
            startup_migration: None,
        }
    }

    #[test]
    fn scheduled_cleanup_waits_for_restart_and_deletes_cache_only() {
        let fixture = TempDirectory::new("scheduled");
        let active = active(&fixture);
        let cache = active
            .webview_dir
            .as_ref()
            .expect("webview")
            .join("Default")
            .join("Cache");
        let persistent = active
            .webview_dir
            .as_ref()
            .expect("webview")
            .join("Default")
            .join("Local Storage");
        fs::create_dir_all(&cache).expect("cache");
        fs::create_dir_all(&persistent).expect("persistent");
        fs::write(cache.join("cache.bin"), vec![7_u8; 32]).expect("cache data");
        fs::write(persistent.join("state.bin"), b"keep").expect("persistent state");
        let runtime = DataCacheRuntime::default();

        let scheduled = schedule(&active, &runtime).expect("schedule cleanup");
        assert!(scheduled.scheduled);
        assert!(cache.is_dir(), "running app never deletes live cache");

        runtime.release();
        process_scheduled_cleanup(&active).expect("startup cleanup");
        assert!(!cache.exists());
        assert!(persistent.is_dir(), "non-cache WebView data is retained");
        assert!(!status(&active).expect("status").scheduled);
    }

    #[test]
    fn scheduling_process_lock_prevents_another_process_from_cleaning_live_cache() {
        let fixture = TempDirectory::new("locked");
        let active = active(&fixture);
        let runtime = DataCacheRuntime::default();
        schedule(&active, &runtime).expect("schedule cleanup");

        assert!(process_scheduled_cleanup(&active)
            .expect_err("lock must block cleanup")
            .contains("still using"));
        cancel(&active, &runtime).expect("cancel cleanup");
    }
}
