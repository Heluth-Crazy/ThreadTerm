use std::path::{Path, PathBuf};
use std::process::Command;

fn validate_local_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Directory path is required.".to_string());
    }

    let dir = Path::new(trimmed);
    if !dir.is_absolute() {
        return Err("Directory path must be absolute.".to_string());
    }
    if !dir.exists() {
        return Err("Directory does not exist.".to_string());
    }
    if !dir.is_dir() {
        return Err("Path is not a directory.".to_string());
    }

    dir.canonicalize()
        .map_err(|err| format!("Could not resolve directory: {err}"))
}

fn open_directory_path(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(dir);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(dir);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(dir);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open directory: {err}"))
}

#[tauri::command]
pub fn open_local_directory(path: String) -> Result<(), String> {
    let dir = validate_local_directory(&path)?;
    open_directory_path(&dir)
}

#[cfg(test)]
mod tests {
    use super::validate_local_directory;
    use std::fs;

    #[test]
    fn rejects_empty_path() {
        assert_eq!(
            validate_local_directory(" ").unwrap_err(),
            "Directory path is required."
        );
    }

    #[test]
    fn rejects_relative_path() {
        assert_eq!(
            validate_local_directory("relative/path").unwrap_err(),
            "Directory path must be absolute."
        );
    }

    #[test]
    fn rejects_missing_directory() {
        let missing =
            std::env::temp_dir().join(format!("threadterm-missing-{}", std::process::id()));
        assert_eq!(
            validate_local_directory(&missing.to_string_lossy()).unwrap_err(),
            "Directory does not exist."
        );
    }

    #[test]
    fn rejects_file_path() {
        let file = std::env::temp_dir().join(format!("threadterm-file-{}", std::process::id()));
        fs::write(&file, "not a dir").unwrap();

        let result = validate_local_directory(&file.to_string_lossy());
        let _ = fs::remove_file(file);

        assert_eq!(result.unwrap_err(), "Path is not a directory.");
    }

    #[test]
    fn accepts_existing_absolute_directory() {
        let temp_dir = std::env::temp_dir();
        assert!(validate_local_directory(&temp_dir.to_string_lossy()).is_ok());
    }
}
