use git2::{
    BranchType, DiffOptions, Repository, StatusOptions,
};
use serde::Serialize;
use std::path::Path;
use tauri::{Emitter, Window};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
    pub untracked: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize)]
pub struct FileStatus {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[derive(Serialize)]
pub struct GitBranches {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    pub is_locked: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_repo(project_path: &str) -> Result<Repository, String> {
    Repository::discover(project_path)
        .map_err(|e| format!("Not a git repository: {e}"))
}

fn status_char(s: git2::Status) -> &'static str {
    if s.contains(git2::Status::INDEX_NEW) || s.contains(git2::Status::WT_NEW) {
        "A"
    } else if s.contains(git2::Status::INDEX_MODIFIED) || s.contains(git2::Status::WT_MODIFIED) {
        "M"
    } else if s.contains(git2::Status::INDEX_DELETED) || s.contains(git2::Status::WT_DELETED) {
        "D"
    } else if s.contains(git2::Status::INDEX_RENAMED) || s.contains(git2::Status::WT_RENAMED) {
        "R"
    } else {
        "?"
    }
}

fn ahead_behind(repo: &Repository) -> (u32, u32) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };
    let local_oid = match head.target() {
        Some(o) => o,
        None => return (0, 0),
    };
    let branch_name = match head.shorthand() {
        Some(n) => n.to_string(),
        None => return (0, 0),
    };
    let upstream_name = format!("origin/{branch_name}");
    let upstream_ref = match repo.find_reference(&format!("refs/remotes/{upstream_name}")) {
        Ok(r) => r,
        Err(_) => return (0, 0),
    };
    let upstream_oid = match upstream_ref.target() {
        Some(o) => o,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(local_oid, upstream_oid)
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    let repo = open_repo(&project_path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git status failed: {e}"))?;

    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_else(|| "HEAD".to_string());

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        if s.contains(git2::Status::WT_NEW) {
            untracked.push(path.clone());
        }
        // Staged (index) changes
        if s.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        ) {
            staged.push(FileStatus {
                path: path.clone(),
                status: status_char(s).to_string(),
            });
        }
        // Unstaged (working tree) changes — but not pure untracked
        if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED,
        ) {
            unstaged.push(FileStatus {
                path,
                status: status_char(s).to_string(),
            });
        }
    }

    let (ahead, behind) = ahead_behind(&repo);

    Ok(GitStatus {
        branch,
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
    })
}

#[tauri::command]
pub async fn git_diff(
    project_path: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let repo = open_repo(&project_path)?;

    let mut opts = DiffOptions::new();
    if let Some(ref fp) = file_path {
        opts.pathspec(fp);
    }

    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| format!("git diff failed: {e}"))?;

    let mut buf = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            buf.push(origin as u8);
        }
        buf.extend_from_slice(line.content());
        true
    })
    .map_err(|e| format!("diff print failed: {e}"))?;

    String::from_utf8(buf).map_err(|e| format!("diff encoding error: {e}"))
}

#[tauri::command]
pub async fn git_log(
    project_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    let repo = open_repo(&project_path)?;
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("revwalk failed: {e}"))?;
    revwalk.push_head().map_err(|e| format!("push_head failed: {e}"))?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| format!("set_sorting failed: {e}"))?;

    let max = limit.unwrap_or(50) as usize;
    let mut commits = Vec::with_capacity(max);

    for (i, oid) in revwalk.enumerate() {
        if i >= max {
            break;
        }
        let oid = oid.map_err(|e| format!("revwalk error: {e}"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("find_commit error: {e}"))?;

        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let message = commit
            .message()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();
        let time = commit.time();
        let dt = chrono::DateTime::from_timestamp(time.seconds(), 0)
            .unwrap_or_default();
        let date = dt.to_rfc3339();

        commits.push(GitCommit {
            hash,
            short_hash,
            message,
            author: author_name,
            date,
        });
    }

    Ok(commits)
}

#[tauri::command]
pub async fn git_branches(project_path: String) -> Result<GitBranches, String> {
    let repo = open_repo(&project_path)?;

    let current = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_default();

    let mut local = Vec::new();
    let mut remote = Vec::new();

    let branches = repo
        .branches(None)
        .map_err(|e| format!("branches failed: {e}"))?;

    for branch in branches {
        let (branch, bt) = branch.map_err(|e| format!("branch iter error: {e}"))?;
        let name = branch
            .name()
            .ok()
            .flatten()
            .unwrap_or("")
            .to_string();
        match bt {
            BranchType::Local => local.push(name),
            BranchType::Remote => remote.push(name),
        }
    }

    Ok(GitBranches {
        current,
        local,
        remote,
    })
}

#[tauri::command]
pub async fn git_stage(
    project_path: String,
    files: Vec<String>,
) -> Result<(), String> {
    let repo = open_repo(&project_path)?;
    let mut index = repo
        .index()
        .map_err(|e| format!("index failed: {e}"))?;

    for file in &files {
        // Handle deleted files — remove from index
        let full = Path::new(&project_path).join(file);
        if !full.exists() {
            index
                .remove_path(Path::new(file))
                .map_err(|e| format!("index remove failed: {e}"))?;
        } else {
            index
                .add_path(Path::new(file))
                .map_err(|e| format!("index add failed: {e}"))?;
        }
    }

    index
        .write()
        .map_err(|e| format!("index write failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
) -> Result<String, String> {
    let repo = open_repo(&project_path)?;
    let mut index = repo
        .index()
        .map_err(|e| format!("index failed: {e}"))?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("write_tree failed: {e}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("find_tree failed: {e}"))?;

    let sig = repo
        .signature()
        .map_err(|e| format!("signature failed: {e}"))?;

    let parent_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());

    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("commit failed: {e}"))?;

    Ok(oid.to_string())
}

#[tauri::command]
pub async fn git_checkout_branch(
    project_path: String,
    branch: String,
) -> Result<(), String> {
    let repo = open_repo(&project_path)?;

    let (obj, reference) = repo
        .revparse_ext(&branch)
        .map_err(|e| format!("revparse failed: {e}"))?;

    repo.checkout_tree(&obj, None)
        .map_err(|e| format!("checkout_tree failed: {e}"))?;

    match reference {
        Some(r) => {
            let refname = r.name().unwrap_or("");
            repo.set_head(refname)
                .map_err(|e| format!("set_head failed: {e}"))?;
        }
        None => {
            repo.set_head_detached(obj.id())
                .map_err(|e| format!("set_head_detached failed: {e}"))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    project_path: String,
    branch: String,
) -> Result<(), String> {
    let repo = open_repo(&project_path)?;
    let head = repo
        .head()
        .map_err(|e| format!("head failed: {e}"))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("peel_to_commit failed: {e}"))?;

    repo.branch(&branch, &commit, false)
        .map_err(|e| format!("branch create failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn git_pull(
    project_path: String,
    window: Window,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};

    let mut child = Command::new("git")
        .args(["pull", "--ff-only", "--progress"])
        .current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git pull failed to start: {e}"))?;

    // Stream stderr (git progress goes to stderr)
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let win = window.clone();
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                let _ = win.emit("git-progress", &line);
            }
        });
    }

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let win = window.clone();
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                let _ = win.emit("git-progress", &line);
            }
        });
    }

    let status = tokio::task::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("Thread join error: {e}"))?
        .map_err(|e| format!("git pull wait failed: {e}"))?;
    if !status.success() {
        return Err("git pull failed".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_push(
    project_path: String,
    window: Window,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};

    let mut child = Command::new("git")
        .args(["push", "--progress"])
        .current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git push failed to start: {e}"))?;

    // Stream stderr (git progress goes to stderr)
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let win = window.clone();
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                let _ = win.emit("git-progress", &line);
            }
        });
    }

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let win = window.clone();
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                let _ = win.emit("git-progress", &line);
            }
        });
    }

    let status = tokio::task::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("Thread join error: {e}"))?
        .map_err(|e| format!("git push wait failed: {e}"))?;
    if !status.success() {
        return Err("git push failed".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Worktree commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_worktree_list(project_path: String) -> Result<Vec<WorktreeInfo>, String> {
    use std::process::Command;

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git worktree list failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_branch = String::new();
    let mut is_locked = false;
    let mut is_first = true;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            // Save previous entry if any
            if !current_path.is_empty() {
                worktrees.push(WorktreeInfo {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    is_main: is_first,
                    is_locked,
                });
                is_first = false;
            }
            current_path = line.strip_prefix("worktree ").unwrap_or("").to_string();
            current_branch = String::new();
            is_locked = false;
        } else if line.starts_with("branch ") {
            let full_ref = line.strip_prefix("branch ").unwrap_or("");
            current_branch = full_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(full_ref)
                .to_string();
        } else if line == "locked" {
            is_locked = true;
        } else if line.trim().is_empty() {
            // Block separator — do nothing
        }
    }

    // Push last entry
    if !current_path.is_empty() {
        worktrees.push(WorktreeInfo {
            path: current_path,
            branch: current_branch,
            is_main: is_first,
            is_locked,
        });
    }

    Ok(worktrees)
}

#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    worktree_name: String,
    base_branch: Option<String>,
) -> Result<String, String> {
    use std::process::Command;

    let project_dir = Path::new(&project_path);
    let project_name = project_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");

    let parent_dir = project_dir
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;

    let worktree_dir_name = format!("{}-worktree-{}", project_name, worktree_name);
    let worktree_path = parent_dir.join(&worktree_dir_name);
    let worktree_path_str = worktree_path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    let mut args = vec![
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        worktree_name.clone(),
        worktree_path_str.clone(),
    ];

    if let Some(ref base) = base_branch {
        args.push(base.clone());
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git worktree add failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    Ok(worktree_path_str)
}

#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    use std::process::Command;

    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&worktree_path);

    let output = Command::new("git")
        .args(&args)
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git worktree remove failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn git_discard_file(project_path: String, file_path: String) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(["checkout", "--", &file_path])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub async fn git_staged_diff(project_path: String, file_path: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff", "--cached"];
    let fp_string;
    if let Some(ref fp) = file_path {
        args.push("--");
        fp_string = fp.clone();
        args.push(&fp_string);
    }
    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn git_show_commit(project_path: String, hash: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["show", "--stat", "-p", &hash])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worktree_info_serialization() {
        let info = WorktreeInfo {
            path: "/path/to/wt".to_string(),
            branch: "feature-x".to_string(),
            is_main: false,
            is_locked: false,
        };
        let json = serde_json::to_string(&info).expect("serialize");
        assert!(json.contains("feature-x"));
        assert!(json.contains("isMain"));
    }

    #[test]
    fn test_worktree_info_fields() {
        let info = WorktreeInfo {
            path: String::new(),
            branch: String::new(),
            is_main: true,
            is_locked: false,
        };
        assert!(info.is_main);
        assert!(!info.is_locked);
    }

    #[test]
    fn test_status_char_mapping() {
        assert_eq!(status_char(git2::Status::INDEX_NEW), "A");
        assert_eq!(status_char(git2::Status::INDEX_MODIFIED), "M");
        assert_eq!(status_char(git2::Status::INDEX_DELETED), "D");
        assert_eq!(status_char(git2::Status::INDEX_RENAMED), "R");
        assert_eq!(status_char(git2::Status::WT_NEW), "A");
        assert_eq!(status_char(git2::Status::WT_MODIFIED), "M");
    }
}
