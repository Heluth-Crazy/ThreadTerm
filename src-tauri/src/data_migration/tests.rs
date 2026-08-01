use super::*;
use crate::data_directory::{
    DataPreflightErrorCode, DataRootLayout, DataRootManifest, BOOTSTRAP_POINTER_FILE,
};
use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
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
            "threadterm-data-migration-{label}-{}-{nonce}",
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

fn create_database(path: &Path) {
    fs::create_dir_all(path.parent().expect("database parent")).expect("database directory");
    let connection = Connection::open(path).expect("create database");
    connection
        .execute_batch(
            "
            PRAGMA journal_mode=WAL;
            CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO sample(value) VALUES ('preserved');
            ",
        )
        .expect("seed database");
}

fn create_state(state_dir: &Path) {
    fs::create_dir_all(state_dir).expect("state directory");
    fs::write(
        state_dir.join("terminal.json"),
        br#"{"formatVersion":1,"initializedKeys":["threadterm-terminal-store"],"values":{"threadterm-terminal-store":"{\"state\":{\"cards\":[]}}"}}"#,
    )
    .expect("terminal state");
}

fn platform_webview(path: PathBuf) -> Option<PathBuf> {
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

fn legacy_fixture(fixture: &TempDirectory) -> ResolvedDataRoot {
    let database_dir = fixture.path.join("legacy-database");
    let database_file = database_dir.join("threadterm.db");
    let state_dir = database_dir.join("state");
    let window_state_file = fixture
        .path
        .join("legacy-config")
        .join(".window-state.json");
    let webview_dir = platform_webview(fixture.path.join("legacy-local").join("EBWebView"));
    create_database(&database_file);
    create_state(&state_dir);
    fs::create_dir_all(window_state_file.parent().expect("window-state parent"))
        .expect("window-state directory");
    fs::write(&window_state_file, br#"{"main":{"x":20,"y":30}}"#).expect("window state");
    if let Some(webview) = webview_dir.as_ref() {
        fs::create_dir_all(webview.join("Default")).expect("webview directory");
        fs::write(
            webview.join("Default").join("Preferences"),
            b"preserved-webview",
        )
        .expect("webview data");
    }

    ResolvedDataRoot {
        mode: DataDirectoryMode::LegacySplit,
        root: None,
        database_file,
        state_dir: Some(state_dir),
        window_state_file,
        webview_dir,
        bootstrap_pointer_path: fixture.path.join("bootstrap").join(BOOTSTRAP_POINTER_FILE),
        recovered_pointer_backup: false,
        startup_migration: None,
    }
}

fn managed_fixture(fixture: &TempDirectory, label: &str) -> ResolvedDataRoot {
    let root = fixture.path.join(label);
    let layout = DataRootLayout::new(&root);
    fs::create_dir_all(&layout.root).expect("managed root");
    fs::write(
        &layout.manifest,
        serde_json::to_vec(&DataRootManifest::default()).expect("manifest json"),
    )
    .expect("manifest");
    create_database(&layout.database_file);
    create_state(&layout.state_dir);
    fs::write(
        &layout.window_state_file,
        br#"{"main":{"maximized":false}}"#,
    )
    .expect("managed window state");
    let webview_dir = platform_webview(layout.webview_dir.clone());
    if let Some(webview) = webview_dir.as_ref() {
        fs::create_dir_all(webview).expect("webview directory");
        fs::write(webview.join("Local State"), b"managed-webview").expect("webview data");
    }
    let bootstrap_pointer_path = fixture.path.join("bootstrap").join(BOOTSTRAP_POINTER_FILE);
    data_directory::write_location_pointer_atomic(
        &bootstrap_pointer_path,
        &DataLocationPointer::new(&root, None),
    )
    .expect("managed pointer");

    ResolvedDataRoot {
        mode: DataDirectoryMode::Managed,
        root: Some(root.clone()),
        database_file: layout.database_file,
        state_dir: Some(layout.state_dir),
        window_state_file: layout.window_state_file,
        webview_dir,
        bootstrap_pointer_path,
        recovered_pointer_backup: false,
        startup_migration: None,
    }
}

fn migrated_active(source: &ResolvedDataRoot, target: &Path) -> ResolvedDataRoot {
    let target = target.canonicalize().expect("canonical target");
    let layout = DataRootLayout::new(&target);
    ResolvedDataRoot {
        mode: DataDirectoryMode::Managed,
        root: Some(target),
        database_file: layout.database_file,
        state_dir: Some(layout.state_dir),
        window_state_file: layout.window_state_file,
        webview_dir: platform_webview(layout.webview_dir),
        bootstrap_pointer_path: source.bootstrap_pointer_path.clone(),
        recovered_pointer_backup: false,
        startup_migration: None,
    }
}

fn read_sample_value(path: &Path) -> String {
    Connection::open(path)
        .expect("open migrated database")
        .query_row("SELECT value FROM sample WHERE id = 1", [], |row| {
            row.get(0)
        })
        .expect("read migrated value")
}

#[test]
fn preflight_rejects_non_empty_and_source_child_targets() {
    let fixture = TempDirectory::new("preflight");
    let active = legacy_fixture(&fixture);
    let non_empty = fixture.path.join("non-empty");
    fs::create_dir_all(&non_empty).expect("non-empty target");
    fs::write(non_empty.join("unrelated.txt"), b"user data").expect("unrelated file");

    assert_eq!(
        filesystem::preflight(&active, &non_empty)
            .expect_err("non-empty target")
            .code,
        DataPreflightErrorCode::NonEmptyTarget
    );

    let source_child = active
        .state_dir
        .as_ref()
        .expect("state directory")
        .join("selected-target");
    fs::create_dir_all(&source_child).expect("source child");
    assert_eq!(
        filesystem::preflight(&active, &source_child)
            .expect_err("source child")
            .code,
        DataPreflightErrorCode::SourceOrChild
    );
}

#[test]
fn scheduling_never_switches_the_running_process_and_can_be_cancelled() {
    let fixture = TempDirectory::new("cancel");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");

    let status =
        schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    assert_eq!(status.phase, DataMigrationPhase::Scheduled);
    assert!(status.restart_required);
    assert_eq!(
        read_sample_value(&active.database_file),
        "preserved".to_string()
    );

    let (pointer, _) = data_directory::read_location_pointer(&active.bootstrap_pointer_path)
        .expect("read pointer")
        .expect("pending pointer");
    assert_eq!(pointer.current_root, target.canonicalize().expect("target"));
    assert_eq!(
        pointer.pending_transaction_id.as_deref(),
        Some(status.transaction_id.as_str())
    );

    cancel_migration(&active, &runtime).expect("cancel migration");
    assert!(
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)
            .expect("read cleared pointer")
            .is_none()
    );
    assert!(!target.exists());
    assert_eq!(
        read_sample_value(&active.database_file),
        "preserved".to_string()
    );
}

#[test]
fn restart_migrates_all_owned_data_then_waits_for_first_launch_confirmation() {
    let fixture = TempDirectory::new("restart");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    let scheduled =
        schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();

    let notice = process_pending_startup(&active.bootstrap_pointer_path)
        .expect("process migration")
        .expect("migration notice");
    assert_eq!(notice.phase, DataMigrationPhase::PointerSwitched);
    let layout = DataRootLayout::new(target.canonicalize().expect("target"));
    assert_eq!(
        read_sample_value(&layout.database_file),
        "preserved".to_string()
    );
    assert!(layout.state_dir.join("terminal.json").is_file());
    assert_eq!(
        fs::read(&layout.window_state_file).expect("migrated window state"),
        fs::read(&active.window_state_file).expect("source window state")
    );
    if let Some(source_webview) = active.webview_dir.as_ref() {
        assert_eq!(
            fs::read(layout.webview_dir.join("Default").join("Preferences"))
                .expect("migrated webview"),
            fs::read(source_webview.join("Default").join("Preferences")).expect("source webview")
        );
    }
    assert!(
        active.database_file.is_file(),
        "source retained before confirmation"
    );

    let (pointer, _) = data_directory::read_location_pointer(&active.bootstrap_pointer_path)
        .expect("read pending target pointer")
        .expect("target pointer");
    assert_eq!(
        pointer.pending_transaction_id.as_deref(),
        Some(scheduled.transaction_id.as_str())
    );

    let migrated = migrated_active(&active, &target);
    let confirmed = confirm_migration(&migrated).expect("confirm first launch");
    assert_eq!(confirmed.phase, DataMigrationPhase::FirstLaunchConfirmed);
    assert!(confirmed.can_rollback);
    let confirmed_again = confirm_migration(&migrated).expect("repeat confirmation is idempotent");
    assert_eq!(
        confirmed_again.phase,
        DataMigrationPhase::FirstLaunchConfirmed
    );
    assert_eq!(confirmed_again.transaction_id, confirmed.transaction_id);
    let (confirmed_pointer, _) =
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)
            .expect("read confirmed pointer")
            .expect("confirmed pointer");
    assert!(confirmed_pointer.pending_transaction_id.is_none());
    assert!(
        active.database_file.is_file(),
        "retained source remains user-controlled"
    );
}

#[test]
fn corrupt_source_database_rolls_back_without_activating_empty_target() {
    let fixture = TempDirectory::new("corrupt");
    let active = legacy_fixture(&fixture);
    fs::write(&active.database_file, b"not a sqlite database").expect("corrupt database");
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();

    let notice = process_pending_startup(&active.bootstrap_pointer_path)
        .expect("safe rollback")
        .expect("rollback notice");
    assert_eq!(notice.phase, DataMigrationPhase::RollbackToSource);
    assert!(notice
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("database")));
    assert!(
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)
            .expect("read restored pointer")
            .is_none(),
        "legacy source remains authoritative"
    );
    assert!(active.database_file.is_file());
    assert!(!DataRootLayout::new(&target).database_file.exists());
}

#[test]
fn disconnected_target_before_restart_restores_legacy_location() {
    let fixture = TempDirectory::new("disconnected");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("external-drive-data");
    schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();
    fs::remove_dir_all(&target).expect("simulate disconnected target");

    let notice = process_pending_startup(&active.bootstrap_pointer_path)
        .expect("restore source")
        .expect("rollback notice");
    assert_eq!(notice.phase, DataMigrationPhase::RollbackToSource);
    assert!(
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)
            .expect("read restored legacy location")
            .is_none()
    );
    assert_eq!(
        read_sample_value(&active.database_file),
        "preserved".to_string()
    );
}

#[test]
fn migration_refuses_to_copy_while_scheduling_process_is_alive() {
    let fixture = TempDirectory::new("locked");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    schedule_migration(&active, &runtime, target, true).expect("schedule migration");

    let error = process_pending_startup(&active.bootstrap_pointer_path)
        .expect_err("live process lock must block copying");
    assert!(error.contains("still using the old data folder"));
    cancel_migration(&active, &runtime).expect("cancel migration");
}

#[test]
fn managed_source_is_restored_when_pending_target_disappears() {
    let fixture = TempDirectory::new("managed-rollback");
    let active = managed_fixture(&fixture, "managed-source");
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("managed-target");
    schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();
    fs::remove_dir_all(&target).expect("simulate unavailable target");

    process_pending_startup(&active.bootstrap_pointer_path).expect("restore managed pointer");
    let (pointer, _) = data_directory::read_location_pointer(&active.bootstrap_pointer_path)
        .expect("read source pointer")
        .expect("managed source pointer");
    assert_eq!(
        pointer.current_root.canonicalize().expect("restored root"),
        active
            .root
            .as_ref()
            .expect("active root")
            .canonicalize()
            .expect("source root")
    );
    assert!(pointer.pending_transaction_id.is_none());
}

#[test]
fn explicit_cleanup_happens_only_after_confirmed_target_launch() {
    let fixture = TempDirectory::new("cleanup");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    let scheduled =
        schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();
    process_pending_startup(&active.bootstrap_pointer_path).expect("migrate");
    let migrated = migrated_active(&active, &target);

    assert!(cleanup_migration_source(&migrated, &scheduled.transaction_id).is_err());
    confirm_migration(&migrated).expect("confirm target");
    let cleaned = cleanup_migration_source(&migrated, &scheduled.transaction_id)
        .expect("clean retained source");
    assert_eq!(cleaned.phase, DataMigrationPhase::OldDataCleanup);
    assert!(!active.database_file.exists());
    assert!(!active.state_dir.as_ref().expect("state").exists());
    assert!(!active.window_state_file.exists());
    if let Some(webview) = active.webview_dir.as_ref() {
        assert!(!webview.exists());
    }
    assert_eq!(
        read_sample_value(&migrated.database_file),
        "preserved".to_string()
    );
}

#[test]
fn interrupted_copy_is_discarded_and_rebuilt_from_the_retained_source() {
    let fixture = TempDirectory::new("interrupted-copy");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    let scheduled =
        schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();

    let mut record = read_record(
        &target.canonicalize().expect("target"),
        &scheduled.transaction_id,
    )
    .expect("read migration record");
    record.phase = DataMigrationPhase::CopyingToStaging;
    record.copied_bytes = 17;
    write_record(&mut record).expect("mark interrupted copy");
    let layout = DataRootLayout::new(target.canonicalize().expect("target"));
    fs::create_dir_all(&layout.database_dir).expect("partial database directory");
    fs::write(&layout.database_file, b"partial").expect("partial copied database");

    let notice = process_pending_startup(&active.bootstrap_pointer_path)
        .expect("resume migration")
        .expect("migration notice");
    assert_eq!(notice.phase, DataMigrationPhase::PointerSwitched);
    assert_eq!(
        read_sample_value(&layout.database_file),
        "preserved".to_string()
    );
}

#[test]
fn retained_source_can_be_selected_again_before_cleanup() {
    let fixture = TempDirectory::new("explicit-rollback");
    let active = legacy_fixture(&fixture);
    let runtime = DataMigrationRuntime::default();
    let target = fixture.path.join("selected-data");
    let scheduled =
        schedule_migration(&active, &runtime, target.clone(), true).expect("schedule migration");
    runtime.release_scheduled_lock();
    process_pending_startup(&active.bootstrap_pointer_path).expect("migrate");
    let migrated = migrated_active(&active, &target);
    confirm_migration(&migrated).expect("confirm target");

    let rollback =
        request_rollback(&migrated, &scheduled.transaction_id).expect("request rollback");
    assert_eq!(rollback.phase, DataMigrationPhase::RollbackToSource);
    assert!(rollback.restart_required);
    let notice = process_pending_startup(&active.bootstrap_pointer_path)
        .expect("activate retained source")
        .expect("rollback notice");
    assert_eq!(notice.phase, DataMigrationPhase::RollbackToSource);
    assert!(
        data_directory::read_location_pointer(&active.bootstrap_pointer_path)
            .expect("read legacy source")
            .is_none()
    );
    assert_eq!(
        read_sample_value(&active.database_file),
        "preserved".to_string()
    );
    assert!(
        migrated.database_file.is_file(),
        "the former target is retained until the user cleans it"
    );
}
