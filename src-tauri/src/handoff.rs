use tauri::AppHandle;

#[derive(serde::Deserialize)]
pub struct HandoffRequest {
    pub source_pty_id: String,
    pub target_provider: String,
    pub project_path: String,
    pub task_description: Option<String>,
}

#[derive(serde::Serialize)]
pub struct HandoffResult {
    pub new_pty_id: String,
    pub handoff_prompt: String,
}

/// Create a handoff from one AI session to another.
/// Reads recent PTY output, generates a structured handoff prompt,
/// and starts a new session with the target provider.
#[tauri::command]
pub async fn handoff_session(
    app_handle: AppHandle,
    req: HandoffRequest,
) -> Result<HandoffResult, String> {
    // 1. Get recent output from the source session
    let recent_output = crate::pty::get_recent_output(&req.source_pty_id);

    // 2. Build handoff prompt
    let handoff_prompt = build_handoff_prompt(
        &req.source_pty_id,
        &req.target_provider,
        recent_output.as_deref().unwrap_or(""),
        req.task_description.as_deref(),
        &req.project_path,
    );

    // 3. Start new session with target provider
    let new_pty_id = crate::ai::start_session_internal(
        &app_handle,
        req.project_path,
        req.target_provider,
        None,
    )?;

    // 4. Wait briefly for the shell to initialize, then send handoff prompt
    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
    crate::pty::pty_write_internal(&new_pty_id, format!("{}\n", handoff_prompt))?;

    Ok(HandoffResult {
        new_pty_id,
        handoff_prompt,
    })
}

fn build_handoff_prompt(
    source_id: &str,
    target_provider: &str,
    recent_output: &str,
    task_description: Option<&str>,
    project_path: &str,
) -> String {
    let mut prompt = String::new();

    prompt.push_str("# Task Handoff\n\n");
    prompt.push_str(&format!(
        "You are continuing work that was started by another AI session ({}). \
         Please pick up where they left off.\n\n",
        source_id
    ));

    prompt.push_str(&format!("**Project**: `{}`\n", project_path));
    prompt.push_str(&format!("**Handoff to**: {}\n\n", target_provider));

    if let Some(desc) = task_description {
        if !desc.is_empty() {
            prompt.push_str(&format!("## Task Description\n{}\n\n", desc));
        }
    }

    if !recent_output.is_empty() {
        // Truncate to last 2000 chars to avoid overwhelming context
        let truncated = if recent_output.len() > 2000 {
            &recent_output[recent_output.len() - 2000..]
        } else {
            recent_output
        };
        prompt.push_str(&format!(
            "## Recent Session Output\n```\n{}\n```\n\n",
            truncated
        ));
    }

    prompt.push_str(
        "Please review the context above and continue the work. \
         If you need to understand the current state better, \
         start by checking `git status` and recent file changes.\n",
    );

    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_handoff_prompt_minimal() {
        let prompt = build_handoff_prompt(
            "pty-123",
            "codex",
            "",
            Some("Fix the login bug"),
            "/home/user/project",
        );
        assert!(prompt.contains("Task Handoff"));
        assert!(prompt.contains("Fix the login bug"));
        assert!(prompt.contains("/home/user/project"));
        assert!(prompt.contains("codex"));
    }

    #[test]
    fn test_build_handoff_prompt_with_output() {
        let recent = "$ git status\nOn branch main\nmodified: src/auth.rs";
        let prompt = build_handoff_prompt("pty-456", "claude", recent, None, "/project");
        assert!(prompt.contains("Recent Session Output"));
        assert!(prompt.contains("git status"));
    }

    #[test]
    fn test_build_handoff_prompt_truncates_long_output() {
        let long_output = "x".repeat(3000);
        let prompt = build_handoff_prompt("id", "claude", &long_output, None, "/p");
        // Should not contain the full 3000 chars
        let output_section = prompt.split("Recent Session Output").nth(1).unwrap_or("");
        assert!(output_section.len() < 2500);
    }

    #[test]
    fn test_build_handoff_prompt_no_task_description() {
        let prompt = build_handoff_prompt("src-1", "cursor", "", None, "/proj");
        assert!(prompt.contains("Task Handoff"));
        assert!(!prompt.contains("Task Description"));
    }

    #[test]
    fn test_build_handoff_prompt_empty_task_description() {
        let prompt = build_handoff_prompt("src-1", "cursor", "", Some(""), "/proj");
        assert!(!prompt.contains("Task Description"));
    }
}
