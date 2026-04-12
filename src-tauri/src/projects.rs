use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub full_path: String,
    pub description: Option<String>,
    pub sessions: Vec<Session>,
    pub created_at: Option<String>,
    pub last_accessed: Option<String>,
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub project_path: String,
    pub provider: String,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub last_message: Option<String>,
    pub message_count: u32,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Encode a project path the way Claude CLI does: expand `~`, then replace
/// `/` (and `.`) with `-`.  On Windows, also strip `:` and normalize `\\`.
/// Example: `/Users/foo/bar` → `-Users-foo-bar`
pub fn encode_project_path(path: &str) -> String {
    let expanded = if path.starts_with('~') {
        dirs::home_dir()
            .map(|h| format!("{}{}", h.display(), &path[1..]))
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };

    #[cfg(target_os = "windows")]
    let result = expanded
        .replace('\\', "-")
        .replace('/', "-")
        .replace(':', "")
        .replace('.', "-");
    #[cfg(not(target_os = "windows"))]
    let result = expanded.replace('/', "-").replace('.', "-");

    result
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct ProjectsFile {
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    excluded_paths: Vec<String>,
}

fn projects_file() -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(".openwork").join("projects.json"))
}

fn load_projects_file() -> Result<ProjectsFile, String> {
    let path = projects_file()?;
    if !path.exists() {
        return Ok(ProjectsFile::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read projects.json: {e}"))?;

    // Try parsing as ProjectsFile first (new format), fall back to Vec<Project> (old format)
    if let Ok(pf) = serde_json::from_str::<ProjectsFile>(&data) {
        return Ok(pf);
    }
    // Legacy format: bare array of projects
    let projects: Vec<Project> = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse projects.json: {e}"))?;
    Ok(ProjectsFile { projects, excluded_paths: Vec::new() })
}

fn load_projects() -> Result<Vec<Project>, String> {
    Ok(load_projects_file()?.projects)
}

fn save_projects_file(pf: &ProjectsFile) -> Result<(), String> {
    let path = projects_file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let data =
        serde_json::to_string_pretty(pf).map_err(|e| format!("Failed to serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Failed to write projects.json: {e}"))
}

fn save_projects(projects: &[Project]) -> Result<(), String> {
    let mut pf = load_projects_file().unwrap_or_default();
    pf.projects = projects.to_vec();
    save_projects_file(&pf)
}

/// Scan `~/.claude/projects/` for the subdirectory whose name matches the
/// encoded `project_path`, then read Claude JSONL sessions from it.
fn discover_claude_sessions(project_path: &str) -> Vec<Session> {
    let projects_root = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Vec::new(),
    };

    if !projects_root.is_dir() {
        return Vec::new();
    }

    let encoded = encode_project_path(project_path);

    // Scan all subdirectories looking for an exact match
    let sessions_dir = match std::fs::read_dir(&projects_root) {
        Ok(entries) => {
            let mut found = None;
            for entry in entries.flatten() {
                if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    if dir_name == encoded {
                        found = Some(entry.path());
                        break;
                    }
                }
            }
            match found {
                Some(p) => p,
                None => return Vec::new(),
            }
        }
        Err(_) => return Vec::new(),
    };

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".jsonl") {
                continue;
            }
            let id = fname.trim_end_matches(".jsonl").to_string();
            let path = entry.path();

            // Read the JSONL file once and extract both created_at and last_message
            let (created_at, last_message) = if let Ok(content) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = content.lines().collect();
                let ca = lines.first().and_then(|l| {
                    serde_json::from_str::<serde_json::Value>(l)
                        .ok()
                        .and_then(|v| v["timestamp"].as_str().map(String::from))
                });
                let lm = lines.last().and_then(|l| {
                    serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| {
                        v["message"]["content"]
                            .as_array()
                            .and_then(|a| a.first())
                            .and_then(|c| c["text"].as_str().map(|s| s.chars().take(100).collect()))
                    })
                });
                (ca, lm)
            } else {
                // Fall back to file metadata for created_at
                let meta = entry.metadata().ok();
                let ca = meta
                    .as_ref()
                    .and_then(|m| m.created().ok())
                    .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
                (ca, None)
            };

            sessions.push(Session {
                id,
                project_path: project_path.to_string(),
                provider: "claude".to_string(),
                name: None,
                created_at,
                last_message,
                message_count: 0,
            });
        }
    }
    sessions
}

fn display_name(path: &str) -> String {
    // Try package.json in the project dir
    let pkg = Path::new(path).join("package.json");
    if let Ok(data) = std::fs::read_to_string(&pkg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                return name.to_string();
            }
        }
    }
    // Fall back to last path component
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Scan `~/.claude/projects/` and auto-discover projects by reading the `cwd`
/// field from the first few lines of each `.jsonl` session file.
fn auto_discover_all_projects() -> Vec<Project> {
    let projects_root = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Vec::new(),
    };

    if !projects_root.is_dir() {
        return Vec::new();
    }

    let mut discovered: Vec<Project> = Vec::new();
    // Track paths we've already added to avoid duplicates within discovery
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    let dir_entries = match std::fs::read_dir(&projects_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in dir_entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }

        let subdir = entry.path();
        // Try to find a .jsonl file and extract `cwd`
        let cwd = extract_cwd_from_subdir(&subdir);
        let cwd = match cwd {
            Some(c) => c,
            None => continue,
        };

        if cwd.is_empty() || seen_paths.contains(&cwd) {
            continue;
        }

        // Only add if the directory actually exists on disk
        if !Path::new(&cwd).is_dir() {
            continue;
        }

        seen_paths.insert(cwd.clone());

        let name = display_name(&cwd);
        let sessions = discover_claude_sessions(&cwd);

        discovered.push(Project {
            name,
            path: cwd.clone(),
            full_path: cwd,
            description: None,
            sessions,
            created_at: None,
            last_accessed: None,
            config: None,
        });
    }

    discovered
}

/// Read the first `.jsonl` file in a directory and extract the `cwd` field
/// from one of the first 10 lines.
fn extract_cwd_from_subdir(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".jsonl") {
            continue;
        }
        if let Some(cwd) = extract_cwd_from_jsonl(&entry.path()) {
            return Some(cwd);
        }
    }
    None
}

/// Parse up to 10 lines of a JSONL file looking for a `cwd` field.
fn extract_cwd_from_jsonl(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    for (i, line) in reader.lines().enumerate() {
        if i >= 10 {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(cwd) = val.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn projects_list() -> Result<Vec<Project>, String> {
    let pf = load_projects_file()?;
    let mut projects = pf.projects;
    let excluded: std::collections::HashSet<String> = pf.excluded_paths.into_iter().collect();

    // Attach Claude sessions discovered on disk
    for proj in &mut projects {
        let claude_sessions = discover_claude_sessions(&proj.full_path);
        let existing_ids: std::collections::HashSet<String> =
            proj.sessions.iter().map(|s| s.id.clone()).collect();
        for s in claude_sessions {
            if !existing_ids.contains(&s.id) {
                proj.sessions.push(s);
            }
        }
    }

    // Auto-discover projects from ~/.claude/projects/
    let discovered = auto_discover_all_projects();
    let existing_paths: std::collections::HashSet<String> =
        projects.iter().map(|p| p.full_path.clone()).collect();
    for proj in discovered {
        if !existing_paths.contains(&proj.full_path) && !excluded.contains(&proj.full_path) {
            projects.push(proj);
        }
    }

    Ok(projects)
}

#[tauri::command]
pub async fn projects_get(path: String) -> Result<Project, String> {
    let projects = load_projects()?;
    let full = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path))
        .to_string_lossy()
        .to_string();

    let mut project = projects
        .into_iter()
        .find(|p| p.full_path == full || p.path == path)
        .ok_or_else(|| format!("Project not found: {path}"))?;

    let claude_sessions = discover_claude_sessions(&project.full_path);
    let existing_ids: std::collections::HashSet<String> =
        project.sessions.iter().map(|s| s.id.clone()).collect();
    for s in claude_sessions {
        if !existing_ids.contains(&s.id) {
            project.sessions.push(s);
        }
    }

    Ok(project)
}

#[tauri::command]
pub async fn projects_add(name: String, path: String) -> Result<Project, String> {
    let full = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path))
        .to_string_lossy()
        .to_string();

    let mut projects = load_projects()?;

    // Prevent duplicates
    if projects.iter().any(|p| p.full_path == full) {
        return Err(format!("Project already exists: {full}"));
    }

    let display = if name.is_empty() {
        display_name(&full)
    } else {
        name
    };

    let project = Project {
        name: display,
        path: path.clone(),
        full_path: full,
        description: None,
        sessions: Vec::new(),
        created_at: Some(chrono::Utc::now().to_rfc3339()),
        last_accessed: Some(chrono::Utc::now().to_rfc3339()),
        config: None,
    };

    projects.push(project.clone());
    save_projects(&projects)?;

    Ok(project)
}

#[tauri::command]
pub async fn projects_remove(path: String) -> Result<(), String> {
    let mut pf = load_projects_file()?;
    let before = pf.projects.len();
    let removed_path = pf.projects.iter()
        .find(|p| p.full_path == path || p.path == path)
        .map(|p| p.full_path.clone());

    pf.projects.retain(|p| p.full_path != path && p.path != path);

    // Add to excluded_paths so auto-discovery doesn't re-add it
    if let Some(full_path) = &removed_path {
        if !pf.excluded_paths.contains(full_path) {
            pf.excluded_paths.push(full_path.clone());
        }
    }
    // Also add the raw path if different
    if !pf.excluded_paths.contains(&path) {
        pf.excluded_paths.push(path.clone());
    }

    if pf.projects.len() == before && removed_path.is_none() {
        // Not found in saved projects; still add to excluded_paths to block re-discovery
        save_projects_file(&pf)?;
        return Ok(());
    }
    save_projects_file(&pf)
}

#[tauri::command]
pub async fn projects_update_session_name(
    project_path: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let mut projects = load_projects()?;
    let proj = projects
        .iter_mut()
        .find(|p| p.full_path == project_path || p.path == project_path)
        .ok_or_else(|| format!("Project not found: {project_path}"))?;

    let session = proj
        .sessions
        .iter_mut()
        .find(|s| s.id == session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    session.name = Some(name);
    save_projects(&projects)
}

#[tauri::command]
pub async fn restore_project(path: String) -> Result<(), String> {
    let mut pf = load_projects_file()?;
    pf.excluded_paths.retain(|p| p != &path);
    save_projects_file(&pf)
}

#[tauri::command]
pub async fn rename_project(path: String, new_name: String) -> Result<(), String> {
    let mut projects = load_projects()?;
    let proj = projects
        .iter_mut()
        .find(|p| p.full_path == path || p.path == path)
        .ok_or_else(|| format!("Project not found: {path}"))?;
    proj.name = new_name;
    save_projects(&projects)
}

#[tauri::command]
pub async fn delete_session(session_id: String, project_path: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let encoded = encode_project_path(&project_path);
    let session_file = home
        .join(".claude/projects")
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));

    if session_file.exists() {
        std::fs::remove_file(&session_file)
            .map_err(|e| format!("Failed to delete session: {e}"))?;
    }

    Ok(())
}
