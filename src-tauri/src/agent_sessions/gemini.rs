use super::preview::{is_meaningful_user_text, sanitize_preview};
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionPage,
    AgentSessionProvider, AgentSessionSummary, TitleKind,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn list_gemini_session_page(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    match ensure_gemini_cli_available().await {
        Ok(false) => {
            return empty_page(
                AgentSessionProvider::Gemini,
                AgentSessionAvailability::MissingCli,
                Some("Gemini CLI was not found".into()),
            );
        }
        Err(_) => {
            return empty_page(
                AgentSessionProvider::Gemini,
                AgentSessionAvailability::Error,
                Some("Failed to probe Gemini CLI".into()),
            );
        }
        Ok(true) => {}
    }

    let Some(root) = gemini_tmp_root() else {
        return empty_page(
            AgentSessionProvider::Gemini,
            AgentSessionAvailability::Unavailable,
            Some("Gemini history directory is unavailable".into()),
        );
    };
    if !root.is_dir() {
        return empty_page(
            AgentSessionProvider::Gemini,
            AgentSessionAvailability::Unavailable,
            Some("Gemini history was not found".into()),
        );
    }

    let mut items = list_gemini_sessions_from_root(&root);
    if let Some(q) = query.map(str::trim).filter(|v| !v.is_empty()) {
        let needle = q.to_ascii_lowercase();
        items.retain(|item| {
            item.id.to_ascii_lowercase().contains(&needle)
                || item.project_path.to_ascii_lowercase().contains(&needle)
                || item
                    .first_user_message_preview
                    .as_ref()
                    .map(|preview| preview.to_ascii_lowercase().contains(&needle))
                    .unwrap_or(false)
        });
    }
    items.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(0)
            .cmp(&a.updated_at.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });

    let offset = cursor
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let end = offset.saturating_add(limit);
    let next_cursor = if end < items.len() {
        Some(end.to_string())
    } else {
        None
    };
    let page_items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();

    AgentSessionPage {
        provider: AgentSessionProvider::Gemini,
        availability: AgentSessionAvailability::Available,
        items: page_items,
        next_cursor,
        scanned_at: super::types::now_ms(),
        warning: None,
    }
}

async fn ensure_gemini_cli_available() -> Result<bool, std::io::Error> {
    let mut command = super::process::background_cli_command("gemini");
    command
        .args(["--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match command.status().await {
        Ok(status) => Ok(status.success()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

fn gemini_tmp_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".gemini").join("tmp"))
}

pub(crate) fn list_gemini_sessions_from_root(root: &Path) -> Vec<AgentSessionSummary> {
    let mut items = Vec::new();
    let Ok(projects) = fs::read_dir(root) else {
        return items;
    };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let chats_dir = project_path.join("chats");
        if !chats_dir.is_dir() {
            continue;
        }
        let Some(project_cwd) = read_project_cwd(&project_path) else {
            continue;
        };
        let Ok(chats) = fs::read_dir(&chats_dir) else {
            continue;
        };
        for chat in chats.flatten() {
            let path = chat.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Some(summary) = parse_gemini_chat_file(&path, &project_cwd) {
                items.push(summary);
            }
        }
    }
    items
}

fn read_project_cwd(project_dir: &Path) -> Option<String> {
    for name in [".project_root", "cwd.txt"] {
        let path = project_dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(path).ok()?;
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    for name in ["project.json", "metadata.json"] {
        let path = project_dir.join(name);
        if !path.is_file() {
            continue;
        }
        let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        if let Some(cwd) = value
            .get("cwd")
            .or_else(|| value.get("path"))
            .or_else(|| value.get("projectPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(cwd.to_string());
        }
    }
    None
}

pub(crate) fn parse_gemini_chat_file(
    path: &Path,
    project_cwd: &str,
) -> Option<AgentSessionSummary> {
    let content = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    if value
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| !kind.eq_ignore_ascii_case("main"))
    {
        return None;
    }
    if project_cwd.trim().is_empty() {
        return None;
    }
    let id = value
        .get("sessionId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(ToOwned::to_owned)
        })?;

    let messages = value
        .get("messages")
        .or_else(|| value.get("history"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut first_user_preview = None;
    let mut message_count = 0u32;
    for message in &messages {
        let role = message
            .get("role")
            .or_else(|| message.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if role.eq_ignore_ascii_case("user") || role.eq_ignore_ascii_case("human") {
            message_count = message_count.saturating_add(1);
            if first_user_preview.is_none() {
                if let Some(text) = message.get("content").and_then(content_text).or_else(|| {
                    message
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                }) {
                    if is_meaningful_user_text(&text) {
                        first_user_preview = sanitize_preview(&text);
                    }
                }
            }
        }
    }

    let updated_at = read_timestamp_ms(value.get("updatedAt"))
        .or_else(|| read_timestamp_ms(value.get("lastUpdated")))
        .or_else(|| {
            fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(system_time_ms)
        });
    let created_at = read_timestamp_ms(value.get("createdAt"))
        .or_else(|| read_timestamp_ms(value.get("startTime")));

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Gemini,
        id,
        project_path: project_cwd.to_string(),
        native_title: None,
        title_kind: if first_user_preview.is_some() {
            TitleKind::FirstPrompt
        } else {
            TitleKind::Unknown
        },
        first_user_message_preview: first_user_preview,
        created_at,
        updated_at,
        message_count: if message_count > 0 {
            Some(message_count)
        } else {
            None
        },
        git_branch: None,
        source_kind: Some("project-chat".into()),
        parent_session_id: None,
        resumable: true,
    })
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let parts = value.as_array()?;
    let mut out = Vec::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            out.push(text);
        } else if let Some(text) = part.as_str() {
            out.push(text);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("\n"))
    }
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadterm-gemini-catalog-{label}-{}-{id}",
            std::process::id()
        ))
    }

    #[test]
    fn parses_project_scoped_chat_fixture() {
        let root = temp_root("fixture");
        let project = root.join("abc123");
        let chats = project.join("chats");
        fs::create_dir_all(&chats).expect("mkdir");
        fs::write(project.join(".project_root"), "/repo/gemini-app\n").expect("cwd");
        fs::write(
            chats.join("session-1.json"),
            r#"{
              "sessionId": "gem-1",
              "kind": "main",
              "startTime": "2023-11-14T22:13:20.000Z",
              "lastUpdated": "2023-11-14T22:13:40.000Z",
              "messages": [
                {"type":"system","content":"boot"},
                {"type":"user","content":[{"text":"  Summarize the release notes  "}]},
                {"type":"gemini","content":"ok"}
              ]
            }"#,
        )
        .expect("chat");

        let items = list_gemini_sessions_from_root(&root);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "gem-1");
        assert_eq!(items[0].project_path, "/repo/gemini-app");
        assert_eq!(
            items[0].first_user_message_preview.as_deref(),
            Some("Summarize the release notes")
        );
        assert_eq!(items[0].message_count, Some(1));
        assert_eq!(items[0].created_at, Some(1_700_000_000_000));
        assert_eq!(items[0].updated_at, Some(1_700_000_020_000));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_subagent_chats_and_projects_without_a_resume_cwd() {
        let root = temp_root("resumable");
        let missing_cwd_chats = root.join("missing-cwd").join("chats");
        fs::create_dir_all(&missing_cwd_chats).expect("mkdir");
        fs::write(
            missing_cwd_chats.join("main.json"),
            r#"{"sessionId":"main","kind":"main","messages":[]}"#,
        )
        .expect("main");

        let project = root.join("with-cwd");
        let chats = project.join("chats");
        fs::create_dir_all(&chats).expect("mkdir");
        fs::write(project.join(".project_root"), "/repo/gemini-app\n").expect("cwd");
        fs::write(
            chats.join("subagent.json"),
            r#"{"sessionId":"sub","kind":"subagent","messages":[]}"#,
        )
        .expect("subagent");

        assert!(list_gemini_sessions_from_root(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_fixture_is_skipped() {
        let root = temp_root("bad");
        let chats = root.join("proj").join("chats");
        fs::create_dir_all(&chats).expect("mkdir");
        fs::write(chats.join("broken.json"), "{not-json").expect("write");
        assert!(list_gemini_sessions_from_root(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
