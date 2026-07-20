use super::preview::{is_generic_session_title, sanitize_preview};
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionPage,
    AgentSessionProvider, AgentSessionSummary, TitleKind,
};
use serde_json::Value;
use std::process::Stdio;

const OPENCODE_LIST_HARD_CAP: usize = 200;

pub async fn list_opencode_session_page(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    match run_opencode_session_list().await {
        Ok(raw_items) => {
            let mut items = normalize_opencode_list(raw_items);
            if let Some(q) = query.map(str::trim).filter(|v| !v.is_empty()) {
                let needle = q.to_ascii_lowercase();
                items.retain(|item| {
                    item.id.to_ascii_lowercase().contains(&needle)
                        || item.project_path.to_ascii_lowercase().contains(&needle)
                        || item
                            .native_title
                            .as_ref()
                            .map(|title| title.to_ascii_lowercase().contains(&needle))
                            .unwrap_or(false)
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
            let mut page_items: Vec<AgentSessionSummary> =
                items.into_iter().skip(offset).take(limit).collect();
            // Lazy-export only the current page rows that still lack a useful
            // preview — never export the full catalog during list rendering.
            for item in &mut page_items {
                if needs_lazy_export_preview(item) {
                    if let Some(preview) = export_opencode_preview(&item.id).await {
                        item.first_user_message_preview = Some(preview);
                    }
                }
            }
            AgentSessionPage {
                provider: AgentSessionProvider::Opencode,
                availability: AgentSessionAvailability::Available,
                items: page_items,
                next_cursor,
                scanned_at: super::types::now_ms(),
                warning: None,
            }
        }
        Err(OpenCodeListError::MissingCli) => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::MissingCli,
            Some("OpenCode CLI was not found".into()),
        ),
        Err(OpenCodeListError::CommandFailed(message)) => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some(message),
        ),
        Err(OpenCodeListError::MalformedJson) => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some("OpenCode returned malformed session list JSON".into()),
        ),
    }
}

#[derive(Debug)]
enum OpenCodeListError {
    MissingCli,
    CommandFailed(String),
    MalformedJson,
}

async fn run_opencode_session_list() -> Result<Vec<Value>, OpenCodeListError> {
    let mut command = super::process::background_cli_command("opencode");
    let hard_cap = OPENCODE_LIST_HARD_CAP.to_string();
    command
        .args([
            "session",
            "list",
            "--format",
            "json",
            "--max-count",
            &hard_cap,
            "--pure",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = match command.output().await {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(OpenCodeListError::MissingCli);
        }
        Err(err) => {
            return Err(OpenCodeListError::CommandFailed(format!(
                "Failed to start OpenCode: {}",
                err.kind()
            )));
        }
    };

    if !output.status.success() {
        return Err(OpenCodeListError::CommandFailed(
            "OpenCode session list failed".into(),
        ));
    }

    parse_opencode_list_json(&output.stdout).map_err(|_| OpenCodeListError::MalformedJson)
}

pub(crate) fn parse_opencode_list_json(bytes: &[u8]) -> Result<Vec<Value>, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    if let Some(array) = value.as_array() {
        return Ok(array.clone());
    }
    if let Some(array) = value.get("sessions").and_then(Value::as_array) {
        return Ok(array.clone());
    }
    if let Some(array) = value.get("data").and_then(Value::as_array) {
        return Ok(array.clone());
    }
    Err(())
}

pub(crate) fn normalize_opencode_list(raw_items: Vec<Value>) -> Vec<AgentSessionSummary> {
    let mut items = Vec::new();
    for raw in raw_items {
        if let Some(summary) = normalize_opencode_row(&raw) {
            items.push(summary);
        }
    }
    items
}

pub(crate) fn normalize_opencode_row(raw: &Value) -> Option<AgentSessionSummary> {
    let id = raw
        .get("id")
        .or_else(|| raw.get("sessionID"))
        .or_else(|| raw.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())?
        .to_string();

    if raw.get("parentID").and_then(Value::as_str).is_some()
        || raw.get("parentId").and_then(Value::as_str).is_some()
        || raw.get("parent_id").and_then(Value::as_str).is_some()
    {
        return None;
    }

    let project_path = raw
        .get("directory")
        .or_else(|| raw.get("path"))
        .or_else(|| raw.get("cwd"))
        .or_else(|| raw.get("projectPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("")
        .to_string();
    if project_path.is_empty() {
        return None;
    }

    let native_title = raw
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    let preview = raw
        .get("preview")
        .or_else(|| raw.get("summary"))
        .and_then(Value::as_str)
        .and_then(sanitize_preview);

    let updated_at = read_timestamp_ms(raw.get("time").and_then(|v| v.get("updated")))
        .or_else(|| read_timestamp_ms(raw.get("updatedAt")))
        .or_else(|| read_timestamp_ms(raw.get("time_updated")));
    let created_at = read_timestamp_ms(raw.get("time").and_then(|v| v.get("created")))
        .or_else(|| read_timestamp_ms(raw.get("createdAt")))
        .or_else(|| read_timestamp_ms(raw.get("time_created")));

    let title_kind = TitleKind::Unknown;
    let first_user_message_preview = preview;

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Opencode,
        id,
        project_path,
        native_title,
        title_kind,
        first_user_message_preview,
        created_at,
        updated_at,
        message_count: raw
            .get("messageCount")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        git_branch: raw
            .get("branch")
            .or_else(|| raw.get("gitBranch"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        source_kind: Some("cli-list".into()),
        parent_session_id: None,
        resumable: true,
    })
}

fn needs_lazy_export_preview(item: &AgentSessionSummary) -> bool {
    if item
        .first_user_message_preview
        .as_ref()
        .map(|preview| !preview.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    match item
        .native_title
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        None => true,
        Some(title) => is_generic_session_title(title),
    }
}

pub async fn export_opencode_preview(session_id: &str) -> Option<String> {
    if !super::process::is_safe_session_id(session_id) {
        return None;
    }

    let mut command = super::process::background_cli_command("opencode");
    command
        .args(["export", session_id, "--pure"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = command.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    extract_first_user_preview_from_export(&output.stdout)
}

pub(crate) fn extract_first_user_preview_from_export(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for message in messages {
        let role = message
            .get("role")
            .or_else(|| message.get("info").and_then(|info| info.get("role")))
            .and_then(Value::as_str)
            .unwrap_or("");
        if role != "user" {
            continue;
        }
        let text = message
            .get("parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| {
                        if part.get("type").and_then(Value::as_str) == Some("text") {
                            part.get("text").and_then(Value::as_str)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .or_else(|| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })?;
        if let Some(preview) = sanitize_preview(&text) {
            return Some(preview);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_user_visible_rows_and_skips_children() {
        let raw = serde_json::json!([
            {
                "id": "parent-1",
                "title": "Build UI",
                "directory": "/repo/app",
                "time": { "created": 1_700_000_000_000u64, "updated": 1_700_000_100_000u64 }
            },
            {
                "id": "child-1",
                "parentID": "parent-1",
                "title": "subagent",
                "directory": "/repo/app"
            }
        ]);
        let items = normalize_opencode_list(raw.as_array().unwrap().clone());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "parent-1");
        assert_eq!(items[0].title_kind, TitleKind::Unknown);
        assert_eq!(items[0].native_title.as_deref(), Some("Build UI"));
    }

    #[test]
    fn parses_list_json_shapes() {
        let nested = br#"{"sessions":[{"id":"a","directory":"/repo","title":"A"}]}"#;
        let rows = parse_opencode_list_json(nested).expect("parse");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn export_preview_reads_first_user_text_only() {
        let export = br#"{
          "messages": [
            {"role":"assistant","parts":[{"type":"text","text":"hi"}]},
            {"role":"user","parts":[{"type":"text","text":"  Please   ship  this  "}]}
          ]
        }"#;
        assert_eq!(
            extract_first_user_preview_from_export(export).as_deref(),
            Some("Please ship this")
        );
    }

    #[test]
    fn lazy_export_only_when_title_or_preview_is_insufficient() {
        let with_preview = AgentSessionSummary {
            provider: AgentSessionProvider::Opencode,
            id: "a".into(),
            project_path: "/repo".into(),
            native_title: None,
            title_kind: TitleKind::Unknown,
            first_user_message_preview: Some("hello".into()),
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: None,
            source_kind: None,
            parent_session_id: None,
            resumable: true,
        };
        assert!(!needs_lazy_export_preview(&with_preview));

        let meaningful_title = AgentSessionSummary {
            native_title: Some("Ship the panel".into()),
            first_user_message_preview: None,
            ..with_preview.clone()
        };
        assert!(!needs_lazy_export_preview(&meaningful_title));

        let generic_title = AgentSessionSummary {
            native_title: Some("New session".into()),
            first_user_message_preview: None,
            ..with_preview.clone()
        };
        assert!(needs_lazy_export_preview(&generic_title));

        let missing_title = AgentSessionSummary {
            native_title: None,
            first_user_message_preview: None,
            ..with_preview
        };
        assert!(needs_lazy_export_preview(&missing_title));
    }
}
