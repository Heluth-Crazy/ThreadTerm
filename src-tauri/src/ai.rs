use crate::db;
use crate::projects::Session;
use crate::pty;
use tauri::Window;

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
        "codex" => Vec::new(),
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
        window,
    )?;

    tracing::info!(provider = %provider, pty_id = %pty_id, "AI session started");
    Ok(pty_id)
}

/// Send a message to the running AI CLI session via PTY input.
#[tauri::command]
pub async fn ai_send_message(pty_id: String, message: String) -> Result<(), String> {
    // Write the message followed by a newline to the PTY
    let input = format!("{message}\n");
    pty::pty_input(pty_id, input).await
}

/// Abort a running AI session by killing its PTY.
#[tauri::command]
pub async fn ai_abort_session(pty_id: String) -> Result<(), String> {
    pty::pty_kill(pty_id).await
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
