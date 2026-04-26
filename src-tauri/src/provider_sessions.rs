use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionInfo {
    pub id: String,
    pub provider: String,
    pub project_path: String,
    pub updated_at: Option<u64>,
}

#[tauri::command]
pub async fn provider_find_recent_session(
    provider: String,
    project_path: String,
    since_ms: Option<u64>,
) -> Result<Option<ProviderSessionInfo>, String> {
    match provider.as_str() {
        "codex" => Ok(find_recent_codex_session(&project_path, since_ms)),
        "claude" => Ok(find_recent_claude_session(&project_path, since_ms)),
        other => Err(format!("Unsupported provider: {other}")),
    }
}

fn find_recent_codex_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return None;
    }

    let mut best: Option<ProviderSessionInfo> = None;
    for file in jsonl_files_recent_first(&root, since_ms) {
        let Some((id, cwd)) = parse_codex_session_meta(&file) else {
            continue;
        };
        if !path_matches(&cwd, project_path) {
            continue;
        }

        let updated_at = file_modified_ms(&file);
        let candidate = ProviderSessionInfo {
            id,
            provider: "codex".to_string(),
            project_path: cwd,
            updated_at,
        };
        if is_newer(&candidate, best.as_ref()) {
            best = Some(candidate);
        }
    }
    best
}

fn find_recent_claude_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    let root = dirs::home_dir()?.join(".claude").join("projects");
    if !root.is_dir() {
        return None;
    }

    let mut best: Option<ProviderSessionInfo> = None;
    for file in jsonl_files_recent_first(&root, since_ms) {
        let Some((id, cwd)) = parse_claude_session_meta(&file) else {
            continue;
        };
        if !path_matches(&cwd, project_path) {
            continue;
        }

        let updated_at = file_modified_ms(&file);
        let candidate = ProviderSessionInfo {
            id,
            provider: "claude".to_string(),
            project_path: cwd,
            updated_at,
        };
        if is_newer(&candidate, best.as_ref()) {
            best = Some(candidate);
        }
    }
    best
}

fn parse_codex_session_meta(path: &Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(24) {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        if value.get("type")?.as_str()? != "session_meta" {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload.get("id")?.as_str()?.to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        return Some((id, cwd));
    }
    None
}

fn parse_claude_session_meta(path: &Path) -> Option<(String, String)> {
    let session_id_from_name = path.file_stem()?.to_str()?.to_string();
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(40) {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        let cwd = value.get("cwd").and_then(|v| v.as_str());
        if let Some(cwd) = cwd {
            let id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or(&session_id_from_name);
            return Some((id.to_string(), cwd.to_string()));
        }
    }
    None
}

fn jsonl_files_recent_first(root: &Path, since_ms: Option<u64>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl_files(root, since_ms, &mut files);
    files.sort_by(|a, b| file_modified_ms(b).cmp(&file_modified_ms(a)));
    files
}

fn collect_jsonl_files(dir: &Path, since_ms: Option<u64>, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, since_ms, out);
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }

        if let Some(since) = since_ms {
            let modified = file_modified_ms(&path).unwrap_or(0);
            // Allow a small clock/flush grace period because CLI session files
            // can be created just before the PTY write callback fires.
            if modified + 120_000 < since {
                continue;
            }
        }

        out.push(path);
    }
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    system_time_ms(modified)
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn is_newer(candidate: &ProviderSessionInfo, current: Option<&ProviderSessionInfo>) -> bool {
    let Some(current) = current else {
        return true;
    };
    candidate.updated_at.unwrap_or(0) > current.updated_at.unwrap_or(0)
}

fn path_matches(candidate: &str, requested: &str) -> bool {
    if candidate == requested {
        return true;
    }

    let candidate_path = Path::new(candidate);
    let requested_path = Path::new(requested);
    if candidate_path.starts_with(requested_path) || requested_path.starts_with(candidate_path) {
        return true;
    }

    candidate_path.file_name().and_then(|v| v.to_str())
        == requested_path.file_name().and_then(|v| v.to_str())
}

