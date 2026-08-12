use super::preview::{is_meaningful_user_text, sanitize_preview};
use super::progress::CatalogProgressReporter;
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionCatalogPhase,
    AgentSessionMetadataLookup, AgentSessionPage, AgentSessionProvider, AgentSessionSummary,
    TitleKind, MAX_METADATA_FILE_BYTES,
};
use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const GEMINI_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const GEMINI_PROBE_OUTPUT_MAX_BYTES: usize = 64 * 1024;
const GEMINI_FILES_SCANNED_PER_PAGE: usize = 500;
const GEMINI_CATALOG_FILE_CAP: usize = 10_000;
const GEMINI_CATALOG_ENTRY_CAP: usize = 20_000;

pub(crate) fn resolve_gemini_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let items = gemini_tmp_root()
        .filter(|root| root.is_dir())
        .map(|root| list_gemini_sessions_from_root(&root))
        .unwrap_or_default();
    lookups
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
        .collect()
}

pub(crate) async fn list_gemini_session_page_with_progress(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    list_gemini_session_page_impl(cursor, limit, query, reporter).await
}

async fn list_gemini_session_page_impl(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    reporter.report(AgentSessionCatalogPhase::Connecting, 0, None)?;
    let probe = ensure_gemini_cli_available_with_progress(reporter).await;
    match probe {
        Ok(false) => {
            return Ok(empty_page(
                AgentSessionProvider::Gemini,
                AgentSessionAvailability::MissingCli,
                Some("Gemini CLI was not found".into()),
            ));
        }
        Err(super::process::BackgroundCommandError::Cancelled) => {
            return Err("Agent session catalog scan was cancelled".into());
        }
        Err(_) => {
            return Ok(empty_page(
                AgentSessionProvider::Gemini,
                AgentSessionAvailability::Error,
                Some("Failed to probe Gemini CLI".into()),
            ));
        }
        Ok(true) => {}
    }

    let Some(root) = gemini_tmp_root() else {
        return Ok(empty_page(
            AgentSessionProvider::Gemini,
            AgentSessionAvailability::Unavailable,
            Some("Gemini history directory is unavailable".into()),
        ));
    };
    if !root.is_dir() {
        return Ok(empty_page(
            AgentSessionProvider::Gemini,
            AgentSessionAvailability::Unavailable,
            Some("Gemini history was not found".into()),
        ));
    }

    let cursor = cursor.map(ToOwned::to_owned);
    let query = query.map(ToOwned::to_owned);
    let reporter = reporter.clone();
    match tokio::task::spawn_blocking(move || {
        list_gemini_session_page_from_root_with_progress(
            &root,
            cursor.as_deref(),
            limit,
            query.as_deref(),
            Some(&reporter),
        )
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Ok(empty_page(
            AgentSessionProvider::Gemini,
            AgentSessionAvailability::Error,
            Some("Gemini history scan failed".into()),
        )),
    }
}

#[derive(Debug, Clone)]
struct GeminiChatCandidate {
    path: PathBuf,
    project_cwd: String,
    modified_ms: Option<u64>,
}

fn list_gemini_session_page_from_root_with_progress(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<AgentSessionPage, String> {
    if let Some(reporter) = reporter {
        reporter.report(AgentSessionCatalogPhase::Discovering, 0, None)?;
    }
    let mut candidates = collect_gemini_chat_candidates(root, reporter)?;
    candidates.sort_by(|a, b| {
        b.modified_ms
            .unwrap_or(0)
            .cmp(&a.modified_ms.unwrap_or(0))
            .then_with(|| a.path.cmp(&b.path))
    });

    list_gemini_candidate_page(
        &candidates,
        cursor,
        limit,
        query,
        reporter,
        &mut |candidate| parse_gemini_chat_file(&candidate.path, &candidate.project_cwd),
    )
}

fn list_gemini_candidate_page<F>(
    candidates: &[GeminiChatCandidate],
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: Option<&CatalogProgressReporter>,
    parser: &mut F,
) -> Result<AgentSessionPage, String>
where
    F: FnMut(&GeminiChatCandidate) -> Option<AgentSessionSummary>,
{
    let mut index = cursor
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(candidates.len());
    let scan_total = candidates
        .len()
        .saturating_sub(index)
        .min(GEMINI_FILES_SCANNED_PER_PAGE);
    if let Some(reporter) = reporter {
        reporter.report(AgentSessionCatalogPhase::Scanning, 0, Some(scan_total))?;
    }
    let mut scanned = 0usize;
    let mut page_items = Vec::with_capacity(limit);
    while index < candidates.len()
        && scanned < GEMINI_FILES_SCANNED_PER_PAGE
        && page_items.len() < limit
    {
        if let Some(reporter) = reporter {
            reporter.check_cancelled()?;
        }
        let candidate = &candidates[index];
        index = index.saturating_add(1);
        scanned = scanned.saturating_add(1);
        if let Some(summary) = parser(candidate) {
            if matches_query(&summary, query) {
                page_items.push(summary);
            }
        }
        if let Some(reporter) = reporter {
            reporter.report(
                AgentSessionCatalogPhase::Scanning,
                scanned,
                Some(scan_total),
            )?;
        }
    }
    if let Some(reporter) = reporter {
        reporter.report_now(
            AgentSessionCatalogPhase::Scanning,
            scanned,
            Some(scan_total),
        )?;
    }
    let next_cursor = (index < candidates.len()).then(|| index.to_string());

    Ok(AgentSessionPage {
        provider: AgentSessionProvider::Gemini,
        availability: AgentSessionAvailability::Available,
        items: page_items,
        next_cursor,
        scanned_at: super::types::now_ms(),
        warning: None,
    })
}

fn collect_gemini_chat_candidates(
    root: &Path,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<Vec<GeminiChatCandidate>, String> {
    let mut candidates = Vec::new();
    let mut entries_scanned = 0usize;
    let Ok(projects) = fs::read_dir(root) else {
        return Ok(candidates);
    };
    for project in projects.flatten() {
        if entries_scanned >= GEMINI_CATALOG_ENTRY_CAP
            || candidates.len() >= GEMINI_CATALOG_FILE_CAP
        {
            break;
        }
        entries_scanned = entries_scanned.saturating_add(1);
        if let Some(reporter) = reporter {
            reporter.report(AgentSessionCatalogPhase::Discovering, entries_scanned, None)?;
        }
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
        let Ok(chats) = fs::read_dir(chats_dir) else {
            continue;
        };
        for chat in chats.flatten() {
            if entries_scanned >= GEMINI_CATALOG_ENTRY_CAP
                || candidates.len() >= GEMINI_CATALOG_FILE_CAP
            {
                break;
            }
            entries_scanned = entries_scanned.saturating_add(1);
            if let Some(reporter) = reporter {
                reporter.report(AgentSessionCatalogPhase::Discovering, entries_scanned, None)?;
            }
            let path = chat.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let modified_ms = chat
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(system_time_ms);
            candidates.push(GeminiChatCandidate {
                path,
                project_cwd: project_cwd.clone(),
                modified_ms,
            });
        }
    }
    Ok(candidates)
}

async fn ensure_gemini_cli_available_with_progress(
    reporter: &CatalogProgressReporter,
) -> Result<bool, super::process::BackgroundCommandError> {
    match super::process::run_background_cli_with_progress(
        "gemini",
        &["--version"],
        super::process::BackgroundCommandLimits {
            timeout: GEMINI_PROBE_TIMEOUT,
            stdout_bytes: GEMINI_PROBE_OUTPUT_MAX_BYTES,
            stderr_bytes: GEMINI_PROBE_OUTPUT_MAX_BYTES,
        },
        reporter,
        AgentSessionCatalogPhase::Connecting,
        0,
        None,
    )
    .await
    {
        Ok(output) => Ok(output.status.success()),
        Err(super::process::BackgroundCommandError::MissingCli) => Ok(false),
        Err(error) => Err(error),
    }
}

fn matches_query(summary: &AgentSessionSummary, query: Option<&str>) -> bool {
    let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let needle = query.to_ascii_lowercase();
    summary.id.to_ascii_lowercase().contains(&needle)
        || summary.project_path.to_ascii_lowercase().contains(&needle)
        || summary
            .native_title
            .as_ref()
            .is_some_and(|title| title.to_ascii_lowercase().contains(&needle))
        || summary
            .first_user_message_preview
            .as_ref()
            .is_some_and(|preview| preview.to_ascii_lowercase().contains(&needle))
}

fn gemini_tmp_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".gemini").join("tmp"))
}

pub fn list_gemini_sessions_for_discovery() -> Vec<AgentSessionSummary> {
    let Some(root) = gemini_tmp_root() else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    list_gemini_sessions_from_root(&root)
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

pub(crate) fn read_project_cwd(project_dir: &Path) -> Option<String> {
    for name in [".project_root", "cwd.txt"] {
        let path = project_dir.join(name);
        if !path.is_file() {
            continue;
        }
        let text = read_bounded_text(&path)?;
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
        let value: Value = serde_json::from_str(&read_bounded_text(&path)?).ok()?;
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
    let value: Value = serde_json::from_slice(&read_bounded_bytes(path)?).ok()?;
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

    let native_title = value
        .get("title")
        .or_else(|| value.get("displayName"))
        .and_then(Value::as_str)
        .and_then(sanitize_preview);

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Gemini,
        id,
        project_path: project_cwd.to_string(),
        native_title: native_title.clone(),
        title_kind: if native_title.is_some() {
            TitleKind::Generated
        } else if first_user_preview.is_some() {
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

fn read_bounded_text(path: &Path) -> Option<String> {
    String::from_utf8(read_bounded_bytes(path)?).ok()
}

fn read_bounded_bytes(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_METADATA_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .ok()?
        .take(MAX_METADATA_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_METADATA_FILE_BYTES).then_some(bytes)
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
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadterm-gemini-catalog-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn candidate(index: usize) -> GeminiChatCandidate {
        GeminiChatCandidate {
            path: PathBuf::from(format!("session-{index}.json")),
            project_cwd: "/repo/gemini-app".into(),
            modified_ms: Some(10_000u64.saturating_sub(index as u64)),
        }
    }

    fn candidate_summary(candidate: &GeminiChatCandidate) -> AgentSessionSummary {
        let id = candidate
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();
        AgentSessionSummary {
            provider: AgentSessionProvider::Gemini,
            id: id.clone(),
            project_path: candidate.project_cwd.clone(),
            native_title: None,
            title_kind: TitleKind::FirstPrompt,
            first_user_message_preview: Some(format!("preview {id}")),
            created_at: None,
            updated_at: candidate.modified_ms,
            message_count: Some(1),
            git_branch: None,
            source_kind: Some("project-chat".into()),
            parent_session_id: None,
            resumable: true,
        }
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

    #[test]
    fn candidate_first_pages_are_disjoint_and_parse_only_rows_needed() {
        let candidates = (0..1_000).map(candidate).collect::<Vec<_>>();
        let (_registration, reporter) =
            super::super::progress::test_catalog_scan(913, AgentSessionProvider::Gemini);
        let mut parsed = 0usize;
        let first = list_gemini_candidate_page(
            &candidates,
            None,
            25,
            None,
            Some(&reporter),
            &mut |candidate| {
                parsed = parsed.saturating_add(1);
                Some(candidate_summary(candidate))
            },
        )
        .expect("first page");
        let second = list_gemini_candidate_page(
            &candidates,
            first.next_cursor.as_deref(),
            25,
            None,
            None,
            &mut |candidate| {
                parsed = parsed.saturating_add(1);
                Some(candidate_summary(candidate))
            },
        )
        .expect("second page");

        assert_eq!(parsed, 50);
        assert_eq!(first.next_cursor.as_deref(), Some("25"));
        assert_eq!(second.next_cursor.as_deref(), Some("50"));
        assert_eq!(
            reporter.test_last_progress(),
            Some((AgentSessionCatalogPhase::Scanning, 25, Some(500)))
        );
        let first_ids = first
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<HashSet<_>>();
        assert!(second
            .items
            .iter()
            .all(|item| !first_ids.contains(&item.id)));
    }

    #[test]
    fn candidate_window_advances_over_malformed_and_filtered_rows() {
        let candidates = (0..600).map(candidate).collect::<Vec<_>>();
        let mut parsed = 0usize;
        let page = list_gemini_candidate_page(
            &candidates,
            None,
            40,
            Some("never-matches"),
            None,
            &mut |candidate| {
                parsed = parsed.saturating_add(1);
                (parsed % 7 != 0).then(|| candidate_summary(candidate))
            },
        )
        .expect("bounded page");

        assert!(page.items.is_empty());
        assert_eq!(parsed, GEMINI_FILES_SCANNED_PER_PAGE);
        assert_eq!(page.next_cursor.as_deref(), Some("500"));
    }
}
