use crate::data_directory::{
    self, DataDirectoryMode, DataLocationPointer, DataRootLayout, DataRootManifest,
    ResolvedDataRoot, BOOTSTRAP_POINTER_BACKUP_FILE, BOOTSTRAP_POINTER_FILE,
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const USE_RECOMMENDED: &str = "使用建议位置 / Use recommended";
const CHOOSE_ANOTHER: &str = "选择其他位置 / Choose another";
const EXIT: &str = "退出 / Exit";
const RETRY: &str = "重试 / Retry";
const LOCATE: &str = "重新定位 / Locate";
const MORE: &str = "更多 / More";
const RESTORE: &str = "恢复旧目录 / Restore";
const BACK: &str = "返回 / Back";

#[derive(Debug, Clone)]
pub enum StartupDataDirectoryMode {
    FirstStart {
        pointer_path: PathBuf,
        recommended_root: PathBuf,
    },
    Recovery {
        pointer_path: Option<PathBuf>,
        error: String,
    },
}

pub fn recommended_root() -> Result<PathBuf, String> {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .map(|documents| documents.join("ThreadTerm Data"))
        .ok_or_else(|| "Could not resolve a recommended ThreadTerm data folder.".to_string())
}

fn path_contains_data(path: &Path) -> bool {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return true;
    }
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => true,
    }
}

pub fn is_first_start(active: &ResolvedDataRoot) -> bool {
    if active.mode != DataDirectoryMode::LegacySplit
        || active.bootstrap_pointer_path.exists()
        || active
            .bootstrap_pointer_path
            .with_file_name(BOOTSTRAP_POINTER_BACKUP_FILE)
            .exists()
    {
        return false;
    }

    let database_root = active
        .database_file
        .parent()
        .unwrap_or(active.database_file.as_path());
    !path_contains_data(database_root)
        && !path_contains_data(&active.window_state_file)
        && active
            .webview_dir
            .as_deref()
            .map_or(true, |path| !path_contains_data(path))
}

fn directory_is_non_empty(path: &Path) -> Result<bool, String> {
    fs::read_dir(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))
        .map(|mut entries| entries.next().is_some())
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

fn validate_root_location(root: &Path) -> Result<(), String> {
    if is_network_location(root) {
        return Err("Network folders are not supported for ThreadTerm data.".to_string());
    }
    if has_app_bundle_component(root) {
        return Err(
            "ThreadTerm data cannot be stored inside a macOS application bundle.".to_string(),
        );
    }
    if std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|application| root.starts_with(application))
    {
        return Err(
            "ThreadTerm data cannot be stored inside the application installation.".to_string(),
        );
    }
    Ok(())
}

fn writable_probe(root: &Path) -> Result<(), String> {
    let probe = root.join(format!(
        ".threadterm-first-start-probe-{}",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|error| format!("ThreadTerm cannot write to {}: {error}", root.display()))?;
    file.write_all(b"threadterm")
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&probe);
            format!(
                "ThreadTerm cannot persist data in {}: {error}",
                root.display()
            )
        })?;
    drop(file);
    fs::remove_file(&probe).map_err(|error| {
        format!(
            "Could not remove the write check from {}: {error}",
            root.display()
        )
    })
}

fn write_manifest(layout: &DataRootLayout) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&DataRootManifest::default())
        .map_err(|error| format!("Could not serialize the data manifest: {error}"))?;
    let temp = layout.root.join(format!(
        ".manifest.json.{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
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
            "Could not activate data manifest {}: {error}",
            layout.manifest.display()
        )
    })
}

fn cleanup_partial_layout(layout: &DataRootLayout, remove_root: bool) {
    let _ = fs::remove_file(&layout.manifest);
    for path in [
        &layout.database_dir,
        &layout.state_dir,
        &layout.webview_dir,
        &layout.migration_dir,
    ] {
        let _ = fs::remove_dir_all(path);
    }
    if remove_root {
        let _ = fs::remove_dir(&layout.root);
    }
}

pub fn initialize_selected_root(
    requested_root: &Path,
    pointer_path: &Path,
) -> Result<PathBuf, String> {
    if requested_root.as_os_str().is_empty() {
        return Err("Choose a ThreadTerm data folder.".to_string());
    }
    if !requested_root.is_absolute() {
        return Err("The ThreadTerm data folder must use an absolute path.".to_string());
    }

    let existed = match fs::symlink_metadata(requested_root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Symbolic-link data folders are not supported.".to_string());
            }
            if !metadata.is_dir() {
                return Err("The selected ThreadTerm data path is not a folder.".to_string());
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Could not inspect {}: {error}",
                requested_root.display()
            ))
        }
    };
    if !existed {
        fs::create_dir_all(requested_root).map_err(|error| {
            format!(
                "ThreadTerm cannot create the selected folder {}: {error}",
                requested_root.display()
            )
        })?;
    }

    let canonical = requested_root.canonicalize().map_err(|error| {
        format!(
            "Could not resolve the selected folder {}: {error}",
            requested_root.display()
        )
    })?;
    validate_root_location(&canonical)?;

    if directory_is_non_empty(&canonical)? {
        let existing = data_directory::validate_managed_root(&canonical).map_err(|_| {
            "The selected folder is not empty and is not a valid ThreadTerm data folder."
                .to_string()
        })?;
        data_directory::write_location_pointer_atomic(
            pointer_path,
            &DataLocationPointer::new(&existing, None),
        )?;
        return Ok(existing);
    }

    writable_probe(&canonical)?;
    let layout = DataRootLayout::new(&canonical);
    let initialized = (|| {
        for path in [
            &layout.database_dir,
            &layout.state_dir,
            &layout.webview_dir,
            &layout.migration_dir,
        ] {
            fs::create_dir_all(path)
                .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        }
        write_manifest(&layout)?;
        data_directory::validate_managed_root(&canonical)
    })();
    let canonical = match initialized {
        Ok(canonical) => canonical,
        Err(error) => {
            cleanup_partial_layout(&layout, !existed);
            return Err(error);
        }
    };
    data_directory::write_location_pointer_atomic(
        pointer_path,
        &DataLocationPointer::new(&canonical, None),
    )?;
    Ok(canonical)
}

pub fn repoint_to_existing_root(pointer_path: &Path, selected_root: &Path) -> Result<(), String> {
    let canonical = data_directory::validate_managed_root(selected_root)?;
    validate_root_location(&canonical)?;
    let previous = data_directory::read_location_pointer(pointer_path)
        .ok()
        .flatten()
        .map(|(pointer, _)| pointer);
    let previous_root = previous.as_ref().and_then(|pointer| {
        if pointer.current_root != canonical {
            Some(pointer.current_root.clone())
        } else {
            pointer.previous_root.clone()
        }
    });
    data_directory::write_location_pointer_atomic(
        pointer_path,
        &DataLocationPointer::new(canonical, previous_root),
    )
}

fn legacy_data_exists(pointer_path: &Path) -> bool {
    let database_root = data_directory::legacy_database_dir();
    let window_state = pointer_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".window-state.json");
    if path_contains_data(&database_root) || path_contains_data(&window_state) {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|path| {
                path.join(data_directory::DATA_ROOT_APP_ID)
                    .join("EBWebView")
            })
            .is_some_and(|path| path_contains_data(&path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn remove_pointer_files(pointer_path: &Path) -> Result<(), String> {
    for path in [
        pointer_path.to_path_buf(),
        pointer_path.with_file_name(BOOTSTRAP_POINTER_BACKUP_FILE),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Could not remove {}: {error}", path.display()));
            }
        }
    }
    Ok(())
}

pub fn restore_previous_root(pointer_path: &Path) -> Result<(), String> {
    if let Some((pointer, _)) = data_directory::read_location_pointer(pointer_path)? {
        if let Some(previous_root) = pointer.previous_root.as_deref() {
            let previous = data_directory::validate_managed_root(previous_root)?;
            return data_directory::write_location_pointer_atomic(
                pointer_path,
                &DataLocationPointer::new(previous, Some(pointer.current_root)),
            );
        }
    }
    if legacy_data_exists(pointer_path) {
        return remove_pointer_files(pointer_path);
    }
    Err("No retained previous ThreadTerm data folder is available.".to_string())
}

fn show_error<R: tauri::Runtime>(app: &tauri::AppHandle<R>, error: &str) {
    app.dialog()
        .message(format!(
            "ThreadTerm 无法完成此操作。\n\nThreadTerm could not complete this action.\n\n{error}"
        ))
        .title("ThreadTerm")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn show_restart_message<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    app.dialog()
        .message(format!(
            "数据位置已保存，ThreadTerm 将重新启动。\n\nThe data location is ready. ThreadTerm will restart.\n\n{}",
            root.display()
        ))
        .title("ThreadTerm")
        .kind(MessageDialogKind::Info)
        .blocking_show();
}

fn pick_folder<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    default_root: &Path,
) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("选择 ThreadTerm 数据目录 / Choose ThreadTerm data folder")
        .set_directory(default_root.parent().unwrap_or(default_root))
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
}

fn run_first_start<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pointer_path: &Path,
    recommended_root: &Path,
) {
    loop {
        let result = app
            .dialog()
            .message(format!(
                "ThreadTerm 只需要一个自有数据目录，用于数据库、界面状态和窗口状态。项目、Git 仓库和 Agent 数据不会被移动。\n\nThreadTerm needs one folder for its own database, interface state, and window state. Projects, Git repositories, and Agent data are never moved.\n\n建议位置 / Recommended:\n{}",
                recommended_root.display()
            ))
            .title("ThreadTerm 首次设置 / First setup")
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                USE_RECOMMENDED.to_string(),
                CHOOSE_ANOTHER.to_string(),
                EXIT.to_string(),
            ))
            .blocking_show_with_result();

        let selected = match result {
            MessageDialogResult::Yes => Some(recommended_root.to_path_buf()),
            MessageDialogResult::No => pick_folder(app, recommended_root),
            MessageDialogResult::Custom(value) if value == USE_RECOMMENDED => {
                Some(recommended_root.to_path_buf())
            }
            MessageDialogResult::Custom(value) if value == CHOOSE_ANOTHER => {
                pick_folder(app, recommended_root)
            }
            _ => {
                app.exit(0);
                return;
            }
        };
        let Some(selected) = selected else {
            continue;
        };
        match initialize_selected_root(&selected, pointer_path) {
            Ok(root) => {
                show_restart_message(app, &root);
                app.request_restart();
                return;
            }
            Err(error) => show_error(app, &error),
        }
    }
}

fn recovery_default_root(pointer_path: Option<&Path>) -> PathBuf {
    pointer_path
        .and_then(|path| data_directory::read_location_pointer(path).ok().flatten())
        .map(|(pointer, _)| pointer.current_root)
        .or_else(|| recommended_root().ok())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn run_recovery<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pointer_path: Option<&Path>,
    error: &str,
) {
    loop {
        let result = app
            .dialog()
            .message(format!(
                "ThreadTerm 没有创建空白工作台，因为已选择的数据目录当前不可用。\n\nThreadTerm did not create an empty workspace because the selected data folder is unavailable.\n\n{error}"
            ))
            .title("ThreadTerm 数据目录不可用 / Data folder unavailable")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                RETRY.to_string(),
                LOCATE.to_string(),
                MORE.to_string(),
            ))
            .blocking_show_with_result();

        match result {
            MessageDialogResult::Yes => {
                app.request_restart();
                return;
            }
            MessageDialogResult::No => {
                let Some(pointer_path) = pointer_path else {
                    show_error(
                        app,
                        "The system configuration directory is unavailable, so ThreadTerm cannot update its data pointer.",
                    );
                    continue;
                };
                let default_root = recovery_default_root(Some(pointer_path));
                if let Some(selected) = pick_folder(app, &default_root) {
                    match repoint_to_existing_root(pointer_path, &selected) {
                        Ok(()) => {
                            show_restart_message(app, &selected);
                            app.request_restart();
                            return;
                        }
                        Err(error) => show_error(app, &error),
                    }
                }
            }
            MessageDialogResult::Custom(value) if value == RETRY => {
                app.request_restart();
                return;
            }
            MessageDialogResult::Custom(value) if value == LOCATE => {
                let Some(pointer_path) = pointer_path else {
                    show_error(
                        app,
                        "The system configuration directory is unavailable, so ThreadTerm cannot update its data pointer.",
                    );
                    continue;
                };
                let default_root = recovery_default_root(Some(pointer_path));
                if let Some(selected) = pick_folder(app, &default_root) {
                    match repoint_to_existing_root(pointer_path, &selected) {
                        Ok(()) => {
                            show_restart_message(app, &selected);
                            app.request_restart();
                            return;
                        }
                        Err(error) => show_error(app, &error),
                    }
                }
            }
            _ => {
                let more = app
                    .dialog()
                    .message(
                        "可以恢复保留的旧数据目录，或退出而不改动任何数据。\n\nRestore a retained previous data folder, or exit without changing data.",
                    )
                    .title("ThreadTerm")
                    .buttons(MessageDialogButtons::YesNoCancelCustom(
                        RESTORE.to_string(),
                        BACK.to_string(),
                        EXIT.to_string(),
                    ))
                    .blocking_show_with_result();
                match more {
                    MessageDialogResult::Yes => {
                        let Some(pointer_path) = pointer_path else {
                            show_error(
                                app,
                                "The system configuration directory is unavailable, so ThreadTerm cannot restore its data pointer.",
                            );
                            continue;
                        };
                        match restore_previous_root(pointer_path) {
                            Ok(()) => {
                                app.request_restart();
                                return;
                            }
                            Err(error) => show_error(app, &error),
                        }
                    }
                    MessageDialogResult::Custom(value) if value == RESTORE => {
                        let Some(pointer_path) = pointer_path else {
                            show_error(
                                app,
                                "The system configuration directory is unavailable, so ThreadTerm cannot restore its data pointer.",
                            );
                            continue;
                        };
                        match restore_previous_root(pointer_path) {
                            Ok(()) => {
                                app.request_restart();
                                return;
                            }
                            Err(error) => show_error(app, &error),
                        }
                    }
                    MessageDialogResult::Cancel => {
                        app.exit(0);
                        return;
                    }
                    MessageDialogResult::Custom(value) if value == EXIT => {
                        app.exit(0);
                        return;
                    }
                    _ => {}
                }
            }
        }
    }
}

pub fn run(mode: StartupDataDirectoryMode) -> Result<(), String> {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let mode = mode.clone();
            std::thread::Builder::new()
                .name("threadterm-data-directory-setup".to_string())
                .spawn(move || match mode {
                    StartupDataDirectoryMode::FirstStart {
                        pointer_path,
                        recommended_root,
                    } => run_first_start(&app_handle, &pointer_path, &recommended_root),
                    StartupDataDirectoryMode::Recovery {
                        pointer_path,
                        error,
                    } => run_recovery(&app_handle, pointer_path.as_deref(), &error),
                })
                .map_err(|error| format!("Could not start the data-folder assistant: {error}"))?;
            Ok(())
        })
        .run(tauri::generate_context!());
    result.map_err(|error| format!("ThreadTerm data-folder assistant failed: {error}"))
}

pub fn startup_pointer_path() -> Result<PathBuf, String> {
    data_directory::bootstrap_config_dir().map(|path| path.join(BOOTSTRAP_POINTER_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
                "threadterm-startup-data-{label}-{}-{nonce}",
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

    fn legacy_active(fixture: &TempDirectory) -> ResolvedDataRoot {
        ResolvedDataRoot {
            mode: DataDirectoryMode::LegacySplit,
            root: None,
            database_file: fixture.path.join("legacy").join("threadterm.db"),
            state_dir: Some(fixture.path.join("legacy").join("state")),
            window_state_file: fixture.path.join("config").join(".window-state.json"),
            webview_dir: Some(fixture.path.join("local").join("EBWebView")),
            bootstrap_pointer_path: fixture.path.join("config").join(BOOTSTRAP_POINTER_FILE),
            recovered_pointer_backup: false,
            startup_migration: None,
        }
    }

    #[test]
    fn first_start_requires_all_legacy_owned_locations_to_be_empty() {
        let fixture = TempDirectory::new("fresh");
        let active = legacy_active(&fixture);
        assert!(is_first_start(&active));

        fs::create_dir_all(active.database_file.parent().expect("database parent"))
            .expect("legacy directory");
        fs::write(&active.database_file, b"existing").expect("legacy database");
        assert!(!is_first_start(&active));
    }

    #[test]
    fn initial_selection_creates_one_versioned_root_and_pointer() {
        let fixture = TempDirectory::new("initialize");
        let target = fixture.path.join("selected");
        let pointer = fixture.path.join("config").join(BOOTSTRAP_POINTER_FILE);

        let canonical =
            initialize_selected_root(&target, &pointer).expect("initialize selected root");
        let layout = DataRootLayout::new(&canonical);
        assert!(layout.database_dir.is_dir());
        assert!(layout.state_dir.is_dir());
        assert!(layout.webview_dir.is_dir());
        assert!(layout.migration_dir.is_dir());
        assert!(layout.manifest.is_file());
        let (stored, _) = data_directory::read_location_pointer(&pointer)
            .expect("pointer read")
            .expect("pointer");
        assert_eq!(stored.current_root, canonical);
        assert!(stored.previous_root.is_none());
    }

    #[test]
    fn initial_selection_reconnects_existing_threadterm_root_but_rejects_other_files() {
        let fixture = TempDirectory::new("reconnect");
        let target = fixture.path.join("selected");
        let pointer = fixture.path.join("config").join(BOOTSTRAP_POINTER_FILE);
        initialize_selected_root(&target, &pointer).expect("initialize");
        fs::remove_file(&pointer).expect("simulate uninstall pointer removal");

        initialize_selected_root(&target, &pointer).expect("reconnect existing root");
        fs::remove_file(&pointer).expect("remove pointer again");

        let unrelated = fixture.path.join("unrelated");
        fs::create_dir_all(&unrelated).expect("unrelated directory");
        fs::write(unrelated.join("notes.txt"), b"user data").expect("unrelated file");
        assert!(initialize_selected_root(&unrelated, &pointer)
            .expect_err("must reject unrelated data")
            .contains("not empty"));
    }

    #[test]
    fn previous_managed_root_can_be_restored_without_deleting_current_root() {
        let fixture = TempDirectory::new("restore");
        let previous = fixture.path.join("previous");
        let current = fixture.path.join("current");
        let pointer = fixture.path.join("config").join(BOOTSTRAP_POINTER_FILE);
        initialize_selected_root(&previous, &pointer).expect("previous root");
        initialize_selected_root(&current, &pointer).expect("current root");
        data_directory::write_location_pointer_atomic(
            &pointer,
            &DataLocationPointer::new(&current, Some(previous.clone())),
        )
        .expect("link roots");

        restore_previous_root(&pointer).expect("restore previous");
        let (restored, _) = data_directory::read_location_pointer(&pointer)
            .expect("read pointer")
            .expect("restored pointer");
        assert_eq!(
            restored.current_root.canonicalize().expect("current"),
            previous.canonicalize().expect("previous")
        );
        assert!(current.is_dir(), "current root remains recoverable");
    }
}
