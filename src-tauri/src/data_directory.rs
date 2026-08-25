use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};

pub const DATA_ROOT_FORMAT_VERSION: u32 = 1;
pub const DATA_ROOT_APP_ID: &str = "com.Heluth-Crazy.threadterm";
pub const BOOTSTRAP_POINTER_FILE: &str = "data-location.json";
pub const BOOTSTRAP_POINTER_BACKUP_FILE: &str = "data-location.previous.json";
pub const BOOTSTRAP_POINTER_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRootLayout {
    pub root: PathBuf,
    pub manifest: PathBuf,
    pub database_dir: PathBuf,
    pub database_file: PathBuf,
    pub state_dir: PathBuf,
    pub window_state_file: PathBuf,
    pub webview_dir: PathBuf,
    pub migration_dir: PathBuf,
}

impl DataRootLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let database_dir = root.join("database");
        let state_dir = root.join("state");
        Self {
            manifest: root.join("manifest.json"),
            database_file: database_dir.join("threadterm.db"),
            window_state_file: state_dir.join("window-state.json"),
            webview_dir: root.join("webview"),
            migration_dir: root.join("migration"),
            database_dir,
            state_dir,
            root,
        }
    }

    fn all_paths(&self) -> [&Path; 8] {
        [
            &self.root,
            &self.manifest,
            &self.database_dir,
            &self.database_file,
            &self.state_dir,
            &self.window_state_file,
            &self.webview_dir,
            &self.migration_dir,
        ]
    }

    pub fn is_self_contained(&self) -> bool {
        self.all_paths()
            .into_iter()
            .skip(1)
            .all(|path| path.starts_with(&self.root))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataRootManifest {
    pub app_id: String,
    pub format_version: u32,
}

impl Default for DataRootManifest {
    fn default() -> Self {
        Self {
            app_id: DATA_ROOT_APP_ID.to_string(),
            format_version: DATA_ROOT_FORMAT_VERSION,
        }
    }
}

impl DataRootManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.app_id != DATA_ROOT_APP_ID {
            return Err("The selected folder belongs to a different application.".to_string());
        }
        if self.format_version != DATA_ROOT_FORMAT_VERSION {
            return Err(format!(
                "Unsupported ThreadTerm data format version: {}.",
                self.format_version
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationPointer {
    pub pointer_version: u32,
    pub current_root: PathBuf,
    pub previous_root: Option<PathBuf>,
    pub pending_transaction_id: Option<String>,
}

impl DataLocationPointer {
    pub fn new(current_root: impl Into<PathBuf>, previous_root: Option<PathBuf>) -> Self {
        Self {
            pointer_version: BOOTSTRAP_POINTER_VERSION,
            current_root: current_root.into(),
            previous_root,
            pending_transaction_id: None,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.pointer_version != BOOTSTRAP_POINTER_VERSION {
            return Err(format!(
                "Unsupported ThreadTerm data-location pointer version: {}.",
                self.pointer_version
            ));
        }
        if !self.current_root.is_absolute() {
            return Err("ThreadTerm data-location pointer is not absolute.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDataRoot {
    pub mode: DataDirectoryMode,
    pub root: Option<PathBuf>,
    pub database_file: PathBuf,
    pub state_dir: Option<PathBuf>,
    pub window_state_file: PathBuf,
    pub webview_dir: Option<PathBuf>,
    pub bootstrap_pointer_path: PathBuf,
    pub recovered_pointer_backup: bool,
    pub startup_migration: Option<DataMigrationNotice>,
}

impl ResolvedDataRoot {
    fn legacy(database_dir: PathBuf, app_local_data_dir: PathBuf, app_config_dir: PathBuf) -> Self {
        let state_dir = database_dir.join("state");
        Self {
            mode: DataDirectoryMode::LegacySplit,
            root: None,
            database_file: database_dir.join("threadterm.db"),
            state_dir: Some(state_dir),
            window_state_file: app_config_dir.join(".window-state.json"),
            webview_dir: legacy_webview_dir(app_local_data_dir),
            bootstrap_pointer_path: app_config_dir.join(BOOTSTRAP_POINTER_FILE),
            recovered_pointer_backup: false,
            startup_migration: None,
        }
    }

    fn managed(
        root: PathBuf,
        bootstrap_pointer_path: PathBuf,
        recovered_pointer_backup: bool,
    ) -> Self {
        let layout = DataRootLayout::new(&root);
        Self {
            mode: DataDirectoryMode::Managed,
            root: Some(root),
            database_file: layout.database_file,
            state_dir: Some(layout.state_dir),
            window_state_file: layout.window_state_file,
            webview_dir: managed_webview_dir(layout.webview_dir),
            bootstrap_pointer_path,
            recovered_pointer_backup,
            startup_migration: None,
        }
    }
}

pub fn apply_webview_data_directory<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, AppHandle<R>>,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let data_directory = app.state::<ResolvedDataRoot>().webview_dir.clone();
    if let Some(data_directory) = data_directory {
        builder.data_directory(data_directory)
    } else {
        builder
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataMigrationPhase {
    Idle,
    Preflight,
    Scheduled,
    CopyingToStaging,
    Verifying,
    PointerSwitched,
    FirstLaunchConfirmed,
    OldDataCleanup,
    RollbackToSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataMigrationNotice {
    pub transaction_id: String,
    pub target_root: PathBuf,
    pub phase: DataMigrationPhase,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataDirectoryMode {
    LegacySplit,
    Managed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DataCategory {
    Database,
    DesktopState,
    WindowState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataCategoryDiagnostic {
    pub category: DataCategory,
    pub paths: Vec<PathBuf>,
    pub bytes: u64,
    pub file_count: u64,
    pub exists: bool,
    pub measurable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryStatus {
    pub mode: DataDirectoryMode,
    pub root: Option<PathBuf>,
    pub application_path: PathBuf,
    pub recommended_root: PathBuf,
    pub bootstrap_pointer_path: PathBuf,
    pub categories: Vec<DataCategoryDiagnostic>,
    pub total_bytes: u64,
    pub platform_notes: Vec<String>,
    pub startup_migration: Option<DataMigrationNotice>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataPreflightErrorCode {
    EmptyPath,
    RelativePath,
    SourceOrChild,
    ApplicationDirectory,
    MacApplicationBundle,
    FileTarget,
    SymbolicLink,
    NonEmptyTarget,
    NotWritable,
    InsufficientSpace,
    NetworkLocation,
    SourceUnavailable,
    SourceSymbolicLink,
    InputOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataPreflightError {
    pub code: DataPreflightErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPreflightFacts {
    pub target_is_empty: bool,
    pub target_is_absolute: bool,
    pub source_or_child: bool,
    pub application_directory: bool,
    pub mac_application_bundle: bool,
    pub target_is_file: bool,
    pub target_is_symlink: bool,
    pub target_is_non_empty: bool,
    pub target_is_writable: bool,
    pub network_location: bool,
    pub required_bytes: u64,
    pub available_bytes: u64,
}

impl Default for DataPreflightFacts {
    fn default() -> Self {
        Self {
            target_is_empty: false,
            target_is_absolute: true,
            source_or_child: false,
            application_directory: false,
            mac_application_bundle: false,
            target_is_file: false,
            target_is_symlink: false,
            target_is_non_empty: false,
            target_is_writable: true,
            network_location: false,
            required_bytes: 0,
            available_bytes: u64::MAX,
        }
    }
}

pub fn validate_preflight_facts(facts: &DataPreflightFacts) -> Result<(), DataPreflightError> {
    let failure = if facts.target_is_empty {
        Some((DataPreflightErrorCode::EmptyPath, "Choose a data folder."))
    } else if !facts.target_is_absolute {
        Some((
            DataPreflightErrorCode::RelativePath,
            "The data folder must use an absolute path.",
        ))
    } else if facts.source_or_child {
        Some((
            DataPreflightErrorCode::SourceOrChild,
            "Choose a folder outside the current ThreadTerm data folder.",
        ))
    } else if facts.application_directory {
        Some((
            DataPreflightErrorCode::ApplicationDirectory,
            "ThreadTerm data cannot be stored inside the application installation.",
        ))
    } else if facts.mac_application_bundle {
        Some((
            DataPreflightErrorCode::MacApplicationBundle,
            "ThreadTerm data cannot be stored inside a macOS application bundle.",
        ))
    } else if facts.target_is_file {
        Some((
            DataPreflightErrorCode::FileTarget,
            "The selected data path is a file.",
        ))
    } else if facts.target_is_symlink {
        Some((
            DataPreflightErrorCode::SymbolicLink,
            "Symbolic-link data folders are not supported.",
        ))
    } else if facts.target_is_non_empty {
        Some((
            DataPreflightErrorCode::NonEmptyTarget,
            "The selected folder already contains unrelated files.",
        ))
    } else if !facts.target_is_writable {
        Some((
            DataPreflightErrorCode::NotWritable,
            "ThreadTerm cannot write to the selected folder.",
        ))
    } else if facts.network_location {
        Some((
            DataPreflightErrorCode::NetworkLocation,
            "Network folders are not supported for ThreadTerm data.",
        ))
    } else if facts.available_bytes < facts.required_bytes {
        Some((
            DataPreflightErrorCode::InsufficientSpace,
            "The selected disk does not have enough free space.",
        ))
    } else {
        None
    };

    match failure {
        Some((code, message)) => Err(DataPreflightError {
            code,
            message: message.to_string(),
        }),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PathUsage {
    bytes: u64,
    file_count: u64,
    exists: bool,
}

fn measure_path(path: &Path) -> PathUsage {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return PathUsage::default(),
    };

    if metadata.file_type().is_symlink() {
        return PathUsage {
            exists: true,
            ..PathUsage::default()
        };
    }

    if metadata.is_file() {
        return PathUsage {
            bytes: metadata.len(),
            file_count: 1,
            exists: true,
        };
    }

    if !metadata.is_dir() {
        return PathUsage {
            exists: true,
            ..PathUsage::default()
        };
    }

    let mut usage = PathUsage {
        exists: true,
        ..PathUsage::default()
    };
    let mut pending = vec![path.to_path_buf()];
    let mut visited = HashSet::new();

    while let Some(directory) = pending.pop() {
        let canonical = directory
            .canonicalize()
            .unwrap_or_else(|_| directory.clone());
        if !visited.insert(canonical) {
            continue;
        }

        let entries = match fs::read_dir(&directory) {
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
                usage.bytes = usage.bytes.saturating_add(entry_metadata.len());
                usage.file_count = usage.file_count.saturating_add(1);
            }
        }
    }

    usage
}

fn category_diagnostic(
    category: DataCategory,
    paths: Vec<PathBuf>,
    measurable: bool,
) -> DataCategoryDiagnostic {
    let usage = if measurable {
        paths
            .iter()
            .map(|path| measure_path(path))
            .fold(PathUsage::default(), |total, usage| PathUsage {
                bytes: total.bytes.saturating_add(usage.bytes),
                file_count: total.file_count.saturating_add(usage.file_count),
                exists: total.exists || usage.exists,
            })
    } else {
        PathUsage::default()
    };
    DataCategoryDiagnostic {
        category,
        paths,
        bytes: usage.bytes,
        file_count: usage.file_count,
        exists: usage.exists,
        measurable,
    }
}

pub fn legacy_database_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".threadterm")
}

fn legacy_webview_dir(app_local_data_dir: PathBuf) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Some(app_local_data_dir.join("EBWebView"))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app_local_data_dir;
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Some(app_local_data_dir)
    }
}

fn managed_webview_dir(path: PathBuf) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let _ = path;
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(path)
    }
}

pub fn bootstrap_config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .map(|config| config.join(DATA_ROOT_APP_ID))
        .ok_or_else(|| "Could not resolve ThreadTerm bootstrap config directory.".to_string())
}

fn legacy_app_local_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|data| data.join(DATA_ROOT_APP_ID))
        .ok_or_else(|| "Could not resolve ThreadTerm local data directory.".to_string())
}

fn read_pointer_file(path: &Path) -> Result<Option<DataLocationPointer>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let pointer: DataLocationPointer = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    pointer.validate()?;
    Ok(Some(pointer))
}

pub(crate) fn read_location_pointer(
    pointer_path: &Path,
) -> Result<Option<(DataLocationPointer, bool)>, String> {
    match read_pointer_file(pointer_path) {
        Ok(Some(pointer)) => Ok(Some((pointer, false))),
        Ok(None) => {
            let backup_path = pointer_path.with_file_name(BOOTSTRAP_POINTER_BACKUP_FILE);
            read_pointer_file(&backup_path).map(|pointer| pointer.map(|pointer| (pointer, true)))
        }
        Err(primary_error) => {
            let backup_path = pointer_path.with_file_name(BOOTSTRAP_POINTER_BACKUP_FILE);
            match read_pointer_file(&backup_path) {
                Ok(Some(pointer)) => Ok(Some((pointer, true))),
                Ok(None) | Err(_) => Err(primary_error),
            }
        }
    }
}

pub(crate) fn validate_managed_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("ThreadTerm data folder is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("ThreadTerm data folder cannot be a symbolic link.".to_string());
    }
    if !metadata.is_dir() {
        return Err("ThreadTerm data location is not a directory.".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve ThreadTerm data folder: {error}"))?;
    let manifest_path = canonical.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "ThreadTerm data manifest is unavailable at {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: DataRootManifest = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        format!(
            "ThreadTerm data manifest is invalid at {}: {error}",
            manifest_path.display()
        )
    })?;
    manifest.validate()?;
    Ok(canonical)
}

fn resolve_data_root_from(
    bootstrap_dir: PathBuf,
    legacy_database_dir: PathBuf,
    legacy_local_data_dir: PathBuf,
    legacy_config_dir: PathBuf,
) -> Result<ResolvedDataRoot, String> {
    let pointer_path = bootstrap_dir.join(BOOTSTRAP_POINTER_FILE);
    let startup_migration = crate::data_migration::process_pending_startup(&pointer_path)?;
    let Some((pointer, recovered_pointer_backup)) = read_location_pointer(&pointer_path)? else {
        let mut resolved = ResolvedDataRoot::legacy(
            legacy_database_dir,
            legacy_local_data_dir,
            legacy_config_dir,
        );
        resolved.startup_migration = startup_migration;
        return Ok(resolved);
    };
    let canonical_root = validate_managed_root(&pointer.current_root)?;
    let mut resolved =
        ResolvedDataRoot::managed(canonical_root, pointer_path, recovered_pointer_backup);
    resolved.startup_migration = startup_migration;
    Ok(resolved)
}

#[cfg(feature = "terminal-startup-harness")]
const TERMINAL_STARTUP_HARNESS_ROOT_ENV: &str = "THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT";
#[cfg(feature = "terminal-startup-harness")]
const TERMINAL_STARTUP_HARNESS_MARKER_FILE: &str = ".threadterm-terminal-startup-harness";
#[cfg(feature = "terminal-startup-harness")]
const TERMINAL_STARTUP_HARNESS_MARKER: &[u8] = b"threadterm-terminal-startup-harness-v1\n";

#[cfg(feature = "terminal-startup-harness")]
fn terminal_startup_harness_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(feature = "terminal-startup-harness")]
fn resolve_terminal_startup_harness_data_root() -> Result<ResolvedDataRoot, String> {
    let raw_sandbox = std::env::var(TERMINAL_STARTUP_HARNESS_ROOT_ENV).map_err(|error| {
        if matches!(error, std::env::VarError::NotPresent) {
            "terminal_startup_harness_root_missing".to_string()
        } else {
            "terminal_startup_harness_root_invalid".to_string()
        }
    })?;
    if raw_sandbox.is_empty() {
        return Err("terminal_startup_harness_root_empty".to_string());
    }

    let sandbox = PathBuf::from(raw_sandbox);
    if !sandbox.is_absolute() {
        return Err("terminal_startup_harness_root_relative".to_string());
    }

    let sandbox_metadata = fs::symlink_metadata(&sandbox)
        .map_err(|_| "terminal_startup_harness_root_invalid".to_string())?;
    if terminal_startup_harness_is_link_or_reparse(&sandbox_metadata) || !sandbox_metadata.is_dir()
    {
        return Err("terminal_startup_harness_root_invalid".to_string());
    }
    let canonical_sandbox = sandbox
        .canonicalize()
        .map_err(|_| "terminal_startup_harness_root_invalid".to_string())?;

    let marker_path = canonical_sandbox.join(TERMINAL_STARTUP_HARNESS_MARKER_FILE);
    let marker_metadata = fs::symlink_metadata(&marker_path)
        .map_err(|_| "terminal_startup_harness_marker_invalid".to_string())?;
    if terminal_startup_harness_is_link_or_reparse(&marker_metadata) || !marker_metadata.is_file() {
        return Err("terminal_startup_harness_marker_invalid".to_string());
    }
    let marker = fs::read(&marker_path)
        .map_err(|_| "terminal_startup_harness_marker_invalid".to_string())?;
    if marker.as_slice() != TERMINAL_STARTUP_HARNESS_MARKER {
        return Err("terminal_startup_harness_marker_invalid".to_string());
    }

    let app_data = sandbox.join("app-data");
    let app_data_metadata = fs::symlink_metadata(&app_data)
        .map_err(|_| "terminal_startup_harness_app_data_invalid".to_string())?;
    if terminal_startup_harness_is_link_or_reparse(&app_data_metadata)
        || !app_data_metadata.is_dir()
    {
        return Err("terminal_startup_harness_app_data_invalid".to_string());
    }
    let canonical_app_data = app_data
        .canonicalize()
        .map_err(|_| "terminal_startup_harness_app_data_invalid".to_string())?;
    let validated_app_data = validate_managed_root(&app_data)
        .map_err(|_| "terminal_startup_harness_app_data_invalid".to_string())?;
    if validated_app_data != canonical_app_data
        || !canonical_app_data.starts_with(&canonical_sandbox)
    {
        return Err("terminal_startup_harness_app_data_invalid".to_string());
    }

    let manifest_path = canonical_app_data.join("manifest.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "terminal_startup_harness_manifest_invalid".to_string())?;
    if terminal_startup_harness_is_link_or_reparse(&manifest_metadata)
        || !manifest_metadata.is_file()
    {
        return Err("terminal_startup_harness_manifest_invalid".to_string());
    }
    let canonical_manifest = manifest_path
        .canonicalize()
        .map_err(|_| "terminal_startup_harness_manifest_invalid".to_string())?;
    if !canonical_manifest.starts_with(&canonical_app_data)
        || !canonical_manifest.starts_with(&canonical_sandbox)
    {
        return Err("terminal_startup_harness_manifest_invalid".to_string());
    }

    for child_name in ["database", "state", "webview", "migration"] {
        let child = canonical_app_data.join(child_name);
        let metadata = fs::symlink_metadata(&child)
            .map_err(|_| "terminal_startup_harness_layout_invalid".to_string())?;
        if terminal_startup_harness_is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err("terminal_startup_harness_layout_invalid".to_string());
        }
        let canonical_child = child
            .canonicalize()
            .map_err(|_| "terminal_startup_harness_layout_invalid".to_string())?;
        if !canonical_child.starts_with(&canonical_app_data)
            || !canonical_child.starts_with(&canonical_sandbox)
        {
            return Err("terminal_startup_harness_layout_invalid".to_string());
        }
    }

    let bootstrap = canonical_sandbox.join("bootstrap");
    let bootstrap_metadata = fs::symlink_metadata(&bootstrap)
        .map_err(|_| "terminal_startup_harness_layout_invalid".to_string())?;
    if terminal_startup_harness_is_link_or_reparse(&bootstrap_metadata)
        || !bootstrap_metadata.is_dir()
    {
        return Err("terminal_startup_harness_layout_invalid".to_string());
    }
    let canonical_bootstrap = bootstrap
        .canonicalize()
        .map_err(|_| "terminal_startup_harness_layout_invalid".to_string())?;
    if !canonical_bootstrap.starts_with(&canonical_sandbox) {
        return Err("terminal_startup_harness_layout_invalid".to_string());
    }
    let isolated_pointer = canonical_bootstrap.join(BOOTSTRAP_POINTER_FILE);
    Ok(ResolvedDataRoot::managed(
        canonical_app_data,
        isolated_pointer,
        false,
    ))
}

fn terminal_startup_harness_data_root_override() -> Option<Result<ResolvedDataRoot, String>> {
    #[cfg(feature = "terminal-startup-harness")]
    {
        if !crate::terminal_startup_harness::offline_attestation().is_enabled() {
            return Some(Err("terminal_startup_harness_offline_required".to_string()));
        }
        Some(resolve_terminal_startup_harness_data_root())
    }
    #[cfg(not(feature = "terminal-startup-harness"))]
    {
        None
    }
}

pub fn resolve_startup_data_root() -> Result<ResolvedDataRoot, String> {
    if let Some(harness_data_root) = terminal_startup_harness_data_root_override() {
        return harness_data_root;
    }

    let bootstrap_dir = bootstrap_config_dir()?;
    resolve_data_root_from(
        bootstrap_dir.clone(),
        legacy_database_dir(),
        legacy_app_local_data_dir()?,
        bootstrap_dir,
    )
}

fn unique_temp_path(target: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data-location.json");
    target.with_file_name(format!(".{file_name}.{}-{nonce}.tmp", std::process::id()))
}

pub fn write_location_pointer_atomic(
    pointer_path: &Path,
    pointer: &DataLocationPointer,
) -> Result<(), String> {
    pointer.validate()?;
    let parent = pointer_path
        .parent()
        .ok_or_else(|| "Data-location pointer has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let temp_path = unique_temp_path(pointer_path);
    let bytes = serde_json::to_vec_pretty(pointer)
        .map_err(|error| format!("Could not serialize data-location pointer: {error}"))?;
    let mut temp = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("Could not create {}: {error}", temp_path.display()))?;
    temp.write_all(&bytes)
        .and_then(|_| temp.sync_all())
        .map_err(|error| format!("Could not persist {}: {error}", temp_path.display()))?;
    drop(temp);

    let backup_path = pointer_path.with_file_name(BOOTSTRAP_POINTER_BACKUP_FILE);
    if pointer_path.exists() {
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                format!(
                    "Could not replace data-location backup {}: {error}",
                    backup_path.display()
                )
            })?;
        }
        fs::rename(pointer_path, &backup_path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Could not preserve previous data location {}: {error}",
                pointer_path.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&temp_path, pointer_path) {
        if backup_path.exists() && !pointer_path.exists() {
            let _ = fs::rename(&backup_path, pointer_path);
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not activate data-location pointer {}: {error}",
            pointer_path.display()
        ));
    }
    Ok(())
}

fn build_managed_status(
    active: &ResolvedDataRoot,
    application_path: PathBuf,
    recommended_root: PathBuf,
) -> DataDirectoryStatus {
    let database_dir = active
        .database_file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| active.database_file.clone());
    let database = category_diagnostic(DataCategory::Database, vec![database_dir], true);

    let mut desktop_paths = active.state_dir.iter().cloned().collect::<Vec<_>>();
    if let Some(webview_dir) = &active.webview_dir {
        desktop_paths.push(webview_dir.clone());
    }
    let mut desktop_state = category_diagnostic(DataCategory::DesktopState, desktop_paths, true);
    let window_state = category_diagnostic(
        DataCategory::WindowState,
        vec![active.window_state_file.clone()],
        true,
    );
    if active
        .state_dir
        .as_ref()
        .is_some_and(|state_dir| active.window_state_file.starts_with(state_dir))
    {
        desktop_state.bytes = desktop_state.bytes.saturating_sub(window_state.bytes);
        desktop_state.file_count = desktop_state
            .file_count
            .saturating_sub(window_state.file_count);
    }
    let categories = vec![database, desktop_state, window_state];
    let total_bytes = categories.iter().fold(0_u64, |total, category| {
        total.saturating_add(category.bytes)
    });

    #[cfg(target_os = "macos")]
    let platform_notes = vec![
        "macOS keeps WebKit engine caches in a system-managed location; ThreadTerm business state is stored in the selected data root.".to_string(),
    ];
    #[cfg(not(target_os = "macos"))]
    let platform_notes = Vec::new();

    DataDirectoryStatus {
        mode: DataDirectoryMode::Managed,
        root: active.root.clone(),
        application_path,
        recommended_root,
        bootstrap_pointer_path: active.bootstrap_pointer_path.clone(),
        categories,
        total_bytes,
        platform_notes,
        startup_migration: active.startup_migration.clone(),
    }
}

fn build_legacy_status(
    app_local_data_dir: PathBuf,
    app_config_dir: PathBuf,
    startup_migration: Option<DataMigrationNotice>,
    application_path: PathBuf,
    recommended_root: PathBuf,
) -> DataDirectoryStatus {
    let database = category_diagnostic(DataCategory::Database, vec![legacy_database_dir()], true);

    #[cfg(target_os = "windows")]
    let desktop_state = category_diagnostic(
        DataCategory::DesktopState,
        vec![app_local_data_dir.join("EBWebView")],
        true,
    );
    #[cfg(target_os = "macos")]
    let desktop_state = category_diagnostic(DataCategory::DesktopState, Vec::new(), false);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let desktop_state =
        category_diagnostic(DataCategory::DesktopState, vec![app_local_data_dir], true);

    let window_state = category_diagnostic(
        DataCategory::WindowState,
        vec![app_config_dir.join(".window-state.json")],
        true,
    );
    let categories = vec![database, desktop_state, window_state];
    let total_bytes = categories.iter().fold(0_u64, |total, category| {
        total.saturating_add(category.bytes)
    });

    #[cfg(target_os = "macos")]
    let platform_notes = vec![
        "macOS keeps WebKit engine caches in a system-managed location; ThreadTerm business state will move to the selected data root.".to_string(),
    ];
    #[cfg(not(target_os = "macos"))]
    let platform_notes = Vec::new();

    DataDirectoryStatus {
        mode: DataDirectoryMode::LegacySplit,
        root: None,
        application_path,
        recommended_root,
        bootstrap_pointer_path: app_config_dir.join(BOOTSTRAP_POINTER_FILE),
        categories,
        total_bytes,
        platform_notes,
        startup_migration,
    }
}

#[cfg(feature = "terminal-startup-harness")]
fn terminal_startup_harness_recommended_root(active: &ResolvedDataRoot) -> Result<PathBuf, String> {
    active
        .root
        .clone()
        .ok_or_else(|| "terminal_startup_harness_root_unavailable".to_string())
}

#[tauri::command]
#[allow(unreachable_code)]
pub async fn data_directory_status(
    app: tauri::AppHandle,
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<DataDirectoryStatus, String> {
    let _ = &app;
    #[cfg(feature = "terminal-startup-harness")]
    {
        if !crate::terminal_startup_harness::offline_attestation().is_enabled() {
            return Err("terminal_startup_harness_offline_required".to_string());
        }
        let active = active.inner().clone();
        let recommended_root = terminal_startup_harness_recommended_root(&active)?;
        let application_path = std::env::current_exe().map_err(|error| {
            format!("Could not resolve the ThreadTerm application path: {error}")
        })?;
        return tauri::async_runtime::spawn_blocking(move || {
            build_managed_status(&active, application_path, recommended_root)
        })
        .await
        .map_err(|error| format!("Could not inspect ThreadTerm data usage: {error}"));
    }

    let application_path = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the ThreadTerm application path: {error}"))?;
    let recommended_root = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve the recommended data directory: {error}"))?
        .join("ThreadTerm Data");

    if active.mode == DataDirectoryMode::Managed {
        let active = active.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            build_managed_status(&active, application_path, recommended_root)
        })
        .await
        .map_err(|error| format!("Could not inspect ThreadTerm data usage: {error}"));
    }

    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve ThreadTerm local data directory: {error}"))?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve ThreadTerm config directory: {error}"))?;

    let startup_migration = active.startup_migration.clone();
    tauri::async_runtime::spawn_blocking(move || {
        build_legacy_status(
            app_local_data_dir,
            app_config_dir,
            startup_migration,
            application_path,
            recommended_root,
        )
    })
    .await
    .map_err(|error| format!("Could not inspect ThreadTerm data usage: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[cfg(feature = "terminal-startup-harness")]
    use std::{
        ffi::OsString,
        sync::{Mutex, OnceLock},
    };

    #[cfg(feature = "terminal-startup-harness")]
    static TERMINAL_STARTUP_HARNESS_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
                "threadterm-data-directory-{label}-{}-{nonce}",
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

    fn prepare_managed_root(root: &Path) {
        fs::create_dir_all(root.join("database")).expect("database directory");
        fs::create_dir_all(root.join("state")).expect("state directory");
        fs::create_dir_all(root.join("webview")).expect("webview directory");
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&DataRootManifest::default()).expect("manifest json"),
        )
        .expect("manifest");
    }

    #[cfg(feature = "terminal-startup-harness")]
    fn prepare_terminal_startup_harness_root(root: &Path) {
        let app_data = root.join("app-data");
        for child in ["database", "state", "webview", "migration"] {
            fs::create_dir_all(app_data.join(child)).expect("harness layout directory");
        }
        fs::create_dir_all(root.join("bootstrap")).expect("harness bootstrap directory");
        fs::write(
            root.join(TERMINAL_STARTUP_HARNESS_MARKER_FILE),
            TERMINAL_STARTUP_HARNESS_MARKER,
        )
        .expect("harness marker");
        fs::write(
            app_data.join("manifest.json"),
            serde_json::to_vec(&DataRootManifest::default()).expect("manifest json"),
        )
        .expect("harness manifest");
    }

    #[cfg(feature = "terminal-startup-harness")]
    struct TerminalStartupHarnessEnvGuard {
        previous: Option<OsString>,
    }

    #[cfg(feature = "terminal-startup-harness")]
    impl TerminalStartupHarnessEnvGuard {
        fn set(root: Option<&Path>) -> Self {
            let previous = std::env::var_os(TERMINAL_STARTUP_HARNESS_ROOT_ENV);
            match root {
                Some(root) => std::env::set_var(TERMINAL_STARTUP_HARNESS_ROOT_ENV, root),
                None => std::env::remove_var(TERMINAL_STARTUP_HARNESS_ROOT_ENV),
            }
            Self { previous }
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    impl Drop for TerminalStartupHarnessEnvGuard {
        fn drop(&mut self) {
            match self.previous.as_ref() {
                Some(previous) => std::env::set_var(TERMINAL_STARTUP_HARNESS_ROOT_ENV, previous),
                None => std::env::remove_var(TERMINAL_STARTUP_HARNESS_ROOT_ENV),
            }
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    struct TerminalStartupHarnessOfflineEnvGuard {
        previous: Option<OsString>,
    }

    #[cfg(feature = "terminal-startup-harness")]
    impl TerminalStartupHarnessOfflineEnvGuard {
        fn set(value: Option<&str>) -> Self {
            let previous = std::env::var_os(
                crate::terminal_startup_harness::TERMINAL_STARTUP_HARNESS_OFFLINE_ENV,
            );
            match value {
                Some(value) => std::env::set_var(
                    crate::terminal_startup_harness::TERMINAL_STARTUP_HARNESS_OFFLINE_ENV,
                    value,
                ),
                None => std::env::remove_var(
                    crate::terminal_startup_harness::TERMINAL_STARTUP_HARNESS_OFFLINE_ENV,
                ),
            }
            Self { previous }
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    impl Drop for TerminalStartupHarnessOfflineEnvGuard {
        fn drop(&mut self) {
            match self.previous.as_ref() {
                Some(previous) => std::env::set_var(
                    crate::terminal_startup_harness::TERMINAL_STARTUP_HARNESS_OFFLINE_ENV,
                    previous,
                ),
                None => std::env::remove_var(
                    crate::terminal_startup_harness::TERMINAL_STARTUP_HARNESS_OFFLINE_ENV,
                ),
            }
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    fn lock_terminal_startup_harness_env() -> std::sync::MutexGuard<'static, ()> {
        TERMINAL_STARTUP_HARNESS_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("harness environment lock")
    }

    #[test]
    fn managed_layout_is_self_contained_and_versioned() {
        let root = PathBuf::from("D:/ThreadTermData");
        let layout = DataRootLayout::new(&root);

        assert!(layout.is_self_contained());
        assert_eq!(layout.manifest, root.join("manifest.json"));
        assert_eq!(
            layout.database_file,
            root.join("database").join("threadterm.db")
        );
        assert_eq!(
            layout.window_state_file,
            root.join("state").join("window-state.json")
        );
        assert_eq!(layout.webview_dir, root.join("webview"));
        assert_eq!(layout.migration_dir, root.join("migration"));
    }

    #[test]
    fn manifest_round_trip_rejects_other_apps_and_versions() {
        let manifest = DataRootManifest::default();
        let json = serde_json::to_string(&manifest).expect("serialize manifest");
        let restored: DataRootManifest = serde_json::from_str(&json).expect("deserialize manifest");
        assert_eq!(restored, manifest);
        assert!(restored.validate().is_ok());

        let mut other_app = restored.clone();
        other_app.app_id = "example.other.app".to_string();
        assert!(other_app.validate().is_err());

        let mut future = restored;
        future.format_version += 1;
        assert!(future.validate().is_err());
    }

    #[test]
    fn migration_phases_have_stable_restart_safe_wire_values() {
        let phases = [
            (DataMigrationPhase::Idle, "\"idle\""),
            (DataMigrationPhase::Preflight, "\"preflight\""),
            (DataMigrationPhase::Scheduled, "\"scheduled\""),
            (
                DataMigrationPhase::CopyingToStaging,
                "\"copying_to_staging\"",
            ),
            (DataMigrationPhase::Verifying, "\"verifying\""),
            (DataMigrationPhase::PointerSwitched, "\"pointer_switched\""),
            (
                DataMigrationPhase::FirstLaunchConfirmed,
                "\"first_launch_confirmed\"",
            ),
            (DataMigrationPhase::OldDataCleanup, "\"old_data_cleanup\""),
            (
                DataMigrationPhase::RollbackToSource,
                "\"rollback_to_source\"",
            ),
        ];

        for (phase, expected) in phases {
            let encoded = serde_json::to_string(&phase).expect("serialize phase");
            assert_eq!(encoded, expected);
            let decoded: DataMigrationPhase =
                serde_json::from_str(&encoded).expect("deserialize phase");
            assert_eq!(decoded, phase);
        }
    }

    #[test]
    fn preflight_accepts_only_safe_writable_empty_targets_with_space() {
        assert!(validate_preflight_facts(&DataPreflightFacts {
            required_bytes: 512,
            available_bytes: 1024,
            ..DataPreflightFacts::default()
        })
        .is_ok());

        let cases = [
            (
                DataPreflightFacts {
                    target_is_empty: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::EmptyPath,
            ),
            (
                DataPreflightFacts {
                    target_is_absolute: false,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::RelativePath,
            ),
            (
                DataPreflightFacts {
                    source_or_child: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::SourceOrChild,
            ),
            (
                DataPreflightFacts {
                    application_directory: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::ApplicationDirectory,
            ),
            (
                DataPreflightFacts {
                    mac_application_bundle: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::MacApplicationBundle,
            ),
            (
                DataPreflightFacts {
                    target_is_file: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::FileTarget,
            ),
            (
                DataPreflightFacts {
                    target_is_symlink: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::SymbolicLink,
            ),
            (
                DataPreflightFacts {
                    target_is_non_empty: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::NonEmptyTarget,
            ),
            (
                DataPreflightFacts {
                    target_is_writable: false,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::NotWritable,
            ),
            (
                DataPreflightFacts {
                    network_location: true,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::NetworkLocation,
            ),
            (
                DataPreflightFacts {
                    required_bytes: 1024,
                    available_bytes: 512,
                    ..DataPreflightFacts::default()
                },
                DataPreflightErrorCode::InsufficientSpace,
            ),
        ];

        for (facts, expected_code) in cases {
            assert_eq!(
                validate_preflight_facts(&facts)
                    .expect_err("unsafe target")
                    .code,
                expected_code
            );
        }
    }

    #[test]
    fn path_usage_counts_files_and_never_follows_directory_links() {
        let fixture = TempDirectory::new("usage");
        let nested = fixture.path.join("nested");
        fs::create_dir_all(&nested).expect("nested directory");
        fs::write(fixture.path.join("one.txt"), b"1234").expect("first file");
        fs::write(nested.join("two.txt"), b"123456").expect("second file");

        let usage = measure_path(&fixture.path);
        assert!(usage.exists);
        assert_eq!(usage.bytes, 10);
        assert_eq!(usage.file_count, 2);

        let missing = measure_path(&fixture.path.join("missing"));
        assert_eq!(missing, PathUsage::default());
    }

    #[test]
    fn legacy_diagnostics_expose_exactly_the_three_owned_categories() {
        let fixture = TempDirectory::new("status");
        let status = build_legacy_status(
            fixture.path.join("local"),
            fixture.path.join("config"),
            None,
            fixture.path.join("app").join("threadterm.exe"),
            fixture.path.join("documents").join("ThreadTerm Data"),
        );
        let categories = status
            .categories
            .iter()
            .map(|entry| entry.category)
            .collect::<Vec<_>>();
        assert_eq!(
            categories,
            vec![
                DataCategory::Database,
                DataCategory::DesktopState,
                DataCategory::WindowState
            ]
        );
        assert!(status.root.is_none());
        assert_eq!(status.mode, DataDirectoryMode::LegacySplit);
        assert_eq!(
            status.bootstrap_pointer_path,
            fixture.path.join("config").join(BOOTSTRAP_POINTER_FILE)
        );
        assert_eq!(
            status.application_path,
            fixture.path.join("app").join("threadterm.exe")
        );
        assert_eq!(
            status.recommended_root,
            fixture.path.join("documents").join("ThreadTerm Data")
        );
    }

    #[test]
    fn missing_pointer_keeps_the_exact_legacy_database_path() {
        let fixture = TempDirectory::new("legacy-root");
        let legacy_database = fixture.path.join("legacy-db");
        let resolved = resolve_data_root_from(
            fixture.path.join("bootstrap"),
            legacy_database.clone(),
            fixture.path.join("local"),
            fixture.path.join("config"),
        )
        .expect("resolve legacy root");

        assert_eq!(resolved.mode, DataDirectoryMode::LegacySplit);
        assert_eq!(
            resolved.database_file,
            legacy_database.join("threadterm.db")
        );
        assert_eq!(resolved.state_dir, Some(legacy_database.join("state")));
        assert_eq!(
            resolved.window_state_file,
            fixture.path.join("config").join(".window-state.json")
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            resolved.webview_dir,
            Some(fixture.path.join("local").join("EBWebView"))
        );
        #[cfg(target_os = "macos")]
        assert_eq!(resolved.webview_dir, None);
        assert!(resolved.root.is_none());
        assert!(!legacy_database.exists());
    }

    #[test]
    fn valid_pointer_cold_starts_from_the_managed_database() {
        let fixture = TempDirectory::new("managed-root");
        let bootstrap = fixture.path.join("bootstrap");
        let managed = fixture.path.join("managed");
        prepare_managed_root(&managed);
        let pointer_path = bootstrap.join(BOOTSTRAP_POINTER_FILE);
        write_location_pointer_atomic(&pointer_path, &DataLocationPointer::new(&managed, None))
            .expect("write pointer");

        let resolved = resolve_data_root_from(
            bootstrap,
            fixture.path.join("legacy-db"),
            fixture.path.join("local"),
            fixture.path.join("config"),
        )
        .expect("resolve managed root");

        assert_eq!(resolved.mode, DataDirectoryMode::Managed);
        let canonical_managed = managed.canonicalize().expect("canonical managed");
        assert_eq!(
            resolved.database_file,
            canonical_managed.join("database").join("threadterm.db")
        );
        assert_eq!(
            resolved.window_state_file,
            canonical_managed.join("state").join("window-state.json")
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            resolved.webview_dir,
            Some(canonical_managed.join("webview"))
        );
        #[cfg(target_os = "macos")]
        assert_eq!(resolved.webview_dir, None);
        assert!(!resolved.recovered_pointer_backup);
    }

    #[test]
    fn unavailable_selected_root_never_falls_back_to_an_empty_legacy_database() {
        let fixture = TempDirectory::new("missing-managed-root");
        let bootstrap = fixture.path.join("bootstrap");
        let legacy_database = fixture.path.join("legacy-db");
        write_location_pointer_atomic(
            &bootstrap.join(BOOTSTRAP_POINTER_FILE),
            &DataLocationPointer::new(fixture.path.join("disconnected-drive"), None),
        )
        .expect("write pointer");

        let error = resolve_data_root_from(
            bootstrap,
            legacy_database.clone(),
            fixture.path.join("local"),
            fixture.path.join("config"),
        )
        .expect_err("missing selected root");

        assert!(error.contains("unavailable"));
        assert!(!legacy_database.exists());
    }

    #[test]
    fn interrupted_pointer_replace_recovers_the_last_valid_pointer_file() {
        let fixture = TempDirectory::new("pointer-backup");
        let bootstrap = fixture.path.join("bootstrap");
        let first_root = fixture.path.join("first");
        let second_root = fixture.path.join("second");
        prepare_managed_root(&first_root);
        prepare_managed_root(&second_root);
        let pointer_path = bootstrap.join(BOOTSTRAP_POINTER_FILE);

        write_location_pointer_atomic(&pointer_path, &DataLocationPointer::new(&first_root, None))
            .expect("first pointer");
        write_location_pointer_atomic(
            &pointer_path,
            &DataLocationPointer::new(&second_root, Some(first_root.clone())),
        )
        .expect("second pointer");
        fs::write(&pointer_path, b"{ interrupted").expect("corrupt active pointer");

        let resolved = resolve_data_root_from(
            bootstrap,
            fixture.path.join("legacy-db"),
            fixture.path.join("local"),
            fixture.path.join("config"),
        )
        .expect("recover backup pointer");

        assert!(resolved.recovered_pointer_backup);
        assert_eq!(
            resolved.root,
            Some(first_root.canonicalize().expect("canonical first root"))
        );
    }

    #[test]
    fn pointer_file_contains_location_metadata_only() {
        let pointer = DataLocationPointer {
            pointer_version: BOOTSTRAP_POINTER_VERSION,
            current_root: PathBuf::from("D:/ThreadTermData"),
            previous_root: Some(PathBuf::from("C:/OldThreadTermData")),
            pending_transaction_id: Some("migration-1".to_string()),
        };
        let value = serde_json::to_value(pointer).expect("pointer json");
        let keys = value
            .as_object()
            .expect("pointer object")
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        assert_eq!(
            keys,
            HashSet::from([
                "pointerVersion".to_string(),
                "currentRoot".to_string(),
                "previousRoot".to_string(),
                "pendingTransactionId".to_string(),
            ])
        );
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn terminal_startup_harness_missing_root_env_fails_closed() {
        let _lock = lock_terminal_startup_harness_env();
        let _offline = TerminalStartupHarnessOfflineEnvGuard::set(Some("1"));
        let _env = TerminalStartupHarnessEnvGuard::set(None);

        let error = resolve_startup_data_root().expect_err("missing harness root");
        assert_eq!(error, "terminal_startup_harness_root_missing");
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn terminal_startup_harness_requires_exact_offline_attestation() {
        let _lock = lock_terminal_startup_harness_env();
        let fixture = TempDirectory::new("startup-harness-offline");
        let sandbox = fixture.path.join("sandbox");
        prepare_terminal_startup_harness_root(&sandbox);
        let _env = TerminalStartupHarnessEnvGuard::set(Some(&sandbox));

        for value in [None, Some("0"), Some("true"), Some(" 1")] {
            let _offline = TerminalStartupHarnessOfflineEnvGuard::set(value);
            let error = resolve_startup_data_root().expect_err("offline attestation required");
            assert_eq!(error, "terminal_startup_harness_offline_required");
            drop(_offline);
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn terminal_startup_harness_valid_layout_resolves_isolated_managed_root() {
        let _lock = lock_terminal_startup_harness_env();
        let _offline = TerminalStartupHarnessOfflineEnvGuard::set(Some("1"));
        let fixture = TempDirectory::new("startup-harness-valid");
        let sandbox = fixture.path.join("sandbox");
        prepare_terminal_startup_harness_root(&sandbox);
        fs::write(
            sandbox.join("bootstrap").join(BOOTSTRAP_POINTER_FILE),
            b"not a real pointer",
        )
        .expect("poisoned harness pointer");
        let _env = TerminalStartupHarnessEnvGuard::set(Some(&sandbox));

        let resolved = resolve_startup_data_root().expect("resolve harness root");
        let canonical_sandbox = sandbox.canonicalize().expect("canonical sandbox");
        let canonical_app_data = canonical_sandbox.join("app-data");

        assert_eq!(resolved.mode, DataDirectoryMode::Managed);
        assert_eq!(resolved.root, Some(canonical_app_data.clone()));
        assert_eq!(
            resolved.database_file,
            canonical_app_data.join("database").join("threadterm.db")
        );
        assert_eq!(
            resolved.window_state_file,
            canonical_app_data.join("state").join("window-state.json")
        );
        assert_eq!(
            resolved.bootstrap_pointer_path,
            canonical_sandbox
                .join("bootstrap")
                .join(BOOTSTRAP_POINTER_FILE)
        );
        assert!(!resolved.recovered_pointer_backup);
        assert!(resolved.startup_migration.is_none());
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn terminal_startup_harness_rejects_bad_marker_and_layout() {
        let _lock = lock_terminal_startup_harness_env();
        let _offline = TerminalStartupHarnessOfflineEnvGuard::set(Some("1"));
        let fixture = TempDirectory::new("startup-harness-invalid");
        let sandbox = fixture.path.join("sandbox");
        prepare_terminal_startup_harness_root(&sandbox);
        let _env = TerminalStartupHarnessEnvGuard::set(Some(&sandbox));

        fs::write(
            sandbox.join(TERMINAL_STARTUP_HARNESS_MARKER_FILE),
            b"wrong-marker\n",
        )
        .expect("bad marker");
        let marker_error = resolve_startup_data_root().expect_err("bad marker");
        assert_eq!(marker_error, "terminal_startup_harness_marker_invalid");

        fs::write(
            sandbox.join(TERMINAL_STARTUP_HARNESS_MARKER_FILE),
            TERMINAL_STARTUP_HARNESS_MARKER,
        )
        .expect("restore marker");
        let invalid_manifest = DataRootManifest {
            app_id: "com.example.other".to_string(),
            ..DataRootManifest::default()
        };
        fs::write(
            sandbox.join("app-data").join("manifest.json"),
            serde_json::to_vec(&invalid_manifest).expect("invalid manifest json"),
        )
        .expect("invalid manifest");
        let manifest_error = resolve_startup_data_root().expect_err("invalid manifest");
        assert_eq!(manifest_error, "terminal_startup_harness_app_data_invalid");

        fs::write(
            sandbox.join("app-data").join("manifest.json"),
            serde_json::to_vec(&DataRootManifest::default()).expect("manifest json"),
        )
        .expect("restore manifest");
        fs::remove_dir_all(sandbox.join("app-data").join("migration")).expect("remove child");
        let layout_error = resolve_startup_data_root().expect_err("missing child");
        assert_eq!(layout_error, "terminal_startup_harness_layout_invalid");
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn offline_status_recommends_the_validated_active_harness_root() {
        let fixture = TempDirectory::new("startup-harness-status");
        let root = fixture.path.join("app-data");
        prepare_managed_root(&root);
        fs::create_dir_all(root.join("migration")).expect("migration directory");
        let active = ResolvedDataRoot::managed(
            root.canonicalize().expect("canonical harness root"),
            fixture.path.join("bootstrap").join(BOOTSTRAP_POINTER_FILE),
            false,
        );

        let recommended = terminal_startup_harness_recommended_root(&active)
            .expect("active harness root should be used");
        assert_eq!(recommended, active.root.clone().unwrap());
        assert!(!recommended.ends_with("Documents"));
        assert!(!recommended.ends_with("ThreadTerm Data"));
    }
}
