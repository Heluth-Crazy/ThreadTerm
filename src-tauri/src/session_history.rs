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

fn codex_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

fn parse_codex_sessions_from_dir(base: &PathBuf, project_path: &str) -> Vec<SessionSummary> {
    let mut sessions = Vec::new();
    let Ok(year_entries) = std::fs::read_dir(base) else { return sessions; };
    for year_entry in year_entries.flatten() {
        let year_path = year_entry.path();
        if !year_path.is_dir() { continue; }
        let Ok(month_entries) = std::fs::read_dir(&year_path) else { continue; };
        for month_entry in month_entries.flatten() {
            let month_path = month_entry.path();
            if !month_path.is_dir() { continue; }
            let Ok(day_entries) = std::fs::read_dir(&month_path) else { continue; };
            for day_entry in day_entries.flatten() {
                let day_path = day_entry.path();
                if !day_path.is_dir() { continue; }
                let Ok(file_entries) = std::fs::read_dir(&day_path) else { continue; };
                for file_entry in file_entries.flatten() {
                    let file_path = file_entry.path();
                    if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                    if let Some(summary) = parse_codex_session_file(&file_path, project_path) {
                        sessions.push(summary);
                    }
                }
            }
        }
    }
    sessions
}

fn parse_codex_session_file(file_path: &PathBuf, filter_project: &str) -> Option<SessionSummary> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let mut session_id = None;
    let mut session_cwd = None;
    let mut created_at = None;
    let mut message_count = 0usize;
    let mut last_message = None;

    for line in content.lines() {
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        let line_type = obj["type"].as_str().unwrap_or("");
        let payload = &obj["payload"];

        match line_type {
            "session_meta" => {
                session_id = payload["id"].as_str().map(String::from);
                session_cwd = payload["cwd"].as_str().map(String::from);
                created_at = payload["timestamp"].as_str().map(String::from);
            }
            "event_msg" => {
                let pt = payload["type"].as_str().unwrap_or("");
                if pt == "user_message" || pt == "agent_message" {
                    message_count += 1;
                    last_message = payload["message"].as_str().map(String::from);
                }
            }
            _ => {}
        }
    }

    let session_id = session_id?;
    if !filter_project.is_empty() {
        if let Some(ref cwd) = session_cwd {
            if !cwd.contains(filter_project) && !filter_project.contains(cwd.as_str()) {
                let cwd_base = std::path::Path::new(cwd).file_name()
                    .and_then(|n| n.to_str()).unwrap_or("");
                let filter_base = std::path::Path::new(filter_project).file_name()
                    .and_then(|n| n.to_str()).unwrap_or("");
                if cwd_base != filter_base {
                    return None;
                }
            }
        }
    }

    Some(SessionSummary {
        session_id,
        project_path: session_cwd.unwrap_or_default(),
        provider: "codex".to_string(),
        name: None,
        message_count,
        last_message,
        created_at,
    })
}

fn parse_codex_session_messages(file_path: &PathBuf, limit: usize, offset: usize) -> Vec<SessionMessage> {
    let content = match std::fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut messages = Vec::new();

    for line in content.lines() {
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        if obj["type"].as_str() != Some("event_msg") { continue; }
        let payload = &obj["payload"];
        let pt = payload["type"].as_str().unwrap_or("");

        let (role, text) = match pt {
            "user_message" => {
                let msg = payload["message"].as_str().unwrap_or("");
                if msg.is_empty() { continue; }
                ("user", msg.to_string())
            }
            "agent_message" => {
                let msg = payload["message"].as_str().unwrap_or("");
                if msg.is_empty() { continue; }
                ("assistant", msg.to_string())
            }
            _ => continue,
        };

        let timestamp = obj["timestamp"].as_str().map(String::from);
        messages.push(SessionMessage {
            uuid: String::new(),
            role: role.to_string(),
            content: serde_json::Value::String(text),
            timestamp,
            is_sidechain: None,
        });
    }

    messages.into_iter().skip(offset).take(limit).collect()
}

fn find_codex_session_files(base: &PathBuf) -> Vec<(PathBuf, String)> {
    let mut result = Vec::new();
    let Ok(year_entries) = std::fs::read_dir(base) else { return result; };
    for year_entry in year_entries.flatten() {
        let year_path = year_entry.path();
        if !year_path.is_dir() { continue; }
        let Ok(month_entries) = std::fs::read_dir(&year_path) else { continue; };
        for month_entry in month_entries.flatten() {
            let month_path = month_entry.path();
            if !month_path.is_dir() { continue; }
            let Ok(day_entries) = std::fs::read_dir(&month_path) else { continue; };
            for day_entry in day_entries.flatten() {
                let day_path = day_entry.path();
                if !day_path.is_dir() { continue; }
                let Ok(file_entries) = std::fs::read_dir(&day_path) else { continue; };
                for file_entry in file_entries.flatten() {
                    let fp = file_entry.path();
                    if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                    if let Ok(content) = std::fs::read_to_string(&fp) {
                        for line in content.lines().take(3) {
                            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
                                if obj["type"].as_str() == Some("session_meta") {
                                    if let Some(id) = obj["payload"]["id"].as_str() {
                                        result.push((fp.clone(), id.to_string()));
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    result
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

    if provider == "codex" {
        let base = match codex_sessions_dir() {
            Some(d) => d,
            None => return Ok(vec![]),
        };
        if !base.exists() {
            return Ok(vec![]);
        }
        let mut all = parse_codex_sessions_from_dir(&base, &project_path);
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let total = all.len();
        let end = (offset + limit).min(total);
        return Ok(if offset < total { all[offset..end].to_vec() } else { vec![] });
    }

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

    if provider == "codex" {
        let base = match codex_sessions_dir() {
            Some(d) => d,
            None => return Ok(vec![]),
        };
        if !base.exists() {
            return Ok(vec![]);
        }
        let all_sessions_with_paths = find_codex_session_files(&base);
        for (file_path, sid) in &all_sessions_with_paths {
            if sid == &session_id {
                return Ok(parse_codex_session_messages(file_path, limit, offset));
            }
        }
        return Ok(vec![]);
    }

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


