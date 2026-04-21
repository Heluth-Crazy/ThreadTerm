use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// Phase 2 durable task boundary: Markdown frontmatter remains the persistence
// format, but this schema is now the durable source of truth for the task queue
// main path. Keep compatibility with older Phase 0/1 task files while carrying
// lightweight Phase 3 execution metadata.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    Queued,
    Dispatched,
    InProgress,
    PendingApproval,
    PendingReview,
    Done,
    Failed,
    Cancelled,
    Archived,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::Queued => "queued",
            TaskStatus::Dispatched => "dispatched",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::PendingApproval => "pending_approval",
            TaskStatus::PendingReview => "pending_review",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
            TaskStatus::Archived => "archived",
        }
    }

    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim() {
            "open" => Ok(TaskStatus::Open),
            "queued" => Ok(TaskStatus::Queued),
            "dispatched" => Ok(TaskStatus::Dispatched),
            "in_progress" => Ok(TaskStatus::InProgress),
            "pending_approval" => Ok(TaskStatus::PendingApproval),
            "pending_review" => Ok(TaskStatus::PendingReview),
            "done" => Ok(TaskStatus::Done),
            "failed" => Ok(TaskStatus::Failed),
            "cancelled" => Ok(TaskStatus::Cancelled),
            "archived" => Ok(TaskStatus::Archived),
            other => Err(format!("Unknown task status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRole {
    Implement,
    Review,
    Verify,
    Research,
}

impl TaskRole {
    fn as_str(&self) -> &'static str {
        match self {
            TaskRole::Implement => "implement",
            TaskRole::Review => "review",
            TaskRole::Verify => "verify",
            TaskRole::Research => "research",
        }
    }

    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim() {
            "implement" => Ok(TaskRole::Implement),
            "review" => Ok(TaskRole::Review),
            "verify" => Ok(TaskRole::Verify),
            "research" => Ok(TaskRole::Research),
            other => Err(format!("Unknown task role: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionStrategy {
    CurrentProject,
    Worktree,
    Handoff,
}

impl TaskExecutionStrategy {
    fn as_str(&self) -> &'static str {
        match self {
            TaskExecutionStrategy::CurrentProject => "current_project",
            TaskExecutionStrategy::Worktree => "worktree",
            TaskExecutionStrategy::Handoff => "handoff",
        }
    }

    fn from_str(s: &str) -> Result<Self, String> {
        match s.trim() {
            "current_project" => Ok(TaskExecutionStrategy::CurrentProject),
            "worktree" => Ok(TaskExecutionStrategy::Worktree),
            "handoff" => Ok(TaskExecutionStrategy::Handoff),
            other => Err(format!("Unknown task execution strategy: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub prompt: String,
    pub status: TaskStatus,
    pub provider: String,
    pub role: Option<TaskRole>,
    pub execution_strategy: TaskExecutionStrategy,
    pub worktree_path: Option<String>,
    pub project_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub deps: Vec<String>,
    pub session_id: Option<String>,
    pub source_session_id: Option<String>,
    pub review_required: bool,
    pub result_summary: Option<String>,
    pub result_changed_files: Vec<String>,
    pub result_verification_summary: Option<String>,
    pub result_risk_summary: Option<String>,
    pub result_suggested_next_step: Option<String>,
}

fn tasks_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".openwork").join("tasks")
}

fn task_file_path(project_path: &str, id: &str) -> Result<PathBuf, String> {
    let trimmed_id = id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.contains('/')
        || trimmed_id.contains('\\')
        || trimmed_id.contains("..")
    {
        return Err("Invalid task id".to_string());
    }

    Ok(tasks_dir(project_path).join(format!("{trimmed_id}.md")))
}

fn ensure_tasks_dir(project_path: &str) -> Result<PathBuf, String> {
    let dir = tasks_dir(project_path);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create tasks directory: {e}"))?;
    Ok(dir)
}

fn serialize_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn serialize_string_option(value: &Option<String>) -> String {
    match value {
        Some(value) if !value.is_empty() => serialize_string(value),
        _ => "null".to_string(),
    }
}

fn serialize_string_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn default_provider() -> String {
    "claude".to_string()
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn infer_execution_strategy(worktree_path: Option<&str>) -> TaskExecutionStrategy {
    if worktree_path.is_some() {
        TaskExecutionStrategy::Worktree
    } else {
        TaskExecutionStrategy::CurrentProject
    }
}

fn canonicalize_handoff_session_binding(
    status: &TaskStatus,
    result_summary: Option<&str>,
    session_id: Option<String>,
    source_session_id: Option<String>,
) -> (Option<String>, Option<String>) {
    let normalized_session_id = normalize_optional_string(session_id);
    let normalized_source_session_id = normalize_optional_string(source_session_id);

    if normalized_source_session_id.is_some() || normalized_session_id.is_none() {
        return (normalized_session_id, normalized_source_session_id);
    }

    let should_treat_session_as_source = matches!(
        status,
        TaskStatus::Open | TaskStatus::Queued | TaskStatus::Dispatched | TaskStatus::Failed
    ) || matches!(status, TaskStatus::Cancelled)
        && result_summary == Some("Cancelled before handoff started");

    if should_treat_session_as_source {
        (None, normalized_session_id)
    } else {
        (normalized_session_id, None)
    }
}

fn normalize_execution_metadata(
    execution_strategy: TaskExecutionStrategy,
    worktree_path: Option<String>,
    session_id: Option<String>,
    source_session_id: Option<String>,
) -> Result<(TaskExecutionStrategy, Option<String>, Option<String>, Option<String>), String> {
    match execution_strategy {
        TaskExecutionStrategy::CurrentProject => Ok((
            TaskExecutionStrategy::CurrentProject,
            None,
            normalize_optional_string(session_id),
            None,
        )),
        TaskExecutionStrategy::Worktree => {
            let normalized_worktree_path = normalize_optional_string(worktree_path);
            if normalized_worktree_path.is_none() {
                return Err("Worktree strategy requires a worktree path".to_string());
            }
            Ok((
                TaskExecutionStrategy::Worktree,
                normalized_worktree_path,
                normalize_optional_string(session_id),
                None,
            ))
        }
        TaskExecutionStrategy::Handoff => {
            let normalized_session_id = normalize_optional_string(session_id);
            let normalized_source_session_id = normalize_optional_string(source_session_id);
            if normalized_source_session_id.is_none() && normalized_session_id.is_none() {
                return Err("Handoff strategy requires a source session id".to_string());
            }
            Ok((
                TaskExecutionStrategy::Handoff,
                normalize_optional_string(worktree_path),
                normalized_session_id,
                normalized_source_session_id,
            ))
        }
    }
}

fn canonicalize_execution_metadata(
    status: &TaskStatus,
    result_summary: Option<&str>,
    execution_strategy: TaskExecutionStrategy,
    worktree_path: Option<String>,
    session_id: Option<String>,
    source_session_id: Option<String>,
) -> Result<(TaskExecutionStrategy, Option<String>, Option<String>, Option<String>), String> {
    let (session_id, source_session_id) = if execution_strategy == TaskExecutionStrategy::Handoff {
        canonicalize_handoff_session_binding(status, result_summary, session_id, source_session_id)
    } else {
        (session_id, source_session_id)
    };

    normalize_execution_metadata(execution_strategy, worktree_path, session_id, source_session_id)
}

fn task_to_markdown(task: &Task) -> String {
    let body = task.description.as_deref().unwrap_or("");

    format!(
        "---\n\
         id: {}\n\
         title: {}\n\
         description: {}\n\
         prompt: {}\n\
         status: {}\n\
         provider: {}\n\
         role: {}\n\
         execution_strategy: {}\n\
         worktree_path: {}\n\
         project_path: {}\n\
         created_at: {}\n\
         updated_at: {}\n\
         deps: {}\n\
         session_id: {}\n\
         source_session_id: {}\n\
         review_required: {}\n\
         result_summary: {}\n\
         result_changed_files: {}\n\
         result_verification_summary: {}\n\
         result_risk_summary: {}\n\
         result_suggested_next_step: {}\n\
         ---\n\
         \n\
         {}",
        serialize_string(&task.id),
        serialize_string(&task.title),
        serialize_string_option(&task.description),
        serialize_string(&task.prompt),
        task.status.as_str(),
        serialize_string(&task.provider),
        task.role
            .as_ref()
            .map(|role| serialize_string(role.as_str()))
            .unwrap_or_else(|| "null".to_string()),
        serialize_string(task.execution_strategy.as_str()),
        serialize_string_option(&task.worktree_path),
        serialize_string(&task.project_path),
        serialize_string(&task.created_at),
        serialize_string(&task.updated_at),
        serialize_string_array(&task.deps),
        serialize_string_option(&task.session_id),
        serialize_string_option(&task.source_session_id),
        task.review_required,
        serialize_string_option(&task.result_summary),
        serialize_string_array(&task.result_changed_files),
        serialize_string_option(&task.result_verification_summary),
        serialize_string_option(&task.result_risk_summary),
        serialize_string_option(&task.result_suggested_next_step),
        body,
    )
}

fn parse_string(value: &str) -> String {
    let trimmed = value.trim();
    serde_json::from_str::<String>(trimmed).unwrap_or_else(|_| {
        let unwrapped = if trimmed.len() >= 4
            && trimmed.starts_with("\\\"")
            && trimmed.ends_with("\\\"")
        {
            &trimmed[2..trimmed.len() - 2]
        } else {
            trimmed.trim_start_matches('"').trim_end_matches('"')
        };

        unwrapped.replace("\\\"", "\"").replace("\\\\", "\\")
    })
}

fn parse_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "null" {
        None
    } else {
        normalize_optional_string(Some(parse_string(trimmed)))
    }
}

fn parse_bool(value: &str) -> bool {
    matches!(value.trim(), "true" | "True" | "TRUE")
}

fn parse_task(content: &str, fallback_project_path: &str) -> Result<Task, String> {
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Err("Invalid task file: missing frontmatter delimiters".to_string());
    }

    let frontmatter = parts[1].trim();
    let body = parts[2].trim();

    let mut id = String::new();
    let mut title = String::new();
    let mut description: Option<String> = None;
    let mut prompt: Option<String> = None;
    let mut status = TaskStatus::Open;
    let mut provider: Option<String> = None;
    let mut role: Option<TaskRole> = None;
    let mut execution_strategy: Option<TaskExecutionStrategy> = None;
    let mut worktree_path: Option<String> = None;
    let mut project_path: Option<String> = None;
    let mut created_at = String::new();
    let mut updated_at = String::new();
    let mut deps: Vec<String> = Vec::new();
    let mut session_id: Option<String> = None;
    let mut source_session_id: Option<String> = None;
    let mut review_required = false;
    let mut result_summary: Option<String> = None;
    let mut result_changed_files: Vec<String> = Vec::new();
    let mut result_verification_summary: Option<String> = None;
    let mut result_risk_summary: Option<String> = None;
    let mut result_suggested_next_step: Option<String> = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, raw_value)) = line.split_once(':') {
            let key = key.trim();
            let value = raw_value.trim();

            match key {
                "id" => id = parse_string(value),
                "title" => title = parse_string(value),
                "description" => description = parse_optional_string(value),
                "prompt" => prompt = parse_optional_string(value),
                "status" => status = TaskStatus::from_str(value.trim_matches('"'))?,
                "provider" => provider = parse_optional_string(value),
                "role" => {
                    role = parse_optional_string(value)
                        .map(|role| TaskRole::from_str(&role))
                        .transpose()?
                }
                "execution_strategy" => {
                    execution_strategy = parse_optional_string(value)
                        .map(|strategy| TaskExecutionStrategy::from_str(&strategy))
                        .transpose()?
                },
                "worktree_path" => worktree_path = parse_optional_string(value),
                "project_path" => project_path = parse_optional_string(value),
                "created_at" => created_at = parse_string(value),
                "updated_at" => updated_at = parse_string(value),
                "deps" => deps = parse_string_array(value),
                "session_id" => session_id = parse_optional_string(value),
                "source_session_id" => source_session_id = parse_optional_string(value),
                "review_required" => review_required = parse_bool(value),
                "result_summary" => result_summary = parse_optional_string(value),
                "result_changed_files" => result_changed_files = parse_string_array(value),
                "result_verification_summary" => {
                    result_verification_summary = parse_optional_string(value)
                },
                "result_risk_summary" => result_risk_summary = parse_optional_string(value),
                "result_suggested_next_step" => {
                    result_suggested_next_step = parse_optional_string(value)
                },
                _ => {}
            }
        }
    }

    if id.is_empty() {
        return Err("Task file missing 'id' field".to_string());
    }
    if title.is_empty() {
        return Err("Task file missing 'title' field".to_string());
    }

    let body_description = normalize_optional_string(Some(body.to_string()));
    let description = description.or(body_description.clone());
    let prompt = prompt
        .or_else(|| body_description.clone())
        .unwrap_or_else(|| title.clone());
    let execution_strategy =
        execution_strategy.unwrap_or_else(|| infer_execution_strategy(worktree_path.as_deref()));
    let (execution_strategy, worktree_path, session_id, source_session_id) =
        canonicalize_execution_metadata(
            &status,
            result_summary.as_deref(),
            execution_strategy,
            worktree_path,
            session_id,
            source_session_id,
        )?;

    Ok(Task {
        id,
        title,
        description,
        prompt,
        status,
        provider: provider.unwrap_or_else(default_provider),
        role,
        execution_strategy,
        worktree_path,
        project_path: project_path.unwrap_or_else(|| fallback_project_path.to_string()),
        created_at,
        updated_at,
        deps,
        session_id,
        source_session_id,
        review_required,
        result_summary,
        result_changed_files,
        result_verification_summary,
        result_risk_summary,
        result_suggested_next_step,
    })
}

fn parse_string_array(s: &str) -> Vec<String> {
    let s = s.trim();
    if s == "[]" || s.is_empty() {
        return Vec::new();
    }

    if let Ok(values) = serde_json::from_str::<Vec<String>>(s) {
        return values;
    }

    let inner = s
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if inner.is_empty() {
        return Vec::new();
    }

    inner
        .split(',')
        .map(parse_string)
        .filter(|value| !value.is_empty())
        .collect()
}

#[tauri::command]
pub async fn task_list(project_path: String) -> Result<Vec<Task>, String> {
    let dir = tasks_dir(&project_path);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read tasks directory: {e}"))?;

    let mut tasks = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read task file {}: {e}", path.display()))?;
            match parse_task(&content, &project_path) {
                Ok(task) => tasks.push(task),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Skipping invalid task file");
                }
            }
        }
    }

    tasks.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(tasks)
}

#[tauri::command]
pub async fn task_create(
    project_path: String,
    title: String,
    description: Option<String>,
    prompt: Option<String>,
    provider: Option<String>,
    role: Option<TaskRole>,
    execution_strategy: Option<TaskExecutionStrategy>,
    worktree_path: Option<String>,
    session_id: Option<String>,
    source_session_id: Option<String>,
    review_required: Option<bool>,
    status: Option<TaskStatus>,
    deps: Vec<String>,
) -> Result<Task, String> {
    let dir = ensure_tasks_dir(&project_path)?;
    let now = Utc::now().to_rfc3339();
    let normalized_description = normalize_optional_string(description);
    let status = status.unwrap_or(TaskStatus::Queued);
    let requested_execution_strategy = execution_strategy
        .unwrap_or_else(|| infer_execution_strategy(worktree_path.as_deref()));
    let (
        execution_strategy,
        normalized_worktree_path,
        normalized_session_id,
        normalized_source_session_id,
    ) = canonicalize_execution_metadata(
        &status,
        None,
        requested_execution_strategy,
        worktree_path,
        session_id,
        source_session_id,
    )?;
    let task = Task {
        id: Uuid::new_v4().to_string(),
        title: normalize_optional_string(Some(title)).unwrap_or_else(|| "Untitled task".to_string()),
        description: normalized_description.clone(),
        prompt: normalize_optional_string(prompt)
            .or_else(|| normalized_description.clone())
            .unwrap_or_else(|| "New task".to_string()),
        status,
        provider: normalize_optional_string(provider).unwrap_or_else(default_provider),
        role,
        execution_strategy,
        worktree_path: normalized_worktree_path,
        project_path: project_path.clone(),
        created_at: now.clone(),
        updated_at: now,
        deps,
        session_id: normalized_session_id,
        source_session_id: normalized_source_session_id,
        review_required: review_required.unwrap_or(false),
        result_summary: None,
        result_changed_files: Vec::new(),
        result_verification_summary: None,
        result_risk_summary: None,
        result_suggested_next_step: None,
    };

    let file_path = dir.join(format!("{}.md", task.id));
    let content = task_to_markdown(&task);
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write task file: {e}"))?;

    tracing::info!(id = %task.id, title = %task.title, "Task created");
    Ok(task)
}

#[tauri::command]
pub async fn task_update(
    project_path: String,
    id: String,
    title: Option<String>,
    description: Option<String>,
    prompt: Option<String>,
    status: Option<TaskStatus>,
    provider: Option<String>,
    role: Option<TaskRole>,
    execution_strategy: Option<TaskExecutionStrategy>,
    worktree_path: Option<String>,
    session_id: Option<String>,
    source_session_id: Option<String>,
    review_required: Option<bool>,
    result_summary: Option<String>,
    result_changed_files: Option<Vec<String>>,
    result_verification_summary: Option<String>,
    result_risk_summary: Option<String>,
    result_suggested_next_step: Option<String>,
) -> Result<Task, String> {
    let file_path = task_file_path(&project_path, &id)?;

    if !file_path.is_file() {
        return Err(format!("Task {id} not found"));
    }

    let content = fs::read_to_string(&file_path).map_err(|e| format!("Failed to read task file: {e}"))?;
    let mut task = parse_task(&content, &project_path)?;

    if let Some(title) = normalize_optional_string(title) {
        task.title = title;
    }
    if description.is_some() {
        task.description = normalize_optional_string(description);
    }
    if let Some(prompt) = normalize_optional_string(prompt) {
        task.prompt = prompt;
    }
    if let Some(status) = status {
        task.status = status;
    }
    if let Some(provider) = normalize_optional_string(provider) {
        task.provider = provider;
    }
    if let Some(role) = role {
        task.role = Some(role);
    }
    if let Some(execution_strategy) = execution_strategy {
        task.execution_strategy = execution_strategy;
    }
    if worktree_path.is_some() {
        task.worktree_path = normalize_optional_string(worktree_path);
    }
    if session_id.is_some() {
        task.session_id = normalize_optional_string(session_id);
    }
    if source_session_id.is_some() {
        task.source_session_id = normalize_optional_string(source_session_id);
    }
    if let Some(review_required) = review_required {
        task.review_required = review_required;
    }
    if result_summary.is_some() {
        task.result_summary = normalize_optional_string(result_summary);
    }
    if let Some(result_changed_files) = result_changed_files {
        task.result_changed_files = result_changed_files
            .into_iter()
            .filter_map(|value| normalize_optional_string(Some(value)))
            .collect();
    }
    if result_verification_summary.is_some() {
        task.result_verification_summary = normalize_optional_string(result_verification_summary);
    }
    if result_risk_summary.is_some() {
        task.result_risk_summary = normalize_optional_string(result_risk_summary);
    }
    if result_suggested_next_step.is_some() {
        task.result_suggested_next_step = normalize_optional_string(result_suggested_next_step);
    }

    let (execution_strategy, worktree_path, session_id, source_session_id) =
        canonicalize_execution_metadata(
            &task.status,
            task.result_summary.as_deref(),
            task.execution_strategy.clone(),
            task.worktree_path.clone(),
            task.session_id.clone(),
            task.source_session_id.clone(),
        )?;
    task.execution_strategy = execution_strategy;
    task.worktree_path = worktree_path;
    task.session_id = session_id;
    task.source_session_id = source_session_id;

    task.updated_at = Utc::now().to_rfc3339();

    let new_content = task_to_markdown(&task);
    fs::write(&file_path, &new_content).map_err(|e| format!("Failed to write task file: {e}"))?;

    tracing::info!(id = %task.id, status = %task.status.as_str(), "Task updated");
    Ok(task)
}

#[tauri::command]
pub async fn task_delete(project_path: String, id: String) -> Result<(), String> {
    let file_path = task_file_path(&project_path, &id)?;

    if !file_path.is_file() {
        return Err(format!("Task {id} not found"));
    }

    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete task file: {e}"))?;

    tracing::info!(id = %id, "Task deleted");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task() -> Task {
        Task {
            id: "abc-123".to_string(),
            title: "Fix login bug".to_string(),
            description: Some("Description body here.".to_string()),
            prompt: "Investigate and fix the login issue".to_string(),
            status: TaskStatus::Dispatched,
            provider: "codex".to_string(),
            role: Some(TaskRole::Review),
            execution_strategy: TaskExecutionStrategy::Worktree,
            worktree_path: Some("/tmp/openwork-worktrees/review".to_string()),
            project_path: "/tmp/openwork".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-02T00:00:00Z".to_string(),
            deps: vec!["dep-1".to_string(), "dep-2".to_string()],
            session_id: Some("sess-456".to_string()),
            source_session_id: None,
            review_required: true,
            result_summary: Some("Waiting for human review".to_string()),
            result_changed_files: vec![
                "src-tauri/src/tasks.rs".to_string(),
                "src/components/overview/ReviewQueuePanel.tsx".to_string(),
            ],
            result_verification_summary: Some("cargo test tasks --lib; npm run vitest ReviewQueuePanel".to_string()),
            result_risk_summary: Some("Low risk; touches durable metadata and Mission Control presentation only.".to_string()),
            result_suggested_next_step: Some("Open the review task and verify the changed files list before accepting.".to_string()),
        }
    }

    #[test]
    fn test_task_status_roundtrip() {
        let cases = vec![
            (TaskStatus::Open, "open"),
            (TaskStatus::Queued, "queued"),
            (TaskStatus::Dispatched, "dispatched"),
            (TaskStatus::InProgress, "in_progress"),
            (TaskStatus::PendingApproval, "pending_approval"),
            (TaskStatus::PendingReview, "pending_review"),
            (TaskStatus::Done, "done"),
            (TaskStatus::Failed, "failed"),
            (TaskStatus::Cancelled, "cancelled"),
            (TaskStatus::Archived, "archived"),
        ];
        for (status, expected_str) in cases {
            assert_eq!(status.as_str(), expected_str);
            let parsed = TaskStatus::from_str(expected_str).unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn test_task_role_roundtrip() {
        let cases = vec![
            (TaskRole::Implement, "implement"),
            (TaskRole::Review, "review"),
            (TaskRole::Verify, "verify"),
            (TaskRole::Research, "research"),
        ];
        for (role, expected_str) in cases {
            assert_eq!(role.as_str(), expected_str);
            let parsed = TaskRole::from_str(expected_str).unwrap();
            assert_eq!(parsed, role);
        }
    }

    #[test]
    fn test_task_execution_strategy_roundtrip() {
        let cases = vec![
            (
                TaskExecutionStrategy::CurrentProject,
                "current_project",
            ),
            (TaskExecutionStrategy::Worktree, "worktree"),
            (TaskExecutionStrategy::Handoff, "handoff"),
        ];
        for (strategy, expected_str) in cases {
            assert_eq!(strategy.as_str(), expected_str);
            let parsed = TaskExecutionStrategy::from_str(expected_str).unwrap();
            assert_eq!(parsed, strategy);
        }
    }

    #[test]
    fn test_task_markdown_roundtrip() {
        let task = sample_task();
        let md = task_to_markdown(&task);
        let parsed = parse_task(&md, "/fallback").expect("Should parse successfully");

        assert_eq!(parsed.id, task.id);
        assert_eq!(parsed.title, task.title);
        assert_eq!(parsed.description, task.description);
        assert_eq!(parsed.prompt, task.prompt);
        assert_eq!(parsed.status, task.status);
        assert_eq!(parsed.provider, task.provider);
        assert_eq!(parsed.role, task.role);
        assert_eq!(parsed.execution_strategy, task.execution_strategy);
        assert_eq!(parsed.worktree_path, task.worktree_path);
        assert_eq!(parsed.project_path, task.project_path);
        assert_eq!(parsed.created_at, task.created_at);
        assert_eq!(parsed.updated_at, task.updated_at);
        assert_eq!(parsed.deps, task.deps);
        assert_eq!(parsed.session_id, task.session_id);
        assert_eq!(parsed.source_session_id, task.source_session_id);
        assert_eq!(parsed.review_required, task.review_required);
        assert_eq!(parsed.result_summary, task.result_summary);
        assert_eq!(parsed.result_changed_files, task.result_changed_files);
        assert_eq!(
            parsed.result_verification_summary,
            task.result_verification_summary
        );
        assert_eq!(parsed.result_risk_summary, task.result_risk_summary);
        assert_eq!(
            parsed.result_suggested_next_step,
            task.result_suggested_next_step
        );
    }

    #[test]
    fn test_legacy_task_defaults_to_phase_two_shape() {
        let legacy = r#"---
id: \"legacy-1\"
title: \"Legacy task\"
status: in_progress
created_at: \"2024-06-01T12:00:00Z\"
updated_at: \"2024-06-01T12:00:00Z\"
deps: []
session_id: null
---

Legacy task body prompt.
"#;

        let parsed = parse_task(legacy, "/tmp/project").expect("legacy task should parse");

        assert_eq!(parsed.status, TaskStatus::InProgress);
        assert_eq!(parsed.prompt, "Legacy task body prompt.");
        assert_eq!(parsed.description, Some("Legacy task body prompt.".to_string()));
        assert_eq!(parsed.provider, "claude");
        assert_eq!(parsed.role, None);
        assert_eq!(
            parsed.execution_strategy,
            TaskExecutionStrategy::CurrentProject
        );
        assert_eq!(parsed.worktree_path, None);
        assert_eq!(parsed.project_path, "/tmp/project");
        assert_eq!(parsed.review_required, false);
        assert_eq!(parsed.result_summary, None);
        assert_eq!(parsed.result_changed_files, Vec::<String>::new());
        assert_eq!(parsed.result_verification_summary, None);
        assert_eq!(parsed.result_risk_summary, None);
        assert_eq!(parsed.result_suggested_next_step, None);
        assert_eq!(parsed.source_session_id, None);
    }

    #[test]
    fn test_legacy_worktree_task_defaults_to_worktree_execution_strategy() {
        let legacy = r#"---
id: \"legacy-2\"
title: \"Legacy worktree task\"
status: queued
worktree_path: \"/tmp/project-worktrees/task-a\"
created_at: \"2024-06-01T12:00:00Z\"
updated_at: \"2024-06-01T12:00:00Z\"
deps: []
session_id: null
---

Legacy worktree prompt.
"#;

        let parsed = parse_task(legacy, "/tmp/project").expect("legacy task should parse");

        assert_eq!(parsed.execution_strategy, TaskExecutionStrategy::Worktree);
        assert_eq!(
            parsed.worktree_path,
            Some("/tmp/project-worktrees/task-a".to_string())
        );
    }

    #[test]
    fn test_legacy_handoff_task_migrates_source_session_for_queued_state() {
        let legacy = r#"---
id: \"legacy-handoff-queued\"
title: \"Legacy handoff queued\"
status: queued
execution_strategy: \"handoff\"
created_at: \"2024-06-01T12:00:00Z\"
updated_at: \"2024-06-01T12:00:00Z\"
deps: []
session_id: \"source-session-1\"
---

Legacy handoff prompt.
"#;

        let parsed = parse_task(legacy, "/tmp/project").expect("legacy handoff task should parse");

        assert_eq!(parsed.execution_strategy, TaskExecutionStrategy::Handoff);
        assert_eq!(parsed.session_id, None);
        assert_eq!(
            parsed.source_session_id,
            Some("source-session-1".to_string())
        );
    }

    #[test]
    fn test_legacy_handoff_task_keeps_runtime_session_for_review_state() {
        let legacy = r#"---
id: \"legacy-handoff-review\"
title: \"Legacy handoff review\"
status: pending_review
execution_strategy: \"handoff\"
created_at: \"2024-06-01T12:00:00Z\"
updated_at: \"2024-06-01T12:00:00Z\"
deps: []
session_id: \"runtime-session-1\"
---

Legacy handoff prompt.
"#;

        let parsed = parse_task(legacy, "/tmp/project").expect("legacy handoff task should parse");

        assert_eq!(parsed.execution_strategy, TaskExecutionStrategy::Handoff);
        assert_eq!(parsed.session_id, Some("runtime-session-1".to_string()));
        assert_eq!(parsed.source_session_id, None);
    }

    #[test]
    fn test_null_optional_fields_remain_none_after_roundtrip() {
        let task = Task {
            session_id: None,
            source_session_id: None,
            result_summary: None,
            result_changed_files: Vec::new(),
            result_verification_summary: None,
            result_risk_summary: None,
            result_suggested_next_step: None,
            description: None,
            role: None,
            execution_strategy: TaskExecutionStrategy::CurrentProject,
            worktree_path: None,
            ..sample_task()
        };

        let md = task_to_markdown(&task);
        let parsed = parse_task(&md, "/fallback").expect("task should parse");

        assert_eq!(parsed.session_id, None);
        assert_eq!(parsed.result_summary, None);
        assert_eq!(parsed.result_changed_files, Vec::<String>::new());
        assert_eq!(parsed.result_verification_summary, None);
        assert_eq!(parsed.result_risk_summary, None);
        assert_eq!(parsed.result_suggested_next_step, None);
        assert_eq!(parsed.description, None);
        assert_eq!(parsed.role, None);
        assert_eq!(parsed.worktree_path, None);
        assert_eq!(
            parsed.execution_strategy,
            TaskExecutionStrategy::CurrentProject
        );
    }

    #[test]
    fn test_multiline_prompt_roundtrip() {
        let task = Task {
            prompt: "line 1\nline 2\nline 3".to_string(),
            description: Some("first line\nsecond line".to_string()),
            ..sample_task()
        };

        let md = task_to_markdown(&task);
        let parsed = parse_task(&md, "/fallback").expect("task should parse");

        assert_eq!(parsed.prompt, task.prompt);
        assert_eq!(parsed.description, task.description);
    }

    #[test]
    fn test_normalize_execution_metadata_keeps_runtime_session_for_non_handoff_strategies() {
        let (
            _,
            current_project_worktree,
            current_project_session,
            current_project_source_session,
        ) =
            normalize_execution_metadata(
                TaskExecutionStrategy::CurrentProject,
                Some("/tmp/project-worktrees/review-a".to_string()),
                Some("runtime-session-1".to_string()),
                Some("source-session-1".to_string()),
            )
            .expect("current project normalization should succeed");
        assert_eq!(current_project_worktree, None);
        assert_eq!(current_project_session, Some("runtime-session-1".to_string()));
        assert_eq!(current_project_source_session, None);

        let (_, worktree_path, worktree_session, worktree_source_session) =
            normalize_execution_metadata(
                TaskExecutionStrategy::Worktree,
                Some("/tmp/project-worktrees/review-a".to_string()),
                Some("runtime-session-2".to_string()),
                Some("source-session-2".to_string()),
            )
            .expect("worktree normalization should succeed");
        assert_eq!(
            worktree_path,
            Some("/tmp/project-worktrees/review-a".to_string())
        );
        assert_eq!(worktree_session, Some("runtime-session-2".to_string()));
        assert_eq!(worktree_source_session, None);
    }

    #[test]
    fn test_canonicalize_handoff_session_binding_promotes_pre_runtime_session_to_source() {
        let (session_id, source_session_id) = canonicalize_handoff_session_binding(
            &TaskStatus::Queued,
            None,
            Some("runtime-or-source".to_string()),
            None,
        );

        assert_eq!(session_id, None);
        assert_eq!(source_session_id, Some("runtime-or-source".to_string()));
    }

    #[tokio::test]
    async fn test_task_create_persists_session_id_and_review_required() {
        let project_path = std::env::temp_dir().join(format!("openwork-task-create-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let created = task_create(
            project_path_str.clone(),
            "  Durable handoff task  ".to_string(),
            Some("  capture prior session  ".to_string()),
            None,
            Some(" codex ".to_string()),
            Some(TaskRole::Review),
            Some(TaskExecutionStrategy::Handoff),
            None,
            None,
            Some("  sess-create-1  ".to_string()),
            Some(true),
            Some(TaskStatus::Queued),
            vec!["dep-1".to_string()],
        )
        .await
        .expect("task_create should succeed");

        assert_eq!(created.title, "Durable handoff task");
        assert_eq!(created.description, Some("capture prior session".to_string()));
        assert_eq!(created.prompt, "capture prior session");
        assert_eq!(created.provider, "codex");
        assert_eq!(created.execution_strategy, TaskExecutionStrategy::Handoff);
        assert_eq!(created.session_id, None);
        assert_eq!(
            created.source_session_id,
            Some("sess-create-1".to_string())
        );
        assert!(created.review_required);

        let listed = task_list(project_path_str.clone())
            .await
            .expect("task_list should succeed after create");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, None);
        assert_eq!(
            listed[0].source_session_id,
            Some("sess-create-1".to_string())
        );
        assert!(listed[0].review_required);

        let _ = fs::remove_dir_all(project_path);
    }

    #[tokio::test]
    async fn test_task_create_canonicalizes_legacy_handoff_session_binding() {
        let project_path =
            std::env::temp_dir().join(format!("openwork-task-create-legacy-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let created = task_create(
            project_path_str.clone(),
            "Legacy handoff".to_string(),
            Some("reuse source session".to_string()),
            None,
            Some("codex".to_string()),
            Some(TaskRole::Implement),
            Some(TaskExecutionStrategy::Handoff),
            None,
            Some(" legacy-source ".to_string()),
            None,
            Some(false),
            Some(TaskStatus::Queued),
            vec![],
        )
        .await
        .expect("task_create should canonicalize queued handoff source binding");

        assert_eq!(created.session_id, None);
        assert_eq!(
            created.source_session_id,
            Some("legacy-source".to_string())
        );

        let listed = task_list(project_path_str.clone())
            .await
            .expect("task_list should succeed after create");
        assert_eq!(listed[0].session_id, None);
        assert_eq!(
            listed[0].source_session_id,
            Some("legacy-source".to_string())
        );

        let _ = fs::remove_dir_all(project_path);
    }

    #[tokio::test]
    async fn test_task_create_rejects_invalid_execution_metadata() {
        let project_path = std::env::temp_dir().join(format!("openwork-task-invalid-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let missing_worktree = task_create(
            project_path_str.clone(),
            "Worktree task".to_string(),
            Some("Run in worktree".to_string()),
            None,
            None,
            None,
            Some(TaskExecutionStrategy::Worktree),
            None,
            None,
            None,
            None,
            Some(TaskStatus::Queued),
            vec![],
        )
        .await;
        assert!(missing_worktree.is_err());

        let missing_handoff_source = task_create(
            project_path_str.clone(),
            "Handoff task".to_string(),
            Some("Resume previous run".to_string()),
            None,
            None,
            None,
            Some(TaskExecutionStrategy::Handoff),
            None,
            None,
            None,
            None,
            Some(TaskStatus::Queued),
            vec![],
        )
        .await;
        assert!(missing_handoff_source.is_err());

        let _ = fs::remove_dir_all(project_path);
    }

    #[tokio::test]
    async fn test_task_update_normalizes_execution_metadata() {
        let project_path = std::env::temp_dir().join(format!("openwork-task-update-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let created = task_create(
            project_path_str.clone(),
            "Update metadata task".to_string(),
            Some("Exercise update path".to_string()),
            None,
            None,
            None,
            Some(TaskExecutionStrategy::Worktree),
            Some("/tmp/project-worktrees/update-a".to_string()),
            None,
            None,
            None,
            Some(TaskStatus::Queued),
            vec![],
        )
        .await
        .expect("task_create should succeed");

        let normalized = task_update(
            project_path_str.clone(),
            created.id.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(TaskExecutionStrategy::CurrentProject),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("task_update should normalize current project metadata");
        assert_eq!(normalized.execution_strategy, TaskExecutionStrategy::CurrentProject);
        assert_eq!(normalized.worktree_path, None);

        let invalid_handoff = task_update(
            project_path_str.clone(),
            created.id,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(TaskExecutionStrategy::Handoff),
            None,
            None,
            Some("   ".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(invalid_handoff.is_err());

        let _ = fs::remove_dir_all(project_path);
    }

    #[tokio::test]
    async fn test_task_update_canonicalizes_pre_runtime_handoff_binding() {
        let project_path =
            std::env::temp_dir().join(format!("openwork-task-update-handoff-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let created = task_create(
            project_path_str.clone(),
            "Queued handoff".to_string(),
            Some("carry source session".to_string()),
            None,
            Some("codex".to_string()),
            None,
            Some(TaskExecutionStrategy::Handoff),
            None,
            None,
            Some("source-session-1".to_string()),
            Some(false),
            Some(TaskStatus::Queued),
            vec![],
        )
        .await
        .expect("task_create should succeed");

        let updated = task_update(
            project_path_str.clone(),
            created.id.clone(),
            None,
            None,
            None,
            Some(TaskStatus::Queued),
            None,
            None,
            Some(TaskExecutionStrategy::Handoff),
            None,
            Some(" source-session-2 ".to_string()),
            Some("   ".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("task_update should keep queued handoff source binding canonicalized");

        assert_eq!(updated.session_id, None);
        assert_eq!(
            updated.source_session_id,
            Some("source-session-2".to_string())
        );

        let _ = fs::remove_dir_all(project_path);
    }

    #[tokio::test]
    async fn test_task_update_and_delete_reject_invalid_ids() {
        let project_path = std::env::temp_dir().join(format!("openwork-task-path-{}", Uuid::new_v4()));
        let project_path_str = project_path.to_string_lossy().to_string();

        let update_result = task_update(
            project_path_str.clone(),
            "../escape".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(update_result.is_err());

        let delete_result = task_delete(project_path_str, "../escape".to_string()).await;
        assert!(delete_result.is_err());

        let _ = fs::remove_dir_all(project_path);
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

    #[test]
    fn test_invalid_role() {
        let result = TaskRole::from_str("shipit");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_execution_strategy() {
        let result = TaskExecutionStrategy::from_str("teleport");
        assert!(result.is_err());
    }
}
