use super::preview::{is_meaningful_user_text, sanitize_preview};
use super::types::{
    empty_page, AgentSessionAvailability, AgentSessionMetadataLookup, AgentSessionPage,
    AgentSessionProvider, AgentSessionSummary, TitleKind, MAX_METADATA_FILE_BYTES,
};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const CLAUDE_PARSE_CACHE_CAP: usize = 256;
const CLAUDE_PARSE_CACHE_TTL: Duration = Duration::from_secs(60);
const CLAUDE_FILES_SCANNED_PER_PAGE: usize = 500;
const CLAUDE_EXACT_PROJECT_DIR_CAP: usize = 512;

#[derive(Debug, Clone)]
struct ParsedClaudeSession {
    summary: AgentSessionSummary,
    mtime_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct ClaudeCacheEntry {
    parsed: ParsedClaudeSession,
    collected_at: std::time::Instant,
}

static CLAUDE_PARSE_CACHE: Lazy<Mutex<HashMap<PathBuf, ClaudeCacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn list_claude_session_page(
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    let Some(root) = claude_projects_root() else {
        return empty_page(
            AgentSessionProvider::Claude,
            AgentSessionAvailability::Unavailable,
            Some("Claude projects directory is unavailable".into()),
        );
    };
    if !root.is_dir() {
        return empty_page(
            AgentSessionProvider::Claude,
            AgentSessionAvailability::Unavailable,
            Some("Claude projects directory was not found".into()),
        );
    }

    list_claude_session_page_from_root(&root, cursor, limit, query)
}

pub(crate) fn resolve_claude_sessions(
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let Some(root) = claude_projects_root().filter(|root| root.is_dir()) else {
        return vec![None; lookups.len()];
    };
    resolve_claude_sessions_from_root(&root, lookups)
}

fn resolve_claude_sessions_from_root(
    root: &Path,
    lookups: &[AgentSessionMetadataLookup],
) -> Vec<Option<AgentSessionSummary>> {
    let project_dirs = collect_claude_project_dirs(root);
    lookups
        .iter()
        .map(|lookup| {
            let file_name = format!("{}.jsonl", lookup.session_id);
            let mut candidates = Vec::new();
            if let Some(project_path) = lookup.project_path.as_deref() {
                candidates.push(
                    root.join(claude_project_directory_name(project_path))
                        .join(&file_name),
                );
            }
            for directory in &project_dirs {
                let candidate = directory.join(&file_name);
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
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
                let modified_ms = path
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|time| {
                        time.duration_since(std::time::UNIX_EPOCH)
                            .ok()
                            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
                    });
                let parsed = parse_claude_file_cached(&path, modified_ms)?;
                if parsed.summary.id != lookup.session_id {
                    return None;
                }
                if lookup.project_path.as_deref().is_some_and(|requested| {
                    !paths_loosely_match(&parsed.summary.project_path, requested)
                }) {
                    return None;
                }
                Some(parsed.summary)
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

fn collect_claude_project_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(CLAUDE_EXACT_PROJECT_DIR_CAP)
        .filter_map(|entry| entry.file_type().ok()?.is_dir().then(|| entry.path()))
        .collect()
}

fn claude_project_directory_name(project_path: &str) -> String {
    let mut raw = project_path.trim().replace('\\', "/");
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("//?/unc/") {
        raw = format!("//{}", &raw[8..]);
    } else if lower.starts_with("//?/") {
        raw = raw[4..].to_string();
    }
    while raw.ends_with('/') && raw.len() > 1 && !(raw.len() == 3 && raw.as_bytes()[1] == b':') {
        raw.pop();
    }
    raw.chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect()
}

fn paths_loosely_match(candidate: &str, requested: &str) -> bool {
    crate::workspace::same_project_path(candidate, requested)
}

fn list_claude_session_page_from_root(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    query: Option<&str>,
) -> AgentSessionPage {
    let files = crate::provider_sessions::jsonl_files_recent_first(root, None);
    let mut index = decode_offset_cursor(cursor).unwrap_or(0).min(files.len());
    let mut scanned = 0usize;
    let mut items = Vec::with_capacity(limit);

    while index < files.len() && scanned < CLAUDE_FILES_SCANNED_PER_PAGE && items.len() < limit {
        let file = &files[index];
        index = index.saturating_add(1);
        scanned = scanned.saturating_add(1);

        if let Some(parsed) = parse_claude_file_cached(&file.path, file.modified_ms) {
            if matches_query(&parsed.summary, query) {
                items.push(parsed.summary);
            }
        }
    }

    let next_cursor = if index < files.len() {
        Some(index.to_string())
    } else {
        None
    };

    AgentSessionPage {
        provider: AgentSessionProvider::Claude,
        availability: AgentSessionAvailability::Available,
        items,
        next_cursor,
        scanned_at: super::types::now_ms(),
        warning: None,
    }
}

fn claude_projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

fn decode_offset_cursor(cursor: Option<&str>) -> Option<usize> {
    cursor?.trim().parse().ok()
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

fn parse_claude_file_cached(path: &Path, mtime_ms: Option<u64>) -> Option<ParsedClaudeSession> {
    if let Ok(cache) = CLAUDE_PARSE_CACHE.lock() {
        if let Some(entry) = cache.get(path) {
            if entry.collected_at.elapsed() <= CLAUDE_PARSE_CACHE_TTL
                && entry.parsed.mtime_ms == mtime_ms
            {
                return Some(entry.parsed.clone());
            }
        }
    }

    let parsed = parse_claude_transcript(path, mtime_ms)?;
    if let Ok(mut cache) = CLAUDE_PARSE_CACHE.lock() {
        cache.retain(|_, entry| entry.collected_at.elapsed() <= CLAUDE_PARSE_CACHE_TTL);
        while cache.len() >= CLAUDE_PARSE_CACHE_CAP {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.collected_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            } else {
                break;
            }
        }
        cache.insert(
            path.to_path_buf(),
            ClaudeCacheEntry {
                parsed: parsed.clone(),
                collected_at: std::time::Instant::now(),
            },
        );
    }
    Some(parsed)
}

fn parse_claude_transcript(path: &Path, mtime_ms: Option<u64>) -> Option<ParsedClaudeSession> {
    let lines = read_claude_metadata_lines(path)?;
    let session_id_from_name = path.file_stem()?.to_str()?.to_string();

    let mut id = session_id_from_name.clone();
    let mut project_path = String::new();
    let mut explicit_title: Option<String> = None;
    let mut generated_title: Option<String> = None;
    let mut first_user_preview: Option<String> = None;
    let mut created_at: Option<u64> = None;
    let mut message_count: u32 = 0;

    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
            if !session_id.trim().is_empty() {
                id = session_id.to_string();
            }
        }
        if project_path.is_empty() {
            if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                if !cwd.trim().is_empty() {
                    project_path = cwd.to_string();
                }
            }
        }
        if created_at.is_none() {
            created_at = extract_timestamp_ms(&value);
        }

        if let Some(title) = extract_custom_title(&value) {
            explicit_title = Some(title);
        }
        if generated_title.is_none() {
            if let Some(title) = extract_generated_title(&value) {
                generated_title = Some(title);
            }
        }

        if first_user_preview.is_none() {
            if let Some(text) = extract_user_text(&value) {
                if is_meaningful_user_text(&text) {
                    first_user_preview = sanitize_preview(&text);
                }
            }
        }

        if value.get("type").and_then(Value::as_str) == Some("user")
            || value.get("role").and_then(Value::as_str) == Some("user")
        {
            message_count = message_count.saturating_add(1);
        }
    }

    if project_path.trim().is_empty() || id.trim().is_empty() {
        return None;
    }

    let (native_title, title_kind) =
        if let Some(title) = explicit_title.filter(|t| !t.trim().is_empty()) {
            (Some(title), TitleKind::Explicit)
        } else if let Some(title) = generated_title.filter(|t| !t.trim().is_empty()) {
            (Some(title), TitleKind::Generated)
        } else if first_user_preview.is_some() {
            (None, TitleKind::FirstPrompt)
        } else {
            (None, TitleKind::Unknown)
        };

    Some(ParsedClaudeSession {
        summary: AgentSessionSummary {
            provider: AgentSessionProvider::Claude,
            id,
            project_path,
            native_title,
            title_kind,
            first_user_message_preview: first_user_preview,
            created_at,
            updated_at: mtime_ms,
            message_count: if message_count > 0 {
                Some(message_count)
            } else {
                None
            },
            git_branch: None,
            source_kind: Some("transcript".into()),
            parent_session_id: None,
            resumable: true,
        },
        mtime_ms,
    })
}

fn read_claude_metadata_lines(path: &Path) -> Option<Vec<String>> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let head_budget = MAX_METADATA_FILE_BYTES / 2;
    let tail_budget = MAX_METADATA_FILE_BYTES.saturating_sub(head_budget);
    let mut head = Vec::new();
    file.by_ref()
        .take(head_budget)
        .read_to_end(&mut head)
        .ok()?;

    let mut segments = vec![head];
    if length > head_budget {
        file.seek(SeekFrom::Start(length.saturating_sub(tail_budget)))
            .ok()?;
        let mut tail = Vec::new();
        file.take(tail_budget).read_to_end(&mut tail).ok()?;
        segments.push(tail);
    }

    Some(
        segments
            .into_iter()
            .flat_map(|segment| {
                String::from_utf8_lossy(&segment)
                    .lines()
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .take(4_000)
            .collect(),
    )
}

fn extract_custom_title(value: &Value) -> Option<String> {
    let candidates = [
        value.get("customTitle"),
        value.get("custom-title"),
        value.pointer("/payload/customTitle"),
        value.pointer("/payload/custom-title"),
        value.pointer("/message/customTitle"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(title) = candidate.as_str().map(str::trim).filter(|v| !v.is_empty()) {
            return Some(title.to_string());
        }
    }

    let event = value.get("type").and_then(Value::as_str).unwrap_or("");
    if event == "custom-title" || event == "session_title" || event == "title" {
        if let Some(title) = value
            .get("title")
            .or_else(|| value.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(title.to_string());
        }
    }
    None
}

fn extract_generated_title(value: &Value) -> Option<String> {
    let candidates = [
        value.get("title"),
        value.pointer("/payload/title"),
        value.pointer("/summary/title"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(title) = candidate.as_str().map(str::trim).filter(|v| !v.is_empty()) {
            let event = value.get("type").and_then(Value::as_str).unwrap_or("");
            if event.contains("title") || value.get("summary").is_some() {
                return Some(title.to_string());
            }
        }
    }
    None
}

fn extract_user_text(value: &Value) -> Option<String> {
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let role = value
        .get("role")
        .or_else(|| value.pointer("/message/role"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let type_name = value.get("type").and_then(Value::as_str).unwrap_or("");
    if role != "user" && type_name != "user" && type_name != "human" {
        return None;
    }

    if let Some(text) = value
        .pointer("/message/content")
        .and_then(content_to_text)
        .or_else(|| value.get("content").and_then(content_to_text))
        .or_else(|| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
    {
        return Some(text);
    }
    None
}

fn content_to_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let array = content.as_array()?;
    let mut parts = Vec::new();
    for item in array {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("text");
        if item_type != "text" {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            parts.push(text);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn extract_timestamp_ms(value: &Value) -> Option<u64> {
    let candidates = [
        value.get("timestamp"),
        value.get("createdAt"),
        value.pointer("/message/timestamp"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(ms) = super::types::read_timestamp_ms(Some(candidate)) {
            return Some(ms);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_root(label: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadterm-claude-catalog-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn write_jsonl(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, content).expect("write");
    }

    #[test]
    fn parses_renamed_and_first_prompt_transcripts() {
        let root = temp_root("parse");
        let renamed = root.join("renamed.jsonl");
        write_jsonl(
            &renamed,
            r#"{"cwd":"/repo/app","sessionId":"sess-1","type":"custom-title","title":"My Rename","timestamp":"2021-01-01T00:00:00.500Z"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Ignore meta"}]},"isMeta":true}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the flaky login test"}]}}
"#,
        );
        let parsed = parse_claude_transcript(&renamed, Some(100)).expect("parse");
        assert_eq!(parsed.summary.native_title.as_deref(), Some("My Rename"));
        assert_eq!(parsed.summary.title_kind, TitleKind::Explicit);
        assert_eq!(parsed.summary.created_at, Some(1_609_459_200_500));
        assert_eq!(
            parsed.summary.first_user_message_preview.as_deref(),
            Some("Fix the flaky login test")
        );

        let untitled = root.join("untitled.jsonl");
        write_jsonl(
            &untitled,
            r#"{"cwd":"/repo/app","sessionId":"sess-2"}
{"type":"system","content":"boot"}
{"type":"user","message":{"role":"user","content":"Please refactor helpers"}}
"#,
        );
        let parsed = parse_claude_transcript(&untitled, Some(200)).expect("parse");
        assert_eq!(parsed.summary.title_kind, TitleKind::FirstPrompt);
        assert_eq!(
            parsed.summary.first_user_message_preview.as_deref(),
            Some("Please refactor helpers")
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_reuses_unchanged_mtime_and_invalidates_on_change() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        let root = temp_root("cache");
        let file = root.join("sess.jsonl");
        write_jsonl(
            &file,
            r#"{"cwd":"/repo","sessionId":"a"}
{"type":"user","message":{"role":"user","content":"one"}}
"#,
        );
        let first = parse_claude_file_cached(&file, Some(1)).expect("first");
        assert_eq!(
            first.summary.first_user_message_preview.as_deref(),
            Some("one")
        );
        write_jsonl(
            &file,
            r#"{"cwd":"/repo","sessionId":"a"}
{"type":"user","message":{"role":"user","content":"two"}}
"#,
        );
        let cached = parse_claude_file_cached(&file, Some(1)).expect("cached");
        assert_eq!(
            cached.summary.first_user_message_preview.as_deref(),
            Some("one")
        );
        let refreshed = parse_claude_file_cached(&file, Some(2)).expect("refreshed");
        assert_eq!(
            refreshed.summary.first_user_message_preview.as_deref(),
            Some("two")
        );
        let _ = fs::remove_dir_all(&root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
    }

    #[test]
    fn skips_malformed_and_empty_transcripts() {
        let root = temp_root("bad");
        let empty = root.join("empty.jsonl");
        write_jsonl(&empty, "{}\nnot-json\n");
        assert!(parse_claude_transcript(&empty, None).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exact_lookup_finds_old_bound_session_without_recent_file_scan() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        let root = temp_root("old-exact");
        for index in 0..600 {
            fs::create_dir_all(root.join(format!("unrelated-{index}"))).expect("mkdir unrelated");
        }
        let session_id = "old-bound-session";
        let project_path = "/Users/demo/App";
        let session_path = root
            .join(claude_project_directory_name(project_path))
            .join(format!("{session_id}.jsonl"));
        write_jsonl(
            &session_path,
            &format!(
                "{{\"cwd\":\"{project_path}\",\"sessionId\":\"{session_id}\"}}\n\
                 {{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"Old prompt\"}}}}\n"
            ),
        );
        let lookup = AgentSessionMetadataLookup {
            session_id: session_id.into(),
            project_path: Some(project_path.into()),
        };

        let resolved = resolve_claude_sessions_from_root(&root, &[lookup]);
        assert_eq!(
            resolved[0]
                .as_ref()
                .and_then(|item| item.first_user_message_preview.as_deref()),
            Some("Old prompt")
        );

        let _ = fs::remove_dir_all(root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
    }

    #[test]
    fn direct_project_directory_normalizes_windows_verbatim_prefixes() {
        assert_eq!(
            claude_project_directory_name(r"\\?\d:\repo\app\"),
            "d--repo-app"
        );
        assert_eq!(
            claude_project_directory_name(r"\\?\unc\Server\Share\App"),
            "--Server-Share-App"
        );
    }

    #[cfg(windows)]
    #[test]
    fn exact_lookup_deduplicates_windows_case_variant_paths() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        let root = temp_root("windows-case");
        let session_id = "windows-case-session";
        let path = root.join("D--Repo-App").join(format!("{session_id}.jsonl"));
        write_jsonl(
            &path,
            &format!("{{\"cwd\":\"D:/Repo/App\",\"sessionId\":\"{session_id}\"}}\n"),
        );
        let lookup = AgentSessionMetadataLookup {
            session_id: session_id.into(),
            project_path: Some(r"d:\repo\app".into()),
        };

        assert!(resolve_claude_sessions_from_root(&root, &[lookup])[0].is_some());

        let _ = fs::remove_dir_all(root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
    }

    #[test]
    fn bounded_head_and_tail_read_keeps_late_native_title() {
        let root = temp_root("head-tail");
        let path = root.join("session-tail.jsonl");
        fs::create_dir_all(&root).expect("mkdir");
        let mut file = File::create(&path).expect("file");
        use std::io::Write as _;
        file.write_all(
            br#"{"cwd":"/repo/app","sessionId":"session-tail"}
{"type":"user","message":{"role":"user","content":"First prompt"}}
"#,
        )
        .expect("head");
        file.write_all(&vec![b' '; MAX_METADATA_FILE_BYTES as usize])
            .expect("middle");
        file.write_all(
            br#"
{"type":"custom-title","title":"Late rename"}
"#,
        )
        .expect("tail");
        drop(file);

        let parsed = parse_claude_transcript(&path, None).expect("parse bounded segments");
        assert_eq!(parsed.summary.native_title.as_deref(), Some("Late rename"));
        assert_eq!(
            parsed.summary.first_user_message_preview.as_deref(),
            Some("First prompt")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn catalog_search_matches_title_and_prompt_not_present_in_file_path() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        let root = temp_root("search");
        let file = root.join("project-hash").join("session-id.jsonl");
        write_jsonl(
            &file,
            r#"{"cwd":"/repo/app","sessionId":"sess-search","type":"custom-title","title":"Release Checklist"}
{"type":"user","message":{"role":"user","content":"Investigate the websocket race"}}
"#,
        );

        let by_title =
            list_claude_session_page_from_root(&root, None, 40, Some("release checklist"));
        assert_eq!(by_title.items.len(), 1);

        let by_prompt = list_claude_session_page_from_root(&root, None, 40, Some("websocket race"));
        assert_eq!(by_prompt.items.len(), 1);

        let _ = fs::remove_dir_all(&root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
    }

    #[test]
    fn catalog_cursor_advances_without_dropping_sessions() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        let root = temp_root("pagination");
        for id in ["one", "two"] {
            write_jsonl(
                &root.join(format!("{id}.jsonl")),
                &format!(
                    "{{\"cwd\":\"/repo\",\"sessionId\":\"{id}\"}}\n\
                     {{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"prompt {id}\"}}}}\n"
                ),
            );
        }

        let first = list_claude_session_page_from_root(&root, None, 1, None);
        assert_eq!(first.items.len(), 1);
        let cursor = first.next_cursor.as_deref().expect("next cursor");
        let second = list_claude_session_page_from_root(&root, Some(cursor), 1, None);
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].id, second.items[0].id);

        let _ = fs::remove_dir_all(&root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
    }

    #[test]
    fn ten_thousand_file_catalog_pages_without_parsing_entire_directory() {
        let _cache_test_guard = CACHE_TEST_LOCK.lock().expect("cache test lock");
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        crate::provider_sessions::clear_jsonl_scan_cache_for_tests();
        let root = temp_root("ten-thousand-files");
        fs::create_dir_all(&root).expect("create catalog root");
        for index in 0..10_000 {
            fs::write(
                root.join(format!("session-{index:05}.jsonl")),
                format!("{{\"cwd\":\"/repo/large\",\"sessionId\":\"session-{index:05}\"}}\n"),
            )
            .expect("write catalog fixture");
        }

        let first = list_claude_session_page_from_root(&root, None, 25, None);
        assert_eq!(first.items.len(), 25);
        assert_eq!(first.next_cursor.as_deref(), Some("25"));
        assert_eq!(CLAUDE_PARSE_CACHE.lock().expect("cache").len(), 25);

        let first_ids = first
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let second =
            list_claude_session_page_from_root(&root, first.next_cursor.as_deref(), 25, None);
        assert_eq!(second.items.len(), 25);
        assert_eq!(second.next_cursor.as_deref(), Some("50"));
        assert!(second
            .items
            .iter()
            .all(|item| !first_ids.contains(item.id.as_str())));
        assert_eq!(CLAUDE_PARSE_CACHE.lock().expect("cache").len(), 50);

        let _ = fs::remove_dir_all(&root);
        CLAUDE_PARSE_CACHE.lock().expect("cache").clear();
        crate::provider_sessions::clear_jsonl_scan_cache_for_tests();
    }
}
