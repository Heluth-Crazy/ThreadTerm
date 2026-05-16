use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const JSONL_SCAN_CACHE_TTL: Duration = Duration::from_millis(2_500);
const SESSION_FILE_GRACE_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionInfo {
    pub id: String,
    pub provider: String,
    pub project_path: String,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone)]
struct SessionFileCandidate {
    path: PathBuf,
    modified_ms: Option<u64>,
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

fn find_recent_codex_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return None;
    }

    let mut best: Option<ProviderSessionInfo> = None;
    for file in jsonl_files_recent_first(&root, since_ms) {
        let Some((id, cwd)) = parse_codex_session_meta(&file.path) else {
            continue;
        };
        if !path_matches(&cwd, project_path) {
            continue;
        }

        let candidate = ProviderSessionInfo {
            id,
            provider: "codex".to_string(),
            project_path: cwd,
            updated_at: file.modified_ms,
        };
        if is_newer(&candidate, best.as_ref()) {
            best = Some(candidate);
        }
    }
    best
}

fn find_recent_claude_session(
    project_path: &str,
    since_ms: Option<u64>,
) -> Option<ProviderSessionInfo> {
    let root = dirs::home_dir()?.join(".claude").join("projects");
    if !root.is_dir() {
        return None;
    }

    let mut best: Option<ProviderSessionInfo> = None;
    for file in jsonl_files_recent_first(&root, since_ms) {
        let Some((id, cwd)) = parse_claude_session_meta(&file.path) else {
            continue;
        };
        if !path_matches(&cwd, project_path) {
            continue;
        }

        let candidate = ProviderSessionInfo {
            id,
            provider: "claude".to_string(),
            project_path: cwd,
            updated_at: file.modified_ms,
        };
        if is_newer(&candidate, best.as_ref()) {
            best = Some(candidate);
        }
    }
    best
}

fn parse_codex_session_meta(path: &Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(24) {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        if value.get("type")?.as_str()? != "session_meta" {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload.get("id")?.as_str()?.to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        return Some((id, cwd));
    }
    None
}

fn parse_claude_session_meta(path: &Path) -> Option<(String, String)> {
    let session_id_from_name = path.file_stem()?.to_str()?.to_string();
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(40) {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
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

fn jsonl_files_recent_first(root: &Path, since_ms: Option<u64>) -> Vec<SessionFileCandidate> {
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
    files.sort_by(|a, b| b.modified_ms.unwrap_or(0).cmp(&a.modified_ms.unwrap_or(0)));

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
