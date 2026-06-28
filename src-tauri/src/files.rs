//! Workspace file access for the in-app Explorer / file viewer.
//!
//! All operations use Rust-native `std::fs` (in-process syscalls) and never
//! spawn a child process — so the Explorer works even in locked-down Windows
//! environments that whitelist which processes may spawn (the file path does
//! NOT depend on a whitelisted `node` / system terminal). The only requirement
//! is that ThreadTerm itself may read the user's working directory, which it
//! already must to host the terminal at that cwd.
//!
//! Listing is lazy (one directory level per call); the frontend tree only
//! reads a child directory when the user expands it, so large folders such as
//! `node_modules` cost nothing until opened.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MAX_TEXT_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// Display name (final path component).
    pub name: String,
    /// Absolute path, usable as the next `read_directory` argument.
    pub path: String,
    pub is_dir: bool,
    /// Whether this is a dot-file / dot-dir (frontend may de-emphasise).
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub contents: String,
    pub size_bytes: u64,
    pub modified_unix_ms: Option<u64>,
}

fn modified_unix_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn canonical_workspace_root(root_path: &str) -> Result<PathBuf, String> {
    let root_path = root_path.trim();
    if root_path.is_empty() {
        return Err("workspace_root_required: Workspace root is required.".to_string());
    }

    let root = Path::new(root_path);
    if !root.is_absolute() {
        return Err("workspace_root_not_absolute: Workspace root must be absolute.".to_string());
    }
    if !root.is_dir() {
        return Err(format!(
            "workspace_root_not_directory: Not a directory: {root_path}"
        ));
    }

    root.canonicalize().map_err(|err| {
        format!("workspace_root_unresolved: Could not resolve workspace root: {err}")
    })
}

fn resolve_existing_workspace_file(root_path: &str, path: &str) -> Result<PathBuf, String> {
    let root = canonical_workspace_root(root_path)?;
    let path = path.trim();
    if path.is_empty() {
        return Err("file_path_required: File path is required.".to_string());
    }

    let input = Path::new(path);
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    let file = candidate
        .canonicalize()
        .map_err(|err| format!("file_unresolved: Could not resolve file: {err}"))?;
    if !file.starts_with(&root) {
        return Err("file_outside_workspace: File is outside the workspace root.".to_string());
    }
    if !file.is_file() {
        return Err(format!("file_not_regular: Not a file: {}", file.display()));
    }
    Ok(file)
}

fn resolve_workspace_file_for_write(root_path: &str, path: &str) -> Result<PathBuf, String> {
    let root = canonical_workspace_root(root_path)?;
    let path = path.trim();
    if path.is_empty() {
        return Err("file_path_required: File path is required.".to_string());
    }

    let input = Path::new(path);
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    let parent = candidate
        .parent()
        .ok_or_else(|| "file_parent_missing: File path has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|err| format!("file_parent_unresolved: Could not resolve file parent: {err}"))?;
    if !parent.starts_with(&root) {
        return Err("file_outside_workspace: File is outside the workspace root.".to_string());
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| "file_name_missing: File path has no file name.".to_string())?;
    let file = parent.join(name);
    if file.exists() {
        let resolved = file
            .canonicalize()
            .map_err(|err| format!("file_unresolved: Could not resolve file: {err}"))?;
        if !resolved.starts_with(&root) {
            return Err("file_outside_workspace: File is outside the workspace root.".to_string());
        }
        if !resolved.is_file() {
            return Err(format!(
                "file_not_regular: Not a file: {}",
                resolved.display()
            ));
        }
        return Ok(resolved);
    }
    Ok(file)
}

fn read_workspace_file_sync(root_path: &str, path: &str) -> Result<WorkspaceFile, String> {
    let file = resolve_existing_workspace_file(root_path, path)?;
    let metadata = std::fs::metadata(&file)
        .map_err(|err| format!("file_stat_failed: Failed to stat file: {err}"))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file_too_large: File is larger than {} bytes.",
            MAX_TEXT_FILE_BYTES
        ));
    }

    let bytes = std::fs::read(&file)
        .map_err(|err| format!("file_read_failed: Failed to read file: {err}"))?;
    if bytes.contains(&0) {
        return Err("file_binary: Binary files cannot be edited.".to_string());
    }
    let contents = String::from_utf8(bytes)
        .map_err(|_| "file_not_utf8: File is not valid UTF-8 text.".to_string())?;

    Ok(WorkspaceFile {
        path: file.to_string_lossy().to_string(),
        contents,
        size_bytes: metadata.len(),
        modified_unix_ms: modified_unix_ms(&metadata),
    })
}

fn write_workspace_file_sync(
    root_path: &str,
    path: &str,
    contents: &str,
    expected_modified_unix_ms: Option<u64>,
) -> Result<WorkspaceFile, String> {
    if contents.as_bytes().len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file_too_large: File is larger than {} bytes.",
            MAX_TEXT_FILE_BYTES
        ));
    }
    if contents.as_bytes().contains(&0) {
        return Err("file_binary: Binary files cannot be edited.".to_string());
    }

    let file = resolve_workspace_file_for_write(root_path, path)?;
    let current_modified = if file.exists() {
        let metadata = std::fs::metadata(&file)
            .map_err(|err| format!("file_stat_failed: Failed to stat file: {err}"))?;
        modified_unix_ms(&metadata)
    } else {
        None
    };
    if let Some(expected) = expected_modified_unix_ms {
        if current_modified != Some(expected) {
            return Err("file_conflict: File changed on disk. Reload before saving.".to_string());
        }
    }

    std::fs::write(&file, contents.as_bytes())
        .map_err(|err| format!("file_write_failed: Failed to write file: {err}"))?;
    read_workspace_file_sync(root_path, &file.to_string_lossy())
}

fn read_directory_sync(path: &str) -> Result<Vec<DirEntry>, String> {
    // Tolerate trailing whitespace / newlines that can ride along when the cwd
    // is derived from a shell OSC sequence (base64-decoded PWD).
    let path = path.trim();
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let read = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {e}"))?;

    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // `file_type()` avoids an extra stat on most platforms and does not
        // follow symlinks (a symlinked dir is reported as symlink, not dir) —
        // fall back to `is_dir` only when the type is unknown.
        let is_dir = match entry.file_type() {
            Ok(t) if t.is_symlink() => entry.path().is_dir(),
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        let is_hidden = name.starts_with('.');
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_hidden,
        });
    }

    // Directories first, then case-insensitive name order — the conventional
    // file-explorer sort.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// List the immediate children of `path` (one level, lazy). Native `std::fs`,
/// no child process spawned.
#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<DirEntry>, String> {
    tokio::task::spawn_blocking(move || read_directory_sync(&path))
        .await
        .map_err(|err| format!("Failed to read directory: {err}"))?
}

#[tauri::command]
pub async fn workspace_read_file(root_path: String, path: String) -> Result<WorkspaceFile, String> {
    tokio::task::spawn_blocking(move || read_workspace_file_sync(&root_path, &path))
        .await
        .map_err(|err| format!("Failed to read workspace file: {err}"))?
}

#[tauri::command]
pub async fn workspace_write_file(
    root_path: String,
    path: String,
    contents: String,
    expected_modified_unix_ms: Option<u64>,
) -> Result<WorkspaceFile, String> {
    tokio::task::spawn_blocking(move || {
        write_workspace_file_sync(&root_path, &path, &contents, expected_modified_unix_ms)
    })
    .await
    .map_err(|err| format!("Failed to write workspace file: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "threadterm_files_{name}_{}_{}",
            std::process::id(),
            stamp
        ))
    }

    #[test]
    fn lists_dirs_first_then_files_case_insensitive() {
        let tmp = std::env::temp_dir().join("threadterm_files_test_a");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Zeta")).unwrap();
        std::fs::create_dir_all(tmp.join("alpha")).unwrap();
        std::fs::write(tmp.join("readme.md"), "x").unwrap();
        std::fs::write(tmp.join(".hidden"), "x").unwrap();

        let out = read_directory_sync(tmp.to_str().unwrap()).unwrap();
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        // dirs first (alpha, Zeta — case-insensitive), then files (.hidden, readme.md).
        assert_eq!(names, vec!["alpha", "Zeta", ".hidden", "readme.md"]);
        assert!(out[0].is_dir && !out[2].is_dir);
        assert!(out[2].is_hidden);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn errors_on_non_directory() {
        assert!(read_directory_sync("/this/does/not/exist/xyz").is_err());
    }

    #[test]
    fn reads_text_file_inside_workspace() {
        let tmp = temp_dir("read_text");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("notes.txt");
        std::fs::write(&file, "hello\r\nworld\r\n").unwrap();

        let out = read_workspace_file_sync(tmp.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert_eq!(out.contents, "hello\r\nworld\r\n");
        assert_eq!(out.size_bytes, 14);
        assert!(out.modified_unix_ms.is_some());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_file_outside_workspace() {
        let root = temp_dir("root");
        let other = temp_dir("other");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let outside = other.join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();

        let err = read_workspace_file_sync(root.to_str().unwrap(), outside.to_str().unwrap())
            .unwrap_err();
        assert!(err.starts_with("file_outside_workspace:"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn rejects_binary_and_non_utf8_files() {
        let tmp = temp_dir("binary");
        std::fs::create_dir_all(&tmp).unwrap();
        let binary = tmp.join("bin.dat");
        let non_utf8 = tmp.join("bad.txt");
        std::fs::write(&binary, b"abc\0def").unwrap();
        std::fs::write(&non_utf8, [0xff, 0xfe]).unwrap();

        let binary_err =
            read_workspace_file_sync(tmp.to_str().unwrap(), binary.to_str().unwrap()).unwrap_err();
        assert!(binary_err.starts_with("file_binary:"), "{binary_err}");
        let utf8_err = read_workspace_file_sync(tmp.to_str().unwrap(), non_utf8.to_str().unwrap())
            .unwrap_err();
        assert!(utf8_err.starts_with("file_not_utf8:"), "{utf8_err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_files_over_size_limit() {
        let tmp = temp_dir("too_large");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("large.txt");
        std::fs::write(&file, vec![b'a'; (MAX_TEXT_FILE_BYTES + 1) as usize]).unwrap();

        let err =
            read_workspace_file_sync(tmp.to_str().unwrap(), file.to_str().unwrap()).unwrap_err();
        assert!(err.starts_with("file_too_large:"), "{err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_rejects_modified_time_conflict() {
        let tmp = temp_dir("conflict");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("notes.txt");
        std::fs::write(&file, "hello").unwrap();
        let current =
            read_workspace_file_sync(tmp.to_str().unwrap(), file.to_str().unwrap()).unwrap();

        let err = write_workspace_file_sync(
            tmp.to_str().unwrap(),
            file.to_str().unwrap(),
            "updated",
            current.modified_unix_ms.map(|value| value + 1),
        )
        .unwrap_err();
        assert!(err.starts_with("file_conflict:"), "{err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_can_restore_missing_file_inside_workspace() {
        let tmp = temp_dir("restore_missing");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("notes.txt");

        let out = write_workspace_file_sync(
            tmp.to_str().unwrap(),
            file.to_str().unwrap(),
            "restored\n",
            None,
        )
        .unwrap();

        assert_eq!(out.contents, "restored\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "restored\n");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_preserves_submitted_crlf_content() {
        let tmp = temp_dir("crlf");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("notes.txt");
        std::fs::write(&file, "old\r\n").unwrap();
        let current =
            read_workspace_file_sync(tmp.to_str().unwrap(), file.to_str().unwrap()).unwrap();

        let out = write_workspace_file_sync(
            tmp.to_str().unwrap(),
            file.to_str().unwrap(),
            "new\r\nline\r\n",
            current.modified_unix_ms,
        )
        .unwrap();
        assert_eq!(out.contents, "new\r\nline\r\n");
        assert_eq!(std::fs::read(&file).unwrap(), b"new\r\nline\r\n");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
