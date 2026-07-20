use super::preview::{is_generic_session_title, sanitize_preview};
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionPage,
    AgentSessionProvider, AgentSessionSummary, TitleKind,
};
use serde_json::{json, Value};
use tauri::AppHandle;

const INTERACTIVE_SOURCE_KINDS: &[&str] = &["cli", "vscode", "appServer"];

pub async fn list_codex_session_page(
    app: &AppHandle,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    let params = thread_list_params(cursor, limit, query);
    match crate::codex_app::list_threads_raw(app, params).await {
        Ok(response) => {
            let (items, next_cursor) = map_thread_list_response(&response, query);
            AgentSessionPage {
                provider: AgentSessionProvider::Codex,
                availability: AgentSessionAvailability::Available,
                items,
                next_cursor,
                scanned_at: super::types::now_ms(),
                warning: None,
            }
        }
        Err(err) => {
            let lower = err.to_ascii_lowercase();
            let availability = if lower.contains("not found") || lower.contains("no such file") {
                AgentSessionAvailability::MissingCli
            } else {
                AgentSessionAvailability::Error
            };
            empty_page(
                AgentSessionProvider::Codex,
                availability,
                Some("Codex session catalog is temporarily unavailable".into()),
            )
        }
    }
}

pub(crate) fn map_thread_list_response(
    response: &Value,
    query: Option<&str>,
) -> (Vec<AgentSessionSummary>, Option<String>) {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_cursor = response
        .get("cursor")
        .or_else(|| response.get("nextCursor"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    let mut items = Vec::new();
    for thread in data {
        if let Some(summary) = map_codex_thread(&thread) {
            if matches_query(&summary, query) {
                items.push(summary);
            }
        }
    }
    (items, next_cursor)
}

pub(crate) fn map_codex_thread(thread: &Value) -> Option<AgentSessionSummary> {
    let id = thread
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())?
        .to_string();

    let source_kind = thread
        .get("source")
        .or_else(|| thread.get("sourceKind"))
        .or_else(|| thread.get("threadSource"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    if let Some(source) = source_kind.as_deref() {
        let lower = source.to_ascii_lowercase();
        if lower.contains("subagent")
            || lower.contains("ephemeral")
            || lower.contains("internal")
            || lower == "parent"
        {
            return None;
        }
        if !matches!(lower.as_str(), "cli" | "vscode" | "appserver" | "user") {
            return None;
        }
    }

    if thread.get("ephemeral").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if thread
        .get("parentThreadId")
        .and_then(Value::as_str)
        .is_some()
        || thread.get("parentId").and_then(Value::as_str).is_some()
    {
        return None;
    }

    let project_path = thread
        .get("cwd")
        .or_else(|| thread.get("projectPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("")
        .to_string();
    if project_path.is_empty() {
        return None;
    }

    let native_title = thread
        .get("name")
        .or_else(|| thread.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    let preview = thread
        .get("preview")
        .and_then(Value::as_str)
        .and_then(sanitize_preview);

    let title_kind = if native_title
        .as_ref()
        .is_some_and(|title| !is_generic_session_title(title))
    {
        TitleKind::Explicit
    } else if preview.is_some() {
        TitleKind::FirstPrompt
    } else if native_title.is_some() {
        TitleKind::Generated
    } else {
        TitleKind::Unknown
    };

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Codex,
        id,
        project_path,
        native_title,
        title_kind,
        first_user_message_preview: preview,
        created_at: read_timestamp_ms(thread.get("createdAt")),
        updated_at: read_timestamp_ms(thread.get("updatedAt")),
        message_count: thread
            .get("messageCount")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        git_branch: thread
            .get("gitBranch")
            .or_else(|| thread.get("branch"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        source_kind,
        parent_session_id: None,
        resumable: true,
    })
}

pub(crate) fn thread_list_params(cursor: Option<&str>, limit: usize, query: Option<&str>) -> Value {
    let mut params = json!({
        "limit": limit,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "useStateDbOnly": true,
        "sourceKinds": INTERACTIVE_SOURCE_KINDS,
    });
    if let Some(cursor) = cursor.map(str::trim).filter(|v| !v.is_empty()) {
        params["cursor"] = json!(cursor);
    }
    if let Some(query) = query.map(str::trim).filter(|v| !v.is_empty()) {
        params["searchTerm"] = json!(query);
    }
    params
}

fn matches_query(summary: &AgentSessionSummary, query: Option<&str>) -> bool {
    let Some(q) = query.map(str::trim).filter(|v| !v.is_empty()) else {
        return true;
    };
    let needle = q.to_ascii_lowercase();
    summary.id.to_ascii_lowercase().contains(&needle)
        || summary.project_path.to_ascii_lowercase().contains(&needle)
        || summary
            .native_title
            .as_ref()
            .map(|title| title.to_ascii_lowercase().contains(&needle))
            .unwrap_or(false)
        || summary
            .first_user_message_preview
            .as_ref()
            .map(|preview| preview.to_ascii_lowercase().contains(&needle))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_interactive_threads_and_excludes_internal() {
        let interactive = json!({
            "id": "thread-1",
            "name": "Auth fix",
            "preview": "Please patch the login race",
            "cwd": "/repo/app",
            "createdAt": 1_700_000_000u64,
            "updatedAt": 1_700_000_001u64,
            "sourceKind": "cli"
        });
        let summary = map_codex_thread(&interactive).expect("interactive");
        assert_eq!(summary.native_title.as_deref(), Some("Auth fix"));
        assert_eq!(summary.title_kind, TitleKind::Explicit);
        assert_eq!(summary.created_at, Some(1_700_000_000_000));
        assert_eq!(summary.updated_at, Some(1_700_000_001_000));

        let subagent = json!({
            "id": "thread-2",
            "cwd": "/repo/app",
            "sourceKind": "subagent"
        });
        assert!(map_codex_thread(&subagent).is_none());

        let ephemeral = json!({
            "id": "thread-3",
            "cwd": "/repo/app",
            "ephemeral": true,
            "sourceKind": "cli"
        });
        assert!(map_codex_thread(&ephemeral).is_none());

        let invalid_source = json!({
            "id": "thread-4",
            "cwd": "/repo/app",
            "sourceKind": "interaction"
        });
        assert!(map_codex_thread(&invalid_source).is_none());
    }

    #[test]
    fn map_thread_list_response_preserves_cursor() {
        let response = json!({
            "data": [{
                "id": "thread-1",
                "name": "One",
                "cwd": "/repo",
                "sourceKind": "cli",
                "updatedAt": 5
            }],
            "nextCursor": "cursor-2"
        });
        let (items, cursor) = map_thread_list_response(&response, None);
        assert_eq!(items.len(), 1);
        assert_eq!(cursor.as_deref(), Some("cursor-2"));
    }

    #[test]
    fn thread_list_params_match_app_server_contract() {
        let params = thread_list_params(Some("next"), 40, Some(" login "));
        assert_eq!(
            params.get("sourceKinds"),
            Some(&json!(["cli", "vscode", "appServer"]))
        );
        assert_eq!(params.get("searchTerm"), Some(&json!("login")));
        assert!(params.get("query").is_none());
        assert_eq!(params.get("cursor"), Some(&json!("next")));
    }
}
