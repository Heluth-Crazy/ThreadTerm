use std::path::Path;
use tauri::{Manager, WebviewWindowBuilder};

pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn prepare_window_state_file(path: &Path) -> Result<String, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Window-state file has no parent directory.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Window-state path is not valid Unicode.".to_string())
}

pub fn create_main_window(app: &mut tauri::App) -> Result<(), String> {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| "Main window configuration is missing.".to_string())?;
    let app_handle = app.handle();
    let builder = WebviewWindowBuilder::from_config(app_handle, &config)
        .map_err(|error| format!("Could not prepare the main window: {error}"))?;
    let builder = crate::data_directory::apply_webview_data_directory(app_handle, builder);
    builder
        .build()
        .map_err(|error| format!("Could not create the main window: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::prepare_window_state_file;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn prepares_an_absolute_window_state_path_outside_app_config() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "threadterm-window-state-{}-{nonce}",
            std::process::id()
        ));
        let target = root
            .join("selected-data")
            .join("state")
            .join("window-state.json");
        let app_config = root.join("app-config");

        let filename = prepare_window_state_file(&target).expect("prepare state path");
        assert!(target.parent().expect("parent").is_dir());
        assert_eq!(app_config.join(PathBuf::from(filename)), target);

        fs::remove_dir_all(&root).expect("cleanup fixture");
    }
}
