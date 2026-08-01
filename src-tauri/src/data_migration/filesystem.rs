use super::{write_record, DataMigrationPreflight, DataMigrationRecord, DataMigrationSource};
use crate::{
    data_directory::{
        validate_preflight_facts, DataDirectoryMode, DataPreflightError, DataPreflightErrorCode,
        DataPreflightFacts, DataRootLayout, DataRootManifest, ResolvedDataRoot,
    },
    managed_state,
};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const PROGRESS_PERSIST_BYTES: u64 = 8 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

fn preflight_error(code: DataPreflightErrorCode, message: impl Into<String>) -> DataPreflightError {
    DataPreflightError {
        code,
        message: message.into(),
    }
}

fn io_preflight_error(
    context: &str,
    path: &Path,
    error: impl std::fmt::Display,
) -> DataPreflightError {
    preflight_error(
        DataPreflightErrorCode::InputOutput,
        format!("{context} {}: {error}", path.display()),
    )
}

fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn is_same_or_child(path: &Path, possible_parent: &Path) -> bool {
    path == possible_parent || path.starts_with(possible_parent)
}

fn canonical_if_available(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn source_comparison_roots(active: &ResolvedDataRoot) -> Vec<PathBuf> {
    if let Some(root) = active.root.as_ref() {
        return vec![canonical_if_available(root)];
    }
    let mut roots = Vec::new();
    if let Some(database_dir) = active.database_file.parent() {
        roots.push(canonical_if_available(database_dir));
    }
    if let Some(state_dir) = active.state_dir.as_ref() {
        roots.push(canonical_if_available(state_dir));
    }
    if let Some(webview_dir) = active.webview_dir.as_ref() {
        roots.push(canonical_if_available(webview_dir));
    }
    if let Some(window_parent) = active.window_state_file.parent() {
        roots.push(canonical_if_available(window_parent));
    }
    roots
}

fn has_app_bundle_component(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| value.to_ascii_lowercase().ends_with(".app"))
    })
}

#[cfg(target_os = "windows")]
fn is_network_location(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _))
    )
}

#[cfg(not(target_os = "windows"))]
fn is_network_location(_path: &Path) -> bool {
    false
}

fn directory_is_non_empty(path: &Path) -> Result<bool, DataPreflightError> {
    let mut entries =
        fs::read_dir(path).map_err(|error| io_preflight_error("Could not inspect", path, error))?;
    Ok(entries.next().is_some())
}

fn writable_probe(path: &Path) -> Result<(), DataPreflightError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = path.join(format!(
        ".threadterm-write-probe-{}-{nonce}",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|error| {
            preflight_error(
                DataPreflightErrorCode::NotWritable,
                format!(
                    "ThreadTerm cannot write to the selected folder {}: {error}",
                    path.display()
                ),
            )
        })?;
    file.write_all(b"threadterm")
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&probe);
            preflight_error(
                DataPreflightErrorCode::NotWritable,
                format!(
                    "ThreadTerm cannot persist data in {}: {error}",
                    path.display()
                ),
            )
        })?;
    drop(file);
    fs::remove_file(&probe)
        .map_err(|error| io_preflight_error("Could not remove write probe from", path, error))
}

fn strict_path_bytes(path: &Path, required: bool) -> Result<u64, DataPreflightError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => return Ok(0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(preflight_error(
                DataPreflightErrorCode::SourceUnavailable,
                format!(
                    "The current ThreadTerm data is unavailable at {}.",
                    path.display()
                ),
            ))
        }
        Err(error) => {
            return Err(io_preflight_error(
                "Could not inspect current ThreadTerm data at",
                path,
                error,
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(preflight_error(
            DataPreflightErrorCode::SourceSymbolicLink,
            format!(
                "ThreadTerm will not migrate data through a symbolic link at {}.",
                path.display()
            ),
        ));
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err(preflight_error(
            DataPreflightErrorCode::SourceUnavailable,
            format!(
                "Current ThreadTerm data at {} is not a regular file or folder.",
                path.display()
            ),
        ));
    }

    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            io_preflight_error(
                "Could not inspect current ThreadTerm data at",
                &directory,
                error,
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                io_preflight_error(
                    "Could not inspect current ThreadTerm data at",
                    &directory,
                    error,
                )
            })?;
            let entry_path = entry.path();
            let entry_metadata = fs::symlink_metadata(&entry_path).map_err(|error| {
                io_preflight_error(
                    "Could not inspect current ThreadTerm data at",
                    &entry_path,
                    error,
                )
            })?;
            if entry_metadata.file_type().is_symlink() {
                return Err(preflight_error(
                    DataPreflightErrorCode::SourceSymbolicLink,
                    format!(
                        "ThreadTerm will not migrate data through a symbolic link at {}.",
                        entry_path.display()
                    ),
                ));
            }
            if entry_metadata.is_dir() {
                pending.push(entry_path);
            } else if entry_metadata.is_file() {
                total = total.saturating_add(entry_metadata.len());
            } else {
                return Err(preflight_error(
                    DataPreflightErrorCode::SourceUnavailable,
                    format!(
                        "Unsupported file type in current ThreadTerm data at {}.",
                        entry_path.display()
                    ),
                ));
            }
        }
    }
    Ok(total)
}

fn source_bytes(active: &ResolvedDataRoot) -> Result<u64, DataPreflightError> {
    let mut total = strict_path_bytes(&active.database_file, true)?;
    total = total.saturating_add(strict_path_bytes(
        &sqlite_sidecar(&active.database_file, "-wal"),
        false,
    )?);
    total = total.saturating_add(strict_path_bytes(
        &sqlite_sidecar(&active.database_file, "-shm"),
        false,
    )?);
    if let Some(state_dir) = active.state_dir.as_ref() {
        total = total.saturating_add(strict_path_bytes(state_dir, false)?);
    }
    let window_is_in_state = active
        .state_dir
        .as_ref()
        .is_some_and(|state_dir| active.window_state_file.starts_with(state_dir));
    if !window_is_in_state {
        total = total.saturating_add(strict_path_bytes(&active.window_state_file, false)?);
    }
    if let Some(webview_dir) = active.webview_dir.as_ref() {
        total = total.saturating_add(strict_path_bytes(webview_dir, false)?);
    }
    Ok(total)
}

pub(super) fn preflight(
    active: &ResolvedDataRoot,
    requested_target: &Path,
) -> Result<DataMigrationPreflight, DataPreflightError> {
    if requested_target.as_os_str().is_empty() {
        return Err(preflight_error(
            DataPreflightErrorCode::EmptyPath,
            "Choose a data folder.",
        ));
    }
    if !requested_target.is_absolute() {
        return Err(preflight_error(
            DataPreflightErrorCode::RelativePath,
            "The data folder must use an absolute path.",
        ));
    }

    let mut created_for_probe = false;
    if let Ok(metadata) = fs::symlink_metadata(requested_target) {
        if metadata.file_type().is_symlink() {
            return Err(preflight_error(
                DataPreflightErrorCode::SymbolicLink,
                "Symbolic-link data folders are not supported.",
            ));
        }
        if metadata.is_file() {
            return Err(preflight_error(
                DataPreflightErrorCode::FileTarget,
                "The selected data path is a file.",
            ));
        }
        if !metadata.is_dir() {
            return Err(preflight_error(
                DataPreflightErrorCode::FileTarget,
                "The selected data path is not a folder.",
            ));
        }
        if directory_is_non_empty(requested_target)? {
            return Err(preflight_error(
                DataPreflightErrorCode::NonEmptyTarget,
                "The selected folder already contains unrelated files.",
            ));
        }
    } else {
        fs::create_dir_all(requested_target).map_err(|error| {
            preflight_error(
                DataPreflightErrorCode::NotWritable,
                format!(
                    "ThreadTerm cannot create the selected folder {}: {error}",
                    requested_target.display()
                ),
            )
        })?;
        created_for_probe = true;
    }

    let result = (|| {
        let target = requested_target.canonicalize().map_err(|error| {
            io_preflight_error(
                "Could not resolve selected data folder",
                requested_target,
                error,
            )
        })?;
        let source_or_child = source_comparison_roots(active)
            .iter()
            .any(|source| is_same_or_child(&target, source));
        let application_directory = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .map(|path| canonical_if_available(&path))
            .is_some_and(|application| is_same_or_child(&target, &application));
        let mac_application_bundle = has_app_bundle_component(&target);
        let network_location = is_network_location(&target);
        writable_probe(&target)?;

        let source_bytes = source_bytes(active)?;
        let reserve = (source_bytes / 10).max(SPACE_RESERVE_BYTES);
        let required_bytes = source_bytes.saturating_add(reserve);
        let available_bytes = fs2::available_space(&target).map_err(|error| {
            io_preflight_error("Could not inspect free space for", &target, error)
        })?;
        validate_preflight_facts(&DataPreflightFacts {
            source_or_child,
            application_directory,
            mac_application_bundle,
            network_location,
            required_bytes,
            available_bytes,
            ..DataPreflightFacts::default()
        })?;

        #[cfg(target_os = "macos")]
        let warnings = vec![
            "macOS WebKit engine caches remain in the system-managed location; ThreadTerm interface state moves to the selected folder."
                .to_string(),
        ];
        #[cfg(not(target_os = "macos"))]
        let warnings = Vec::new();
        Ok(DataMigrationPreflight {
            target_root: target,
            source_bytes,
            required_bytes,
            available_bytes,
            warnings,
        })
    })();

    if created_for_probe {
        let _ = fs::remove_dir(requested_target);
    }
    result
}

fn write_manifest(root: &Path) -> Result<(), String> {
    let layout = DataRootLayout::new(root);
    let bytes = serde_json::to_vec_pretty(&DataRootManifest::default())
        .map_err(|error| format!("Could not serialize ThreadTerm data manifest: {error}"))?;
    let temp = root.join(format!(
        ".manifest.json.{}-{}.tmp",
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
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not persist {}: {error}", temp.display()))?;
    drop(file);
    fs::rename(&temp, &layout.manifest).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!(
            "Could not activate ThreadTerm data manifest {}: {error}",
            layout.manifest.display()
        )
    })
}

pub(super) fn prepare_empty_target(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The selected ThreadTerm data location is not a regular folder.".to_string());
    }
    if fs::read_dir(root)
        .map_err(|error| format!("Could not inspect {}: {error}", root.display()))?
        .next()
        .is_some()
    {
        return Err("The selected ThreadTerm data folder is no longer empty.".to_string());
    }
    write_manifest(root)
}

pub(super) fn validate_managed_source_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Previous ThreadTerm data folder is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Previous ThreadTerm data location is not a regular folder.".to_string());
    }
    let bytes = fs::read(root.join("manifest.json")).map_err(|error| {
        format!(
            "Previous ThreadTerm data manifest is unavailable at {}: {error}",
            root.display()
        )
    })?;
    let manifest: DataRootManifest = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Previous ThreadTerm data manifest is invalid at {}: {error}",
            root.display()
        )
    })?;
    manifest.validate()
}

pub(super) fn source_is_available(source: &DataMigrationSource) -> bool {
    if !source.database_file.is_file() {
        return false;
    }
    match source.mode {
        DataDirectoryMode::Managed => source
            .root
            .as_deref()
            .is_some_and(|root| validate_managed_source_root(root).is_ok()),
        DataDirectoryMode::LegacySplit => true,
    }
}

fn ensure_regular_source(path: &Path, required: bool) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                Err(format!(
                    "ThreadTerm will not copy a symbolic link at {}.",
                    path.display()
                ))
            } else {
                Ok(Some(metadata))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => Ok(None),
        Err(error) => Err(format!(
            "Current ThreadTerm data is unavailable at {}: {error}",
            path.display()
        )),
    }
}

fn checkpoint_and_validate_source_database(path: &Path) -> Result<(), String> {
    let metadata = ensure_regular_source(path, true)?
        .ok_or_else(|| "Current ThreadTerm database is unavailable.".to_string())?;
    if !metadata.is_file() {
        return Err(format!(
            "Current ThreadTerm database is not a regular file at {}.",
            path.display()
        ));
    }
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|error| {
            format!(
                "Could not open current ThreadTerm database {}: {error}",
                path.display()
            )
        })?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Could not configure database checkpoint: {error}"))?;
    let checkpoint = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("Could not checkpoint ThreadTerm database: {error}"))?;
    if checkpoint.0 != 0 {
        return Err(
            "ThreadTerm database is still busy; close all ThreadTerm processes and retry."
                .to_string(),
        );
    }
    validate_database_connection(&connection, path)
}

fn validate_database_connection(connection: &Connection, path: &Path) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| {
            format!(
                "Could not validate ThreadTerm database {}: {error}",
                path.display()
            )
        })?;
    if result != "ok" {
        return Err(format!(
            "ThreadTerm database integrity check failed at {}: {result}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_copied_database(path: &Path) -> Result<(), String> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            format!(
                "Could not open copied ThreadTerm database {}: {error}",
                path.display()
            )
        })?;
    validate_database_connection(&connection, path)
}

fn remove_owned_path(path: &Path, root: &Path) -> Result<(), String> {
    if !path.starts_with(root) || path == root {
        return Err(format!(
            "Refusing to remove a path outside the migration target: {}.",
            path.display()
        ));
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to remove a symbolic link from migration data: {}.",
            path.display()
        ));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))
    }
}

fn staging_dir(record: &DataMigrationRecord) -> Result<PathBuf, String> {
    Ok(
        super::record_path(&record.target_root, &record.transaction_id)?
            .parent()
            .ok_or_else(|| "Data-migration record has no parent folder.".to_string())?
            .join("staging"),
    )
}

fn reset_target_payload(record: &DataMigrationRecord) -> Result<PathBuf, String> {
    let layout = DataRootLayout::new(&record.target_root);
    let staging = staging_dir(record)?;
    for path in [
        staging.as_path(),
        layout.database_dir.as_path(),
        layout.state_dir.as_path(),
        layout.webview_dir.as_path(),
    ] {
        remove_owned_path(path, &record.target_root)?;
    }
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Could not create {}: {error}", staging.display()))?;
    Ok(staging)
}

fn copy_size(source: &DataMigrationSource) -> Result<u64, String> {
    let mut total = strict_copy_path_bytes(&source.database_file, true)?;
    if let Some(state_dir) = source.state_dir.as_ref() {
        total = total.saturating_add(strict_copy_path_bytes(state_dir, false)?);
    }
    let external_window = source.state_dir.as_ref().map_or(true, |state_dir| {
        !source.window_state_file.starts_with(state_dir)
    });
    if external_window {
        total = total.saturating_add(strict_copy_path_bytes(&source.window_state_file, false)?);
    }
    if let Some(webview_dir) = source.webview_dir.as_ref() {
        total = total.saturating_add(strict_copy_path_bytes(webview_dir, false)?);
    }
    Ok(total)
}

fn strict_copy_path_bytes(path: &Path, required: bool) -> Result<u64, String> {
    strict_path_bytes(path, required).map_err(|error| error.message)
}

struct CopyProgress<'a> {
    record: &'a mut DataMigrationRecord,
    persisted_bytes: u64,
}

impl CopyProgress<'_> {
    fn add(&mut self, bytes: u64) -> Result<(), String> {
        self.record.copied_bytes = self.record.copied_bytes.saturating_add(bytes);
        if self
            .record
            .copied_bytes
            .saturating_sub(self.persisted_bytes)
            >= PROGRESS_PERSIST_BYTES
        {
            write_record(self.record)?;
            self.persisted_bytes = self.record.copied_bytes;
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        write_record(self.record)?;
        self.persisted_bytes = self.record.copied_bytes;
        Ok(())
    }
}

fn copy_file(source: &Path, target: &Path, progress: &mut CopyProgress<'_>) -> Result<(), String> {
    let metadata = ensure_regular_source(source, true)?
        .ok_or_else(|| format!("Source file is unavailable at {}.", source.display()))?;
    if !metadata.is_file() {
        return Err(format!("Source is not a file at {}.", source.display()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let mut input = File::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
        progress.add(read as u64)?;
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not persist {}: {error}", target.display()))?;
    fs::set_permissions(target, metadata.permissions()).map_err(|error| {
        format!(
            "Could not preserve permissions for {}: {error}",
            target.display()
        )
    })
}

fn copy_tree(source: &Path, target: &Path, progress: &mut CopyProgress<'_>) -> Result<(), String> {
    let Some(metadata) = ensure_regular_source(source, false)? else {
        fs::create_dir_all(target)
            .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
        return Ok(());
    };
    if !metadata.is_dir() {
        return Err(format!("Source is not a folder at {}.", source.display()));
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((source_dir, target_dir)) = pending.pop() {
        let entries = fs::read_dir(&source_dir)
            .map_err(|error| format!("Could not inspect {}: {error}", source_dir.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect {}: {error}", source_dir.display()))?;
            let source_path = entry.path();
            let target_path = target_dir.join(entry.file_name());
            let entry_metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("Could not inspect {}: {error}", source_path.display()))?;
            if entry_metadata.file_type().is_symlink() {
                return Err(format!(
                    "ThreadTerm will not copy a symbolic link at {}.",
                    source_path.display()
                ));
            }
            if entry_metadata.is_dir() {
                fs::create_dir(&target_path).map_err(|error| {
                    format!("Could not create {}: {error}", target_path.display())
                })?;
                pending.push((source_path, target_path));
            } else if entry_metadata.is_file() {
                copy_file(&source_path, &target_path, progress)?;
            } else {
                return Err(format!(
                    "Unsupported file type in ThreadTerm data at {}.",
                    source_path.display()
                ));
            }
        }
        if let Ok(source_metadata) = fs::metadata(&source_dir) {
            let _ = fs::set_permissions(&target_dir, source_metadata.permissions());
        }
    }
    Ok(())
}

pub(super) fn copy_to_staging(record: &mut DataMigrationRecord) -> Result<(), String> {
    checkpoint_and_validate_source_database(&record.source.database_file)?;
    let source = record.source.clone();
    let staging = reset_target_payload(record)?;
    record.total_bytes = copy_size(&source)?;
    record.copied_bytes = 0;
    write_record(record)?;

    let database_dir = staging.join("database");
    let state_dir = staging.join("state");
    let webview_dir = staging.join("webview");
    fs::create_dir_all(&database_dir)
        .map_err(|error| format!("Could not create {}: {error}", database_dir.display()))?;
    let database_target = database_dir.join("threadterm.db");
    let mut progress = CopyProgress {
        record,
        persisted_bytes: 0,
    };
    copy_file(&source.database_file, &database_target, &mut progress)?;
    if let Some(source_state) = source.state_dir.as_ref() {
        copy_tree(source_state, &state_dir, &mut progress)?;
    } else {
        fs::create_dir_all(&state_dir)
            .map_err(|error| format!("Could not create {}: {error}", state_dir.display()))?;
    }

    let window_is_in_state = source
        .state_dir
        .as_ref()
        .is_some_and(|state_dir| source.window_state_file.starts_with(state_dir));
    if !window_is_in_state && source.window_state_file.exists() {
        let staged_window = state_dir.join("window-state.json");
        if staged_window.exists() {
            fs::remove_file(&staged_window).map_err(|error| {
                format!(
                    "Could not replace staged window state {}: {error}",
                    staged_window.display()
                )
            })?;
        }
        copy_file(&source.window_state_file, &staged_window, &mut progress)?;
    }

    if let Some(source_webview) = source.webview_dir.as_ref() {
        copy_tree(source_webview, &webview_dir, &mut progress)?;
    }
    progress.finish()
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::metadata(left)
        .map_err(|error| format!("Could not inspect {}: {error}", left.display()))?;
    let right_metadata = fs::metadata(right)
        .map_err(|error| format!("Could not inspect {}: {error}", right.display()))?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let mut left_file =
        File::open(left).map_err(|error| format!("Could not open {}: {error}", left.display()))?;
    let mut right_file = File::open(right)
        .map_err(|error| format!("Could not open {}: {error}", right.display()))?;
    let mut left_buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut right_buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|error| format!("Could not read {}: {error}", left.display()))?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|error| format!("Could not read {}: {error}", right.display()))?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

fn compare_tree_subset(
    source: &Path,
    target: &Path,
    skipped_relative_paths: &HashSet<PathBuf>,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    let mut pending = vec![source.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?;
            let source_path = entry.path();
            let relative = source_path
                .strip_prefix(source)
                .map_err(|_| "Could not compare migrated file paths.".to_string())?;
            if skipped_relative_paths.contains(relative) {
                continue;
            }
            let target_path = target.join(relative);
            let metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("Could not inspect {}: {error}", source_path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "ThreadTerm will not verify a symbolic link at {}.",
                    source_path.display()
                ));
            }
            if metadata.is_dir() {
                if !target_path.is_dir() {
                    return Err(format!(
                        "Migrated folder is missing at {}.",
                        target_path.display()
                    ));
                }
                pending.push(source_path);
            } else if metadata.is_file() && !files_equal(&source_path, &target_path)? {
                return Err(format!(
                    "Migrated file does not match its source: {}.",
                    source_path.display()
                ));
            }
        }
    }
    Ok(())
}

fn validate_window_state(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| format!("Window state is invalid at {}: {error}", path.display()))?;
    Ok(())
}

pub(super) fn verify_staging(record: &DataMigrationRecord) -> Result<(), String> {
    let staging = staging_dir(record)?;
    let database = staging.join("database").join("threadterm.db");
    if !files_equal(&record.source.database_file, &database)? {
        return Err("Copied ThreadTerm database does not match its source.".to_string());
    }
    validate_copied_database(&database)?;

    let state = staging.join("state");
    if let Some(source_state) = record.source.state_dir.as_ref() {
        let mut skipped = HashSet::new();
        let external_window = !record.source.window_state_file.starts_with(source_state);
        if external_window && record.source.window_state_file.exists() {
            skipped.insert(PathBuf::from("window-state.json"));
        }
        compare_tree_subset(source_state, &state, &skipped)?;
    }
    let window_is_in_state = record
        .source
        .state_dir
        .as_ref()
        .is_some_and(|state_dir| record.source.window_state_file.starts_with(state_dir));
    if !window_is_in_state && record.source.window_state_file.exists() {
        let staged_window = state.join("window-state.json");
        if !files_equal(&record.source.window_state_file, &staged_window)? {
            return Err("Copied ThreadTerm window state does not match its source.".to_string());
        }
    }
    managed_state::validate_state_directory(&state)?;
    validate_window_state(&state.join("window-state.json"))?;

    if let Some(source_webview) = record.source.webview_dir.as_ref() {
        compare_tree_subset(source_webview, &staging.join("webview"), &HashSet::new())?;
    }
    Ok(())
}

pub(super) fn activate_staging(record: &DataMigrationRecord) -> Result<(), String> {
    let staging = staging_dir(record)?;
    let layout = DataRootLayout::new(&record.target_root);
    for (source, target) in [
        (staging.join("database"), layout.database_dir),
        (staging.join("state"), layout.state_dir),
    ] {
        fs::rename(&source, &target).map_err(|error| {
            format!(
                "Could not activate migrated data {}: {error}",
                target.display()
            )
        })?;
    }
    let staged_webview = staging.join("webview");
    if staged_webview.exists() {
        fs::rename(&staged_webview, &layout.webview_dir).map_err(|error| {
            format!(
                "Could not activate migrated WebView data {}: {error}",
                layout.webview_dir.display()
            )
        })?;
    }
    fs::remove_dir(&staging)
        .map_err(|error| format!("Could not finish migration staging: {error}"))?;
    Ok(())
}

fn remove_regular_file_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Refusing to remove a non-regular ThreadTerm file at {}.",
            path.display()
        ));
    }
    fs::remove_file(path).map_err(|error| format!("Could not remove {}: {error}", path.display()))
}

fn remove_owned_directory_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Refusing to remove a non-regular ThreadTerm folder at {}.",
            path.display()
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Could not remove {}: {error}", path.display()))
}

fn remove_if_empty(path: &Path) {
    if path
        .read_dir()
        .ok()
        .is_some_and(|mut entries| entries.next().is_none())
    {
        let _ = fs::remove_dir(path);
    }
}

pub(super) fn cleanup_source(
    source: &DataMigrationSource,
    active_target: &Path,
) -> Result<(), String> {
    match source.mode {
        DataDirectoryMode::Managed => {
            let source_root = source
                .root
                .as_deref()
                .ok_or_else(|| "Previous managed data root is missing.".to_string())?;
            let source_canonical = source_root
                .canonicalize()
                .map_err(|error| format!("Could not resolve {}: {error}", source_root.display()))?;
            let target_canonical = active_target.canonicalize().map_err(|error| {
                format!("Could not resolve {}: {error}", active_target.display())
            })?;
            if source_canonical == target_canonical
                || target_canonical.starts_with(&source_canonical)
                || source_canonical.starts_with(&target_canonical)
            {
                return Err("Refusing to clean overlapping ThreadTerm data folders.".to_string());
            }
            validate_managed_source_root(&source_canonical)?;
            remove_owned_directory_if_exists(&source_canonical)
        }
        DataDirectoryMode::LegacySplit => {
            remove_regular_file_if_exists(&source.database_file)?;
            remove_regular_file_if_exists(&sqlite_sidecar(&source.database_file, "-wal"))?;
            remove_regular_file_if_exists(&sqlite_sidecar(&source.database_file, "-shm"))?;
            if let Some(state_dir) = source.state_dir.as_ref() {
                remove_owned_directory_if_exists(state_dir)?;
            }
            if let Some(webview_dir) = source.webview_dir.as_ref() {
                remove_owned_directory_if_exists(webview_dir)?;
            }
            remove_regular_file_if_exists(&source.window_state_file)?;
            if let Some(database_dir) = source.database_file.parent() {
                remove_if_empty(database_dir);
            }
            if let Some(webview_parent) = source.webview_dir.as_ref().and_then(|path| path.parent())
            {
                remove_if_empty(webview_parent);
            }
            Ok(())
        }
    }
}

pub(super) fn remove_scheduled_target(
    target_root: &Path,
    transaction_id: &str,
) -> Result<(), String> {
    validate_managed_source_root(target_root)?;
    let allowed = HashSet::from([OsString::from("manifest.json"), OsString::from("migration")]);
    for entry in fs::read_dir(target_root)
        .map_err(|error| format!("Could not inspect {}: {error}", target_root.display()))?
    {
        let entry = entry
            .map_err(|error| format!("Could not inspect {}: {error}", target_root.display()))?;
        if !allowed.contains(&entry.file_name()) {
            return Err(format!(
                "Refusing to discard migration target because it contains unexpected data: {}.",
                entry.path().display()
            ));
        }
    }
    let transaction = target_root.join("migration").join(transaction_id);
    if !transaction.starts_with(target_root) {
        return Err("Invalid data-migration target transaction.".to_string());
    }
    fs::remove_dir_all(target_root)
        .map_err(|error| format!("Could not discard {}: {error}", target_root.display()))
}
