use crate::projects::encode_project_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionMessage {
    pub uuid: String,
    pub role: String,
    pub content: serde_json::Value,
    pub timestamp: Option<String>,
    pub is_sidechain: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub project_path: String,
    pub provider: String,
    pub name: Option<String>,
    pub message_count: usize,
    pub last_message: Option<String>,
    pub created_at: Option<String>,
}

fn claude_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

#[tauri::command]
pub async fn session_list(
    project_path: String,
    provider: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<SessionSummary>, String> {
    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);

    if provider != "claude" {
        return Ok(vec![]);
    }

    let base = match claude_sessions_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    let encoded = encode_project_path(&project_path);
    let sessions_dir = base.join(&encoded);

    if !sessions_dir.exists() {
        if !base.exists() {
            return Ok(vec![]);
        }
        let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
        let mut all = vec![];
        for entry in entries.flatten() {
            let subdir = entry.path();
            if subdir.is_dir() {
                let result =
                    list_sessions_in_dir(&subdir, &project_path, &provider, limit + offset);
                all.extend(result);
            }
        }
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let end = std::cmp::min(offset + limit, all.len());
        let start = std::cmp::min(offset, all.len());
        return Ok(all[start..end].to_vec());
    }

    let mut sessions =
        list_sessions_in_dir(&sessions_dir, &project_path, &provider, limit + offset);
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let end = std::cmp::min(offset + limit, sessions.len());
    let start = std::cmp::min(offset, sessions.len());
    Ok(sessions[start..end].to_vec())
}

fn list_sessions_in_dir(
    dir: &std::path::Path,
    project_path: &str,
    provider: &str,
    limit: usize,
) -> Vec<SessionSummary> {
    let mut result = vec![];
    let Ok(entries) = std::fs::read_dir(dir) else {
        return result;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if let Ok(content) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = content.lines().collect();
            let message_count = lines.len();
            let last_message = lines.last().and_then(|l| {
                serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| {
                    v["message"]["content"]
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|c| c["text"].as_str().map(|s| s.chars().take(100).collect()))
                })
            });
            let created_at = lines.first().and_then(|l| {
                serde_json::from_str::<serde_json::Value>(l)
                    .ok()
                    .and_then(|v| v["timestamp"].as_str().map(String::from))
            });

            result.push(SessionSummary {
                session_id,
                project_path: project_path.to_string(),
                provider: provider.to_string(),
                name: None,
                message_count,
                last_message,
                created_at,
            });
        }

        if result.len() >= limit {
            break;
        }
    }
    result
}

#[tauri::command]
pub async fn session_messages(
    project_path: String,
    session_id: String,
    limit: Option<usize>,
    offset: Option<usize>,
    provider: Option<String>,
) -> Result<Vec<SessionMessage>, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    let provider = provider.unwrap_or_else(|| "claude".to_string());

    if provider != "claude" {
        return Ok(vec![]);
    }

    let base = match claude_sessions_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    let encoded = encode_project_path(&project_path);
    let session_file = base
        .join(&encoded)
        .join(format!("{session_id}.jsonl"));

    if !session_file.exists() {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                let candidate = entry.path().join(format!("{session_id}.jsonl"));
                if candidate.exists() {
                    return read_session_file(&candidate, limit, offset);
                }
            }
        }
        return Ok(vec![]);
    }

    read_session_file(&session_file, limit, offset)
}

fn read_session_file(
    path: &std::path::Path,
    limit: usize,
    offset: usize,
) -> Result<Vec<SessionMessage>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let messages: Vec<SessionMessage> = content
        .lines()
        .filter_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            let role = v["type"].as_str()?.to_string();
            if role == "summary" {
                return None;
            }
            let content = v["message"].clone();
            let uuid = v["uuid"].as_str().unwrap_or("").to_string();
            let timestamp = v["timestamp"].as_str().map(String::from);
            let is_sidechain = v["isSidechain"].as_bool();
            Some(SessionMessage {
                uuid,
                role,
                content,
                timestamp,
                is_sidechain,
            })
        })
        .collect();

    let total = messages.len();
    let start = std::cmp::min(offset, total);
    let end = std::cmp::min(start + limit, total);
    Ok(messages[start..end].to_vec())
}
