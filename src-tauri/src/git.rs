use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

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

#[tauri::command]
pub async fn git_worktree_list(project_path: String) -> Result<Vec<WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || list_worktrees_for_directory(&project_path))
        .await
        .map_err(|err| format!("Failed to list git worktrees: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::{parse_worktree_porcelain, validate_git_project_directory};

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
}
