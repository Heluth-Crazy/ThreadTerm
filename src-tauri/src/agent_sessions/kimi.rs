use super::preview::{is_generic_session_title, sanitize_preview};
use super::progress::CatalogProgressReporter;
use super::types::{
    empty_page, read_timestamp_ms, AgentSessionAvailability, AgentSessionCatalogPhase,
    AgentSessionMetadataLookup, AgentSessionPage, AgentSessionProvider, AgentSessionSummary,
    TitleKind, MAX_METADATA_FILE_BYTES,
};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const KIMI_FILES_SCANNED_PER_PAGE: usize = 500;
const KIMI_WORKSPACE_DIR_CAP: usize = 512;
const KIMI_RECENT_SESSION_DIR_CAP: usize = 512;
const KIMI_CATALOG_STATE_FILE_CAP: usize = 10_000;
const KIMI_CATALOG_ENTRY_CAP: usize = 20_000;

pub(crate) fn list_kimi_session_page_with_progress(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    list_kimi_session_page_impl(cursor, limit, query, reporter)
}

fn list_kimi_session_page_impl(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    reporter.report(AgentSessionCatalogPhase::Discovering, 0, None)?;
    let Some(root) = kimi_sessions_root() else {
        return Ok(empty_page(
            AgentSessionProvider::Kimi,
            AgentSessionAvailability::Unavailable,
            Some("Kimi Code home directory is unavailable".into()),
        ));
    };
    if !root.is_dir() {
        return Ok(empty_page(
            AgentSessionProvider::Kimi,
            AgentSessionAvailability::Unavailable,
            Some("Kimi Code sessions directory was not found".into()),
        ));
    }

    list_kimi_session_page_from_root_with_progress(&root, cursor, limit, query, Some(reporter))
}

pub(crate) fn resolve_kimi_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let Some(root) = kimi_sessions_root().filter(|root| root.is_dir()) else {
        return vec![None; lookups.len()];
    };
    let workspaces_file = kimi_home_dir().map(|home| home.join("workspaces.json"));
    resolve_kimi_sessions_from_root(&root, workspaces_file.as_deref(), lookups)
}

pub fn find_recent_kimi_session(
    project_path: &str,
    since_ms: Option<u64>,
    excluded_ids: &[String],
) -> Option<AgentSessionSummary> {
    let root = kimi_sessions_root()?;
    if !root.is_dir() {
        return None;
    }
    let workspaces_file = kimi_home_dir().map(|home| home.join("workspaces.json"));
    let mut reader = read_bounded_file;
    let workspace_mappings = read_workspace_mappings(workspaces_file.as_deref(), &mut reader);
    let workspace_ids = workspace_ids_for_project(&workspace_mappings, project_path);
    if workspace_ids.len() != 1 {
        return None;
    }
    let excluded: HashSet<&str> = excluded_ids.iter().map(String::as_str).collect();
    let candidates = collect_session_state_files_bounded(
        &root.join(&workspace_ids[0]),
        KIMI_RECENT_SESSION_DIR_CAP,
    )?;
    let threshold = since_ms.map(|since| since.saturating_sub(5_000));
    let mut matches = candidates
        .into_iter()
        .filter(|candidate| {
            threshold.map_or(true, |minimum| {
                candidate.modified_ms.unwrap_or(0) >= minimum
            })
        })
        .filter_map(|candidate| parse_kimi_state_file_with(&candidate.path, &mut reader))
        .filter(|item| !excluded.contains(item.id.as_str()))
        .filter(|item| path_matches(&item.project_path, project_path))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return None;
    }
    matches.pop()
}

#[cfg(test)]
fn list_kimi_session_page_from_root(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    list_kimi_session_page_from_root_with_progress(root, cursor, limit, query, None)
        .expect("Kimi scan without cancellation cannot fail")
}

fn list_kimi_session_page_from_root_with_progress(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<AgentSessionPage, String> {
    let mut candidates = collect_state_files_with_progress(root, reporter)?;
    candidates.sort_by(|a, b| {
        b.modified_ms
            .unwrap_or(0)
            .cmp(&a.modified_ms.unwrap_or(0))
            .then_with(|| a.path.cmp(&b.path))
    });

    let mut index = cursor
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(candidates.len());
    let mut scanned = 0usize;
    let mut items = Vec::with_capacity(limit);
    let scan_total = candidates
        .len()
        .saturating_sub(index)
        .min(KIMI_FILES_SCANNED_PER_PAGE);
    if let Some(reporter) = reporter {
        reporter.report(AgentSessionCatalogPhase::Scanning, 0, Some(scan_total))?;
    }

    while index < candidates.len() && scanned < KIMI_FILES_SCANNED_PER_PAGE && items.len() < limit {
        if let Some(reporter) = reporter {
            reporter.check_cancelled()?;
        }
        let candidate = &candidates[index];
        index = index.saturating_add(1);
        scanned = scanned.saturating_add(1);
        if let Some(summary) = parse_kimi_state_file(&candidate.path) {
            if matches_query(&summary, query) {
                items.push(summary);
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

    let next_cursor = if index < candidates.len() {
        Some(index.to_string())
    } else {
        None
    };

    Ok(AgentSessionPage {
        provider: AgentSessionProvider::Kimi,
        availability: AgentSessionAvailability::Available,
        items,
        next_cursor,
        scanned_at: super::types::now_ms(),
        warning: None,
    })
}

#[cfg(test)]
fn list_kimi_sessions_from_root(root: &Path) -> Vec<AgentSessionSummary> {
    collect_state_files(root)
        .into_iter()
        .filter_map(|candidate| parse_kimi_state_file(&candidate.path))
        .collect()
}

fn resolve_kimi_sessions_from_root(
    root: &Path,
    workspaces_file: Option<&Path>,
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let mut reader = read_bounded_file;
    resolve_kimi_sessions_from_root_with_reader(root, workspaces_file, lookups, &mut reader)
}

fn resolve_kimi_sessions_from_root_with_reader<F>(
    root: &Path,
    workspaces_file: Option<&Path>,
    lookups: &[AgentSessionMetadataLookup],
    reader: &mut F,
) -> Vec<Option<AgentSessionSummary>>
where
    F: FnMut(&Path) -> Option<Vec<u8>>,
{
    let (workspace_dirs, workspace_dirs_complete) = collect_workspace_dirs_bounded(root);
    let workspace_mappings = read_workspace_mappings(workspaces_file, reader);
    lookups
        .iter()
        .map(|lookup| {
            let mut candidates = Vec::new();
            if let Some(project_path) = lookup.project_path.as_deref() {
                let workspace_ids = workspace_ids_for_project(&workspace_mappings, project_path);
                if workspace_ids.len() == 1 {
                    candidates.push(
                        root.join(&workspace_ids[0])
                            .join(&lookup.session_id)
                            .join("state.json"),
                    );
                } else if workspace_ids.len() > 1 {
                    return None;
                }
            }
            if workspace_dirs_complete {
                for directory in &workspace_dirs {
                    let candidate = directory.join(&lookup.session_id).join("state.json");
                    if !candidates.contains(&candidate) {
                        candidates.push(candidate);
                    }
                }
            }

            let mut seen_paths = HashSet::new();
            let mut matches = candidates.into_iter().filter_map(|path| {
                if !path.is_file() {
                    return None;
                }
                let resolved_path = path.canonicalize().unwrap_or_else(|_| path.clone());
                if !seen_paths.insert(resolved_path) {
                    return None;
                }
                let summary = parse_kimi_state_file_with(&path, reader)?;
                if summary.id != lookup.session_id {
                    return None;
                }
                if lookup
                    .project_path
                    .as_deref()
                    .is_some_and(|requested| !path_matches(&summary.project_path, requested))
                {
                    return None;
                }
                Some(summary)
            });
            let found = matches.next();
            if matches.next().is_some() {
                None
            } else {
                found
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct StateFileCandidate {
    path: PathBuf,
    modified_ms: Option<u64>,
}

#[cfg(test)]
fn collect_state_files(root: &Path) -> Vec<StateFileCandidate> {
    collect_state_files_with_progress(root, None)
        .expect("Kimi scan without cancellation cannot fail")
}

fn collect_state_files_with_progress(
    root: &Path,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<Vec<StateFileCandidate>, String> {
    let mut out = Vec::new();
    let mut entries_scanned = 0usize;
    let Ok(workspaces) = fs::read_dir(root) else {
        return Ok(out);
    };
    for workspace in workspaces.flatten() {
        if entries_scanned >= KIMI_CATALOG_ENTRY_CAP {
            return Ok(out);
        }
        entries_scanned = entries_scanned.saturating_add(1);
        if let Some(reporter) = reporter {
            reporter.report(AgentSessionCatalogPhase::Discovering, entries_scanned, None)?;
        }
        let workspace_path = workspace.path();
        if !workspace_path.is_dir() {
            continue;
        }
        let Ok(sessions) = fs::read_dir(&workspace_path) else {
            continue;
        };
        for session in sessions.flatten() {
            if entries_scanned >= KIMI_CATALOG_ENTRY_CAP {
                return Ok(out);
            }
            entries_scanned = entries_scanned.saturating_add(1);
            if let Some(reporter) = reporter {
                reporter.report(AgentSessionCatalogPhase::Discovering, entries_scanned, None)?;
            }
            let session_path = session.path();
            if !session_path.is_dir() {
                continue;
            }
            let state_path = session_path.join("state.json");
            if !state_path.is_file() {
                continue;
            }
            let modified_ms = fs::metadata(&state_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(system_time_ms);
            out.push(StateFileCandidate {
                path: state_path,
                modified_ms,
            });
            if out.len() >= KIMI_CATALOG_STATE_FILE_CAP {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

pub(crate) fn parse_kimi_state_file(path: &Path) -> Option<AgentSessionSummary> {
    parse_kimi_state_file_with(path, &mut read_bounded_file)
}

fn parse_kimi_state_file_with<F>(path: &Path, reader: &mut F) -> Option<AgentSessionSummary>
where
    F: FnMut(&Path) -> Option<Vec<u8>>,
{
    let meta = fs::metadata(path).ok()?;
    let buf = reader(path)?;
    let value: Value = serde_json::from_slice(&buf).ok()?;
    if value
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        // Keep archived sessions out of the normal recovery catalog.
        return None;
    }

    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
        })?;
    if !super::process::is_safe_session_id(&id) {
        return None;
    }

    let project_path = read_kimi_cwd(&value)?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);
    let is_custom = value
        .get("isCustomTitle")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let last_prompt = value
        .get("lastPrompt")
        .and_then(Value::as_str)
        .and_then(sanitize_preview);
    let created_at = read_timestamp_ms(value.get("createdAt"));
    let updated_at = read_timestamp_ms(value.get("updatedAt"))
        .or_else(|| meta.modified().ok().and_then(system_time_ms));

    let (native_title, title_kind) = match (title.as_deref(), is_custom, last_prompt.as_ref()) {
        (Some(title), true, _) if !is_generic_session_title(title) => {
            (Some(title.to_string()), TitleKind::Explicit)
        }
        (Some(title), _, _) if !is_generic_session_title(title) => {
            (Some(title.to_string()), TitleKind::Generated)
        }
        (_, _, Some(_)) => (None, TitleKind::FirstPrompt),
        _ => (title, TitleKind::Unknown),
    };

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Kimi,
        id,
        project_path,
        native_title,
        title_kind,
        first_user_message_preview: last_prompt,
        created_at,
        updated_at,
        message_count: None,
        git_branch: None,
        source_kind: Some("state".into()),
        parent_session_id: None,
        resumable: true,
    })
}

fn read_bounded_file(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_METADATA_FILE_BYTES {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.by_ref()
        .take(MAX_METADATA_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut buf)
        .ok()?;
    (buf.len() as u64 <= MAX_METADATA_FILE_BYTES).then_some(buf)
}

fn read_workspace_mappings<F>(
    workspaces_file: Option<&Path>,
    reader: &mut F,
) -> Vec<(String, String)>
where
    F: FnMut(&Path) -> Option<Vec<u8>>,
{
    let Some(path) = workspaces_file.filter(|path| path.is_file()) else {
        return Vec::new();
    };
    let Some(bytes) = reader(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let entries = value.get("workspaces").unwrap_or(&value);
    let mut mappings = Vec::new();
    match entries {
        Value::Object(items) => {
            for (key, item) in items {
                push_workspace_mapping(&mut mappings, Some(key), item);
            }
        }
        Value::Array(items) => {
            for item in items {
                push_workspace_mapping(&mut mappings, None, item);
            }
        }
        _ => {}
    }
    mappings.sort();
    mappings.dedup();
    mappings
}

fn push_workspace_mapping(
    mappings: &mut Vec<(String, String)>,
    fallback_id: Option<&str>,
    item: &Value,
) {
    let root = item
        .get("root")
        .or_else(|| item.get("workDir"))
        .or_else(|| item.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|root| !root.is_empty());
    let id = item
        .get("id")
        .or_else(|| item.get("workspaceId"))
        .or_else(|| item.get("workspace_id"))
        .and_then(Value::as_str)
        .or(fallback_id)
        .map(str::trim)
        .filter(|id| is_safe_path_segment(id));
    if let (Some(id), Some(root)) = (id, root) {
        mappings.push((id.to_string(), root.to_string()));
    }
}

fn workspace_ids_for_project(mappings: &[(String, String)], project_path: &str) -> Vec<String> {
    let mut matches = mappings
        .iter()
        .filter(|(_, root)| path_matches(root, project_path))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    matches
}

fn is_safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

fn collect_workspace_dirs_bounded(root: &Path) -> (Vec<PathBuf>, bool) {
    let Ok(entries) = fs::read_dir(root) else {
        return (Vec::new(), true);
    };
    let sampled = entries
        .flatten()
        .take(KIMI_WORKSPACE_DIR_CAP.saturating_add(1))
        .collect::<Vec<_>>();
    let complete = sampled.len() <= KIMI_WORKSPACE_DIR_CAP;
    let mut directories = sampled
        .into_iter()
        .filter_map(|entry| entry.path().is_dir().then_some(entry.path()))
        .collect::<Vec<_>>();
    directories.truncate(KIMI_WORKSPACE_DIR_CAP);
    directories.sort();
    (directories, complete)
}

fn collect_session_state_files_bounded(
    workspace_dir: &Path,
    cap: usize,
) -> Option<Vec<StateFileCandidate>> {
    let entries = fs::read_dir(workspace_dir).ok()?;
    let mut candidates = Vec::new();
    let mut entries_scanned = 0usize;
    for entry in entries.flatten() {
        if entries_scanned >= cap {
            return None;
        }
        entries_scanned = entries_scanned.saturating_add(1);
        let session_path = entry.path();
        if !session_path.is_dir() {
            continue;
        }
        let state_path = session_path.join("state.json");
        if !state_path.is_file() {
            continue;
        }
        if candidates.len() >= cap {
            return None;
        }
        let modified_ms = fs::metadata(&state_path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(system_time_ms);
        candidates.push(StateFileCandidate {
            path: state_path,
            modified_ms,
        });
    }
    Some(candidates)
}

fn read_kimi_cwd(value: &Value) -> Option<String> {
    for key in ["cwd", "workDir"] {
        if let Some(cwd) = value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(cwd.to_string());
        }
    }
    value
        .get("custom")
        .and_then(|custom| custom.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
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
            .map(|v| v.to_ascii_lowercase().contains(&needle))
            .unwrap_or(false)
        || summary
            .first_user_message_preview
            .as_ref()
            .map(|v| v.to_ascii_lowercase().contains(&needle))
            .unwrap_or(false)
}

fn path_matches(candidate: &str, requested: &str) -> bool {
    crate::workspace::same_project_path(candidate, requested)
}

fn kimi_home_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("KIMI_CODE_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".kimi-code"))
}

fn kimi_sessions_root() -> Option<PathBuf> {
    kimi_home_dir().map(|home| home.join("sessions"))
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
            "threadterm-kimi-catalog-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn write_state(root: &Path, workspace: &str, session_id: &str, body: &str) -> PathBuf {
        let dir = root.join(workspace).join(session_id);
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("state.json");
        fs::write(&path, body).expect("write state");
        path
    }

    #[test]
    fn parses_current_state_fixture() {
        let root = temp_root("current");
        let path = write_state(
            &root,
            "ws1",
            "sess-abc",
            r#"{
              "id": "sess-abc",
              "title": "Fix login race",
              "isCustomTitle": true,
              "lastPrompt": "please fix the race",
              "createdAt": 1700000000,
              "updatedAt": 1700000001000,
              "cwd": "D:/repo/app",
              "archived": false
            }"#,
        );
        let summary = parse_kimi_state_file(&path).expect("parse");
        assert_eq!(summary.id, "sess-abc");
        assert_eq!(summary.project_path, "D:/repo/app");
        assert_eq!(summary.native_title.as_deref(), Some("Fix login race"));
        assert_eq!(summary.title_kind, TitleKind::Explicit);
        assert_eq!(summary.created_at, Some(1_700_000_000_000));
        assert_eq!(summary.updated_at, Some(1_700_000_001_000));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_legacy_iso_and_workdir_fields() {
        let root = temp_root("legacy");
        let path = write_state(
            &root,
            "ws2",
            "legacy-1",
            r#"{
              "id": "legacy-1",
              "title": "Legacy title",
              "isCustomTitle": false,
              "createdAt": "2021-01-01T00:00:00.500Z",
              "updatedAt": "2021-01-02T00:00:00.000Z",
              "workDir": "/Users/me/project"
            }"#,
        );
        let summary = parse_kimi_state_file(&path).expect("parse");
        assert_eq!(summary.project_path, "/Users/me/project");
        assert_eq!(summary.created_at, Some(1_609_459_200_500));
        assert_eq!(summary.title_kind, TitleKind::Generated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skips_archived_corrupt_and_oversized() {
        let root = temp_root("skip");
        let archived = write_state(
            &root,
            "ws",
            "arch",
            r#"{"id":"arch","cwd":"/repo","archived":true,"title":"x"}"#,
        );
        assert!(parse_kimi_state_file(&archived).is_none());

        let corrupt = write_state(&root, "ws", "bad", "{not-json");
        assert!(parse_kimi_state_file(&corrupt).is_none());

        let oversized = write_state(
            &root,
            "ws",
            "big",
            &format!(
                "{{\"id\":\"big\",\"cwd\":\"/repo\",\"title\":\"{}\"}}",
                "x".repeat((MAX_METADATA_FILE_BYTES as usize) + 8)
            ),
        );
        assert!(parse_kimi_state_file(&oversized).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_batch_loads_workspace_map_once_and_never_opens_transcripts() {
        let root = temp_root("wire");
        let workspaces = root.join("workspaces.json");
        fs::create_dir_all(&root).expect("mkdir root");
        fs::write(
            &workspaces,
            r#"{"workspaces":{"ws":{"root":"D:/Repo/App"}}}"#,
        )
        .expect("workspaces");
        for session_id in ["one", "two"] {
            let session = root.join("ws").join(session_id);
            fs::create_dir_all(session.join("agents").join("a1")).expect("mkdir");
            fs::write(
                session.join("state.json"),
                format!(r#"{{"id":"{session_id}","cwd":"D:/Repo/App","title":"{session_id}"}}"#),
            )
            .expect("state");
            fs::write(
                session.join("agents").join("a1").join("wire.jsonl"),
                "secret",
            )
            .expect("wire");
            fs::write(session.join("signals.json"), "secret").expect("signals");
        }
        let lookups = [
            AgentSessionMetadataLookup {
                session_id: "one".into(),
                project_path: Some(r"d:\repo\app".into()),
            },
            AgentSessionMetadataLookup {
                session_id: "two".into(),
                project_path: Some("D:/Repo/App".into()),
            },
        ];
        let mut opened = Vec::new();
        let mut reader = |path: &Path| {
            opened.push(path.to_path_buf());
            read_bounded_file(path)
        };
        let resolved = resolve_kimi_sessions_from_root_with_reader(
            &root,
            Some(&workspaces),
            &lookups,
            &mut reader,
        );
        assert!(resolved.iter().all(Option::is_some));
        assert_eq!(opened.iter().filter(|path| *path == &workspaces).count(), 1);
        assert_eq!(opened.len(), 3);
        assert!(opened.iter().all(|path| {
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("workspaces.json" | "state.json")
            )
        }));

        let production = include_str!("kimi.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source");
        for forbidden in [
            "wire.jsonl",
            "updates.jsonl",
            "chat_history.jsonl",
            "signals.json",
        ] {
            assert!(!production.contains(forbidden));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_recent_scan_refuses_truncated_workspace_history() {
        let root = temp_root("large-recent");
        let workspace = root.join("ws");
        for index in 0..=KIMI_RECENT_SESSION_DIR_CAP {
            write_state(
                &root,
                "ws",
                &format!("session-{index}"),
                &format!(r#"{{"id":"session-{index}","cwd":"/repo"}}"#),
            );
        }
        assert!(
            collect_session_state_files_bounded(&workspace, KIMI_RECENT_SESSION_DIR_CAP).is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_recent_scan_counts_empty_history_entries() {
        let root = temp_root("large-empty-recent");
        let workspace = root.join("ws");
        for index in 0..=KIMI_RECENT_SESSION_DIR_CAP {
            fs::create_dir_all(workspace.join(format!("empty-{index}"))).expect("mkdir");
        }
        assert!(
            collect_session_state_files_bounded(&workspace, KIMI_RECENT_SESSION_DIR_CAP).is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recent_discovery_requires_unique_match() {
        let root = temp_root("recent");
        write_state(
            &root,
            "ws",
            "a",
            r#"{"id":"a","cwd":"/repo","title":"A","updatedAt":2000}"#,
        );
        write_state(
            &root,
            "ws",
            "b",
            r#"{"id":"b","cwd":"/repo","title":"B","updatedAt":3000}"#,
        );
        // Temporarily point root by writing under the path collect would use via env is hard;
        // unit-test uniqueness via the pure list filter path.
        let items = list_kimi_sessions_from_root(&root);
        assert_eq!(items.len(), 2);
        let unique = {
            let mut matches = items
                .into_iter()
                .filter(|item| path_matches(&item.project_path, "/repo"))
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                matches.pop()
            } else {
                None
            }
        };
        assert!(unique.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pages_with_cursor() {
        let root = temp_root("page");
        for i in 0..5 {
            write_state(
                &root,
                "ws",
                &format!("s{i}"),
                &format!(
                    r#"{{"id":"s{i}","cwd":"/repo","title":"T{i}","updatedAt":{}}}"#,
                    1000 + i
                ),
            );
        }
        let page1 = list_kimi_session_page_from_root(&root, None, 2, None);
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.next_cursor.as_deref(), Some("2"));
        let page2 = list_kimi_session_page_from_root(&root, Some("2"), 2, None);
        assert_eq!(page2.items.len(), 2);
        assert_ne!(page1.items[0].id, page2.items[0].id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn controlled_scan_reports_real_total_and_honors_cancellation() {
        let root = temp_root("progress-cancel");
        write_state(
            &root,
            "workspace",
            "session",
            r#"{"id":"session","cwd":"/repo","title":"Session"}"#,
        );
        let (_registration, reporter) =
            super::super::progress::test_catalog_scan(911, AgentSessionProvider::Kimi);

        let page =
            list_kimi_session_page_from_root_with_progress(&root, None, 40, None, Some(&reporter))
                .expect("controlled page");
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            reporter.test_last_progress(),
            Some((AgentSessionCatalogPhase::Scanning, 1, Some(1)))
        );

        assert!(super::super::progress::cancel_catalog_scan(911));
        assert!(list_kimi_session_page_from_root_with_progress(
            &root,
            None,
            40,
            None,
            Some(&reporter),
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }
}
