use super::preview::{is_generic_session_title, sanitize_preview};
use super::progress::CatalogProgressReporter;
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionCatalogPhase,
    AgentSessionMetadataLookup, AgentSessionPage, AgentSessionProvider, AgentSessionSummary,
    TitleKind,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::future::Future;
use std::time::Duration;
use tokio::task::JoinSet;

const OPENCODE_LIST_HARD_CAP: usize = 200;
const OPENCODE_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const OPENCODE_LIST_STDOUT_MAX_BYTES: usize = 4 * 1024 * 1024;
const OPENCODE_STDERR_MAX_BYTES: usize = 256 * 1024;
const OPENCODE_EXPORT_STDOUT_MAX_BYTES: usize = 1024 * 1024;
const OPENCODE_EXPORT_CONCURRENCY: usize = 4;

pub(crate) async fn resolve_opencode_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Result<Vec<Option<AgentSessionSummary>>, OpenCodeListError> {
    resolve_opencode_sessions_with(lookups, run_opencode_session_list).await
}

async fn resolve_opencode_sessions_with<F, Fut>(
    lookups: &[AgentSessionMetadataLookup],
    loader: F,
) -> Result<Vec<Option<AgentSessionSummary>>, OpenCodeListError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<Value>, OpenCodeListError>>,
{
    let items = loader().await.map(normalize_opencode_list)?;
    Ok(lookups
        .iter()
        .map(|lookup| {
            let mut matches = items.iter().filter(|item| {
                item.id == lookup.session_id
                    && lookup.project_path.as_deref().map_or(true, |requested| {
                        crate::workspace::same_project_path(&item.project_path, requested)
                    })
            });
            let found = matches.next().cloned();
            if matches.next().is_some() {
                None
            } else {
                found
            }
        })
        .collect())
}

/// Discovery helper for recent-session binding (no lazy export).
pub async fn list_opencode_sessions_for_discovery() -> Vec<AgentSessionSummary> {
    run_opencode_session_list()
        .await
        .map(normalize_opencode_list)
        .unwrap_or_default()
}

pub(crate) async fn list_opencode_session_page_with_progress(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    list_opencode_session_page_impl(cursor, limit, query, reporter).await
}

async fn list_opencode_session_page_impl(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    reporter.report(AgentSessionCatalogPhase::Listing, 0, None)?;
    let listed = run_opencode_session_list_with_progress(reporter).await;
    match listed {
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
            if let Err(error) = enrich_opencode_page(&mut page_items, reporter).await {
                if matches!(error, OpenCodeListError::Cancelled) {
                    return Err("Agent session catalog scan was cancelled".into());
                }
                return Ok(opencode_error_page(error));
            }
            Ok(AgentSessionPage {
                provider: AgentSessionProvider::Opencode,
                availability: AgentSessionAvailability::Available,
                items: page_items,
                next_cursor,
                scanned_at: super::types::now_ms(),
                warning: None,
            })
        }
        Err(OpenCodeListError::Cancelled) => Err("Agent session catalog scan was cancelled".into()),
        Err(error) => Ok(opencode_error_page(error)),
    }
}

fn opencode_error_page(error: OpenCodeListError) -> AgentSessionPage {
    match error {
        OpenCodeListError::MissingCli => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::MissingCli,
            Some("OpenCode CLI was not found".into()),
        ),
        OpenCodeListError::CommandFailed(message) => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some(message),
        ),
        OpenCodeListError::MalformedJson => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some("OpenCode returned malformed session list JSON".into()),
        ),
        OpenCodeListError::TimedOut => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some("OpenCode session command timed out".into()),
        ),
        OpenCodeListError::OutputTooLarge => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some("OpenCode session command exceeded its output limit".into()),
        ),
        OpenCodeListError::Cancelled => empty_page(
            AgentSessionProvider::Opencode,
            AgentSessionAvailability::Error,
            Some("OpenCode session scan was cancelled".into()),
        ),
    }
}

#[derive(Debug)]
pub(crate) enum OpenCodeListError {
    MissingCli,
    Cancelled,
    CommandFailed(String),
    MalformedJson,
    TimedOut,
    OutputTooLarge,
}

async fn run_opencode_session_list() -> Result<Vec<Value>, OpenCodeListError> {
    run_opencode_session_list_impl(None).await
}

async fn run_opencode_session_list_with_progress(
    reporter: &CatalogProgressReporter,
) -> Result<Vec<Value>, OpenCodeListError> {
    run_opencode_session_list_impl(Some(reporter)).await
}

async fn run_opencode_session_list_impl(
    reporter: Option<&CatalogProgressReporter>,
) -> Result<Vec<Value>, OpenCodeListError> {
    let hard_cap = OPENCODE_LIST_HARD_CAP.to_string();
    let args = [
        "session",
        "list",
        "--format",
        "json",
        "--max-count",
        &hard_cap,
        "--pure",
    ];
    let limits = super::process::BackgroundCommandLimits {
        timeout: OPENCODE_LIST_TIMEOUT,
        stdout_bytes: OPENCODE_LIST_STDOUT_MAX_BYTES,
        stderr_bytes: OPENCODE_STDERR_MAX_BYTES,
    };
    let output = if let Some(reporter) = reporter {
        super::process::run_background_cli_with_progress(
            "opencode",
            &args,
            limits,
            reporter,
            AgentSessionCatalogPhase::Listing,
            0,
            None,
        )
        .await
    } else {
        super::process::run_background_cli("opencode", &args, limits).await
    }
    .map_err(map_process_error)?;

    if !output.status.success() {
        return Err(OpenCodeListError::CommandFailed(
            "OpenCode session list failed".into(),
        ));
    }

    parse_opencode_list_json(&output.stdout).map_err(|_| OpenCodeListError::MalformedJson)
}

fn map_process_error(error: super::process::BackgroundCommandError) -> OpenCodeListError {
    match error {
        super::process::BackgroundCommandError::MissingCli => OpenCodeListError::MissingCli,
        super::process::BackgroundCommandError::Cancelled => OpenCodeListError::Cancelled,
        super::process::BackgroundCommandError::TimedOut => OpenCodeListError::TimedOut,
        super::process::BackgroundCommandError::OutputTooLarge(_) => {
            OpenCodeListError::OutputTooLarge
        }
        super::process::BackgroundCommandError::Io(_)
        | super::process::BackgroundCommandError::ReaderFailed => {
            OpenCodeListError::CommandFailed("OpenCode process failed".into())
        }
    }
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

    let title_kind = if native_title
        .as_deref()
        .is_some_and(|title| !is_generic_session_title(title))
    {
        TitleKind::Generated
    } else if preview.is_some() {
        TitleKind::FirstPrompt
    } else {
        TitleKind::Unknown
    };
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

async fn export_opencode_preview_result(
    session_id: &str,
    reporter: &CatalogProgressReporter,
    completed: usize,
    total: Option<usize>,
) -> Result<Option<String>, OpenCodeListError> {
    if !super::process::is_safe_session_id(session_id) {
        return Err(OpenCodeListError::CommandFailed(
            "OpenCode returned an invalid session id".into(),
        ));
    }

    let args = ["export", session_id, "--pure"];
    let limits = super::process::BackgroundCommandLimits {
        timeout: OPENCODE_LIST_TIMEOUT,
        stdout_bytes: OPENCODE_EXPORT_STDOUT_MAX_BYTES,
        stderr_bytes: OPENCODE_STDERR_MAX_BYTES,
    };
    let output = super::process::run_background_cli_with_progress(
        "opencode",
        &args,
        limits,
        reporter,
        AgentSessionCatalogPhase::Enriching,
        completed,
        total,
    )
    .await
    .map_err(map_process_error)?;
    if !output.status.success() {
        return Err(OpenCodeListError::CommandFailed(
            "OpenCode session export failed".into(),
        ));
    }
    extract_first_user_preview_from_export_result(&output.stdout).map_err(|_| {
        OpenCodeListError::CommandFailed("OpenCode returned malformed session export JSON".into())
    })
}

async fn enrich_opencode_page(
    items: &mut [AgentSessionSummary],
    reporter: &CatalogProgressReporter,
) -> Result<(), OpenCodeListError> {
    enrich_opencode_page_with(
        items,
        reporter,
        |session_id, reporter, completed, total| async move {
            export_opencode_preview_result(&session_id, &reporter, completed, Some(total)).await
        },
    )
    .await
}

async fn enrich_opencode_page_with<F, Fut>(
    items: &mut [AgentSessionSummary],
    reporter: &CatalogProgressReporter,
    exporter: F,
) -> Result<(), OpenCodeListError>
where
    F: Fn(String, CatalogProgressReporter, usize, usize) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<Option<String>, OpenCodeListError>> + Send + 'static,
{
    let mut jobs = items
        .iter()
        .enumerate()
        .filter(|(_, item)| needs_lazy_export_preview(item))
        .map(|(index, item)| (index, item.id.clone()))
        .collect::<VecDeque<_>>();
    let total = jobs.len();
    reporter
        .report(AgentSessionCatalogPhase::Enriching, 0, Some(total))
        .map_err(|_| OpenCodeListError::Cancelled)?;
    if total == 0 {
        return Ok(());
    }

    let mut tasks = JoinSet::new();
    let mut completed = 0usize;
    let mut first_error = None;
    while tasks.len() < OPENCODE_EXPORT_CONCURRENCY {
        let Some((index, session_id)) = jobs.pop_front() else {
            break;
        };
        let reporter = reporter.clone();
        let exporter = exporter.clone();
        tasks.spawn(async move {
            let preview = exporter(session_id, reporter, completed, total).await?;
            Ok::<_, OpenCodeListError>((index, preview))
        });
    }

    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok((index, Some(preview)))) => {
                items[index].first_user_message_preview = Some(preview);
            }
            Ok(Ok((_index, None))) => {}
            Ok(Err(OpenCodeListError::Cancelled)) => {
                return Err(OpenCodeListError::Cancelled);
            }
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some(OpenCodeListError::CommandFailed(
                        "OpenCode export task failed".into(),
                    ));
                }
            }
        }
        completed = completed.saturating_add(1);
        reporter
            .report(AgentSessionCatalogPhase::Enriching, completed, Some(total))
            .map_err(|_| OpenCodeListError::Cancelled)?;

        if let Some((next_index, session_id)) = jobs.pop_front() {
            let reporter = reporter.clone();
            let exporter = exporter.clone();
            let completed_before_start = completed;
            tasks.spawn(async move {
                let preview = exporter(session_id, reporter, completed_before_start, total).await?;
                Ok::<_, OpenCodeListError>((next_index, preview))
            });
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
pub(crate) fn extract_first_user_preview_from_export(bytes: &[u8]) -> Option<String> {
    extract_first_user_preview_from_export_result(bytes)
        .ok()
        .flatten()
}

fn extract_first_user_preview_from_export_result(bytes: &[u8]) -> Result<Option<String>, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
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
            });
        let Some(text) = text else {
            continue;
        };
        if let Some(preview) = sanitize_preview(&text) {
            return Ok(Some(preview));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn export_required_item(index: usize) -> AgentSessionSummary {
        AgentSessionSummary {
            provider: AgentSessionProvider::Opencode,
            id: format!("session-{index}"),
            project_path: "/repo".into(),
            native_title: Some("New session".into()),
            title_kind: TitleKind::Unknown,
            first_user_message_preview: None,
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: None,
            source_kind: None,
            parent_session_id: None,
            resumable: true,
        }
    }

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
        assert_eq!(items[0].title_kind, TitleKind::Generated);
        assert_eq!(items[0].native_title.as_deref(), Some("Build UI"));
    }

    #[tokio::test]
    async fn batch_exact_lookup_loads_the_cli_catalog_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = AtomicUsize::new(0);
        let lookups = vec![
            AgentSessionMetadataLookup {
                session_id: "one".into(),
                project_path: Some(r"D:\Repo\App".into()),
            },
            AgentSessionMetadataLookup {
                session_id: "two".into(),
                project_path: Some("D:/repo/app".into()),
            },
        ];
        let resolved = resolve_opencode_sessions_with(&lookups, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                Ok(vec![
                    serde_json::json!({
                        "id": "one",
                        "directory": "d:/repo/app",
                        "title": "One"
                    }),
                    serde_json::json!({
                        "id": "two",
                        "directory": r"D:\REPO\APP",
                        "title": "Two"
                    }),
                ])
            }
        })
        .await
        .expect("resolve");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(resolved.len(), 2);
        assert_eq!(
            resolved[0]
                .as_ref()
                .and_then(|item| item.native_title.as_deref()),
            Some("One")
        );
        assert_eq!(
            resolved[1]
                .as_ref()
                .and_then(|item| item.native_title.as_deref()),
            Some("Two")
        );
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
    fn malformed_export_is_not_treated_as_an_empty_first_message() {
        assert!(extract_first_user_preview_from_export_result(b"{broken").is_err());
    }

    #[tokio::test]
    async fn enrichment_attempts_every_row_with_at_most_four_concurrent_exports() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let (_registration, reporter) =
            super::super::progress::test_catalog_scan(801, AgentSessionProvider::Opencode);
        let attempts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let mut items = (0..11).map(export_required_item).collect::<Vec<_>>();
        let original_ids = items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();

        enrich_opencode_page_with(&mut items, &reporter, {
            let attempts = attempts.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            move |session_id, _reporter, _completed, _total| {
                let attempts = attempts.clone();
                let active = active.clone();
                let max_active = max_active.clone();
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now_active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(Some(format!("preview-{session_id}")))
                }
            }
        })
        .await
        .expect("enrich");

        assert_eq!(attempts.load(Ordering::SeqCst), items.len());
        assert!(max_active.load(Ordering::SeqCst) <= OPENCODE_EXPORT_CONCURRENCY);
        assert!(max_active.load(Ordering::SeqCst) > 1);
        assert_eq!(
            items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            original_ids
        );
        assert!(items
            .iter()
            .all(|item| item.first_user_message_preview.is_some()));
        assert_eq!(
            reporter.test_last_progress(),
            Some((AgentSessionCatalogPhase::Enriching, 11, Some(11)))
        );
    }

    #[tokio::test]
    async fn enrichment_finishes_all_attempts_before_returning_a_required_lookup_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let (_registration, reporter) =
            super::super::progress::test_catalog_scan(802, AgentSessionProvider::Opencode);
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut items = (0..9).map(export_required_item).collect::<Vec<_>>();
        let result = enrich_opencode_page_with(&mut items, &reporter, {
            let attempts = attempts.clone();
            move |session_id, _reporter, _completed, _total| {
                let attempts = attempts.clone();
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    if session_id == "session-3" {
                        Err(OpenCodeListError::CommandFailed("export failed".into()))
                    } else {
                        Ok(None)
                    }
                }
            }
        })
        .await;

        assert!(matches!(result, Err(OpenCodeListError::CommandFailed(_))));
        assert_eq!(attempts.load(Ordering::SeqCst), items.len());
        assert_eq!(
            reporter.test_last_progress(),
            Some((AgentSessionCatalogPhase::Enriching, 9, Some(9)))
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
