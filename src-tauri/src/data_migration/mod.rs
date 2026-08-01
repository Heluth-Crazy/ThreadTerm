mod filesystem;

use crate::data_directory::{
    self, DataDirectoryMode, DataLocationPointer, DataMigrationNotice, DataMigrationPhase,
    DataPreflightError, DataPreflightErrorCode, ResolvedDataRoot,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const MIGRATION_RECORD_VERSION: u32 = 1;
const MIGRATION_RECORD_FILE: &str = "record.json";
const MIGRATION_RECORD_BACKUP_FILE: &str = "record.previous.json";
const MIGRATION_LOCK_FILE: &str = "migration.lock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataMigrationPreflight {
    pub target_root: PathBuf,
    pub source_bytes: u64,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataMigrationStatus {
    pub transaction_id: String,
    pub phase: DataMigrationPhase,
    pub source_root: Option<PathBuf>,
    pub target_root: PathBuf,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub retain_source: bool,
    pub last_error: Option<String>,
    pub restart_required: bool,
    pub can_cancel: bool,
    pub can_rollback: bool,
    pub can_cleanup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct DataMigrationSource {
    pub mode: DataDirectoryMode,
    pub root: Option<PathBuf>,
    pub database_file: PathBuf,
    pub state_dir: Option<PathBuf>,
    pub window_state_file: PathBuf,
    pub webview_dir: Option<PathBuf>,
}

impl DataMigrationSource {
    fn from_active(active: &ResolvedDataRoot) -> Self {
        Self {
            mode: active.mode,
            root: active.root.clone(),
            database_file: active.database_file.clone(),
            state_dir: active.state_dir.clone(),
            window_state_file: active.window_state_file.clone(),
            webview_dir: active.webview_dir.clone(),
        }
    }

    fn display_root(&self) -> Option<PathBuf> {
        self.root.clone().or_else(|| {
            self.database_file
                .parent()
                .map(std::path::Path::to_path_buf)
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct DataMigrationRecord {
    pub record_version: u32,
    pub transaction_id: String,
    pub source: DataMigrationSource,
    pub target_root: PathBuf,
    pub original_pointer: Option<DataLocationPointer>,
    pub phase: DataMigrationPhase,
    pub retain_source: bool,
    pub total_bytes: u64,
    pub copied_bytes: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_error: Option<String>,
}

impl DataMigrationRecord {
    fn validate(
        &self,
        expected_transaction_id: &str,
        expected_target: &Path,
    ) -> Result<(), String> {
        if self.record_version != MIGRATION_RECORD_VERSION {
            return Err(format!(
                "Unsupported data-migration record version: {}.",
                self.record_version
            ));
        }
        if self.transaction_id != expected_transaction_id {
            return Err("Data-migration transaction identifier does not match.".to_string());
        }
        if self.target_root != expected_target {
            return Err("Data-migration target does not match its transaction folder.".to_string());
        }
        if !self.target_root.is_absolute() {
            return Err("Data-migration target is not an absolute path.".to_string());
        }
        if !self.source.database_file.is_absolute() {
            return Err("Data-migration source database is not an absolute path.".to_string());
        }
        for source_path in self
            .source
            .root
            .iter()
            .chain(self.source.state_dir.iter())
            .chain(std::iter::once(&self.source.window_state_file))
            .chain(self.source.webview_dir.iter())
        {
            if !source_path.is_absolute() {
                return Err(format!(
                    "Data-migration source path is not absolute: {}.",
                    source_path.display()
                ));
            }
        }
        Ok(())
    }

    fn touch(&mut self) {
        self.updated_at_ms = now_ms();
    }

    fn notice(&self) -> DataMigrationNotice {
        DataMigrationNotice {
            transaction_id: self.transaction_id.clone(),
            target_root: self.target_root.clone(),
            phase: self.phase,
            last_error: self.last_error.clone(),
        }
    }

    fn status(&self) -> DataMigrationStatus {
        let source_available = filesystem::source_is_available(&self.source);
        DataMigrationStatus {
            transaction_id: self.transaction_id.clone(),
            phase: self.phase,
            source_root: self.source.display_root(),
            target_root: self.target_root.clone(),
            copied_bytes: self.copied_bytes,
            total_bytes: self.total_bytes,
            retain_source: self.retain_source,
            last_error: self.last_error.clone(),
            restart_required: matches!(
                self.phase,
                DataMigrationPhase::Scheduled | DataMigrationPhase::RollbackToSource
            ),
            can_cancel: self.phase == DataMigrationPhase::Scheduled,
            can_rollback: matches!(
                self.phase,
                DataMigrationPhase::PointerSwitched | DataMigrationPhase::FirstLaunchConfirmed
            ) && self.retain_source
                && source_available,
            can_cleanup: self.phase == DataMigrationPhase::FirstLaunchConfirmed && source_available,
        }
    }
}

#[derive(Default)]
struct DataMigrationRuntimeInner {
    scheduled_lock: Mutex<Option<File>>,
    confirmation_lock: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct DataMigrationRuntime {
    inner: Arc<DataMigrationRuntimeInner>,
}

impl DataMigrationRuntime {
    fn lock_slot(&self) -> MutexGuard<'_, Option<File>> {
        self.inner
            .scheduled_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn hold_scheduled_lock(&self, file: File) -> Result<(), String> {
        let mut slot = self.lock_slot();
        if slot.is_some() {
            return Err("A ThreadTerm data migration is already scheduled.".to_string());
        }
        *slot = Some(file);
        Ok(())
    }

    fn release_scheduled_lock(&self) {
        self.lock_slot().take();
    }

    fn confirmation_guard(&self) -> MutexGuard<'_, ()> {
        self.inner
            .confirmation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn transaction_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("migration-{}-{nanos}", std::process::id())
}

fn validate_transaction_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid ThreadTerm data-migration transaction identifier.".to_string());
    }
    Ok(())
}

fn transaction_dir(target_root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(transaction_id)?;
    Ok(target_root.join("migration").join(transaction_id))
}

pub(super) fn record_path(target_root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    Ok(transaction_dir(target_root, transaction_id)?.join(MIGRATION_RECORD_FILE))
}

fn record_backup_path(path: &Path) -> PathBuf {
    path.with_file_name(MIGRATION_RECORD_BACKUP_FILE)
}

fn unique_temp_path(target: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(MIGRATION_RECORD_FILE);
    target.with_file_name(format!(".{file_name}.{}-{nonce}.tmp", std::process::id()))
}

fn parse_record(path: &Path) -> Result<DataMigrationRecord, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))
}

fn read_record(target_root: &Path, transaction_id: &str) -> Result<DataMigrationRecord, String> {
    let path = record_path(target_root, transaction_id)?;
    let record = match parse_record(&path) {
        Ok(record) => record,
        Err(primary_error) => {
            let backup = record_backup_path(&path);
            match parse_record(&backup) {
                Ok(record) => record,
                Err(_) => return Err(primary_error),
            }
        }
    };
    record.validate(transaction_id, target_root)?;
    Ok(record)
}

pub(super) fn write_record(record: &mut DataMigrationRecord) -> Result<(), String> {
    record.touch();
    let path = record_path(&record.target_root, &record.transaction_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Data-migration record has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let temp_path = unique_temp_path(&path);
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("Could not serialize data-migration record: {error}"))?;
    let mut temp = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("Could not create {}: {error}", temp_path.display()))?;
    temp.write_all(&bytes)
        .and_then(|_| temp.sync_all())
        .map_err(|error| format!("Could not persist {}: {error}", temp_path.display()))?;
    drop(temp);

    let backup = record_backup_path(&path);
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("Could not replace {}: {error}", backup.display()))?;
        }
        fs::rename(&path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Could not preserve data-migration record {}: {error}",
                path.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temp_path, &path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not activate data-migration record {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn open_transaction_lock(target_root: &Path, transaction_id: &str) -> Result<File, String> {
    let path = transaction_dir(target_root, transaction_id)?.join(MIGRATION_LOCK_FILE);
    let parent = path
        .parent()
        .ok_or_else(|| "Data-migration lock has no parent directory.".to_string())?;
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

fn original_pointer_for(active: &ResolvedDataRoot) -> Result<Option<DataLocationPointer>, String> {
    let current = data_directory::read_location_pointer(&active.bootstrap_pointer_path)?;
    match active.mode {
        DataDirectoryMode::LegacySplit => {
            if current.is_some() {
                return Err(
                    "Legacy ThreadTerm data unexpectedly has an active location pointer."
                        .to_string(),
                );
            }
            Ok(None)
        }
        DataDirectoryMode::Managed => {
            let Some((pointer, _)) = current else {
                return Err(
                    "Managed ThreadTerm data is missing its active location pointer.".to_string(),
                );
            };
            if pointer.pending_transaction_id.is_some() {
                return Err("A ThreadTerm data migration is already pending.".to_string());
            }
            let active_root = active
                .root
                .as_ref()
                .ok_or_else(|| "Managed ThreadTerm data root is missing.".to_string())?;
            if pointer.current_root.canonicalize().ok() != active_root.canonicalize().ok() {
                return Err(
                    "The active ThreadTerm data folder does not match its location pointer."
                        .to_string(),
                );
            }
            Ok(Some(pointer))
        }
    }
}

fn pending_pointer_for(record: &DataMigrationRecord) -> Result<DataLocationPointer, String> {
    let previous_root = record.source.root.clone();
    let mut pointer = DataLocationPointer::new(&record.target_root, previous_root);
    pointer.pending_transaction_id = Some(record.transaction_id.clone());
    pointer.validate()?;
    Ok(pointer)
}

fn clear_pointer_files(pointer_path: &Path) -> Result<(), String> {
    let backup = pointer_path.with_file_name(data_directory::BOOTSTRAP_POINTER_BACKUP_FILE);
    for path in [pointer_path, backup.as_path()] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not clear data-location pointer {}: {error}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

fn restore_source_pointer(
    pointer_path: &Path,
    pending_pointer: &DataLocationPointer,
    record: Option<&DataMigrationRecord>,
) -> Result<(), String> {
    if let Some(original) = record.and_then(|value| value.original_pointer.as_ref()) {
        return data_directory::write_location_pointer_atomic(pointer_path, original);
    }
    if let Some(previous_root) = pending_pointer.previous_root.as_ref() {
        filesystem::validate_managed_source_root(previous_root)?;
        return data_directory::write_location_pointer_atomic(
            pointer_path,
            &DataLocationPointer::new(previous_root, None),
        );
    }
    clear_pointer_files(pointer_path)
}

fn rollback_without_record(
    pointer_path: &Path,
    pointer: &DataLocationPointer,
    transaction_id: &str,
    error: String,
) -> Result<Option<DataMigrationNotice>, String> {
    restore_source_pointer(pointer_path, pointer, None).map_err(|restore_error| {
        format!(
            "{error} ThreadTerm also could not restore the previous data location: {restore_error}"
        )
    })?;
    Ok(Some(DataMigrationNotice {
        transaction_id: transaction_id.to_string(),
        target_root: pointer.current_root.clone(),
        phase: DataMigrationPhase::RollbackToSource,
        last_error: Some(error),
    }))
}

fn execute_migration(record: &mut DataMigrationRecord) -> Result<(), String> {
    record.phase = DataMigrationPhase::CopyingToStaging;
    record.copied_bytes = 0;
    record.last_error = None;
    write_record(record)?;

    filesystem::copy_to_staging(record)?;

    record.phase = DataMigrationPhase::Verifying;
    write_record(record)?;
    filesystem::verify_staging(record)?;
    filesystem::activate_staging(record)?;

    record.phase = DataMigrationPhase::PointerSwitched;
    record.copied_bytes = record.total_bytes;
    write_record(record)
}

pub fn process_pending_startup(pointer_path: &Path) -> Result<Option<DataMigrationNotice>, String> {
    let Some((pointer, _)) = data_directory::read_location_pointer(pointer_path)? else {
        return Ok(None);
    };
    let Some(transaction_id) = pointer.pending_transaction_id.as_deref() else {
        return Ok(None);
    };

    let mut record = match read_record(&pointer.current_root, transaction_id) {
        Ok(record) => record,
        Err(error) => {
            return rollback_without_record(
                pointer_path,
                &pointer,
                transaction_id,
                format!("The pending ThreadTerm data migration could not be opened: {error}"),
            )
        }
    };

    let lock = open_transaction_lock(&record.target_root, &record.transaction_id)?;
    lock.try_lock_exclusive().map_err(|_| {
        "ThreadTerm is still using the old data folder. Close the running app before migration."
            .to_string()
    })?;

    match record.phase {
        DataMigrationPhase::Scheduled
        | DataMigrationPhase::CopyingToStaging
        | DataMigrationPhase::Verifying => {
            if let Err(error) = execute_migration(&mut record) {
                record.phase = DataMigrationPhase::RollbackToSource;
                record.last_error = Some(error.clone());
                let record_error = write_record(&mut record).err();
                restore_source_pointer(pointer_path, &pointer, Some(&record)).map_err(
                    |restore_error| {
                        format!(
                            "ThreadTerm data migration failed: {error}. The previous data location could not be restored: {restore_error}"
                        )
                    },
                )?;
                if let Some(record_error) = record_error {
                    tracing::warn!(
                        %record_error,
                        "Migration failed and its failure record could not be persisted"
                    );
                }
                Ok(Some(record.notice()))
            } else {
                Ok(Some(record.notice()))
            }
        }
        DataMigrationPhase::RollbackToSource => {
            restore_source_pointer(pointer_path, &pointer, Some(&record))?;
            Ok(Some(record.notice()))
        }
        DataMigrationPhase::PointerSwitched => Ok(Some(record.notice())),
        DataMigrationPhase::FirstLaunchConfirmed | DataMigrationPhase::OldDataCleanup => {
            let mut confirmed_pointer = pointer;
            confirmed_pointer.pending_transaction_id = None;
            data_directory::write_location_pointer_atomic(pointer_path, &confirmed_pointer)?;
            Ok(Some(record.notice()))
        }
        DataMigrationPhase::Idle | DataMigrationPhase::Preflight => {
            let error = "The pending data migration was not in a restart-safe phase.".to_string();
            record.phase = DataMigrationPhase::RollbackToSource;
            record.last_error = Some(error);
            write_record(&mut record)?;
            restore_source_pointer(pointer_path, &pointer, Some(&record))?;
            Ok(Some(record.notice()))
        }
    }
}

fn schedule_migration(
    active: &ResolvedDataRoot,
    runtime: &DataMigrationRuntime,
    target_root: PathBuf,
    retain_source: bool,
) -> Result<DataMigrationStatus, String> {
    if runtime.lock_slot().is_some() {
        return Err("A ThreadTerm data migration is already scheduled.".to_string());
    }
    if data_directory::read_location_pointer(&active.bootstrap_pointer_path)?
        .is_some_and(|(pointer, _)| pointer.pending_transaction_id.is_some())
    {
        return Err("A ThreadTerm data migration is already pending.".to_string());
    }

    let original_pointer = original_pointer_for(active)?;
    let preflight = filesystem::preflight(active, &target_root).map_err(|error| error.message)?;
    filesystem::prepare_empty_target(&preflight.target_root)?;
    let transaction_id = transaction_id();
    let lock = match open_transaction_lock(&preflight.target_root, &transaction_id) {
        Ok(lock) => lock,
        Err(error) => {
            let _ = filesystem::remove_scheduled_target(&preflight.target_root, &transaction_id);
            return Err(error);
        }
    };
    if lock.try_lock_exclusive().is_err() {
        drop(lock);
        let _ = filesystem::remove_scheduled_target(&preflight.target_root, &transaction_id);
        return Err("Could not reserve the data-migration transaction.".to_string());
    }

    let timestamp = now_ms();
    let mut record = DataMigrationRecord {
        record_version: MIGRATION_RECORD_VERSION,
        transaction_id,
        source: DataMigrationSource::from_active(active),
        target_root: preflight.target_root,
        original_pointer,
        phase: DataMigrationPhase::Scheduled,
        retain_source,
        total_bytes: preflight.source_bytes,
        copied_bytes: 0,
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        last_error: None,
    };

    if let Err(error) = write_record(&mut record) {
        drop(lock);
        let _ = filesystem::remove_scheduled_target(&record.target_root, &record.transaction_id);
        return Err(error);
    }
    let pointer = match pending_pointer_for(&record) {
        Ok(pointer) => pointer,
        Err(error) => {
            drop(lock);
            let _ =
                filesystem::remove_scheduled_target(&record.target_root, &record.transaction_id);
            return Err(error);
        }
    };
    if let Err(error) =
        data_directory::write_location_pointer_atomic(&active.bootstrap_pointer_path, &pointer)
    {
        drop(lock);
        let _ = filesystem::remove_scheduled_target(&record.target_root, &record.transaction_id);
        return Err(error);
    }
    if let Err(error) = runtime.hold_scheduled_lock(lock) {
        let _ = restore_source_pointer(&active.bootstrap_pointer_path, &pointer, Some(&record));
        let _ = filesystem::remove_scheduled_target(&record.target_root, &record.transaction_id);
        return Err(error);
    }
    Ok(record.status())
}

fn find_latest_record(root: &Path) -> Result<Option<DataMigrationRecord>, String> {
    let migration_dir = root.join("migration");
    let entries = match fs::read_dir(&migration_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect {}: {error}",
                migration_dir.display()
            ))
        }
    };
    let mut latest: Option<DataMigrationRecord> = None;
    for entry in entries.flatten() {
        let transaction_id = match entry.file_name().to_str() {
            Some(value) if validate_transaction_id(value).is_ok() => value.to_string(),
            _ => continue,
        };
        let Ok(record) = read_record(root, &transaction_id) else {
            continue;
        };
        if latest
            .as_ref()
            .map_or(true, |current| record.updated_at_ms > current.updated_at_ms)
        {
            latest = Some(record);
        }
    }
    Ok(latest)
}

fn migration_status(active: &ResolvedDataRoot) -> Result<Option<DataMigrationStatus>, String> {
    if let Some((pointer, _)) =
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)?
    {
        if let Some(transaction_id) = pointer.pending_transaction_id.as_deref() {
            return read_record(&pointer.current_root, transaction_id)
                .map(|record| Some(record.status()));
        }
    }
    if let Some(root) = active.root.as_deref() {
        if let Some(record) = find_latest_record(root)? {
            return Ok(Some(record.status()));
        }
    }
    Ok(active
        .startup_migration
        .as_ref()
        .map(|notice| DataMigrationStatus {
            transaction_id: notice.transaction_id.clone(),
            phase: notice.phase,
            source_root: active.root.clone().or_else(|| {
                active
                    .database_file
                    .parent()
                    .map(std::path::Path::to_path_buf)
            }),
            target_root: notice.target_root.clone(),
            copied_bytes: 0,
            total_bytes: 0,
            retain_source: true,
            last_error: notice.last_error.clone(),
            restart_required: false,
            can_cancel: false,
            can_rollback: false,
            can_cleanup: false,
        }))
}

fn cancel_migration(
    active: &ResolvedDataRoot,
    runtime: &DataMigrationRuntime,
) -> Result<(), String> {
    let Some((pointer, _)) = data_directory::read_location_pointer(&active.bootstrap_pointer_path)?
    else {
        return Err("There is no pending ThreadTerm data migration.".to_string());
    };
    let transaction_id = pointer
        .pending_transaction_id
        .as_deref()
        .ok_or_else(|| "There is no pending ThreadTerm data migration.".to_string())?;
    let record = read_record(&pointer.current_root, transaction_id)?;
    if record.phase != DataMigrationPhase::Scheduled {
        return Err("This data migration can no longer be cancelled safely.".to_string());
    }

    restore_source_pointer(&active.bootstrap_pointer_path, &pointer, Some(&record))?;
    runtime.release_scheduled_lock();
    filesystem::remove_scheduled_target(&record.target_root, &record.transaction_id)
}

fn confirm_migration(active: &ResolvedDataRoot) -> Result<DataMigrationStatus, String> {
    let Some((mut pointer, _)) =
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)?
    else {
        return Err("The active data folder has no location pointer.".to_string());
    };
    let Some(transaction_id) = pointer.pending_transaction_id.clone() else {
        let root = active
            .root
            .as_deref()
            .ok_or_else(|| "There is no migrated data awaiting confirmation.".to_string())?;
        let record = find_latest_record(root)?
            .filter(|record| {
                matches!(
                    record.phase,
                    DataMigrationPhase::FirstLaunchConfirmed | DataMigrationPhase::OldDataCleanup
                )
            })
            .ok_or_else(|| "There is no migrated data awaiting confirmation.".to_string())?;
        return Ok(record.status());
    };
    let mut record = read_record(&pointer.current_root, &transaction_id)?;
    if record.phase != DataMigrationPhase::PointerSwitched {
        return Err("The migrated data is not ready for first-launch confirmation.".to_string());
    }
    let active_root = active
        .root
        .as_deref()
        .ok_or_else(|| "The active ThreadTerm data folder is not managed.".to_string())?;
    if active_root.canonicalize().ok() != record.target_root.canonicalize().ok() {
        return Err("The running app did not start from the migrated data folder.".to_string());
    }

    record.phase = DataMigrationPhase::FirstLaunchConfirmed;
    record.last_error = None;
    write_record(&mut record)?;
    pointer.pending_transaction_id = None;
    data_directory::write_location_pointer_atomic(&active.bootstrap_pointer_path, &pointer)?;

    if !record.retain_source {
        if let Err(error) = filesystem::cleanup_source(&record.source, &record.target_root) {
            record.last_error = Some(error);
            write_record(&mut record)?;
        } else {
            record.phase = DataMigrationPhase::OldDataCleanup;
            write_record(&mut record)?;
        }
    }
    Ok(record.status())
}

fn cleanup_migration_source(
    active: &ResolvedDataRoot,
    transaction_id: &str,
) -> Result<DataMigrationStatus, String> {
    let root = active.root.as_deref().ok_or_else(|| {
        "Source cleanup is available only from a managed data folder.".to_string()
    })?;
    let mut record = read_record(root, transaction_id)?;
    if record.phase != DataMigrationPhase::FirstLaunchConfirmed {
        return Err(
            "Old ThreadTerm data can be cleaned only after the new folder has started successfully."
                .to_string(),
        );
    }
    filesystem::cleanup_source(&record.source, &record.target_root)?;
    record.retain_source = false;
    record.phase = DataMigrationPhase::OldDataCleanup;
    record.last_error = None;
    write_record(&mut record)?;
    Ok(record.status())
}

fn request_rollback(
    active: &ResolvedDataRoot,
    transaction_id: &str,
) -> Result<DataMigrationStatus, String> {
    let root = active
        .root
        .as_deref()
        .ok_or_else(|| "Rollback is available only from a managed data folder.".to_string())?;
    let mut record = read_record(root, transaction_id)?;
    if !matches!(
        record.phase,
        DataMigrationPhase::PointerSwitched | DataMigrationPhase::FirstLaunchConfirmed
    ) || !record.retain_source
        || !filesystem::source_is_available(&record.source)
    {
        return Err("The previous ThreadTerm data folder is no longer available.".to_string());
    }

    let previous_phase = record.phase;
    record.phase = DataMigrationPhase::RollbackToSource;
    record.last_error = None;
    write_record(&mut record)?;
    let pointer = pending_pointer_for(&record)?;
    if let Err(error) =
        data_directory::write_location_pointer_atomic(&active.bootstrap_pointer_path, &pointer)
    {
        record.phase = previous_phase;
        let _ = write_record(&mut record);
        return Err(error);
    }
    Ok(record.status())
}

#[tauri::command]
pub async fn data_migration_preflight(
    target_root: String,
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<DataMigrationPreflight, DataPreflightError> {
    let active = active.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        filesystem::preflight(&active, Path::new(target_root.trim()))
    })
    .await
    .map_err(|error| DataPreflightError {
        code: DataPreflightErrorCode::InputOutput,
        message: format!("Could not inspect the selected data folder: {error}"),
    })?
}

#[tauri::command]
pub async fn data_migration_schedule(
    target_root: String,
    retain_source: bool,
    active: tauri::State<'_, ResolvedDataRoot>,
    runtime: tauri::State<'_, DataMigrationRuntime>,
) -> Result<DataMigrationStatus, String> {
    let active = active.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        schedule_migration(
            &active,
            &runtime,
            PathBuf::from(target_root.trim()),
            retain_source,
        )
    })
    .await
    .map_err(|error| format!("Could not schedule ThreadTerm data migration: {error}"))?
}

#[tauri::command]
pub async fn data_migration_status(
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<Option<DataMigrationStatus>, String> {
    let active = active.inner().clone();
    tauri::async_runtime::spawn_blocking(move || migration_status(&active))
        .await
        .map_err(|error| format!("Could not inspect ThreadTerm data migration: {error}"))?
}

#[tauri::command]
pub async fn data_migration_cancel(
    active: tauri::State<'_, ResolvedDataRoot>,
    runtime: tauri::State<'_, DataMigrationRuntime>,
) -> Result<(), String> {
    let active = active.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cancel_migration(&active, &runtime))
        .await
        .map_err(|error| format!("Could not cancel ThreadTerm data migration: {error}"))?
}

#[tauri::command]
pub async fn data_migration_confirm(
    active: tauri::State<'_, ResolvedDataRoot>,
    runtime: tauri::State<'_, DataMigrationRuntime>,
) -> Result<DataMigrationStatus, String> {
    let active = active.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = runtime.confirmation_guard();
        confirm_migration(&active)
    })
    .await
    .map_err(|error| format!("Could not confirm ThreadTerm data migration: {error}"))?
}

#[tauri::command]
pub async fn data_migration_cleanup_source(
    transaction_id: String,
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<DataMigrationStatus, String> {
    let active = active.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cleanup_migration_source(&active, &transaction_id))
        .await
        .map_err(|error| format!("Could not clean old ThreadTerm data: {error}"))?
}

#[tauri::command]
pub async fn data_migration_request_rollback(
    transaction_id: String,
    active: tauri::State<'_, ResolvedDataRoot>,
) -> Result<DataMigrationStatus, String> {
    let active = active.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request_rollback(&active, &transaction_id))
        .await
        .map_err(|error| {
            format!("Could not restore the previous ThreadTerm data folder: {error}")
        })?
}

#[tauri::command]
pub fn data_migration_restart(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        app.request_restart();
    });
}

#[cfg(test)]
mod tests;
