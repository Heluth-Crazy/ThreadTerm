use std::path::{Component, Path, PathBuf};
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        checked_worktree_target, default_worktree_path, merge_branch_worktree,
        parse_branch_ref_output, parse_worktree_porcelain, sanitize_worktree_branch,
        validate_git_project_directory, BranchRecord, WorktreeInfo,
    };

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
}
