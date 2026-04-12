use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// ── Data types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    InProgress,
    Done,
    Failed,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
        }
    }

    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim() {
            "open" => Ok(TaskStatus::Open),
            "in_progress" => Ok(TaskStatus::InProgress),
            "done" => Ok(TaskStatus::Done),
            "failed" => Ok(TaskStatus::Failed),
            other => Err(format!("Unknown task status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub created_at: String,
    pub updated_at: String,
    pub deps: Vec<String>,
    pub session_id: Option<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn tasks_dir(project_path: &str) -> PathBuf {
    Path::new(project_path)
        .join(".openwork")
        .join("tasks")
}

fn ensure_tasks_dir(project_path: &str) -> Result<PathBuf, String> {
    let dir = tasks_dir(project_path);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create tasks directory: {e}"))?;
    Ok(dir)
}

/// Serialize a `Task` to Markdown with YAML frontmatter.
fn task_to_markdown(task: &Task) -> String {
    let deps_str = if task.deps.is_empty() {
        "[]".to_string()
    } else {
        let items: Vec<String> = task.deps.iter().map(|d| format!("\"{d}\"")).collect();
        format!("[{}]", items.join(", "))
    };

    let session_id_str = match &task.session_id {
        Some(sid) => format!("\"{sid}\""),
        None => "null".to_string(),
    };

    let body = task.description.as_deref().unwrap_or("");

    format!(
        "---\n\
         id: \"{}\"\n\
         title: \"{}\"\n\
         status: {}\n\
         created_at: \"{}\"\n\
         updated_at: \"{}\"\n\
         deps: {}\n\
         session_id: {}\n\
         ---\n\
         \n\
         {}",
        task.id,
        task.title.replace('"', "\\\""),
        task.status.as_str(),
        task.created_at,
        task.updated_at,
        deps_str,
        session_id_str,
        body,
    )
}

/// Parse a `Task` from Markdown with YAML frontmatter.
fn parse_task(content: &str) -> Result<Task, String> {
    // Split on `---` delimiters
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Err("Invalid task file: missing frontmatter delimiters".to_string());
    }

    let frontmatter = parts[1].trim();
    let body = parts[2].trim();

    let mut id = String::new();
    let mut title = String::new();
    let mut status = TaskStatus::Open;
    let mut created_at = String::new();
    let mut updated_at = String::new();
    let mut deps: Vec<String> = Vec::new();
    let mut session_id: Option<String> = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            let unquoted = value
                .trim_start_matches('"')
                .trim_end_matches('"');

            match key {
                "id" => id = unquoted.to_string(),
                "title" => title = unquoted.replace("\\\"", "\""),
                "status" => status = TaskStatus::from_str(unquoted)?,
                "created_at" => created_at = unquoted.to_string(),
                "updated_at" => updated_at = unquoted.to_string(),
                "deps" => {
                    deps = parse_string_array(value);
                }
                "session_id" => {
                    if value == "null" || value.is_empty() {
                        session_id = None;
                    } else {
                        session_id = Some(unquoted.to_string());
                    }
                }
                _ => {} // ignore unknown keys
            }
        }
    }

    if id.is_empty() {
        return Err("Task file missing 'id' field".to_string());
    }
    if title.is_empty() {
        return Err("Task file missing 'title' field".to_string());
    }

    Ok(Task {
        id,
        title,
        description: if body.is_empty() { None } else { Some(body.to_string()) },
        status,
        created_at,
        updated_at,
        deps,
        session_id,
    })
}

/// Parse a simple JSON-like array of strings: `["a", "b"]` or `[]`.
fn parse_string_array(s: &str) -> Vec<String> {
    let s = s.trim();
    if s == "[]" || s.is_empty() {
        return Vec::new();
    }
    // Remove brackets
    let inner = s
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if inner.is_empty() {
        return Vec::new();
    }
    inner
        .split(',')
        .map(|item| {
            item.trim()
                .trim_start_matches('"')
                .trim_end_matches('"')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn task_list(project_path: String) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read tasks directory: {e}"))?;

    let mut tasks = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read task file {}: {e}", path.display()))?;
            match parse_task(&content) {
                Ok(task) => tasks.push(task),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Skipping invalid task file");
                }
            }
        }
    }

    // Sort by created_at ascending
    tasks.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(tasks)
}

#[tauri::command]
pub async fn task_create(
    project_path: String,
    title: String,
    description: Option<String>,
    deps: Vec<String>,
) -> Result<Task, String> {
    let dir = ensure_tasks_dir(&project_path)?;
    let now = Utc::now().to_rfc3339();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        title,
        description,
        status: TaskStatus::Open,
        created_at: now.clone(),
        updated_at: now,
        deps,
        session_id: None,
    };

    let file_path = dir.join(format!("{}.md", task.id));
    let content = task_to_markdown(&task);
    fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to write task file: {e}"))?;

    tracing::info!(id = %task.id, title = %task.title, "Task created");
    Ok(task)
}

#[tauri::command]
pub async fn task_update(
    project_path: String,
    id: String,
    title: Option<String>,
    description: Option<String>,
    status: Option<TaskStatus>,
    session_id: Option<String>,
) -> Result<Task, String> {
    let dir = tasks_dir(&project_path);
    let file_path = dir.join(format!("{id}.md"));

    if !file_path.is_file() {
        return Err(format!("Task {id} not found"));
    }

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read task file: {e}"))?;
    let mut task = parse_task(&content)?;

    if let Some(t) = title {
        task.title = t;
    }
    // Update description if explicitly provided
    if description.is_some() {
        task.description = description;
    }
    if let Some(s) = status {
        task.status = s;
    }
    if session_id.is_some() {
        task.session_id = session_id;
    }

    task.updated_at = Utc::now().to_rfc3339();

    let new_content = task_to_markdown(&task);
    fs::write(&file_path, &new_content)
        .map_err(|e| format!("Failed to write task file: {e}"))?;

    tracing::info!(id = %task.id, "Task updated");
    Ok(task)
}

#[tauri::command]
pub async fn task_delete(project_path: String, id: String) -> Result<(), String> {
    let dir = tasks_dir(&project_path);
    let file_path = dir.join(format!("{id}.md"));

    if !file_path.is_file() {
        return Err(format!("Task {id} not found"));
    }

    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete task file: {e}"))?;

    tracing::info!(id = %id, "Task deleted");
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_status_roundtrip() {
        let cases = vec![
            (TaskStatus::Open, "open"),
            (TaskStatus::InProgress, "in_progress"),
            (TaskStatus::Done, "done"),
            (TaskStatus::Failed, "failed"),
        ];
        for (status, expected_str) in cases {
            assert_eq!(status.as_str(), expected_str);
            let parsed = TaskStatus::from_str(expected_str).unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn test_task_markdown_roundtrip() {
        let task = Task {
            id: "abc-123".to_string(),
            title: "Fix login bug".to_string(),
            description: Some("Description body here.".to_string()),
            status: TaskStatus::InProgress,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-02T00:00:00Z".to_string(),
            deps: vec!["dep-1".to_string(), "dep-2".to_string()],
            session_id: Some("sess-456".to_string()),
        };

        let md = task_to_markdown(&task);
        let parsed = parse_task(&md).expect("Should parse successfully");

        assert_eq!(parsed.id, task.id);
        assert_eq!(parsed.title, task.title);
        assert_eq!(parsed.description, task.description);
        assert_eq!(parsed.status, task.status);
        assert_eq!(parsed.created_at, task.created_at);
        assert_eq!(parsed.updated_at, task.updated_at);
        assert_eq!(parsed.deps, task.deps);
        assert_eq!(parsed.session_id, task.session_id);
    }

    #[test]
    fn test_task_no_description_no_deps() {
        let task = Task {
            id: "xyz-789".to_string(),
            title: "Simple task".to_string(),
            description: None,
            status: TaskStatus::Open,
            created_at: "2024-06-01T12:00:00Z".to_string(),
            updated_at: "2024-06-01T12:00:00Z".to_string(),
            deps: Vec::new(),
            session_id: None,
        };

        let md = task_to_markdown(&task);
        let parsed = parse_task(&md).expect("Should parse successfully");

        assert_eq!(parsed.id, task.id);
        assert_eq!(parsed.title, task.title);
        assert_eq!(parsed.description, None);
        assert_eq!(parsed.deps.len(), 0);
        assert_eq!(parsed.session_id, None);
    }

    #[test]
    fn test_parse_string_array() {
        assert_eq!(parse_string_array("[]"), Vec::<String>::new());
        assert_eq!(parse_string_array("[\"a\", \"b\"]"), vec!["a", "b"]);
        assert_eq!(parse_string_array("[\"single\"]"), vec!["single"]);
    }

    #[test]
    fn test_invalid_status() {
        let result = TaskStatus::from_str("unknown_status");
        assert!(result.is_err());
    }
}
