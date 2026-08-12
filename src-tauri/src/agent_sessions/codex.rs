use super::preview::{is_generic_session_title, sanitize_preview};
use super::progress::CatalogProgressReporter;
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionCatalogPhase,
    AgentSessionMetadataLookup, AgentSessionPage, AgentSessionProvider, AgentSessionSummary,
    TitleKind,
};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const INTERACTIVE_SOURCE_KINDS: &[&str] = &["cli", "vscode", "appServer"];
const CODEX_STATE_DATABASE_CANDIDATE_CAP: usize = 32;
const CODEX_TITLE_QUERY_CHARS: usize = 512;
const CODEX_PROMPT_QUERY_CHARS: usize = 1024;

pub(crate) fn resolve_codex_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Result<Vec<Option<AgentSessionSummary>>, String> {
    let Some(home) = codex_home_dir() else {
        return Ok(vec![None; lookups.len()]);
    };
    resolve_codex_sessions_from_home(&home, lookups)
}

fn resolve_codex_sessions_from_home(
    home: &Path,
    lookups: &[AgentSessionMetadataLookup],
) -> Result<Vec<Option<AgentSessionSummary>>, String> {
    let Some(database) = find_codex_state_database(home)? else {
        return Ok(vec![None; lookups.len()]);
    };
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Codex state metadata is unavailable".to_string())?;
    let columns = codex_thread_columns(&connection)?;
    if !columns.contains("id") || !columns.contains("cwd") {
        return Err("Codex state metadata schema is unsupported".into());
    }

    let ids = lookups
        .iter()
        .map(|lookup| lookup.session_id.as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let text_column = |name: &str, max_chars: usize| {
        if columns.contains(name) {
            format!("substr({name}, 1, {max_chars})")
        } else {
            "NULL".to_string()
        }
    };
    let scalar_column = |name: &str| {
        if columns.contains(name) {
            name.to_string()
        } else {
            "NULL".to_string()
        }
    };
    let sql = format!(
        "SELECT id, {}, {}, {}, {}, {}, {}, {}, {}, {} FROM threads WHERE id IN ({placeholders})",
        text_column("cwd", 4096),
        text_column("name", CODEX_TITLE_QUERY_CHARS),
        text_column("title", CODEX_TITLE_QUERY_CHARS),
        text_column("first_user_message", CODEX_PROMPT_QUERY_CHARS),
        text_column("preview", CODEX_PROMPT_QUERY_CHARS),
        text_column("git_branch", CODEX_TITLE_QUERY_CHARS),
        text_column("source", 256),
        scalar_column("created_at"),
        scalar_column("updated_at"),
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|_| "Codex state metadata query could not be prepared".to_string())?;
    let rows = statement
        .query_map(params_from_iter(ids), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        })
        .map_err(|_| "Codex state metadata query failed".to_string())?;

    let mut by_id = HashMap::new();
    for row in rows {
        let (id, cwd, name, title, first_message, preview, branch, source, created, updated) =
            row.map_err(|_| "Codex state metadata row was invalid".to_string())?;
        if cwd.trim().is_empty() || !is_interactive_state_source(source.as_deref()) {
            continue;
        }
        let explicit_title = name
            .as_deref()
            .and_then(sanitize_preview)
            .filter(|value| !is_generic_session_title(value));
        let generated_title = title
            .as_deref()
            .and_then(sanitize_preview)
            .filter(|value| !is_generic_session_title(value));
        let first_user_message_preview = first_message
            .as_deref()
            .and_then(sanitize_preview)
            .or_else(|| preview.as_deref().and_then(sanitize_preview));
        let (native_title, title_kind) = if explicit_title.is_some() {
            (explicit_title, TitleKind::Explicit)
        } else if generated_title.is_some() {
            (generated_title, TitleKind::Generated)
        } else if first_user_message_preview.is_some() {
            (None, TitleKind::FirstPrompt)
        } else {
            (None, TitleKind::Unknown)
        };
        by_id.insert(
            id.clone(),
            AgentSessionSummary {
                provider: AgentSessionProvider::Codex,
                id,
                project_path: cwd,
                native_title,
                title_kind,
                first_user_message_preview,
                created_at: sqlite_timestamp_ms(created),
                updated_at: sqlite_timestamp_ms(updated),
                message_count: None,
                git_branch: branch.and_then(|value| sanitize_preview(&value)),
                source_kind: source,
                parent_session_id: None,
                resumable: true,
            },
        );
    }

    Ok(lookups
        .iter()
        .map(|lookup| {
            by_id.get(&lookup.session_id).and_then(|summary| {
                lookup.project_path.as_deref().map_or_else(
                    || Some(summary.clone()),
                    |requested| {
                        crate::workspace::same_project_path(&summary.project_path, requested)
                            .then(|| summary.clone())
                    },
                )
            })
        })
        .collect())
}

fn codex_home_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

fn find_codex_state_database(home: &Path) -> Result<Option<PathBuf>, String> {
    let Ok(entries) = fs::read_dir(home) else {
        return Ok(None);
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(version) = name
            .strip_prefix("state_")
            .and_then(|value| value.strip_suffix(".sqlite"))
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if path.is_file() {
            candidates.push((version, path));
            if candidates.len() > CODEX_STATE_DATABASE_CANDIDATE_CAP {
                return Err("Codex state metadata has too many database candidates".into());
            }
        }
    }
    candidates.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    Ok(candidates.into_iter().next().map(|(_, path)| path))
}

fn codex_thread_columns(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(threads)")
        .map_err(|_| "Codex state metadata schema could not be read".to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "Codex state metadata schema query failed".to_string())?;
    let mut columns = HashSet::new();
    for name in rows.take(128) {
        columns.insert(name.map_err(|_| "Codex state metadata schema was invalid".to_string())?);
    }
    Ok(columns)
}

fn is_interactive_state_source(source: Option<&str>) -> bool {
    let Some(source) = source.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let lower = source.to_ascii_lowercase();
    !lower.contains("subagent") && !lower.contains("ephemeral") && !lower.contains("internal")
}

fn sqlite_timestamp_ms(value: Option<i64>) -> Option<u64> {
    let value = u64::try_from(value?).ok()?;
    Some(if value < 1_000_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    })
}

pub(crate) async fn list_codex_session_page_with_progress(
    app: &AppHandle,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    let params = thread_list_params(cursor, limit, query);
    let response = crate::codex_app::list_threads_raw_with_progress(app, params, reporter).await;
    if reporter.is_cancelled() {
        return Err("Agent session catalog scan was cancelled".into());
    }
    if let Ok(value) = &response {
        let total = value
            .get("data")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        reporter.report(AgentSessionCatalogPhase::Scanning, total, Some(total))?;
    }
    Ok(map_codex_list_result(response, query))
}

fn map_codex_list_result(response: Result<Value, String>, query: Option<&str>) -> AgentSessionPage {
    match response {
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
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_home(label: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadterm-codex-state-{label}-{}-{id}",
            std::process::id()
        ))
    }

    #[test]
    fn exact_state_database_lookup_returns_bounded_authoritative_titles() {
        let home = temp_home("exact");
        fs::create_dir_all(&home).expect("mkdir");
        let database = home.join("state_5.sqlite");
        let connection = Connection::open(&database).expect("open fixture database");
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    cwd TEXT NOT NULL,
                    name TEXT,
                    title TEXT,
                    first_user_message TEXT,
                    preview TEXT,
                    git_branch TEXT,
                    source TEXT,
                    created_at INTEGER,
                    updated_at INTEGER
                );",
            )
            .expect("schema");
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    "thread-explicit",
                    r"\\?\D:\Repo\App",
                    "Native rename",
                    "Generated title",
                    "first prompt",
                    "main",
                    "cli",
                    1_700_000_000i64,
                    1_700_000_001_000i64,
                ],
            )
            .expect("insert explicit");
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, ?5, NULL, NULL)",
                rusqlite::params![
                    "thread-prompt",
                    "/Users/demo/App",
                    "New session",
                    "x".repeat(10_000),
                    "vscode",
                ],
            )
            .expect("insert prompt");
        connection
            .execute(
                "INSERT INTO threads VALUES ('child', '/Users/demo/App', 'Child', NULL, NULL, NULL, NULL, 'subagent', NULL, NULL)",
                [],
            )
            .expect("insert child");
        drop(connection);

        let lookups = vec![
            AgentSessionMetadataLookup {
                session_id: "thread-explicit".into(),
                project_path: Some("d:/repo/app".into()),
            },
            AgentSessionMetadataLookup {
                session_id: "thread-prompt".into(),
                project_path: Some("/Users/demo/App".into()),
            },
            AgentSessionMetadataLookup {
                session_id: "child".into(),
                project_path: Some("/Users/demo/App".into()),
            },
            AgentSessionMetadataLookup {
                session_id: "thread-explicit".into(),
                project_path: Some("D:/repo/app/child".into()),
            },
        ];
        let resolved = resolve_codex_sessions_from_home(&home, &lookups).expect("resolve");

        assert_eq!(
            resolved[0]
                .as_ref()
                .and_then(|item| item.native_title.as_deref()),
            Some("Native rename")
        );
        assert_eq!(
            resolved[0].as_ref().map(|item| item.title_kind),
            Some(TitleKind::Explicit)
        );
        assert_eq!(
            resolved[1]
                .as_ref()
                .and_then(|item| item.first_user_message_preview.as_ref())
                .map(|preview| preview.chars().count()),
            Some(super::super::types::MAX_PREVIEW_CHARS)
        );
        assert_eq!(
            resolved[1].as_ref().map(|item| item.title_kind),
            Some(TitleKind::FirstPrompt)
        );
        assert!(resolved[2].is_none());
        assert!(resolved[3].is_none());

        let _ = fs::remove_dir_all(home);
    }

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
