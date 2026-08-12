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

const GROK_FILES_SCANNED_PER_PAGE: usize = 500;
const GROK_PROJECT_DIR_CAP: usize = 512;
const GROK_RECENT_SESSION_DIR_CAP: usize = 512;
const GROK_CATALOG_SUMMARY_FILE_CAP: usize = 10_000;
const GROK_CATALOG_ENTRY_CAP: usize = 20_000;

pub(crate) fn list_grok_session_page_with_progress(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    list_grok_session_page_impl(cursor, limit, query, reporter)
}

fn list_grok_session_page_impl(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: &CatalogProgressReporter,
) -> Result<AgentSessionPage, String> {
    reporter.report(AgentSessionCatalogPhase::Discovering, 0, None)?;
    let Some(root) = grok_sessions_root() else {
        return Ok(empty_page(
            AgentSessionProvider::Grok,
            AgentSessionAvailability::Unavailable,
            Some("Grok Build sessions directory is unavailable".into()),
        ));
    };
    if !root.is_dir() {
        return Ok(empty_page(
            AgentSessionProvider::Grok,
            AgentSessionAvailability::Unavailable,
            Some("Grok Build sessions directory was not found".into()),
        ));
    }

    list_grok_session_page_from_root_with_progress(&root, cursor, limit, query, Some(reporter))
}

pub(crate) fn resolve_grok_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let Some(root) = grok_sessions_root().filter(|root| root.is_dir()) else {
        return vec![None; lookups.len()];
    };
    resolve_grok_sessions_from_root(&root, lookups)
}

pub fn find_recent_grok_session(
    project_path: &str,
    since_ms: Option<u64>,
    excluded_ids: &[String],
) -> Option<AgentSessionSummary> {
    let root = grok_sessions_root()?;
    if !root.is_dir() {
        return None;
    }
    let excluded: HashSet<&str> = excluded_ids.iter().map(String::as_str).collect();
    let project_dirs = grok_project_directory_names(project_path)
        .into_iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    if project_dirs.is_empty() {
        return None;
    }
    let candidates =
        collect_project_summary_files_bounded(&project_dirs, GROK_RECENT_SESSION_DIR_CAP)?;
    let threshold = since_ms.map(|since| since.saturating_sub(5_000));
    let mut reader = read_bounded_file;
    let mut matches = candidates
        .into_iter()
        .filter(|candidate| {
            threshold.map_or(true, |minimum| {
                candidate.modified_ms.unwrap_or(0) >= minimum
            })
        })
        .filter_map(|candidate| parse_grok_summary_file_with(&candidate.path, &mut reader))
        .filter(|item| !excluded.contains(item.id.as_str()))
        .filter(|item| path_matches(&item.project_path, project_path))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return None;
    }
    matches.pop()
}

#[cfg(test)]
fn list_grok_session_page_from_root(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    list_grok_session_page_from_root_with_progress(root, cursor, limit, query, None)
        .expect("Grok scan without cancellation cannot fail")
}

fn list_grok_session_page_from_root_with_progress(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<AgentSessionPage, String> {
    let mut candidates = collect_summary_files_with_progress(root, reporter)?;
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
        .min(GROK_FILES_SCANNED_PER_PAGE);
    if let Some(reporter) = reporter {
        reporter.report(AgentSessionCatalogPhase::Scanning, 0, Some(scan_total))?;
    }

    while index < candidates.len() && scanned < GROK_FILES_SCANNED_PER_PAGE && items.len() < limit {
        if let Some(reporter) = reporter {
            reporter.check_cancelled()?;
        }
        let candidate = &candidates[index];
        index = index.saturating_add(1);
        scanned = scanned.saturating_add(1);
        if let Some(summary) = parse_grok_summary_file(&candidate.path) {
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
        provider: AgentSessionProvider::Grok,
        availability: AgentSessionAvailability::Available,
        items,
        next_cursor,
        scanned_at: super::types::now_ms(),
        warning: None,
    })
}

fn resolve_grok_sessions_from_root(
    root: &Path,
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let mut reader = read_bounded_file;
    resolve_grok_sessions_from_root_with_reader(root, lookups, &mut reader)
}

fn resolve_grok_sessions_from_root_with_reader<F>(
    root: &Path,
    lookups: &[AgentSessionMetadataLookup],
    reader: &mut F,
) -> Vec<Option<AgentSessionSummary>>
where
    F: FnMut(&Path) -> Option<Vec<u8>>,
{
    let (project_dirs, project_dirs_complete) = collect_project_dirs_bounded(root);
    lookups
        .iter()
        .map(|lookup| {
            let mut candidates = Vec::new();
            if let Some(project_path) = lookup.project_path.as_deref() {
                for name in grok_project_directory_names(project_path) {
                    candidates.push(
                        root.join(name)
                            .join(&lookup.session_id)
                            .join("summary.json"),
                    );
                }
            }
            if project_dirs_complete {
                for directory in &project_dirs {
                    let candidate = directory.join(&lookup.session_id).join("summary.json");
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
                let summary = parse_grok_summary_file_with(&path, reader)?;
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
struct SummaryFileCandidate {
    path: PathBuf,
    modified_ms: Option<u64>,
}

fn collect_summary_files_with_progress(
    root: &Path,
    reporter: Option<&CatalogProgressReporter>,
) -> Result<Vec<SummaryFileCandidate>, String> {
    let mut out = Vec::new();
    let mut entries_scanned = 0usize;
    let Ok(cwd_dirs) = fs::read_dir(root) else {
        return Ok(out);
    };
    for cwd_dir in cwd_dirs.flatten() {
        if entries_scanned >= GROK_CATALOG_ENTRY_CAP {
            return Ok(out);
        }
        entries_scanned = entries_scanned.saturating_add(1);
        if let Some(reporter) = reporter {
            reporter.report(AgentSessionCatalogPhase::Discovering, entries_scanned, None)?;
        }
        let cwd_path = cwd_dir.path();
        if !cwd_path.is_dir() {
            continue;
        }
        let Ok(sessions) = fs::read_dir(&cwd_path) else {
            continue;
        };
        for session in sessions.flatten() {
            if entries_scanned >= GROK_CATALOG_ENTRY_CAP {
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
            let summary_path = session_path.join("summary.json");
            if !summary_path.is_file() {
                continue;
            }
            let modified_ms = fs::metadata(&summary_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(system_time_ms);
            out.push(SummaryFileCandidate {
                path: summary_path,
                modified_ms,
            });
            if out.len() >= GROK_CATALOG_SUMMARY_FILE_CAP {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

pub(crate) fn parse_grok_summary_file(path: &Path) -> Option<AgentSessionSummary> {
    parse_grok_summary_file_with(path, &mut read_bounded_file)
}

fn parse_grok_summary_file_with<F>(path: &Path, reader: &mut F) -> Option<AgentSessionSummary>
where
    F: FnMut(&Path) -> Option<Vec<u8>>,
{
    let meta = fs::metadata(path).ok()?;
    let buf = reader(path)?;
    let value: Value = serde_json::from_slice(&buf).ok()?;
    if value
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if let Some(kind) = value.get("session_kind").and_then(Value::as_str) {
        let kind = kind.trim().to_ascii_lowercase();
        if kind == "subagent" || kind == "hidden" {
            return None;
        }
    }
    if value
        .get("parent_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|v| !v.is_empty())
    {
        // Subagent sessions are excluded from the normal recovery catalog.
        return None;
    }

    let info = value.get("info")?;
    let id = info
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

    let project_path = info
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)?;

    let generated_title = value
        .get("generated_title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);
    let title_is_manual = value
        .get("title_is_manual")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_summary = value
        .get("session_summary")
        .and_then(Value::as_str)
        .and_then(sanitize_preview);
    let head_branch = value
        .get("head_branch")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    let created_at = read_timestamp_ms(value.get("created_at"));
    let updated_at = read_timestamp_ms(value.get("last_active_at"))
        .or_else(|| read_timestamp_ms(value.get("updated_at")))
        .or_else(|| meta.modified().ok().and_then(system_time_ms));

    let (native_title, title_kind) = if title_is_manual {
        if let Some(title) = generated_title
            .clone()
            .filter(|title| !is_generic_session_title(title))
        {
            (Some(title), TitleKind::Explicit)
        } else if let Some(summary) = session_summary.clone() {
            (Some(summary), TitleKind::Explicit)
        } else {
            (generated_title, TitleKind::Unknown)
        }
    } else if let Some(title) = generated_title
        .clone()
        .filter(|title| !is_generic_session_title(title))
    {
        (Some(title), TitleKind::Generated)
    } else if let Some(summary) = session_summary.clone() {
        (Some(summary), TitleKind::FirstPrompt)
    } else {
        (None, TitleKind::Unknown)
    };

    Some(AgentSessionSummary {
        provider: AgentSessionProvider::Grok,
        id,
        project_path,
        native_title,
        title_kind,
        first_user_message_preview: session_summary,
        created_at,
        updated_at,
        message_count: None,
        git_branch: head_branch,
        source_kind: Some("summary".into()),
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

fn collect_project_dirs_bounded(root: &Path) -> (Vec<PathBuf>, bool) {
    let Ok(entries) = fs::read_dir(root) else {
        return (Vec::new(), true);
    };
    let sampled = entries
        .flatten()
        .take(GROK_PROJECT_DIR_CAP.saturating_add(1))
        .collect::<Vec<_>>();
    let complete = sampled.len() <= GROK_PROJECT_DIR_CAP;
    let mut directories = sampled
        .into_iter()
        .filter_map(|entry| entry.path().is_dir().then_some(entry.path()))
        .collect::<Vec<_>>();
    directories.truncate(GROK_PROJECT_DIR_CAP);
    directories.sort();
    (directories, complete)
}

fn collect_project_summary_files_bounded(
    project_dirs: &[PathBuf],
    cap: usize,
) -> Option<Vec<SummaryFileCandidate>> {
    let mut candidates = Vec::new();
    let mut entries_scanned = 0usize;
    let mut project_dirs_seen = HashSet::new();
    for project_dir in project_dirs {
        let resolved_project_dir = project_dir
            .canonicalize()
            .unwrap_or_else(|_| project_dir.clone());
        if !project_dirs_seen.insert(resolved_project_dir) {
            continue;
        }
        let entries = fs::read_dir(project_dir).ok()?;
        for entry in entries.flatten() {
            if entries_scanned >= cap {
                return None;
            }
            entries_scanned = entries_scanned.saturating_add(1);
            let session_path = entry.path();
            if !session_path.is_dir() {
                continue;
            }
            let summary_path = session_path.join("summary.json");
            if !summary_path.is_file() {
                continue;
            }
            if candidates.len() >= cap {
                return None;
            }
            let modified_ms = fs::metadata(&summary_path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(system_time_ms);
            candidates.push(SummaryFileCandidate {
                path: summary_path,
                modified_ms,
            });
        }
    }
    Some(candidates)
}

fn grok_project_directory_names(project_path: &str) -> Vec<String> {
    let trimmed = project_path.trim();
    let mut variants = vec![trimmed.to_string()];
    let slash_form = trimmed.replace('\\', "/");
    let slash_form_lower = slash_form.to_ascii_lowercase();
    if slash_form_lower.starts_with("//?/unc/") {
        let rest = &slash_form[8..];
        variants.push(format!("//{rest}"));
    } else if slash_form_lower.starts_with("//?/") {
        variants.push(slash_form[4..].to_string());
    }
    if let Some(normalized) = crate::workspace::normalize_project_identity_path(trimmed) {
        variants.push(normalized);
    }

    let mut separator_variants = Vec::with_capacity(variants.len() * 3);
    for variant in variants {
        separator_variants.push(variant.clone());
        if variant.contains('\\') {
            separator_variants.push(variant.replace('\\', "/"));
        }
        if variant.contains('/') {
            separator_variants.push(variant.replace('/', "\\"));
        }
    }
    let mut names = separator_variants
        .into_iter()
        .map(|variant| percent_encode_path_key(&variant))
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn percent_encode_path_key(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
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

fn grok_sessions_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".grok").join("sessions"))
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
            "threadterm-grok-catalog-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn write_summary(root: &Path, cwd_key: &str, session_id: &str, body: &str) -> PathBuf {
        let dir = root.join(cwd_key).join(session_id);
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("summary.json");
        fs::write(&path, body).expect("write summary");
        path
    }

    #[test]
    fn parses_manual_and_generated_titles() {
        let root = temp_root("titles");
        let manual = write_summary(
            &root,
            "cwd1",
            "11111111-1111-4111-8111-111111111111",
            r#"{
              "info": {"id":"11111111-1111-4111-8111-111111111111","cwd":"D:/repo"},
              "generated_title": "Ship workspace tabs",
              "title_is_manual": true,
              "session_summary": "work on tabs",
              "created_at": 1700000000000,
              "updated_at": 1700000001000,
              "last_active_at": 1700000002000,
              "head_branch": "feat/tabs",
              "hidden": false
            }"#,
        );
        let summary = parse_grok_summary_file(&manual).expect("parse");
        assert_eq!(summary.native_title.as_deref(), Some("Ship workspace tabs"));
        assert_eq!(summary.title_kind, TitleKind::Explicit);
        assert_eq!(summary.git_branch.as_deref(), Some("feat/tabs"));
        assert_eq!(summary.updated_at, Some(1_700_000_002_000));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skips_hidden_subagent_corrupt_and_oversized() {
        let root = temp_root("skip");
        let hidden = write_summary(
            &root,
            "cwd",
            "h1",
            r#"{"info":{"id":"h1","cwd":"/repo"},"hidden":true,"generated_title":"x"}"#,
        );
        assert!(parse_grok_summary_file(&hidden).is_none());

        let subagent = write_summary(
            &root,
            "cwd",
            "s1",
            r#"{"info":{"id":"s1","cwd":"/repo"},"parent_session_id":"root","generated_title":"child"}"#,
        );
        assert!(parse_grok_summary_file(&subagent).is_none());

        let corrupt = write_summary(&root, "cwd", "bad", "{nope");
        assert!(parse_grok_summary_file(&corrupt).is_none());

        let oversized = write_summary(
            &root,
            "cwd",
            "big",
            &format!(
                "{{\"info\":{{\"id\":\"big\",\"cwd\":\"/repo\"}},\"generated_title\":\"{}\"}}",
                "y".repeat((MAX_METADATA_FILE_BYTES as usize) + 8)
            ),
        );
        assert!(parse_grok_summary_file(&oversized).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_batch_never_opens_transcript_files() {
        let root = temp_root("transcript");
        let session = root
            .join(percent_encode_path_key("/repo"))
            .join("22222222-2222-4222-8222-222222222222");
        fs::create_dir_all(&session).expect("mkdir");
        fs::write(
            session.join("summary.json"),
            r#"{
              "info":{"id":"22222222-2222-4222-8222-222222222222","cwd":"/repo"},
              "generated_title":"Safe title",
              "title_is_manual": false
            }"#,
        )
        .expect("summary");
        fs::write(session.join("updates.jsonl"), r#"{"secret":true}"#).expect("updates");
        fs::write(session.join("chat_history.jsonl"), r#"{"msg":"secret"}"#).expect("history");
        fs::write(session.join("signals.json"), r#"{"secret":true}"#).expect("signals");
        let lookups = [AgentSessionMetadataLookup {
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            project_path: Some("/repo".into()),
        }];
        let mut opened = Vec::new();
        let mut reader = |path: &Path| {
            opened.push(path.to_path_buf());
            read_bounded_file(path)
        };
        let resolved = resolve_grok_sessions_from_root_with_reader(&root, &lookups, &mut reader);
        assert_eq!(
            resolved[0]
                .as_ref()
                .and_then(|summary| summary.native_title.as_deref()),
            Some("Safe title")
        );
        assert_eq!(opened.len(), 1);
        assert_eq!(
            opened[0].file_name().and_then(|name| name.to_str()),
            Some("summary.json")
        );

        let production = include_str!("grok.rs")
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
    fn direct_windows_path_lookup_is_exact_across_prefix_and_separators() {
        let root = temp_root("windows-path");
        let session_id = "33333333-3333-4333-8333-333333333333";
        for index in 0..=GROK_PROJECT_DIR_CAP {
            fs::create_dir_all(root.join(format!("unrelated-{index}"))).expect("mkdir");
        }
        write_summary(
            &root,
            &percent_encode_path_key(r"d:\repo\app"),
            session_id,
            &format!(
                r#"{{"info":{{"id":"{session_id}","cwd":"D:/Repo/App"}},"generated_title":"Windows"}}"#
            ),
        );
        let lookups = [
            AgentSessionMetadataLookup {
                session_id: session_id.into(),
                project_path: Some(r"\\?\d:\repo\app".into()),
            },
            AgentSessionMetadataLookup {
                session_id: session_id.into(),
                project_path: Some("D:/Repo/App/child".into()),
            },
        ];
        let resolved = resolve_grok_sessions_from_root(&root, &lookups);
        assert!(resolved[0].is_some());
        assert!(resolved[1].is_none());

        let unc_names = grok_project_directory_names(r"\\?\unc\Server\Share\App");
        assert!(unc_names.contains(&percent_encode_path_key(r"\\Server\Share\App")));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn exact_lookup_deduplicates_windows_case_variant_paths() {
        let root = temp_root("windows-case");
        let session_id = "44444444-4444-4444-8444-444444444444";
        write_summary(
            &root,
            &percent_encode_path_key(r"D:\Repo\App"),
            session_id,
            &format!(
                r#"{{"info":{{"id":"{session_id}","cwd":"D:/Repo/App"}},"generated_title":"Windows case"}}"#
            ),
        );
        let lookup = AgentSessionMetadataLookup {
            session_id: session_id.into(),
            project_path: Some(r"d:\repo\app".into()),
        };

        assert!(resolve_grok_sessions_from_root(&root, &[lookup])[0].is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn recent_scan_deduplicates_windows_case_variant_project_dirs() {
        let root = temp_root("windows-recent-case");
        let session_id = "55555555-5555-4555-8555-555555555555";
        write_summary(
            &root,
            &percent_encode_path_key(r"D:\Repo\App"),
            session_id,
            &format!(r#"{{"info":{{"id":"{session_id}","cwd":"D:/Repo/App"}}}}"#),
        );
        let dirs = [
            root.join(percent_encode_path_key(r"D:\Repo\App")),
            root.join(percent_encode_path_key(r"d:\repo\app")),
        ];

        let candidates = collect_project_summary_files_bounded(&dirs, GROK_RECENT_SESSION_DIR_CAP)
            .expect("bounded scan");
        assert_eq!(candidates.len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_recent_scan_refuses_truncated_project_history() {
        let root = temp_root("large-recent");
        let project_dir = root.join(percent_encode_path_key("/repo"));
        for index in 0..=GROK_RECENT_SESSION_DIR_CAP {
            write_summary(
                &root,
                &percent_encode_path_key("/repo"),
                &format!("session-{index}"),
                &format!(r#"{{"info":{{"id":"session-{index}","cwd":"/repo"}}}}"#),
            );
        }
        assert!(
            collect_project_summary_files_bounded(&[project_dir], GROK_RECENT_SESSION_DIR_CAP)
                .is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_recent_scan_counts_empty_history_entries() {
        let root = temp_root("large-empty-recent");
        let project_dir = root.join(percent_encode_path_key("/repo"));
        for index in 0..=GROK_RECENT_SESSION_DIR_CAP {
            fs::create_dir_all(project_dir.join(format!("empty-{index}"))).expect("mkdir");
        }
        assert!(
            collect_project_summary_files_bounded(&[project_dir], GROK_RECENT_SESSION_DIR_CAP)
                .is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pages_with_cursor() {
        let root = temp_root("page");
        for i in 0..4 {
            write_summary(
                &root,
                "cwd",
                &format!("s{i}"),
                &format!(
                    r#"{{"info":{{"id":"s{i}","cwd":"/repo"}},"generated_title":"T{i}","updated_at":{}}}"#,
                    1000 + i
                ),
            );
        }
        let page1 = list_grok_session_page_from_root(&root, None, 2, None);
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.next_cursor.as_deref(), Some("2"));
        let page2 = list_grok_session_page_from_root(&root, Some("2"), 2, None);
        assert_eq!(page2.items.len(), 2);
        assert_ne!(page1.items[0].id, page2.items[0].id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn controlled_scan_reports_real_total_and_honors_cancellation() {
        let root = temp_root("progress-cancel");
        write_summary(
            &root,
            "workspace",
            "session",
            r#"{"info":{"id":"session","cwd":"/repo"},"generated_title":"Session"}"#,
        );
        let (_registration, reporter) =
            super::super::progress::test_catalog_scan(912, AgentSessionProvider::Grok);

        let page =
            list_grok_session_page_from_root_with_progress(&root, None, 40, None, Some(&reporter))
                .expect("controlled page");
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            reporter.test_last_progress(),
            Some((AgentSessionCatalogPhase::Scanning, 1, Some(1)))
        );

        assert!(super::super::progress::cancel_catalog_scan(912));
        assert!(list_grok_session_page_from_root_with_progress(
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
