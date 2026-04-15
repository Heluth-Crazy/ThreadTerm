use crate::db;
use crate::projects::Session;
use crate::pty;
use tauri::{AppHandle, Manager, Window};

/// Find the path to a CLI executable, checking settings first then PATH.
fn resolve_cli(provider: &str) -> Result<String, String> {
    // Check settings for a custom path
    let key = format!("{provider}_cli_path");
    if let Ok(Some(custom)) = db::get_setting(&key) {
        if !custom.is_empty() && std::path::Path::new(&custom).exists() {
            return Ok(custom);
        }
    }

    let binary = match provider {
        "claude" => "claude",
        "codex" => "codex",
        "cursor" => "cursor-agent",
        _ => return Err(format!("Unknown AI provider: {provider}")),
    };

    which::which(binary)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| format!("CLI not found in PATH: {binary}"))
}

/// Build the argument list for each provider.
fn build_args<'a>(
    provider: &str,
    resume_session_id: &'a Option<String>,
) -> Vec<&'a str> {
    match provider {
        "claude" => {
            let mut args = Vec::new();
            if let Some(sid) = resume_session_id {
                args.push("--resume");
                args.push(sid.as_str());
            }
            args
        }
        "codex" => {
            let mut args = Vec::new();
            if let Some(sid) = resume_session_id {
                args.push("resume");
                args.push(sid.as_str());
            }
            args.push("--no-alt-screen");
            args
        }
        "cursor" => {
            let mut args = Vec::new();
            if let Some(sid) = resume_session_id {
                args.push("--resume");
                args.push(sid.as_str());
            }
            args
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start an AI CLI session by spawning it in a PTY.
#[tauri::command]
pub async fn ai_start_session(
    session_id: String,
    provider: String,
    project_path: String,
    resume_session_id: Option<String>,
    window: Window,
) -> Result<String, String> {
    if provider == "codex" {
        let cli_path = resolve_cli(&provider)?;
        let args = build_args(&provider, &resume_session_id);
        let arg_refs: Vec<&str> = args.iter().copied().collect();

        let pty_id = pty::create_command_pty(
            session_id.clone(),
            project_path,
            &cli_path,
            &arg_refs,
            24,
            120,
            window.app_handle().clone(),
        )?;

        tracing::info!(provider = %provider, pty_id = %pty_id, "AI session started in direct command PTY");
        return Ok(pty_id);
    }

    let cli_path = resolve_cli(&provider)?;
    let args = build_args(&provider, &resume_session_id);
    let arg_refs: Vec<&str> = args.iter().copied().collect();

    let pty_id = pty::create_command_pty(
        session_id.clone(),
        project_path,
        &cli_path,
        &arg_refs,
        24,
        120,
        window.app_handle().clone(),
    )?;

    tracing::info!(provider = %provider, pty_id = %pty_id, "AI session started");
    Ok(pty_id)
}

/// Send a message to the running AI CLI session via PTY input.
#[tauri::command]
pub async fn ai_send_message(pty_id: String, message: String) -> Result<(), String> {
    // Send \n: canonical-mode PTYs (Claude) pass it through unchanged;
    // raw-mode PTYs (Codex TUI) need \n since ICRNL translation is disabled.
    let input = format!("{message}\n");
    pty::pty_input(pty_id, input).await
}

#[tauri::command]
pub async fn ai_run_codex_exec(
    session_id: String,
    project_path: String,
    prompt: String,
    resume_session_id: Option<String>,
    window: Window,
) -> Result<String, String> {
    let cli_path = resolve_cli("codex")?;

    let mut args: Vec<&str> = vec![
        "exec",
        "--skip-git-repo-check",
        "--json",
    ];

    if let Some(ref resume_id) = resume_session_id {
        args.push("resume");
        args.push(resume_id.as_str());
    }

    args.push(prompt.as_str());

    let pty_id = pty::create_command_pty(
        session_id.clone(),
        project_path,
        &cli_path,
        &args,
        24,
        120,
        window.app_handle().clone(),
    )?;

    tracing::info!(session_id = %session_id, pty_id = %pty_id, "Codex exec session started");
    Ok(pty_id)
}

/// Abort a running AI session by killing its PTY.
#[tauri::command]
pub async fn ai_abort_session(pty_id: String) -> Result<(), String> {
    pty::pty_kill(pty_id).await
}

/// Approve or deny a tool-use permission request.
/// Claude CLI receives tool approval via stdin as JSON.
#[tauri::command]
pub async fn ai_approve_tool(
    session_id: String,
    permission_id: String,
    approved: bool,
) -> Result<(), String> {
    let approval_msg = serde_json::json!({
        "type": "tool_approval",
        "id": permission_id,
        "approved": approved,
    });
    let input = serde_json::to_string(&approval_msg)
        .map_err(|e| format!("Failed to serialize approval: {e}"))? + "\n";
    pty::write_to_session_by_prefix(&session_id, &input)
}

/// List existing Claude sessions for a project by scanning `~/.claude/projects/`.
#[tauri::command]
pub async fn ai_list_sessions(
    project_path: String,
    provider: String,
) -> Result<Vec<Session>, String> {
    if provider != "claude" {
        // Only Claude stores session files on disk
        return Ok(Vec::new());
    }

    let projects_root = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".claude")
        .join("projects");

    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let encoded = crate::projects::encode_project_path(&project_path);

    // Scan all subdirectories to find the matching one
    let sessions_dir = {
        let mut found = None;
        let entries = std::fs::read_dir(&projects_root)
            .map_err(|e| format!("Failed to read projects dir: {e}"))?;
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
            None => return Ok(Vec::new()),
        }
    };

    let mut sessions = Vec::new();
    let entries = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read sessions dir: {e}"))?;

    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".jsonl") {
            continue;
        }
        let id = fname.trim_end_matches(".jsonl").to_string();
        let meta = entry.metadata().ok();
        let created = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

        sessions.push(Session {
            id,
            project_path: project_path.clone(),
            provider: "claude".to_string(),
            name: None,
            created_at: created,
            last_message: None,
            message_count: 0,
        });
    }

    Ok(sessions)
}

/// Read AI provider configuration from settings.
#[tauri::command]
pub async fn settings_get_ai_config(provider: String) -> Result<serde_json::Value, String> {
    let keys = [
        format!("{provider}_cli_path"),
        format!("{provider}_model"),
        format!("{provider}_max_tokens"),
    ];

    let mut map = serde_json::Map::new();
    for key in &keys {
        if let Ok(Some(val)) = db::get_setting(key) {
            map.insert(
                key.clone(),
                serde_json::Value::String(val),
            );
        }
    }

    Ok(serde_json::Value::Object(map))
}

// ── Public helper for HTTP server ────────────────────────────────────────────

/// Start an AI CLI session programmatically (for HTTP server use).
pub fn start_session_internal(
    app_handle: &AppHandle,
    project_path: String,
    provider: String,
    resume_session_id: Option<String>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let cli_path = resolve_cli(&provider)?;
    let args = build_args(&provider, &resume_session_id);
    let arg_refs: Vec<&str> = args.iter().copied().collect();

    let pty_id = pty::create_command_pty(
        session_id,
        project_path,
        &cli_path,
        &arg_refs,
        24,
        120,
        app_handle.clone(),
    )?;

    tracing::info!(provider = %provider, pty_id = %pty_id, "AI session started via HTTP");
    Ok(pty_id)
}
