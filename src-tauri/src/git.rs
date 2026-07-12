use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MAX_TEXT_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_detached: bool,
    pub is_bare: bool,
    pub is_locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BranchRecord {
    branch: String,
    head: String,
    is_current: bool,
    last_commit_unix: i64,
    upstream: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRow {
    pub branch: String,
    pub head: String,
    pub is_current: bool,
    pub worktree_path: Option<String>,
    pub is_main_worktree: bool,
    pub last_commit_unix: i64,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// Repository-relative path using Git's slash separator.
    pub path: String,
    /// Absolute platform path suitable for opening in the workspace editor.
    pub absolute_path: String,
    /// Canonical repository root; use as the workspace root when opening this file.
    pub repository_root: String,
    /// Porcelain X status, if staged.
    pub staged: Option<String>,
    /// Porcelain Y status, if unstaged.
    pub unstaged: Option<String>,
    pub is_untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub staged_diff: String,
    pub unstaged_diff: String,
    pub is_binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTextDiffSection {
    pub kind: String,
    pub base_label: String,
    pub current_label: String,
    pub base_contents: String,
    pub current_contents: String,
    pub editable: bool,
    pub current_modified_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTextDiff {
    pub path: String,
    pub repository_root: String,
    pub is_binary: bool,
    pub sections: Vec<GitTextDiffSection>,
}

#[derive(Default)]
struct WorktreeBuilder {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    is_detached: bool,
    is_bare: bool,
    is_locked: bool,
}

fn validate_git_project_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Project path is required.".to_string());
    }

    let dir = Path::new(trimmed);
    if !dir.is_absolute() {
        return Err("Project path must be absolute.".to_string());
    }
    if !dir.exists() {
        return Err("Project path does not exist.".to_string());
    }
    if !dir.is_dir() {
        return Err("Project path is not a directory.".to_string());
    }

    dir.canonicalize()
        .map_err(|err| format!("Could not resolve project path: {err}"))
}

fn branch_name(raw: &str) -> String {
    raw.strip_prefix("refs/heads/").unwrap_or(raw).to_string()
}

fn push_record(records: &mut Vec<WorktreeInfo>, builder: &mut WorktreeBuilder) {
    let Some(path) = builder.path.take() else {
        *builder = WorktreeBuilder::default();
        return;
    };

    let is_main = records.is_empty();
    records.push(WorktreeInfo {
        path,
        head: builder.head.take().unwrap_or_default(),
        branch: builder.branch.take(),
        is_main,
        is_detached: builder.is_detached,
        is_bare: builder.is_bare,
        is_locked: builder.is_locked,
    });

    *builder = WorktreeBuilder::default();
}

fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeInfo> {
    let mut records = Vec::new();
    let mut builder = WorktreeBuilder::default();

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            push_record(&mut records, &mut builder);
            continue;
        }

        if let Some(path) = line.strip_prefix("worktree ") {
            if builder.path.is_some() {
                push_record(&mut records, &mut builder);
            }
            builder.path = Some(path.to_string());
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            builder.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            builder.branch = Some(branch_name(branch));
        } else if line == "detached" {
            builder.is_detached = true;
        } else if line == "bare" {
            builder.is_bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            builder.is_locked = true;
        }
    }

    push_record(&mut records, &mut builder);
    records
}

fn parse_branch_ref_output(output: &str) -> Vec<BranchRecord> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let branch = fields.next()?.to_string();
            if branch.is_empty() {
                return None;
            }
            let head = fields.next().unwrap_or_default().to_string();
            let is_current = fields.next().unwrap_or_default() == "*";
            let last_commit_unix = fields
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            let upstream = fields
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Some(BranchRecord {
                branch,
                head,
                is_current,
                last_commit_unix,
                upstream,
            })
        })
        .collect()
}

fn merge_branch_worktree(
    branches: Vec<BranchRecord>,
    worktrees: Vec<WorktreeInfo>,
) -> Vec<BranchRow> {
    let mut rows: Vec<(usize, BranchRow)> = branches
        .into_iter()
        .enumerate()
        .map(|(index, branch)| {
            let worktree = worktrees
                .iter()
                .find(|worktree| worktree.branch.as_deref() == Some(branch.branch.as_str()));
            (
                index,
                BranchRow {
                    branch: branch.branch,
                    head: branch.head,
                    is_current: branch.is_current,
                    worktree_path: worktree.map(|worktree| worktree.path.clone()),
                    is_main_worktree: worktree.map(|worktree| worktree.is_main).unwrap_or(false),
                    last_commit_unix: branch.last_commit_unix,
                    upstream: branch.upstream,
                },
            )
        })
        .collect();

    rows.sort_by(|(left_index, left), (right_index, right)| {
        right
            .is_current
            .cmp(&left.is_current)
            .then_with(|| {
                right
                    .worktree_path
                    .is_some()
                    .cmp(&left.worktree_path.is_some())
            })
            .then_with(|| left_index.cmp(right_index))
    });
    rows.into_iter().map(|(_, row)| row).collect()
}

fn list_worktrees_for_directory(project_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let dir = validate_git_project_directory(project_path)?;
    let output = match Command::new("git")
        .arg("-C")
        .arg(&dir)
        .arg("worktree")
        .arg("list")
        .arg("--porcelain")
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_porcelain(&stdout))
}

fn list_branches_for_directory(project_path: &str) -> Result<Vec<BranchRecord>, String> {
    let dir = validate_git_project_directory(project_path)?;
    let output = match Command::new("git")
        .arg("-C")
        .arg(&dir)
        .arg("for-each-ref")
        .arg("--sort=-committerdate")
        .arg("--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(committerdate:unix)%00%(upstream:short)")
        .arg("refs/heads")
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_branch_ref_output(&stdout))
}

fn branch_overview_for_directory(project_path: &str) -> Result<Vec<BranchRow>, String> {
    let branches = list_branches_for_directory(project_path)?;
    if branches.is_empty() {
        return Ok(Vec::new());
    }
    let worktrees = list_worktrees_for_directory(project_path).unwrap_or_default();
    Ok(merge_branch_worktree(branches, worktrees))
}

fn path_to_display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn git_path_to_absolute(repo_root: &Path, git_path: &str) -> String {
    path_to_display(&repo_root.join(git_path))
}

fn porcelain_status_char(value: char) -> Option<String> {
    match value {
        ' ' | '?' | '!' => None,
        other => Some(other.to_string()),
    }
}

fn parse_status_porcelain_z(output: &[u8], repo_root: &Path) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());

    while let Some(field) = fields.next() {
        let record = String::from_utf8_lossy(field);
        if record.len() < 4 {
            continue;
        }
        let mut chars = record.chars();
        let Some(x) = chars.next() else {
            continue;
        };
        let Some(y) = chars.next() else {
            continue;
        };
        let Some(separator) = chars.next() else {
            continue;
        };
        if separator != ' ' {
            continue;
        }
        let path = chars.as_str().to_string();
        if path.is_empty() {
            continue;
        }

        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            let _ = fields.next();
        }

        entries.push(GitStatusEntry {
            absolute_path: git_path_to_absolute(repo_root, &path),
            repository_root: path_to_display(repo_root),
            path,
            staged: porcelain_status_char(x),
            unstaged: porcelain_status_char(y),
            is_untracked: x == '?' && y == '?',
        });
    }

    entries
}

fn status_for_directory(project_path: &str) -> Result<Vec<GitStatusEntry>, String> {
    let project_dir = validate_git_project_directory(project_path)?;
    let repo_root = match git_repo_root(&project_dir) {
        Ok(root) => root,
        Err(_) => return Ok(Vec::new()),
    };
    let output = match Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .arg("--untracked-files=all")
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(parse_status_porcelain_z(&output.stdout, &repo_root))
}

fn git_repo_root(project_path: &Path) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_path)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Project path is not a git repository.".to_string()
        } else {
            stderr
        });
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("Could not resolve git repository root.".to_string());
    }
    Ok(PathBuf::from(root))
}

fn validate_repo_relative_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Git path is required.".to_string());
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') || looks_like_windows_drive_path(&normalized) {
        return Err("Git path must stay inside the repository.".to_string());
    }
    let repo_path = Path::new(&normalized);
    if repo_path.is_absolute() || has_root_prefix_or_parent(repo_path) {
        return Err("Git path must stay inside the repository.".to_string());
    }
    Ok(normalized)
}

fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn run_git_diff(repo_root: &Path, path: &str, cached: bool) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo_root)
        .arg("diff")
        .arg("--no-color")
        .arg("--no-ext-diff");
    if cached {
        command.arg("--cached");
    }
    let output = command
        .arg("--")
        .arg(path)
        .output()
        .map_err(|err| format!("Failed to run git diff: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to read git diff.".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn diff_is_binary(diff: &str) -> bool {
    diff.contains("Binary files ") || diff.contains("GIT binary patch")
}

fn file_diff_for_directory(project_path: &str, path: &str) -> Result<GitFileDiff, String> {
    let project_dir = validate_git_project_directory(project_path)?;
    let repo_root = git_repo_root(&project_dir)?;
    let path = validate_repo_relative_path(path)?;
    let staged_diff = run_git_diff(&repo_root, &path, true)?;
    let unstaged_diff = run_git_diff(&repo_root, &path, false)?;
    let is_binary = diff_is_binary(&staged_diff) || diff_is_binary(&unstaged_diff);

    Ok(GitFileDiff {
        path,
        staged_diff,
        unstaged_diff,
        is_binary,
    })
}

fn modified_unix_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn bytes_to_text(bytes: Vec<u8>, label: &str) -> Result<String, String> {
    if bytes.len() > MAX_TEXT_DIFF_BYTES {
        return Err(format!(
            "file_too_large: {label} is larger than {} bytes.",
            MAX_TEXT_DIFF_BYTES
        ));
    }
    if bytes.contains(&0) {
        return Err(format!("file_binary: {label} is binary."));
    }
    String::from_utf8(bytes).map_err(|_| format!("file_not_utf8: {label} is not valid UTF-8 text."))
}

fn read_git_blob(repo_root: &Path, revision: &str, path: &str) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("show")
        .arg(format!("{revision}:{path}"))
        .output()
        .map_err(|err| format!("Failed to run git show: {err}"))?;

    if !output.status.success() {
        return Ok(None);
    }

    bytes_to_text(output.stdout, &format!("{revision}:{path}")).map(Some)
}

fn read_worktree_file(repo_root: &Path, path: &str) -> Result<Option<String>, String> {
    let file = repo_root.join(path);
    if !file.exists() {
        return Ok(None);
    }
    if !file.is_file() {
        return Err(format!("file_not_regular: Not a file: {}", file.display()));
    }
    let bytes = std::fs::read(&file)
        .map_err(|err| format!("file_read_failed: Failed to read file: {err}"))?;
    bytes_to_text(bytes, path).map(Some)
}

fn file_text_diff_for_directory(project_path: &str, path: &str) -> Result<GitTextDiff, String> {
    let project_dir = validate_git_project_directory(project_path)?;
    let repo_root = git_repo_root(&project_dir)?;
    let path = validate_repo_relative_path(path)?;
    let staged_diff = run_git_diff(&repo_root, &path, true)?;
    let unstaged_diff = run_git_diff(&repo_root, &path, false)?;
    let is_binary = diff_is_binary(&staged_diff) || diff_is_binary(&unstaged_diff);
    if is_binary {
        return Ok(GitTextDiff {
            path,
            repository_root: path_to_display(&repo_root),
            is_binary: true,
            sections: Vec::new(),
        });
    }

    let mut sections = Vec::new();
    if !staged_diff.trim().is_empty() {
        sections.push(GitTextDiffSection {
            kind: "staged".to_string(),
            base_label: "HEAD".to_string(),
            current_label: "Index".to_string(),
            base_contents: read_git_blob(&repo_root, "HEAD", &path)?.unwrap_or_default(),
            current_contents: read_git_blob(&repo_root, "", &path)?.unwrap_or_default(),
            editable: false,
            current_modified_unix_ms: None,
        });
    }

    if !unstaged_diff.trim().is_empty() {
        let worktree_path = repo_root.join(&path);
        sections.push(GitTextDiffSection {
            kind: "unstaged".to_string(),
            base_label: "Index".to_string(),
            current_label: "Working tree".to_string(),
            base_contents: read_git_blob(&repo_root, "", &path)?.unwrap_or_default(),
            current_contents: read_worktree_file(&repo_root, &path)?.unwrap_or_default(),
            editable: true,
            current_modified_unix_ms: modified_unix_ms(&worktree_path),
        });
    }

    Ok(GitTextDiff {
        path,
        repository_root: path_to_display(&repo_root),
        is_binary: false,
        sections,
    })
}

fn sanitize_worktree_branch(branch: &str) -> String {
    let sanitized = branch.replace(['/', '\\'], "-");
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "branch".to_string()
    } else {
        sanitized
    }
}

fn worktree_base_dir(repo_root: &Path) -> Result<PathBuf, String> {
    let parent = repo_root
        .parent()
        .ok_or_else(|| "Git repository root has no parent directory.".to_string())?;
    let repo_name = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Git repository root has no directory name.".to_string())?;
    Ok(parent.join(format!("{repo_name}-worktrees")))
}

fn has_parent_dir(path: &Path) -> bool {
    path.components()
        .any(|component| component == Component::ParentDir)
}

fn has_root_prefix_or_parent(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn default_worktree_path(repo_root: &Path, branch: &str) -> Result<PathBuf, String> {
    let base = worktree_base_dir(repo_root)?;
    checked_worktree_target(&base, &PathBuf::from(sanitize_worktree_branch(branch)))
}

fn checked_worktree_target(base: &Path, requested: &Path) -> Result<PathBuf, String> {
    let target = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        base.join(requested)
    };
    if has_parent_dir(&target) || !target.starts_with(base) {
        return Err(
            "Worktree path must stay inside the repository worktrees directory.".to_string(),
        );
    }
    Ok(target)
}

fn add_worktree_for_branch(
    project_path: &str,
    branch: &str,
    worktree_path: Option<String>,
) -> Result<WorktreeInfo, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is required.".to_string());
    }

    let project_dir = validate_git_project_directory(project_path)?;
    let repo_root = git_repo_root(&project_dir)?;
    let base = worktree_base_dir(&repo_root)?;
    let target = match worktree_path {
        Some(path) if !path.trim().is_empty() => {
            checked_worktree_target(&base, Path::new(path.trim()))?
        }
        _ => default_worktree_path(&repo_root, branch)?,
    };

    if target.exists() {
        return Err(format!(
            "Worktree target already exists: {}",
            target.display()
        ));
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        .arg("worktree")
        .arg("add")
        .arg(&target)
        .arg(branch)
        .output()
        .map_err(|err| format!("Failed to run git worktree add: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Failed to create worktree for branch {branch}.")
        } else {
            stderr
        });
    }

    let target_string = target.to_string_lossy().to_string();
    let worktrees = list_worktrees_for_directory(&repo_root.to_string_lossy())?;
    worktrees
        .into_iter()
        .find(|worktree| worktree.path == target_string)
        .ok_or_else(|| format!("Created worktree was not found: {}", target.display()))
}

#[tauri::command]
pub async fn git_worktree_list(project_path: String) -> Result<Vec<WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || list_worktrees_for_directory(&project_path))
        .await
        .map_err(|err| format!("Failed to list git worktrees: {err}"))?
}

#[tauri::command]
pub async fn git_branch_overview(project_path: String) -> Result<Vec<BranchRow>, String> {
    tokio::task::spawn_blocking(move || branch_overview_for_directory(&project_path))
        .await
        .map_err(|err| format!("Failed to list git branches: {err}"))?
}

#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> Result<WorktreeInfo, String> {
    tokio::task::spawn_blocking(move || {
        add_worktree_for_branch(&project_path, &branch, worktree_path)
    })
    .await
    .map_err(|err| format!("Failed to create git worktree: {err}"))?
}

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitStatusEntry>, String> {
    tokio::task::spawn_blocking(move || status_for_directory(&project_path))
        .await
        .map_err(|err| format!("Failed to read git status: {err}"))?
}

#[tauri::command]
pub async fn git_file_diff(project_path: String, path: String) -> Result<GitFileDiff, String> {
    tokio::task::spawn_blocking(move || file_diff_for_directory(&project_path, &path))
        .await
        .map_err(|err| format!("Failed to read git file diff: {err}"))?
}

#[tauri::command]
pub async fn git_file_text_diff(project_path: String, path: String) -> Result<GitTextDiff, String> {
    tokio::task::spawn_blocking(move || file_text_diff_for_directory(&project_path, &path))
        .await
        .map_err(|err| format!("Failed to read git text diff: {err}"))?
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        checked_worktree_target, default_worktree_path, file_text_diff_for_directory,
        merge_branch_worktree, parse_branch_ref_output, parse_status_porcelain_z,
        parse_worktree_porcelain, sanitize_worktree_branch, validate_git_project_directory,
        validate_repo_relative_path, BranchRecord, WorktreeInfo,
    };

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "threadterm_git_{name}_{}_{}",
            std::process::id(),
            stamp
        ))
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parse_worktree_porcelain_reads_main_and_linked_worktrees() {
        let output = "\
worktree /repo/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/app-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/worktree-ui
";

        let worktrees = parse_worktree_porcelain(output);
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].path, "/repo/app");
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[1].is_main);
        assert_eq!(worktrees[1].path, "/repo/app-feature");
        assert_eq!(worktrees[1].branch.as_deref(), Some("feature/worktree-ui"));
    }

    #[test]
    fn parse_worktree_porcelain_marks_detached_bare_and_locked() {
        let output = "\
worktree /repo/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/app-detached
HEAD 3333333333333333333333333333333333333333
detached
locked migrating

worktree /repo/app-bare
HEAD 4444444444444444444444444444444444444444
bare
";

        let worktrees = parse_worktree_porcelain(output);
        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[1].is_detached);
        assert!(worktrees[1].is_locked);
        assert_eq!(worktrees[1].branch, None);
        assert!(worktrees[2].is_bare);
    }

    #[test]
    fn validate_git_project_directory_rejects_relative_path() {
        assert_eq!(
            validate_git_project_directory("relative/path").unwrap_err(),
            "Project path must be absolute."
        );
    }

    #[test]
    fn parse_branch_ref_output_reads_nul_separated_fields() {
        let output = concat!(
            "main\0aaaaaaaa\0*\0",
            "1690000000\0origin/main\n",
            "feature/login\0bbbbbbbb\0 \0",
            "1680000000\0\n",
        );
        let branches = parse_branch_ref_output(output);
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].branch, "main");
        assert!(branches[0].is_current);
        assert_eq!(branches[0].last_commit_unix, 1_690_000_000);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(branches[1].branch, "feature/login");
        assert!(!branches[1].is_current);
        assert_eq!(branches[1].upstream, None);
    }

    #[test]
    fn merge_branch_worktree_prioritizes_current_then_existing_worktrees() {
        let branches = vec![
            BranchRecord {
                branch: "feature/no-tree".to_string(),
                head: "333".to_string(),
                is_current: false,
                last_commit_unix: 30,
                upstream: None,
            },
            BranchRecord {
                branch: "main".to_string(),
                head: "111".to_string(),
                is_current: true,
                last_commit_unix: 10,
                upstream: Some("origin/main".to_string()),
            },
            BranchRecord {
                branch: "feature/tree".to_string(),
                head: "222".to_string(),
                is_current: false,
                last_commit_unix: 20,
                upstream: None,
            },
        ];
        let worktrees = vec![
            WorktreeInfo {
                path: "/repo/app".to_string(),
                head: "111".to_string(),
                branch: Some("main".to_string()),
                is_main: true,
                is_detached: false,
                is_bare: false,
                is_locked: false,
            },
            WorktreeInfo {
                path: "/repo/app-worktrees/feature-tree".to_string(),
                head: "222".to_string(),
                branch: Some("feature/tree".to_string()),
                is_main: false,
                is_detached: false,
                is_bare: false,
                is_locked: false,
            },
        ];

        let rows = merge_branch_worktree(branches, worktrees);
        assert_eq!(rows[0].branch, "main");
        assert!(rows[0].is_main_worktree);
        assert_eq!(rows[0].worktree_path.as_deref(), Some("/repo/app"));
        assert_eq!(rows[1].branch, "feature/tree");
        assert_eq!(
            rows[1].worktree_path.as_deref(),
            Some("/repo/app-worktrees/feature-tree")
        );
        assert_eq!(rows[2].branch, "feature/no-tree");
        assert_eq!(rows[2].worktree_path, None);
    }

    #[test]
    fn sanitize_branch_name_replaces_path_separators() {
        assert_eq!(sanitize_worktree_branch("feature/login"), "feature-login");
        assert_eq!(sanitize_worktree_branch("bug\\windows"), "bug-windows");
        assert_eq!(sanitize_worktree_branch(".."), "branch");
    }

    #[test]
    fn default_worktree_path_uses_sibling_worktrees_directory() {
        let path = default_worktree_path(Path::new("/repos/threadterm"), "feature/login").unwrap();
        assert_eq!(
            path,
            PathBuf::from("/repos/threadterm-worktrees/feature-login")
        );
    }

    #[test]
    fn checked_worktree_target_rejects_escape_paths() {
        let base = Path::new("/repos/threadterm-worktrees");
        assert!(checked_worktree_target(base, Path::new("../other")).is_err());
        assert!(checked_worktree_target(base, Path::new("/tmp/other")).is_err());
        assert_eq!(
            checked_worktree_target(base, Path::new("feature")).unwrap(),
            PathBuf::from("/repos/threadterm-worktrees/feature")
        );
    }

    #[test]
    fn parse_status_porcelain_z_reads_staged_unstaged_and_untracked() {
        let output =
            b"M  src/lib.rs\0 M src/main.rs\0?? docs/new file.md\0A  \xe4\xb8\xad\xe6\x96\x87.txt\0";
        let rows = parse_status_porcelain_z(output, Path::new("/repo/app"));

        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].path, "src/lib.rs");
        assert_eq!(rows[0].staged.as_deref(), Some("M"));
        assert_eq!(rows[0].unstaged, None);
        assert_eq!(rows[1].unstaged.as_deref(), Some("M"));
        assert!(rows[2].is_untracked);
        assert_eq!(rows[2].path, "docs/new file.md");
        assert_eq!(
            PathBuf::from(&rows[2].absolute_path),
            Path::new("/repo/app").join("docs/new file.md")
        );
        assert_eq!(rows[3].path, "中文.txt");
    }

    #[test]
    fn parse_status_porcelain_z_consumes_rename_source() {
        let output = b"R  new name.txt\0old name.txt\0 M keep.txt\0";
        let rows = parse_status_porcelain_z(output, Path::new("/repo/app"));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "new name.txt");
        assert_eq!(rows[0].staged.as_deref(), Some("R"));
        assert_eq!(rows[1].path, "keep.txt");
    }

    #[test]
    fn validate_repo_relative_path_rejects_absolute_and_parent_paths() {
        assert!(validate_repo_relative_path("../secret").is_err());
        assert!(validate_repo_relative_path("src\\..\\secret").is_err());
        assert!(validate_repo_relative_path("/tmp/secret").is_err());
        assert!(validate_repo_relative_path("\\tmp\\secret").is_err());
        assert!(validate_repo_relative_path("C:\\tmp\\secret").is_err());
        assert!(validate_repo_relative_path("C:/tmp/secret").is_err());
        assert_eq!(
            validate_repo_relative_path("src\\main.rs").unwrap(),
            "src/main.rs"
        );
    }

    #[test]
    fn file_text_diff_returns_editable_unstaged_contents() {
        let repo = temp_dir("text_diff");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "threadterm@example.test"]);
        run_git(&repo, &["config", "user.name", "ThreadTerm Test"]);
        std::fs::write(repo.join("app.txt"), "old\nsame\n").unwrap();
        run_git(&repo, &["add", "app.txt"]);
        run_git(&repo, &["commit", "-m", "initial"]);
        std::fs::write(repo.join("app.txt"), "new\nsame\n").unwrap();

        let diff = file_text_diff_for_directory(repo.to_str().unwrap(), "app.txt").unwrap();

        assert!(!diff.is_binary);
        assert_eq!(diff.sections.len(), 1);
        let section = &diff.sections[0];
        assert_eq!(section.kind, "unstaged");
        assert!(section.editable);
        assert_eq!(section.base_contents, "old\nsame\n");
        assert_eq!(section.current_contents, "new\nsame\n");

        let _ = std::fs::remove_dir_all(&repo);
    }
}
