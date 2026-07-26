use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const JSONL_SCAN_CACHE_TTL: Duration = Duration::from_millis(2_500);
const SESSION_FILE_GRACE_MS: u64 = 120_000;
const DEFAULT_PROVIDER_SESSION_LIST_LIMIT: usize = 200;
const MAX_CODEX_SESSION_ANCESTRY_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionInfo {
    pub id: String,
    pub provider: String,
    pub project_path: String,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone)]
struct CodexSessionMeta {
    id: String,
    cwd: String,
    parent_session_id: Option<String>,
    resumable: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionFileCandidate {
    pub(crate) path: PathBuf,
    pub(crate) modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Eq)]
struct JsonlScanCacheKey {
    root: PathBuf,
    since_ms: Option<u64>,
}

impl PartialEq for JsonlScanCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.root == other.root && self.since_ms == other.since_ms
    }
}

impl Hash for JsonlScanCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.root.hash(state);
        self.since_ms.hash(state);
    }
}

#[derive(Debug, Clone)]
struct JsonlScanCacheEntry {
    collected_at: Instant,
    files: Vec<SessionFileCandidate>,
}

static JSONL_SCAN_CACHE: Lazy<Mutex<HashMap<JsonlScanCacheKey, JsonlScanCacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub async fn provider_find_recent_session(
    provider: String,
    project_path: String,
    since_ms: Option<u64>,
) -> Result<Option<ProviderSessionInfo>, String> {
    tokio::task::spawn_blocking(move || match provider.as_str() {
        "codex" => Ok(find_recent_codex_session(&project_path, since_ms)),
        "claude" => Ok(find_recent_claude_session(&project_path, since_ms)),
        other => Err(format!("Unsupported provider: {other}")),
    })
    .await
    .map_err(|e| format!("Provider session discovery task failed: {e}"))?
}

#[tauri::command]
pub async fn provider_list_recent_sessions(
    limit: Option<usize>,
) -> Result<Vec<ProviderSessionInfo>, String> {
    let limit = normalize_provider_session_limit(limit);
    tokio::task::spawn_blocking(move || Ok(list_recent_provider_sessions(limit)))
        .await
        .map_err(|e| format!("Provider session discovery task failed: {e}"))?
}

#[tauri::command]
pub async fn provider_resolve_resume_session(
    provider: String,
    session_id: String,
) -> Result<Option<ProviderSessionInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(None);
        }

        match provider.as_str() {
            "codex" => resolve_codex_resume_session(session_id),
            "claude" => Ok(list_claude_sessions(None)
                .into_iter()
                .find(|session| session.id == session_id)),
            other => Err(format!("Unsupported provider: {other}")),
        }
    })
    .await
    .map_err(|e| format!("Provider session validation task failed: {e}"))?
}

fn find_recent_codex_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    find_recent_session_for_project(list_codex_sessions(since_ms), project_path)
}

fn find_recent_claude_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    find_recent_session_for_project(list_claude_sessions(since_ms), project_path)
}

fn list_recent_provider_sessions(limit: usize) -> Vec<ProviderSessionInfo> {
    let mut sessions = Vec::new();
    sessions.extend(list_codex_sessions(None));
    sessions.extend(list_claude_sessions(None));
    dedupe_and_sort_provider_sessions(sessions, limit)
}

fn list_codex_sessions(since_ms: Option<u64>) -> Vec<ProviderSessionInfo> {
    let Some(root) = dirs::home_dir().map(|home| home.join(".codex").join("sessions")) else {
        return Vec::new();
    };
    provider_sessions_from_root(&root, "codex", since_ms, parse_codex_session_meta)
}

fn list_claude_sessions(since_ms: Option<u64>) -> Vec<ProviderSessionInfo> {
    let Some(root) = dirs::home_dir().map(|home| home.join(".claude").join("projects")) else {
        return Vec::new();
    };
    provider_sessions_from_root(&root, "claude", since_ms, parse_claude_session_meta)
}

fn provider_sessions_from_root(
    root: &Path,
    provider: &str,
    since_ms: Option<u64>,
    parse_meta: fn(&Path) -> Option<(String, String)>,
) -> Vec<ProviderSessionInfo> {
    if !root.is_dir() {
        return Vec::new();
    }

    let mut sessions = Vec::new();
    for file in jsonl_files_recent_first(root, since_ms) {
        let Some((id, cwd)) = parse_meta(&file.path) else {
            continue;
        };
        sessions.push(ProviderSessionInfo {
            id,
            provider: provider.to_string(),
            project_path: cwd,
            updated_at: file.modified_ms,
        });
    }
    sessions
}

fn find_recent_session_for_project(
    sessions: Vec<ProviderSessionInfo>,
    project_path: &str,
) -> Option<ProviderSessionInfo> {
    let mut best: Option<ProviderSessionInfo> = None;
    for candidate in sessions {
        if !path_matches(&candidate.project_path, project_path) {
            continue;
        }
        if is_newer(&candidate, best.as_ref()) {
            best = Some(candidate);
        }
    }
    best
}

fn dedupe_and_sort_provider_sessions(
    sessions: Vec<ProviderSessionInfo>,
    limit: usize,
) -> Vec<ProviderSessionInfo> {
    let mut by_key: HashMap<(String, String), ProviderSessionInfo> = HashMap::new();
    for session in sessions {
        if session.id.trim().is_empty()
            || session.provider.trim().is_empty()
            || session.project_path.trim().is_empty()
        {
            continue;
        }

        let key = (session.provider.clone(), session.id.clone());
        let should_replace = by_key
            .get(&key)
            .map(|current| is_newer(&session, Some(current)))
            .unwrap_or(true);
        if should_replace {
            by_key.insert(key, session);
        }
    }

    let mut sessions: Vec<ProviderSessionInfo> = by_key.into_values().collect();
    sessions.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(0)
            .cmp(&a.updated_at.unwrap_or(0))
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| a.project_path.cmp(&b.project_path))
            .then_with(|| a.id.cmp(&b.id))
    });
    sessions.truncate(limit);
    sessions
}

fn normalize_provider_session_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_PROVIDER_SESSION_LIST_LIMIT)
        .clamp(1, DEFAULT_PROVIDER_SESSION_LIST_LIMIT)
}

fn parse_codex_session_meta(path: &Path) -> Option<(String, String)> {
    let meta = parse_codex_session_record(path)?;
    meta.resumable.then_some((meta.id, meta.cwd))
}

fn parse_codex_session_record(path: &Path) -> Option<CodexSessionMeta> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(24) {
        let line = line.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("type")?.as_str()? != "session_meta" {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload.get("id")?.as_str()?.to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        return Some(CodexSessionMeta {
            id,
            cwd,
            parent_session_id: codex_parent_session_id(payload),
            resumable: is_resumable_codex_session_payload(payload),
        });
    }
    None
}

fn codex_parent_session_id(payload: &serde_json::Value) -> Option<String> {
    [
        "parent_thread_id",
        "parentThreadId",
        "parent_id",
        "parentId",
    ]
    .iter()
    .find_map(|key| {
        payload
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
    .or_else(|| {
        payload
            .pointer("/source/subagent/thread_spawn/parent_thread_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn is_resumable_codex_session_payload(payload: &serde_json::Value) -> bool {
    if payload
        .get("ephemeral")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return false;
    }

    if codex_parent_session_id(payload).is_some() {
        return false;
    }

    if let Some(thread_source) = payload
        .get("thread_source")
        .or_else(|| payload.get("threadSource"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let source = thread_source.to_ascii_lowercase();
        if !matches!(
            source.as_str(),
            "user" | "cli" | "vscode" | "appserver" | "app_server"
        ) {
            return false;
        }
    }

    let Some(source) = payload.get("source") else {
        // Older Codex session metadata did not always record a source.
        return true;
    };
    let Some(source) = source
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // Structured sources are used for child/internal sessions (for
        // example {"subagent": {"thread_spawn": ...}}) and are not safe
        // roots for an interactive `codex resume`.
        return false;
    };
    matches!(
        source.to_ascii_lowercase().as_str(),
        "cli" | "vscode" | "appserver" | "app_server" | "user"
    )
}

fn resolve_codex_resume_session(session_id: &str) -> Result<Option<ProviderSessionInfo>, String> {
    let Some(root) = dirs::home_dir().map(|home| home.join(".codex").join("sessions")) else {
        return Ok(None);
    };
    resolve_codex_resume_session_from_root(&root, session_id)
}

fn resolve_codex_resume_session_from_root(
    root: &Path,
    session_id: &str,
) -> Result<Option<ProviderSessionInfo>, String> {
    if !root.is_dir() {
        return Ok(None);
    }

    let files = jsonl_files_recent_first(root, None);
    let mut current_id = session_id.to_string();
    let mut visited = HashSet::new();

    for _ in 0..MAX_CODEX_SESSION_ANCESTRY_DEPTH {
        if !visited.insert(current_id.clone()) {
            return Err(format!(
                "Codex session ancestry contains a cycle at {current_id}"
            ));
        }

        let Some((meta, updated_at)) = find_codex_session_record(&files, &current_id) else {
            return Ok(None);
        };
        if meta.resumable {
            return Ok(Some(ProviderSessionInfo {
                id: meta.id,
                provider: "codex".to_string(),
                project_path: meta.cwd,
                updated_at,
            }));
        }

        let Some(parent_session_id) = meta.parent_session_id else {
            return Ok(None);
        };
        current_id = parent_session_id;
    }

    Err(format!(
        "Codex session ancestry exceeds {MAX_CODEX_SESSION_ANCESTRY_DEPTH} levels"
    ))
}

fn find_codex_session_record(
    files: &[SessionFileCandidate],
    session_id: &str,
) -> Option<(CodexSessionMeta, Option<u64>)> {
    files
        .iter()
        .filter(|file| {
            file.path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(session_id))
        })
        .filter_map(|file| {
            parse_codex_session_record(&file.path).map(|meta| (meta, file.modified_ms))
        })
        .find(|(meta, _)| meta.id == session_id)
}

fn parse_claude_session_meta(path: &Path) -> Option<(String, String)> {
    let session_id_from_name = path.file_stem()?.to_str()?.to_string();
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(40) {
        let line = line.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        let cwd = value.get("cwd").and_then(|v| v.as_str());
        if let Some(cwd) = cwd {
            let id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or(&session_id_from_name);
            return Some((id.to_string(), cwd.to_string()));
        }
    }
    None
}

pub fn jsonl_files_recent_first(root: &Path, since_ms: Option<u64>) -> Vec<SessionFileCandidate> {
    let key = JsonlScanCacheKey {
        root: root.to_path_buf(),
        since_ms,
    };

    if let Ok(cache) = JSONL_SCAN_CACHE.lock() {
        if let Some(entry) = cache.get(&key) {
            if entry.collected_at.elapsed() <= JSONL_SCAN_CACHE_TTL {
                return entry.files.clone();
            }
        }
    }

    let mut files = Vec::new();
    collect_jsonl_files(root, since_ms, &mut files);
    files.sort_by_key(|file| std::cmp::Reverse(file.modified_ms.unwrap_or(0)));

    if let Ok(mut cache) = JSONL_SCAN_CACHE.lock() {
        cache.retain(|_, entry| entry.collected_at.elapsed() <= JSONL_SCAN_CACHE_TTL);
        cache.insert(
            key,
            JsonlScanCacheEntry {
                collected_at: Instant::now(),
                files: files.clone(),
            },
        );
    }

    files
}

fn collect_jsonl_files(dir: &Path, since_ms: Option<u64>, out: &mut Vec<SessionFileCandidate>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            collect_jsonl_files(&path, since_ms, out);
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }

        let modified_ms = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(system_time_ms);
        if let Some(since) = since_ms {
            // Allow a small clock/flush grace period because CLI session files
            // can be created just before the PTY write callback fires.
            if modified_ms
                .unwrap_or(0)
                .saturating_add(SESSION_FILE_GRACE_MS)
                < since
            {
                continue;
            }
        }

        out.push(SessionFileCandidate { path, modified_ms });
    }
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn is_newer(candidate: &ProviderSessionInfo, current: Option<&ProviderSessionInfo>) -> bool {
    let Some(current) = current else {
        return true;
    };
    candidate.updated_at.unwrap_or(0) > current.updated_at.unwrap_or(0)
}

fn path_matches(candidate: &str, requested: &str) -> bool {
    if candidate == requested {
        return true;
    }

    let candidate_path = Path::new(candidate);
    let requested_path = Path::new(requested);
    if candidate_path.starts_with(requested_path) || requested_path.starts_with(candidate_path) {
        return true;
    }

    candidate_path.file_name().and_then(|v| v.to_str())
        == requested_path.file_name().and_then(|v| v.to_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn temp_root(label: &str) -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "threadterm-provider-sessions-{label}-{}-{id}",
            std::process::id()
        ))
    }

    fn write_jsonl(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("jsonl parent")).expect("create parent");
        fs::write(path, content).expect("write jsonl");
    }

    fn clear_scan_cache() {
        JSONL_SCAN_CACHE.lock().expect("scan cache").clear();
    }

    fn session(
        id: &str,
        provider: &str,
        project_path: &str,
        updated_at: u64,
    ) -> ProviderSessionInfo {
        ProviderSessionInfo {
            id: id.to_string(),
            provider: provider.to_string(),
            project_path: project_path.to_string(),
            updated_at: Some(updated_at),
        }
    }

    #[test]
    fn parse_codex_session_meta_reads_session_payload() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        let root = temp_root("codex-parse");
        let file = root.join("session.jsonl");
        write_jsonl(
            &file,
            r#"{"type":"session_meta","payload":{"id":"codex-1","cwd":"/repo/app"}}"#,
        );

        assert_eq!(
            parse_codex_session_meta(&file),
            Some(("codex-1".to_string(), "/repo/app".to_string()))
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_codex_session_meta_rejects_subagent_thread_spawn_payload() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        let root = temp_root("codex-subagent");
        let file =
            root.join("rollout-2026-07-11T21-07-51-019f514a-8678-7c33-b6cf-3a8c40e53052.jsonl");
        write_jsonl(
            &file,
            r#"{"type":"session_meta","payload":{"id":"019f514a-8678-7c33-b6cf-3a8c40e53052","cwd":"/repo/app","thread_source":"subagent","parent_thread_id":"019f513b-d9ae-7833-8e9e-d878ac9e9fe5","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019f513b-d9ae-7833-8e9e-d878ac9e9fe5","depth":1,"agent_path":"/root/rust_checks","agent_nickname":"Pasteur"}}},"agent_path":"/root/rust_checks"}}"#,
        );

        assert_eq!(parse_codex_session_meta(&file), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_resume_resolution_follows_subagent_parent_without_losing_history() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        clear_scan_cache();
        let root = temp_root("codex-resolution");
        let interactive_id = "019f513b-d9ae-7833-8e9e-d878ac9e9fe5";
        let subagent_id = "019f514a-8678-7c33-b6cf-3a8c40e53052";
        write_jsonl(
            &root.join(format!("rollout-{interactive_id}.jsonl")),
            &format!(
                r#"{{"type":"session_meta","payload":{{"id":"{interactive_id}","cwd":"/repo/app","thread_source":"user","source":"vscode"}}}}"#
            ),
        );
        write_jsonl(
            &root.join(format!("rollout-{subagent_id}.jsonl")),
            &format!(
                r#"{{"type":"session_meta","payload":{{"id":"{subagent_id}","cwd":"/repo/app","thread_source":"subagent","parent_thread_id":"{interactive_id}","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{interactive_id}","depth":1,"agent_path":"/root/rust_checks","agent_nickname":"Pasteur"}}}}}},"agent_path":"/root/rust_checks"}}}}"#
            ),
        );

        let direct = resolve_codex_resume_session_from_root(&root, interactive_id)
            .expect("resolve direct")
            .expect("interactive root");
        assert_eq!(direct.id, interactive_id);

        let migrated = resolve_codex_resume_session_from_root(&root, subagent_id)
            .expect("resolve child")
            .expect("parent root");
        assert_eq!(migrated.id, interactive_id);
        assert_eq!(migrated.provider, "codex");
        assert_eq!(migrated.project_path, "/repo/app");

        assert!(resolve_codex_resume_session_from_root(&root, "missing")
            .expect("missing lookup")
            .is_none());

        let _ = fs::remove_dir_all(&root);
        clear_scan_cache();
    }

    #[test]
    fn codex_resume_resolution_rejects_ancestry_cycles() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        clear_scan_cache();
        let root = temp_root("codex-cycle");
        for (id, parent) in [("child-a", "child-b"), ("child-b", "child-a")] {
            write_jsonl(
                &root.join(format!("rollout-{id}.jsonl")),
                &format!(
                    r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"/repo/app","thread_source":"subagent","parent_thread_id":"{parent}","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{parent}"}}}}}}}}}}"#
                ),
            );
        }

        let error =
            resolve_codex_resume_session_from_root(&root, "child-a").expect_err("cycle must fail");
        assert!(error.contains("cycle"));

        let _ = fs::remove_dir_all(&root);
        clear_scan_cache();
    }

    #[test]
    fn parse_claude_session_meta_reads_cwd_and_falls_back_to_file_stem() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        let root = temp_root("claude-parse");
        let file = root.join("claude-session-1.jsonl");
        write_jsonl(&file, r#"{"cwd":"/repo/app","message":"hello"}"#);

        assert_eq!(
            parse_claude_session_meta(&file),
            Some(("claude-session-1".to_string(), "/repo/app".to_string()))
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_claude_session_meta_stops_after_finding_header_metadata() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        let root = temp_root("claude-bounded-read");
        let file = root.join("claude-session-2.jsonl");
        fs::create_dir_all(&root).expect("create root");
        let mut bytes = br#"{"sessionId":"claude-2","cwd":"/repo/bounded","message":"hello"}
"#
        .to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 2 * 1024 * 1024));
        bytes.extend([0xff, 0xfe, 0xfd]);
        fs::write(&file, bytes).expect("write fixture");

        assert_eq!(
            parse_claude_session_meta(&file),
            Some(("claude-2".to_string(), "/repo/bounded".to_string()))
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn provider_sessions_from_root_lists_valid_jsonl_metadata() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        clear_scan_cache();
        let root = temp_root("list");
        write_jsonl(
            &root.join("nested").join("codex.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"codex-1","cwd":"/repo/app"}}"#,
        );
        write_jsonl(&root.join("nested").join("notes.txt"), "{}\n");
        write_jsonl(&root.join("bad.jsonl"), r#"{"type":"other"}"#);

        let sessions = provider_sessions_from_root(&root, "codex", None, parse_codex_session_meta);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "codex-1");
        assert_eq!(sessions[0].provider, "codex");
        assert_eq!(sessions[0].project_path, "/repo/app");
        assert!(sessions[0].updated_at.is_some());

        let _ = fs::remove_dir_all(&root);
        clear_scan_cache();
    }

    #[test]
    fn dedupe_and_sort_provider_sessions_keeps_newest_per_provider_session_id() {
        let sessions = vec![
            session("same", "codex", "/repo/old", 10),
            session("claude-1", "claude", "/repo/claude", 30),
            session("same", "codex", "/repo/new", 40),
            session("", "codex", "/repo/ignored", 50),
        ];

        let result = dedupe_and_sort_provider_sessions(sessions, 10);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "same");
        assert_eq!(result[0].provider, "codex");
        assert_eq!(result[0].project_path, "/repo/new");
        assert_eq!(result[1].id, "claude-1");
    }

    #[test]
    fn dedupe_and_sort_provider_sessions_applies_limit() {
        let sessions = vec![
            session("old", "codex", "/repo/old", 10),
            session("new", "claude", "/repo/new", 20),
        ];

        let result = dedupe_and_sort_provider_sessions(sessions, 1);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "new");
    }

    #[test]
    fn jsonl_files_recent_first_caches_recent_directory_scan() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        clear_scan_cache();
        let root = temp_root("cache");
        let file = root.join("nested").join("session.jsonl");
        write_jsonl(&file, "{}\n");

        let first = jsonl_files_recent_first(&root, None);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].path, file);

        fs::remove_file(&file).expect("remove jsonl");
        let second = jsonl_files_recent_first(&root, None);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].path, first[0].path);

        let _ = fs::remove_dir_all(&root);
        clear_scan_cache();
    }

    #[test]
    fn jsonl_files_recent_first_filters_stale_files_before_returning_candidates() {
        let _guard = TEST_LOCK.lock().expect("provider session test lock");
        clear_scan_cache();
        let root = temp_root("since");
        write_jsonl(&root.join("old.jsonl"), "{}\n");

        let future_since =
            system_time_ms(SystemTime::now() + Duration::from_secs(240)).expect("future millis");
        let files = jsonl_files_recent_first(&root, Some(future_since));
        assert!(files.is_empty());

        let _ = fs::remove_dir_all(&root);
        clear_scan_cache();
    }

    #[tokio::test]
    async fn provider_find_recent_session_reports_unsupported_provider_from_blocking_task() {
        let error =
            provider_find_recent_session("gemini".to_string(), "/tmp/repo".to_string(), None)
                .await
                .expect_err("unsupported provider");

        assert_eq!(error, "Unsupported provider: gemini");
    }
}
