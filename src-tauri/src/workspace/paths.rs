//! Canonical worktree identity and safe WorkspaceId-scoped path resolution.

use super::error::{WorkspaceError, WorkspaceErrorCode};
use std::path::{Component, Path, PathBuf};

/// Strip Windows `\\?\` / `\\?\UNC\` verbatim prefixes for display only.
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

/// Build a stable comparison key for a canonical root.
///
/// Windows: lowercase + forward slashes so drive-letter and separator variants
/// collapse. Unix: keep the canonical form as-is (case-sensitive).
pub fn comparison_key(canonical_root: &Path) -> String {
    let display = display_path(canonical_root);
    #[cfg(windows)]
    {
        display.replace('\\', "/").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        display
    }
}

/// Normalize a provider-reported project path for identity comparison without
/// touching the filesystem. Windows-shaped paths are compared case-insensitively
/// with slash and verbatim-prefix normalization; Unix paths remain case-sensitive.
pub(crate) fn normalize_project_identity_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let mut normalized = raw.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("//?/unc/") {
        normalized = format!("//{}", &normalized[8..]);
    } else if lower.starts_with("//?/") {
        normalized = normalized[4..].to_string();
    }

    let windows_path = normalized.starts_with("//")
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':')
        || raw.contains('\\');
    if windows_path {
        let unc = normalized.starts_with("//");
        let collapsed = normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        normalized = if unc {
            format!("//{collapsed}")
        } else {
            collapsed
        };
    }

    while normalized.ends_with('/')
        && normalized.len() > 1
        && !(normalized.len() == 3 && normalized.as_bytes().get(1) == Some(&b':'))
    {
        normalized.pop();
    }

    Some(if windows_path {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    })
}

pub(crate) fn same_project_path(left: &str, right: &str) -> bool {
    match (
        normalize_project_identity_path(left),
        normalize_project_identity_path(right),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Canonicalize an absolute existing directory root for registration.
pub fn canonicalize_workspace_root(root_path: &str) -> Result<PathBuf, WorkspaceError> {
    let root_path = root_path.trim();
    if root_path.is_empty() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "Workspace root is required.",
        ));
    }
    let root = Path::new(root_path);
    if !root.is_absolute() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "Workspace root must be absolute.",
        ));
    }
    if !root.is_dir() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceUnavailable,
            format!("Not a directory: {root_path}"),
        ));
    }
    root.canonicalize().map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceUnavailable,
            format!("Could not resolve workspace root: {err}"),
        )
    })
}

/// Reject empty, absolute, parent-traversal, and empty-component relative paths
/// before joining them under a registered root.
pub fn validate_relative_path(relative: &str) -> Result<PathBuf, WorkspaceError> {
    let relative = relative.trim();
    if relative.is_empty() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "Relative path is required.",
        ));
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            "Absolute paths are not allowed; use a workspace-relative path.",
        ));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                if part.is_empty() {
                    return Err(WorkspaceError::new(
                        WorkspaceErrorCode::PathInvalid,
                        "Relative path contains an empty segment.",
                    ));
                }
                clean.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(WorkspaceError::new(
                    WorkspaceErrorCode::PathOutsideWorkspace,
                    "Parent directory traversal is not allowed.",
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::new(
                    WorkspaceErrorCode::PathOutsideWorkspace,
                    "Absolute paths are not allowed; use a workspace-relative path.",
                ));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "Relative path resolved empty.",
        ));
    }
    Ok(clean)
}

/// Resolve an existing file under a registered root. Follows symlinks only for
/// the final canonicalize and rejects escape.
pub fn resolve_existing_relative_file(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    let rel = validate_relative_path(relative)?;
    let candidate = root.join(&rel);
    let file = candidate.canonicalize().map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::FileNotFound,
            format!("Could not resolve file: {err}"),
        )
    })?;
    if !file.starts_with(root) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            "File is outside the workspace root.",
        ));
    }
    if !file.is_file() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            format!("Not a file: {}", display_path(&file)),
        ));
    }
    Ok(file)
}

/// Resolve a write target: parent must exist inside the root; file may be new.
pub fn resolve_relative_file_for_write(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    let rel = validate_relative_path(relative)?;
    let candidate = root.join(&rel);
    let parent = candidate.parent().ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "File path has no parent directory.",
        )
    })?;
    let parent = parent.canonicalize().map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            format!("Could not resolve file parent: {err}"),
        )
    })?;
    if !parent.starts_with(root) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            "File is outside the workspace root.",
        ));
    }
    let name = candidate.file_name().ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            "File path has no file name.",
        )
    })?;
    let file = parent.join(name);
    if file.exists() {
        let resolved = file.canonicalize().map_err(|err| {
            WorkspaceError::new(
                WorkspaceErrorCode::PathInvalid,
                format!("Could not resolve file: {err}"),
            )
        })?;
        if !resolved.starts_with(root) {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::PathOutsideWorkspace,
                "File is outside the workspace root.",
            ));
        }
        if !resolved.is_file() {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::PathInvalid,
                format!("Not a file: {}", display_path(&resolved)),
            ));
        }
        return Ok(resolved);
    }
    Ok(file)
}

/// Resolve an existing directory under the registered root for listing.
pub fn resolve_relative_directory(
    root: &Path,
    relative: Option<&str>,
) -> Result<PathBuf, WorkspaceError> {
    let relative = relative.map(str::trim).filter(|value| !value.is_empty());
    let candidate = match relative {
        None => root.to_path_buf(),
        Some(rel) => {
            let clean = validate_relative_path(rel)?;
            root.join(clean)
        }
    };
    let dir = candidate.canonicalize().map_err(|err| {
        WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            format!("Could not resolve directory: {err}"),
        )
    })?;
    if !dir.starts_with(root) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            "Directory is outside the workspace root.",
        ));
    }
    if !dir.is_dir() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathInvalid,
            format!("Not a directory: {}", display_path(&dir)),
        ));
    }
    Ok(dir)
}

/// Normalize a relative path string for identity (forward slashes, no `.`).
pub fn normalize_relative_key(relative: &str) -> Result<String, WorkspaceError> {
    let clean = validate_relative_path(relative)?;
    let mut parts = Vec::new();
    for component in clean.components() {
        if let Component::Normal(part) = component {
            parts.push(part.to_string_lossy().into_owned());
        }
    }
    Ok(parts.join("/"))
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
            "threadterm_ws_paths_{name}_{}_{}",
            std::process::id(),
            stamp
        ))
    }

    #[test]
    fn rejects_absolute_and_parent_relative_paths() {
        assert_eq!(
            validate_relative_path("../secret").unwrap_err().code,
            WorkspaceErrorCode::PathOutsideWorkspace
        );
        assert_eq!(
            validate_relative_path("/abs/path").unwrap_err().code,
            WorkspaceErrorCode::PathOutsideWorkspace
        );
        #[cfg(windows)]
        assert_eq!(
            validate_relative_path(r"C:\abs").unwrap_err().code,
            WorkspaceErrorCode::PathOutsideWorkspace
        );
    }

    #[test]
    fn normalizes_relative_keys() {
        assert_eq!(
            normalize_relative_key(r"src\lib\a.ts").unwrap(),
            "src/lib/a.ts"
        );
        assert_eq!(
            normalize_relative_key("./src/./lib/a.ts").unwrap(),
            "src/lib/a.ts"
        );
    }

    #[test]
    fn resolves_file_inside_root_and_rejects_escape() {
        let root = temp_dir("root");
        let other = temp_dir("other");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(root.join("src").join("a.txt"), "a").unwrap();
        std::fs::write(other.join("secret.txt"), "s").unwrap();
        let root = root.canonicalize().unwrap();

        let file = resolve_existing_relative_file(&root, "src/a.txt").unwrap();
        assert!(file.ends_with("a.txt"));

        // Symlink escape (when the platform supports it).
        #[cfg(unix)]
        {
            let link = root.join("escape");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&other, &link).unwrap();
            let err = resolve_existing_relative_file(&root, "escape/secret.txt").unwrap_err();
            assert_eq!(err.code, WorkspaceErrorCode::PathOutsideWorkspace);
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn display_path_strips_verbatim_prefix() {
        #[cfg(windows)]
        {
            assert_eq!(
                display_path(Path::new(r"\\?\C:\Users\demo")),
                r"C:\Users\demo"
            );
            assert_eq!(
                display_path(Path::new(r"\\?\UNC\server\share")),
                r"\\server\share"
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(display_path(Path::new("/Users/demo")), "/Users/demo");
        }
    }

    #[test]
    fn project_identity_normalizes_windows_forms_exactly() {
        assert!(same_project_path(
            r"\\?\D:\Repo\ThreadTerm\",
            "d:/repo/threadterm"
        ));
        assert!(same_project_path(
            r"\\?\UNC\Server\Share\ThreadTerm",
            r"\\server\share\threadterm"
        ));
        assert!(!same_project_path(
            r"C:\Repo\ThreadTerm",
            r"D:\Repo\ThreadTerm"
        ));
        assert!(!same_project_path(
            r"C:\One\ThreadTerm",
            r"C:\Two\ThreadTerm"
        ));
        assert!(!same_project_path(
            r"C:\Repo\ThreadTerm",
            r"C:\Repo\ThreadTerm\child"
        ));
    }

    #[test]
    fn project_identity_keeps_macos_paths_case_sensitive() {
        assert!(same_project_path("/Users/demo/App", "/Users/demo/App/"));
        assert!(!same_project_path("/Users/demo/App", "/Users/demo/app"));
        assert!(!same_project_path("/Users/one/App", "/Users/two/App"));
        assert!(!same_project_path("/Users/demo", "/Users/demo/App"));
    }
}
