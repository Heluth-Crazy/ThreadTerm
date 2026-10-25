//! Agent change review: working-tree checkpoints kept as Git objects in a private
//! object store next to the V3 database.
//!
//! A snapshot maintains a private index per worktree, stages the working-tree
//! differences into it with `GIT_OBJECT_DIRECTORY` pointing at the private store
//! (repository objects are only alternates), and records the resulting tree. The
//! user's refs, index, working tree and object database are never written. Review
//! is "changed since checkpoint", not authorship.
use crate::{
    db::Database,
    file_ops::{contained_parent_for, recycle},
    git_actions::complete,
    git_read::{
        git_text_until, plain_path, repo_paths_until, repo_prefix, run_git, text_of,
        validate_relative, MAX_TEXT_BYTES,
    },
    workspace_services::{fingerprint, replace_file_atomically, root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak},
    time::{Duration, Instant},
};

const MAX_SNAPSHOT_FILE: u64 = 5 * 1024 * 1024;
const MAX_SKIPPED: usize = 200;
const TURN_BUDGET: Duration = Duration::from_secs(10);
const REVIEW_BUDGET: Duration = Duration::from_secs(60);
const MAX_LABEL_CHARS: usize = 160;
const MAX_REVIEW_CACHES: usize = 256;
const MAX_UNAVAILABLE_DETAIL: usize = 400;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS review_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, turn_id TEXT, label TEXT, operation_id TEXT UNIQUE, store TEXT, tree TEXT, status TEXT NOT NULL, error TEXT, skipped TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS review_checkpoints_session ON review_checkpoints(session_id, created_at);";

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| Ok(tx.execute_batch(SCHEMA)?))
}

struct Snapshot {
    tree: String,
    skipped: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum FileStamp {
    Missing,
    Directory,
    File([u8; 32]),
    Volatile,
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(anyhow!("git_timeout"))
    } else {
        Ok(())
    }
}

fn file_stamp(path: &Path, deadline: Instant) -> Result<FileStamp> {
    if Instant::now() >= deadline {
        return Ok(FileStamp::Volatile);
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(FileStamp::Directory),
        Ok(metadata) if metadata.is_file() => {
            let mut file = fs::File::open(path)?;
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                if Instant::now() >= deadline {
                    return Ok(FileStamp::Volatile);
                }
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
            }
            if Instant::now() >= deadline {
                return Ok(FileStamp::Volatile);
            }
            Ok(FileStamp::File(digest.finalize().into()))
        }
        Ok(_) => Ok(FileStamp::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileStamp::Missing),
        Err(error) => Err(error.into()),
    }
}

fn marker_deadline(deadline: Instant) -> Instant {
    let now = Instant::now();
    let capped = now + Duration::from_millis(500);
    let reserved = deadline.checked_sub(Duration::from_secs(2)).unwrap_or(now);
    capped.min(reserved)
}

fn stamps_reusable(stamps: &[(PathBuf, FileStamp)]) -> bool {
    !stamps
        .iter()
        .any(|(_, stamp)| matches!(stamp, FileStamp::Volatile))
}

fn stamp_paths(paths: &[PathBuf], deadline: Instant) -> Result<Vec<(PathBuf, FileStamp)>> {
    paths
        .iter()
        .map(|path| Ok((path.clone(), file_stamp(path, deadline)?)))
        .collect()
}

#[derive(Clone)]
struct RepoDiscovery {
    top: PathBuf,
    prefix: String,
    index: PathBuf,
    common: PathBuf,
    alternates: Vec<PathBuf>,
    ignore_files: Vec<PathBuf>,
    markers: Vec<(PathBuf, FileStamp)>,
}

fn path_cache_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    return value.to_lowercase();
    #[cfg(not(windows))]
    value.into_owned()
}

fn global_config_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for name in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
        if let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(value));
        }
    }
    for name in ["USERPROFILE", "HOME"] {
        if let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            let home = PathBuf::from(value);
            paths.push(home.join(".gitconfig"));
            paths.push(home.join(".config").join("git").join("config"));
        }
    }
    if let Some(value) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value).join("git").join("config"));
    }
    if let Some(value) = std::env::var_os("APPDATA").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value).join("Git").join("config"));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn default_global_ignore_from(
    xdg_config: Option<&OsStr>,
    home: Option<&OsStr>,
    user_profile: Option<&OsStr>,
) -> Option<PathBuf> {
    if let Some(value) = xdg_config.filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(value).join("git").join("ignore"));
    }
    home.or(user_profile)
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(value).join(".config").join("git").join("ignore"))
}

fn default_global_ignore() -> Option<PathBuf> {
    default_global_ignore_from(
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
    )
}

fn discovery_marker_paths(root: &Path, top: &Path, index: &Path, common: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut current = Some(root);
    while let Some(directory) = current {
        paths.push(directory.join(".git"));
        if directory == top {
            break;
        }
        current = directory.parent();
    }
    paths.push(common.join("objects").join("info").join("alternates"));
    paths.push(common.join("config"));
    paths.push(common.join("config.worktree"));
    if let Some(directory) = index.parent() {
        paths.push(directory.join("HEAD"));
        paths.push(directory.join("config.worktree"));
    }
    paths.extend(global_config_candidates());
    paths.sort();
    paths.dedup();
    paths
}

fn config_origin_paths(root: &Path, deadline: Instant) -> Result<(Vec<PathBuf>, bool)> {
    let output = git_text_until(
        root,
        &[
            "config",
            "--includes",
            "--show-origin",
            "--name-only",
            "--null",
            "--list",
        ],
        deadline,
    )?;
    let mut fields = output.split('\0');
    let mut paths = Vec::new();
    let mut has_includes = false;
    while let (Some(origin), Some(name)) = (fields.next(), fields.next()) {
        has_includes |= name.starts_with("include.")
            || (name.starts_with("includeif.") && name.ends_with(".path"));
        let Some(path) = origin.strip_prefix("file:") else {
            continue;
        };
        let path = PathBuf::from(path);
        paths.push(if path.is_absolute() {
            path
        } else {
            root.join(path)
        });
    }
    Ok((paths, has_includes))
}

fn include_target_paths(root: &Path, deadline: Instant) -> Vec<PathBuf> {
    let Ok(output) = git_text_until(
        root,
        &[
            "config",
            "--includes",
            "--show-origin",
            "--null",
            "--path",
            "--get-regexp",
            "^include.*\\.path$",
        ],
        deadline,
    ) else {
        return Vec::new();
    };
    let mut fields = output.split('\0');
    let mut paths = Vec::new();
    while let (Some(origin), Some(entry)) = (fields.next(), fields.next()) {
        let Some((_name, value)) = entry.split_once('\n') else {
            continue;
        };
        let value = PathBuf::from(value);
        if value.is_absolute() {
            paths.push(value);
            continue;
        }
        let base = origin
            .strip_prefix("file:")
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| root.to_path_buf());
        paths.push(base.join(value));
    }
    paths
}

fn cached_discovery(root: &Path, deadline: Instant) -> Result<RepoDiscovery> {
    type Cache = HashMap<String, RepoDiscovery>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    check_deadline(deadline)?;
    let stamp_deadline = marker_deadline(deadline);
    let canonical_root = plain_path(&root.canonicalize()?);
    let key = path_cache_key(&canonical_root);
    let cached = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned();
    if let Some(cached) = cached {
        let paths: Vec<PathBuf> = cached.markers.iter().map(|(path, _)| path.clone()).collect();
        let markers = stamp_paths(&paths, stamp_deadline)?;
        if stamps_reusable(&markers) && markers == cached.markers {
            return Ok(cached);
        }
    }

    let (prefix, repo) = repo_paths_until(&canonical_root, deadline)?;
    let top = plain_path(&repo.top.canonicalize()?);
    let common = plain_path(&repo.common.canonicalize()?);
    let index = plain_path(&repo.index);
    let repo_objects = common.join("objects");
    let mut alternates = vec![repo_objects.clone()];
    if let Ok(list) = fs::read_to_string(repo_objects.join("info").join("alternates")) {
        for line in list
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let path = Path::new(line);
            alternates.push(plain_path(&if path.is_absolute() {
                path.to_path_buf()
            } else {
                repo_objects.join(path)
            }));
        }
    }
    let mut marker_paths = discovery_marker_paths(&canonical_root, &top, &index, &common);
    let (config_origins, has_includes) = config_origin_paths(&canonical_root, deadline)?;
    marker_paths.extend(config_origins);
    if has_includes {
        marker_paths.extend(include_target_paths(&canonical_root, deadline));
    }
    let configured_excludes = git_text_until(
        &canonical_root,
        &[
            "config",
            "--path",
            "--default",
            "",
            "--get",
            "core.excludesFile",
        ],
        deadline,
    )
    .ok()
    .map(|value| PathBuf::from(value.trim_end_matches(['\r', '\n'])))
    .filter(|path| !path.as_os_str().is_empty())
    .map(|path| if path.is_absolute() { path } else { top.join(path) });
    let global_ignore = configured_excludes.or_else(default_global_ignore);
    if let Some(path) = global_ignore.as_ref() {
        marker_paths.push(path.clone());
    }
    marker_paths.sort();
    marker_paths.dedup();
    let markers = stamp_paths(&marker_paths, stamp_deadline)?;
    let reusable_markers = stamps_reusable(&markers);
    let mut ignore_files = vec![common.join("info").join("exclude")];
    if let Some(path) = global_ignore {
        ignore_files.push(path);
    }
    let discovery = RepoDiscovery {
        top,
        prefix,
        index,
        common,
        alternates,
        ignore_files,
        markers,
    };
    let mut cache = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if reusable_markers {
        if cache.len() >= MAX_REVIEW_CACHES {
            cache.clear();
        }
        cache.insert(key, discovery.clone());
    } else {
        cache.remove(&key);
    }
    Ok(discovery)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SourceFingerprint {
    Missing,
    Present([u8; 32]),
}

struct SourceIndex {
    fingerprint: SourceFingerprint,
    bytes: Option<Vec<u8>>,
}

impl SourceIndex {
    fn read(path: &Path, deadline: Instant) -> Result<Self> {
        check_deadline(deadline)?;
        match fs::File::open(path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                let mut digest = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    check_deadline(deadline)?;
                    let read = file.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    digest.update(&buffer[..read]);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                check_deadline(deadline)?;
                Ok(Self {
                    fingerprint: SourceFingerprint::Present(digest.finalize().into()),
                    bytes: Some(bytes),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                fingerprint: SourceFingerprint::Missing,
                bytes: None,
            }),
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Default)]
struct SnapshotState {
    source: Option<SourceFingerprint>,
    external_ignores: Vec<(PathBuf, FileStamp)>,
    worktree_ignore_paths: Vec<PathBuf>,
    worktree_ignores: Vec<(PathBuf, FileStamp)>,
    tree: Option<String>,
}

fn object_writer_lock(path: &Path) -> Arc<Mutex<()>> {
    type Locks = HashMap<String, Weak<Mutex<()>>>;
    static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = path_cache_key(path);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn snapshot_state(path: &Path) -> Arc<Mutex<SnapshotState>> {
    type States = HashMap<String, Arc<Mutex<SnapshotState>>>;
    static STATES: OnceLock<Mutex<States>> = OnceLock::new();
    let mut states = STATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if states.len() >= MAX_REVIEW_CACHES {
        states.retain(|_, state| Arc::strong_count(state) > 1);
    }
    states.entry(path_cache_key(path)).or_default().clone()
}

fn lock_until<T>(lock: &Mutex<T>, deadline: Instant) -> Result<MutexGuard<'_, T>> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::WouldBlock) => return Err(anyhow!("git_timeout")),
        }
    }
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

struct SharedIndex {
    path: PathBuf,
    hash_len: usize,
}

fn index_extensions(bytes: &[u8], hash_len: usize) -> Option<Vec<(&[u8], &[u8])>> {
    if bytes.get(..4)? != b"DIRC" {
        return None;
    }
    let version = u32::from_be_bytes(bytes.get(4..8)?.try_into().ok()?);
    if !(2..=4).contains(&version) {
        return None;
    }
    let entries = u32::from_be_bytes(bytes.get(8..12)?.try_into().ok()?) as usize;
    let trailer = bytes.len().checked_sub(hash_len)?;
    let mut cursor = 12_usize;
    for _ in 0..entries {
        let start = cursor;
        cursor = cursor.checked_add(40 + hash_len)?;
        let flags = u16::from_be_bytes(bytes.get(cursor..cursor + 2)?.try_into().ok()?);
        cursor += 2;
        if flags & 0x4000 != 0 {
            cursor = cursor.checked_add(2)?;
        }
        if version == 4 {
            loop {
                let byte = *bytes.get(cursor)?;
                cursor += 1;
                if byte & 0x80 == 0 {
                    break;
                }
            }
            cursor += bytes.get(cursor..trailer)?.iter().position(|byte| *byte == 0)? + 1;
        } else {
            let encoded_len = (flags & 0x0fff) as usize;
            if encoded_len < 0x0fff {
                cursor = cursor.checked_add(encoded_len)?;
                if *bytes.get(cursor)? != 0 {
                    return None;
                }
                cursor += 1;
            } else {
                cursor += bytes.get(cursor..trailer)?.iter().position(|byte| *byte == 0)? + 1;
            }
            let consumed = cursor.checked_sub(start)?;
            cursor = cursor.checked_add((8 - consumed % 8) % 8)?;
        }
        if cursor > trailer {
            return None;
        }
    }
    let mut extensions = Vec::new();
    while cursor < trailer {
        let signature = bytes.get(cursor..cursor + 4)?;
        let size = u32::from_be_bytes(bytes.get(cursor + 4..cursor + 8)?.try_into().ok()?)
            as usize;
        cursor += 8;
        let payload = bytes.get(cursor..cursor.checked_add(size)?)?;
        cursor += size;
        extensions.push((signature, payload));
    }
    (cursor == trailer).then_some(extensions)
}

fn linked_shared_index(source_index: &Path, bytes: &[u8]) -> Result<Option<SharedIndex>> {
    let directory = source_index
        .parent()
        .ok_or_else(|| anyhow!("review_unavailable"))?;
    let mut parsed = false;
    let mut unresolved_link = false;
    for hash_len in [20_usize, 32] {
        let Some(extensions) = index_extensions(bytes, hash_len) else {
            continue;
        };
        parsed = true;
        for (signature, payload) in extensions {
            if signature != b"link" {
                continue;
            }
            let Some(oid) = payload.get(..hash_len) else {
                unresolved_link = true;
                continue;
            };
            let path = directory.join(format!("sharedindex.{}", hex::encode(oid)));
            if path.is_file() {
                return Ok(Some(SharedIndex { path, hash_len }));
            }
            unresolved_link = true;
        }
    }
    if unresolved_link || !parsed {
        Err(anyhow!("split_index_unavailable"))
    } else {
        Ok(None)
    }
}

fn copy_file_until(source: &Path, target: &Path, deadline: Instant) -> Result<()> {
    check_deadline(deadline)?;
    let mut input = fs::File::open(source)?;
    let temporary = sibling_path(target, &format!(".copy-{}", uuid::Uuid::new_v4()));
    let mut output = fs::File::create(&temporary)?;
    let mut buffer = [0_u8; 64 * 1024];
    let result = (|| -> Result<()> {
        loop {
            check_deadline(deadline)?;
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
        }
        output.flush()?;
        check_deadline(deadline)?;
        drop(output);
        let _ = fs::remove_file(target);
        fs::rename(&temporary, target)?;
        check_deadline(deadline)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn needs_update(x: &str, y: &str) -> bool {
    x == "?" || y != " " || x == "U" || y == "U"
}

fn changed_gitignore(status: &[u8]) -> bool {
    String::from_utf8_lossy(status)
        .split('\0')
        .filter(|record| record.len() > 3)
        .any(|record| {
            needs_update(&record[..1], &record[1..2])
                && record[3..].rsplit('/').next() == Some(".gitignore")
        })
}

/// Object-store context for one repository.
struct Store {
    top: PathBuf,
    prefix: String,
    source_index: PathBuf,
    private_index: PathBuf,
    private_git_dir: PathBuf,
    objects: PathBuf,
    alternates: Vec<PathBuf>,
    ignore_files: Vec<PathBuf>,
    writer_lock: Arc<Mutex<()>>,
    state: Arc<Mutex<SnapshotState>>,
}

impl Store {
    fn open(db: &Database, root: &Path, deadline: Instant) -> Result<Self> {
        let repo = cached_discovery(root, deadline)?;
        let common_key = hex::encode(Sha256::digest(path_cache_key(&repo.common).as_bytes()));
        let worktree_key = hex::encode(Sha256::digest(path_cache_key(&repo.top).as_bytes()));
        let base = db
            .path()
            .parent()
            .ok_or_else(|| anyhow!("review_unavailable"))?;
        let objects = plain_path(&base.join("review-objects").join(&common_key));
        let indexes = plain_path(&base.join("review-indexes").join(&common_key));
        fs::create_dir_all(&objects)?;
        fs::create_dir_all(&indexes)?;
        let private_index = indexes.join(worktree_key);
        let private_git_dir = plain_path(&base.join("review-git").join(hex::encode(
            Sha256::digest(path_cache_key(&private_index).as_bytes()),
        )));
        Ok(Self {
            top: repo.top,
            prefix: repo.prefix,
            source_index: repo.index,
            writer_lock: object_writer_lock(&objects),
            state: snapshot_state(&private_index),
            private_index,
            private_git_dir,
            objects,
            alternates: repo.alternates,
            ignore_files: repo.ignore_files,
        })
    }

    /// Environment that reads `extra` stores (older checkpoints) as alternates.
    fn env(
        &self,
        index: Option<&Path>,
        extra: &[PathBuf],
    ) -> Result<Vec<(&'static str, OsString)>> {
        let mut alternates: Vec<PathBuf> = extra
            .iter()
            .filter(|path| **path != self.objects)
            .cloned()
            .collect();
        alternates.extend(self.alternates.iter().cloned());
        let mut env = vec![
            (
                "GIT_OBJECT_DIRECTORY",
                self.objects.clone().into_os_string(),
            ),
            (
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                std::env::join_paths(alternates)?,
            ),
        ];
        if let Some(index) = index {
            env.push(("GIT_INDEX_FILE", index.as_os_str().to_owned()));
        }
        Ok(env)
    }

    fn run(
        &self,
        args: &[&str],
        env: &[(&'static str, OsString)],
        stdin: Option<&[u8]>,
        deadline: Instant,
    ) -> Result<Vec<u8>> {
        let borrowed: Vec<(&str, &OsStr)> = env
            .iter()
            .map(|(key, value)| (*key, value.as_os_str()))
            .collect();
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| anyhow!("git_timeout"))?;
        let configured;
        let args = if env.iter().any(|(key, _)| *key == "GIT_INDEX_FILE") {
            configured = ["-c", "core.splitIndex=false"]
                .into_iter()
                .chain(args.iter().copied())
                .collect::<Vec<_>>();
            configured.as_slice()
        } else {
            args
        };
        run_git(&self.top, args, &borrowed, stdin, remaining)
    }

    fn reset_private_index(
        &self,
        source: &SourceIndex,
        state: &mut SnapshotState,
        deadline: Instant,
    ) -> Result<()> {
        let lock = sibling_path(&self.private_index, ".lock");
        let _ = fs::remove_file(&lock);
        let _ = fs::remove_file(&self.private_index);
        if let Some(bytes) = source.bytes.as_ref() {
            let temporary = sibling_path(
                &self.private_index,
                &format!(".reset-{}", uuid::Uuid::new_v4()),
            );
            fs::write(&temporary, bytes)?;
            if let Err(error) = fs::rename(&temporary, &self.private_index) {
                let _ = fs::remove_file(&temporary);
                return Err(error.into());
            }
            if let Some(shared) = linked_shared_index(&self.source_index, bytes)? {
                self.flatten_private_split_index(&shared, deadline)?;
            }
        }
        state.source = Some(source.fingerprint.clone());
        state.tree = None;
        Ok(())
    }

    fn flatten_private_split_index(&self, shared: &SharedIndex, deadline: Instant) -> Result<()> {
        check_deadline(deadline)?;
        fs::create_dir_all(self.private_git_dir.join("objects"))?;
        fs::create_dir_all(self.private_git_dir.join("refs"))?;
        let source_head = self
            .source_index
            .parent()
            .ok_or_else(|| anyhow!("review_unavailable"))?
            .join("HEAD");
        let private_head = self.private_git_dir.join("HEAD");
        match fs::metadata(&source_head) {
            Ok(_) => copy_file_until(&source_head, &private_head, deadline)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                check_deadline(deadline)?;
                fs::write(&private_head, b"ref: refs/heads/main\n")?;
            }
            Err(error) => return Err(error.into()),
        }
        let shared_name = shared
            .path
            .file_name()
            .ok_or_else(|| anyhow!("review_unavailable"))?;
        copy_file_until(
            &shared.path,
            &self.private_git_dir.join(shared_name),
            deadline,
        )?;
        check_deadline(deadline)?;
        let config = if shared.hash_len == 32 {
            b"[core]\n\trepositoryFormatVersion = 1\n\tbare = false\n[extensions]\n\tobjectFormat = sha256\n".as_slice()
        } else {
            b"[core]\n\trepositoryFormatVersion = 0\n\tbare = false\n".as_slice()
        };
        fs::write(self.private_git_dir.join("config"), config)?;
        check_deadline(deadline)?;
        let mut env = self.env(Some(&self.private_index), &[])?;
        env.push(("GIT_DIR", self.private_git_dir.as_os_str().to_owned()));
        env.push(("GIT_WORK_TREE", self.top.as_os_str().to_owned()));
        self.run(&["update-index", "--no-split-index"], &env, None, deadline)?;
        Ok(())
    }

    fn invalidate_private_index(&self, state: &mut SnapshotState) {
        let _ = fs::remove_file(sibling_path(&self.private_index, ".lock"));
        let _ = fs::remove_file(&self.private_index);
        *state = SnapshotState::default();
    }

    fn remember_gitignore_candidates(&self, state: &mut SnapshotState, path: &str) {
        let full = self.top.join(path);
        let mut directory = full.parent();
        while let Some(candidate) = directory.filter(|candidate| candidate.starts_with(&self.top)) {
            state.worktree_ignore_paths.push(candidate.join(".gitignore"));
            if candidate == self.top {
                break;
            }
            directory = candidate.parent();
        }
    }

    fn status(&self, env: &[(&'static str, OsString)], deadline: Instant) -> Result<Vec<u8>> {
        self.run(
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--no-renames",
                "--ignore-submodules=all",
            ],
            env,
            None,
            deadline,
        )
    }

    fn snapshot_locked(&self, state: &mut SnapshotState, deadline: Instant) -> Result<Snapshot> {
        let source = SourceIndex::read(&self.source_index, deadline)?;
        let stamp_deadline = marker_deadline(deadline);
        let external_ignores = stamp_paths(&self.ignore_files, stamp_deadline)?;
        if state.worktree_ignore_paths.is_empty() {
            state.worktree_ignore_paths.push(self.top.join(".gitignore"));
        }
        state.worktree_ignore_paths.sort();
        state.worktree_ignore_paths.dedup();
        let worktree_ignores = stamp_paths(&state.worktree_ignore_paths, stamp_deadline)?;
        let reset = state
            .source
            .as_ref()
            .is_none_or(|cached| cached != &source.fingerprint)
            || !stamps_reusable(&external_ignores)
            || !stamps_reusable(&worktree_ignores)
            || state.external_ignores != external_ignores
            || state.worktree_ignores != worktree_ignores
            || !self.private_index.exists();
        if reset {
            self.reset_private_index(&source, state, deadline)?;
        }
        state.external_ignores = external_ignores;
        state.worktree_ignores = worktree_ignores;
        let env = self.env(Some(&self.private_index), &[])?;
        let mut status = self.status(&env, deadline)?;
        if !reset && changed_gitignore(&status) {
            // The reused index may contain paths that the new ignore rules now
            // exclude. Resetting to the user's index lets Git apply those rules
            // before untracked paths are staged again.
            self.reset_private_index(&source, state, deadline)?;
            status = self.status(&env, deadline)?;
        }
        let text = String::from_utf8_lossy(&status);
        let mut update = Vec::new();
        let mut skipped = Vec::new();
        for (x, y, path) in text
            .split('\0')
            .filter(|record| record.len() > 3)
            .map(|record| (&record[..1], &record[1..2], &record[3..]))
        {
            if !needs_update(x, y) {
                continue;
            }
            self.remember_gitignore_candidates(state, path);
            let full = self.top.join(path);
            match fs::symlink_metadata(&full) {
                Ok(meta) if meta.is_dir() => continue,
                Ok(meta) if meta.is_file() && meta.len() > MAX_SNAPSHOT_FILE => {
                    if skipped.len() < MAX_SKIPPED {
                        if let Some(relative) = path.strip_prefix(&self.prefix) {
                            skipped.push(relative.to_owned());
                        }
                    }
                    continue;
                }
                _ => {}
            }
            update.extend_from_slice(path.as_bytes());
            update.push(0);
        }
        if !update.is_empty() {
            self.run(
                &["update-index", "-z", "--add", "--remove", "--stdin"],
                &env,
                Some(&update),
                deadline,
            )?;
        }
        let tree = if update.is_empty() {
            match state.tree.as_ref() {
                Some(tree) => tree.clone(),
                None => String::from_utf8(self.run(&["write-tree"], &env, None, deadline)?)?
                    .trim()
                    .to_owned(),
            }
        } else {
            String::from_utf8(self.run(&["write-tree"], &env, None, deadline)?)?
                .trim()
                .to_owned()
        };
        if tree.is_empty() {
            return Err(anyhow!("snapshot_failed"));
        }
        state.worktree_ignore_paths.sort();
        state.worktree_ignore_paths.dedup();
        state.worktree_ignores = stamp_paths(
            &state.worktree_ignore_paths,
            marker_deadline(deadline),
        )?;
        state.tree = Some(tree.clone());
        Ok(Snapshot { tree, skipped })
    }

    fn snapshot(&self, deadline: Instant) -> Result<Snapshot> {
        let _writer = lock_until(&self.writer_lock, deadline)?;
        let mut state = lock_until(&self.state, deadline)?;
        let result = self.snapshot_locked(&mut state, deadline);
        if result.is_err() {
            self.invalidate_private_index(&mut state);
        }
        result
    }

    /// Resolves one file inside a checkpoint tree by reading the tree objects.
    /// A readable tree that does not list the path means the file is verified
    /// absent; an unreadable tree (missing store, pruned or corrupt object) is
    /// an unavailable checkpoint rather than an empty baseline.
    fn listed_blob(
        &self,
        tree: &str,
        path: &str,
        env: &[(&'static str, OsString)],
        deadline: Instant,
    ) -> Result<Option<String>> {
        let full = format!("{}{}", self.prefix, path.replace('\\', "/"));
        let mut scoped = env.to_vec();
        scoped.push(("GIT_LITERAL_PATHSPECS", OsString::from("1")));
        let output = self
            .run(
                &["ls-tree", "-r", "-z", "--full-tree", tree, "--", &full],
                &scoped,
                None,
                deadline,
            )
            .map_err(|error| checkpoint_unavailable(&error))?;
        for record in String::from_utf8_lossy(&output)
            .split('\0')
            .filter(|record| !record.is_empty())
        {
            let Some((meta, listed)) = record.split_once('\t') else {
                return Err(anyhow!("checkpoint_unavailable: malformed tree entry"));
            };
            if listed != full {
                continue;
            }
            let mut fields = meta.split(' ');
            let (Some(_mode), Some(kind), Some(oid)) =
                (fields.next(), fields.next(), fields.next())
            else {
                return Err(anyhow!("checkpoint_unavailable: malformed tree entry"));
            };
            // Directories and submodule commits are not reviewable files.
            return Ok((kind == "blob").then(|| oid.to_owned()));
        }
        Ok(None)
    }

    fn blob(
        &self,
        tree: &str,
        path: &str,
        extra: &[PathBuf],
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>> {
        let env = self.env(None, extra)?;
        let Some(oid) = self.listed_blob(tree, path, &env, deadline)? else {
            return Ok(None);
        };
        let size: usize = String::from_utf8(
            self.run(&["cat-file", "-s", &oid], &env, None, deadline)
                .map_err(|error| checkpoint_unavailable(&error))?,
        )?
        .trim()
        .parse()
        .map_err(|_| anyhow!("checkpoint_unavailable: unreadable blob size"))?;
        if size > MAX_TEXT_BYTES {
            return Err(anyhow!("file_too_large"));
        }
        self.run(&["cat-file", "blob", &oid], &env, None, deadline)
            .map(Some)
            .map_err(|error| checkpoint_unavailable(&error))
    }

    /// Changed files between two trees, restricted to the registered root.
    fn changes(
        &self,
        from: &str,
        to: &str,
        extra: &[PathBuf],
        deadline: Instant,
    ) -> Result<Vec<Value>> {
        let env = self.env(None, extra)?;
        let numstat = self.run(
            &[
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                from,
                to,
            ],
            &env,
            None,
            deadline,
        )?;
        let mut counts = std::collections::HashMap::new();
        for record in String::from_utf8_lossy(&numstat).split('\0') {
            let Some((added, rest)) = record.split_once('\t') else { continue; };
            let Some((removed, path)) = rest.split_once('\t') else { continue; };
            let Some(relative) = path.strip_prefix(&self.prefix).filter(|rest| !rest.is_empty()) else { continue; };
            let binary = added == "-" || removed == "-";
            counts.insert(relative.to_owned(), (added.parse::<u64>().ok(), removed.parse::<u64>().ok(), binary));
        }
        let output = self.run(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-status",
                from,
                to,
            ],
            &env,
            None,
            deadline,
        )?;
        let text = String::from_utf8_lossy(&output);
        let mut fields = text.split('\0').filter(|field| !field.is_empty());
        let mut files = Vec::new();
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            let Some(relative) = path
                .strip_prefix(&self.prefix)
                .filter(|rest| !rest.is_empty())
            else {
                continue;
            };
            let status = match status.chars().next() {
                Some('A') => "A",
                Some('D') => "D",
                _ => "M",
            };
            let (added, removed, binary) = counts.remove(relative).unwrap_or((None, None, false));
            let mut file = serde_json::Map::new();
            file.insert("path".into(), json!(relative));
            file.insert("status".into(), json!(status));
            if let Some(added) = added { file.insert("added".into(), json!(added)); }
            if let Some(removed) = removed { file.insert("removed".into(), json!(removed)); }
            if binary { file.insert("binary".into(), Value::Bool(true)); }
            files.push(Value::Object(file));
        }
        Ok(files)
    }
}

/// Distinguishes an unreadable checkpoint object from a file the checkpoint
/// tree verifiably does not contain. The detail stays short and user-facing.
fn checkpoint_unavailable(error: &anyhow::Error) -> anyhow::Error {
    let detail: String = error
        .to_string()
        .chars()
        .take(MAX_UNAVAILABLE_DETAIL)
        .collect();
    anyhow!("checkpoint_unavailable: {detail}")
}

struct Scope {
    root: PathBuf,
    project_id: String,
    worktree_path: Option<String>,
}

fn session_scope(db: &Database, session_id: &str) -> Result<Option<Scope>> {
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        let row: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT project_id, worktree_path FROM sessions WHERE id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (project, worktree) = row.ok_or_else(|| anyhow!("session_not_found"))?;
        let Some(project) = project else {
            return Ok(None);
        };
        let root = root_for(tx, &project, worktree.as_deref())?;
        Ok(Some(Scope {
            root,
            project_id: project,
            worktree_path: worktree,
        }))
    })
}

struct Row {
    store: Option<String>,
    tree: Option<String>,
    status: String,
}

fn checkpoint_row(db: &Database, session_id: &str, id: &str) -> Result<Row> {
    db.transaction(|tx| {
        tx.query_row(
            "SELECT store, tree, status FROM review_checkpoints WHERE id=? AND session_id=?",
            params![id, session_id],
            |row| {
                Ok(Row {
                    store: row.get(0)?,
                    tree: row.get(1)?,
                    status: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("checkpoint_missing"))
    })
}

fn ready_tree(row: &Row) -> Result<(String, Vec<PathBuf>)> {
    match (&row.tree, row.status.as_str()) {
        (Some(tree), "ready") => Ok((tree.clone(), row.store.iter().map(PathBuf::from).collect())),
        _ => Err(anyhow!("checkpoint_failed")),
    }
}

fn checkpoint_json(db: &Database, id: &str) -> Result<Value> {
    db.transaction(|tx| {
        tx.query_row(
            "SELECT id, session_id, kind, turn_id, label, status, error, skipped, created_at FROM review_checkpoints WHERE id=?",
            [id],
            |row| Ok(row_json(row)),
        )
        .map_err(Into::into)
    })?
}

fn row_json(row: &rusqlite::Row<'_>) -> Result<Value> {
    let mut value = Map::new();
    value.insert("id".into(), json!(row.get::<_, String>(0)?));
    value.insert("sessionId".into(), json!(row.get::<_, String>(1)?));
    value.insert("kind".into(), json!(row.get::<_, String>(2)?));
    if let Some(turn) = row.get::<_, Option<String>>(3)? {
        value.insert("turnId".into(), json!(turn));
    }
    if let Some(label) = row.get::<_, Option<String>>(4)? {
        value.insert("label".into(), json!(label));
    }
    value.insert("status".into(), json!(row.get::<_, String>(5)?));
    if let Some(error) = row.get::<_, Option<String>>(6)? {
        value.insert("error".into(), json!(error));
    }
    let skipped: Value = serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(json!([]));
    value.insert("skipped".into(), skipped);
    value.insert("createdAt".into(), json!(row.get::<_, String>(8)?));
    Ok(Value::Object(value))
}

/// Records a checkpoint for the session's registered root. Non-Git roots and
/// sessions without a project return `review_unavailable` without a row; other
/// snapshot failures are persisted as `failed` so the UI can report them.
fn capture(
    db: &Database,
    session_id: &str,
    kind: &str,
    operation_id: Option<&str>,
    label: Option<&str>,
    budget: Duration,
) -> Result<String> {
    if let Some(operation) = operation_id {
        let existing: Option<String> = db.transaction(|tx| {
            tx.execute_batch(SCHEMA)?;
            Ok(tx
                .query_row(
                    "SELECT id FROM review_checkpoints WHERE operation_id=?",
                    [operation],
                    |row| row.get(0),
                )
                .optional()?)
        })?;
        if let Some(id) = existing {
            return Ok(id);
        }
    }
    let scope = session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
    let deadline = Instant::now() + budget;
    let (store, tree, status, error, skipped) = match Store::open(db, &scope.root, deadline) {
        Ok(store) => match store.snapshot(deadline) {
            Ok(snapshot) => (Some(store), Some(snapshot.tree), "ready", None, snapshot.skipped),
            Err(error) => (Some(store), None, "failed", Some(error.to_string()), Vec::new()),
        },
        Err(error) if error.to_string().contains("git_unavailable") => {
            return Err(anyhow!("review_unavailable"));
        }
        Err(error) => (None, None, "failed", Some(error.to_string()), Vec::new()),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let label = label.map(|value| {
        let single = value.split_whitespace().collect::<Vec<_>>().join(" ");
        single.chars().take(MAX_LABEL_CHARS).collect::<String>()
    });
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO review_checkpoints(id,session_id,kind,label,operation_id,store,tree,status,error,skipped,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                session_id,
                kind,
                label,
                operation_id,
                store.as_ref().map(|store| store.objects.to_string_lossy().into_owned()),
                tree,
                status,
                error,
                serde_json::to_string(&skipped)?,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// Chat hook: snapshot before a turn is sent. Never fails the send.
pub fn capture_before_turn(
    db: &Database,
    session_id: &str,
    operation_id: &str,
    text: &str,
) -> Option<String> {
    let trace_timer = crate::send_trace::Timer::start();
    crate::send_trace::emit(crate::send_trace::Event::new("review.checkpoint.begin")
        .operation_id(operation_id).session_id(session_id).method("chat.send"));
    let checkpoint = capture(
        db,
        session_id,
        "turn",
        Some(operation_id),
        Some(text),
        TURN_BUDGET,
    )
    .ok();
    crate::send_trace::emit(crate::send_trace::Event::new("review.checkpoint.end")
        .operation_id(operation_id).session_id(session_id).method("chat.send")
        .outcome(if checkpoint.is_some() { "recorded" } else { "unavailable" })
        .duration_us(trace_timer.elapsed_us()));
    checkpoint
}

/// Attaches the provider turn id once `chat.send` has returned one.
pub fn attach_turn(db: &Database, checkpoint_id: &str, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else { return };
    let _ = db.transaction(|tx| {
        tx.execute(
            "UPDATE review_checkpoints SET turn_id=? WHERE id=?",
            params![turn_id, checkpoint_id],
        )?;
        Ok(())
    });
}

/// Tags the newest still-untagged pre-turn checkpoint for the session. The
/// `chat.turn.started` projection calls this so pairing no longer depends on
/// the `chat.send` response winning its race with the completion event.
pub fn attach_turn_to_latest(db: &Database, session_id: &str, turn_id: &str) {
    let _ = db.transaction(|tx| {
        tx.execute(
            "UPDATE review_checkpoints SET turn_id=? WHERE NOT EXISTS(SELECT 1 FROM review_checkpoints WHERE session_id=? AND turn_id=? AND kind='turn' AND COALESCE(operation_id,'') NOT LIKE 'turn-complete:%') AND id=(SELECT id FROM review_checkpoints WHERE session_id=? AND turn_id IS NULL AND kind='turn' AND COALESCE(operation_id,'') NOT LIKE 'turn-complete:%' ORDER BY created_at DESC, rowid DESC LIMIT 1) AND turn_id IS NULL",
            params![turn_id, session_id, turn_id, session_id],
        )?;
        Ok(())
    });
}

fn tagged_before_checkpoint(db: &Database, session_id: &str, turn_id: &str) -> Option<String> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT id FROM review_checkpoints WHERE session_id=? AND turn_id=? AND kind='turn' AND COALESCE(operation_id,'') NOT LIKE 'turn-complete:%' ORDER BY created_at ASC, rowid ASC LIMIT 1",
                params![session_id, turn_id],
                |row| row.get(0),
            )
            .optional()?)
    })
    .ok()
    .flatten()
}

/// Reuses an already complete immutable Chat review pair; never captures a new
/// tree or waits for the review worker when Group enrichment can use its fallback.
pub(crate) fn completed_group_turn_changes(db: &Database, session_id: &str, turn_id: &str, cwd: &str) -> Option<Vec<Value>> {
    let before = tagged_before_checkpoint(db, session_id, turn_id)?;
    let operation = format!("turn-complete:{session_id}:{turn_id}");
    let after: String = db.transaction(|tx| Ok(tx.query_row(
        "SELECT id FROM review_checkpoints WHERE session_id=? AND operation_id=? AND status='ready'",
        params![session_id, operation], |row| row.get(0))?)).ok()?;
    for id in [&before, &after] {
        let checkpoint = checkpoint_json(db,id).ok()?;
        if checkpoint["status"] != "ready" || !checkpoint["skipped"].as_array()?.is_empty() {return None;}
    }
    let scope = session_scope(db,session_id).ok()??;
    let root = scope.root.canonicalize().ok()?;
    let folder = Path::new(cwd).canonicalize().ok()?;
    let prefix = folder.strip_prefix(&root).ok()?;
    let (from,mut extra) = ready_tree(&checkpoint_row(db,session_id,&before).ok()?).ok()?;
    let (to,stores) = ready_tree(&checkpoint_row(db,session_id,&after).ok()?).ok()?;
    extra.extend(stores);
    let deadline = Instant::now()+Duration::from_secs(3);
    let store = Store::open(db,&scope.root,deadline).ok()?;
    Some(store.changes(&from,&to,&extra,deadline).ok()?.into_iter().filter_map(|file| {
        let path = Path::new(file["path"].as_str()?).strip_prefix(prefix).ok()?;
        if path.as_os_str().is_empty() {return None;}
        Some(json!({"path":path.to_string_lossy().replace('\\',"/"), "status":match file["status"].as_str(){Some("A")=>"added",Some("D")=>"deleted",_=>"modified"},"evidence":"folder"}))
    }).collect())
}

/// The fallback for a turn whose completion was projected before the send
/// handler tagged its checkpoint: adopt the newest untagged pre-turn row and
/// tag it now, so the pair is never lost and stays stable for replay.
fn adopt_untagged_checkpoint(db: &Database, session_id: &str, turn_id: &str) -> Option<String> {
    let id: Option<String> = db
        .transaction(|tx| {
            Ok(tx
                .query_row(
                    "SELECT id FROM review_checkpoints WHERE session_id=? AND turn_id IS NULL AND kind='turn' AND COALESCE(operation_id,'') NOT LIKE 'turn-complete:%' ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .ok()
        .flatten();
    let id = id?;
    let _ = db.transaction(|tx| {
        tx.execute(
            "UPDATE review_checkpoints SET turn_id=? WHERE id=? AND turn_id IS NULL",
            params![turn_id, id],
        )?;
        Ok(())
    });
    Some(id)
}

/// Captures the immutable post-turn tree and returns the compact comparison
/// metadata for the matching pre-turn checkpoint. This is deliberately called
/// by the service after projection has released its provider/SQLite fences.
pub fn capture_after_turn(db: &Database, session_id: &str, turn_id: &str) -> Option<crate::domain::ChatTurnReview> {
    let before = tagged_before_checkpoint(db, session_id, turn_id)
        .or_else(|| adopt_untagged_checkpoint(db, session_id, turn_id))?;
    let operation = format!("turn-complete:{session_id}:{turn_id}");
    let after = capture(db, session_id, "turn", Some(&operation), None, TURN_BUDGET).ok()?;
    attach_turn(db, &after, Some(turn_id));
    // A bounded checkpoint can omit files. Do not advertise a misleading count
    // for an incomplete pair.
    if checkpoint_json(db, &before).ok()?["skipped"].as_array().is_some_and(|files| !files.is_empty())
        || checkpoint_json(db, &after).ok()?["skipped"].as_array().is_some_and(|files| !files.is_empty()) {
        return None;
    }
    let scope = session_scope(db, session_id).ok()??;
    let (from, mut extra) = ready_tree(&checkpoint_row(db, session_id, &before).ok()?).ok()?;
    let (to, stores) = ready_tree(&checkpoint_row(db, session_id, &after).ok()?).ok()?;
    extra.extend(stores);
    let deadline = Instant::now() + TURN_BUDGET;
    let store = Store::open(db, &scope.root, deadline).ok()?;
    let file_count = store.changes(&from, &to, &extra, deadline).ok()?.len() as u64;
    Some(crate::domain::ChatTurnReview { from: before, to: after, file_count })
}

/// Terminal hook: snapshot an agent terminal launch in the background.
pub fn capture_launch_in_background(db: std::sync::Arc<Database>, session_id: String) {
    std::thread::spawn(move || {
        let _ = capture(&db, &session_id, "launch", None, None, REVIEW_BUDGET);
    });
}

/// One after-turn capture runs per session at a time. Later completions wait
/// on the same lock instead of overlapping Git work or dropping a review.
fn after_turn_session_lock(session_id: &str) -> Arc<Mutex<()>> {
    type Locks = HashMap<String, Arc<Mutex<()>>>;
    static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    locks.entry(session_id.to_owned()).or_default().clone()
}

/// Captures the post-turn tree away from the single provider-event projection
/// thread, then emits the updated item through `attach_turn_review`.
pub fn capture_after_turn_in_background(db: Arc<Database>, session_id: String, turn_id: String) {
    after_turn_worker(db, session_id, turn_id, capture_after_turn);
}

fn after_turn_worker<F>(db: Arc<Database>, session_id: String, turn_id: String, capture_turn: F)
where
    F: Fn(&Database, &str, &str) -> Option<crate::domain::ChatTurnReview> + Send + 'static,
{
    let lock = after_turn_session_lock(&session_id);
    std::thread::spawn(move || {
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(review) = capture_turn(&db, &session_id, &turn_id) {
            if let Err(error) = crate::chat_projection::attach_turn_review(&db, &session_id, &turn_id, review) {
                eprintln!("could not attach turn review for {session_id}: {error}");
            }
        }
    });
}

pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if let Some(result) = crate::session_documents::dispatch(db, method, params)? {
        return Ok(Some(result));
    }
    if !matches!(
        method,
        "review.list" | "review.changes" | "review.diff" | "review.revert" | "review.checkpoint"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("invalid_request"))
    };
    let session_id = string("sessionId")?;
    let result = match method {
        "review.list" => list(db, session_id)?,
        "review.checkpoint" => {
            let kind = string("kind")?;
            if !matches!(kind, "manual" | "baseline") {
                return Err(anyhow!("invalid_request"));
            }
            let operation_id = string("operationId")?;
            let id = capture(
                db,
                session_id,
                kind,
                Some(operation_id),
                None,
                REVIEW_BUDGET,
            )?;
            let value = checkpoint_json(db, &id)?;
            db.transaction(|tx| complete(tx, operation_id, method, &value, None))?;
            value
        }
        "review.changes" | "review.diff" => {
            let scope =
                session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
            let deadline = Instant::now() + REVIEW_BUDGET;
            let store = Store::open(db, &scope.root, deadline)?;
            let (from, mut extra) = ready_tree(&checkpoint_row(db, session_id, string("from")?)?)?;
            let to = match object.get("to").and_then(Value::as_str) {
                Some(id) => {
                    let (tree, stores) = ready_tree(&checkpoint_row(db, session_id, id)?)?;
                    extra.extend(stores);
                    Some(tree)
                }
                None => None,
            };
            if method == "review.changes" {
                let target = match to {
                    Some(tree) => tree,
                    None => store.snapshot(deadline)?.tree,
                };
                json!({"files":store.changes(&from, &target, &extra, deadline)?})
            } else {
                let path = string("path")?;
                validate_relative(path)?;
                diff(
                    &scope.root,
                    &store,
                    &from,
                    to.as_deref(),
                    &extra,
                    path,
                    deadline,
                )?
            }
        }
        "review.revert" => revert(db, session_id, object)?,
        _ => unreachable!(),
    };
    Ok(Some(result))
}

fn list(db: &Database, session_id: &str) -> Result<Value> {
    let Some(scope) = session_scope(db, session_id)? else {
        return Ok(json!({"available":false,"reason":"session_has_no_project","checkpoints":[]}));
    };
    let mut value = Map::new();
    value.insert("projectId".into(), json!(scope.project_id));
    if let Some(worktree) = &scope.worktree_path {
        value.insert("worktreePath".into(), json!(worktree));
    }
    if repo_prefix(&scope.root).is_err() {
        value.insert("available".into(), json!(false));
        value.insert("reason".into(), json!("git_unavailable"));
        value.insert("checkpoints".into(), json!([]));
        return Ok(Value::Object(value));
    }
    let checkpoints = db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT id, session_id, kind, turn_id, label, status, error, skipped, created_at FROM review_checkpoints WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200",
        )?;
        let rows = statement.query_map([session_id], |row| Ok(row_json(row)))?;
        let mut values = Vec::new();
        for row in rows {
            values.push(row??);
        }
        Ok(values)
    })?;
    value.insert("available".into(), json!(true));
    value.insert("checkpoints".into(), json!(checkpoints));
    Ok(Value::Object(value))
}

fn current_file(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    let lexical = scoped_path(root, path, false)?;
    match fs::symlink_metadata(&lexical) {
        Ok(meta) if meta.is_file() => {
            let target = scoped_path(root, path, true)?;
            if fs::metadata(&target)?.len() as usize > MAX_TEXT_BYTES {
                return Err(anyhow!("file_too_large"));
            }
            Ok(Some(fs::read(target)?))
        }
        Ok(_) => Err(anyhow!("file_reference_not_file")),
        Err(_) => Ok(None),
    }
}

fn diff(
    root: &Path,
    store: &Store,
    from: &str,
    to: Option<&str>,
    extra: &[PathBuf],
    path: &str,
    deadline: Instant,
) -> Result<Value> {
    let old = store.blob(from, path, extra, deadline)?;
    let (new, current) = match to {
        Some(tree) => (store.blob(tree, path, extra, deadline)?, None),
        None => {
            let current = current_file(root, path)?;
            (current.clone(), Some(current))
        }
    };
    let mut value = Map::new();
    value.insert("path".into(), json!(path));
    value.insert("exists".into(), json!(new.is_some()));
    if let Some(Some(bytes)) = &current {
        value.insert("fingerprint".into(), json!(fingerprint(bytes)));
    }
    match (
        text_of(old.as_deref().unwrap_or_default()),
        text_of(new.as_deref().unwrap_or_default()),
    ) {
        (Some(old), Some(new)) => {
            value.insert("oldText".into(), json!(old));
            value.insert("newText".into(), json!(new));
            value.insert("binary".into(), json!(false));
        }
        _ => {
            value.insert("oldText".into(), json!(""));
            value.insert("newText".into(), json!(""));
            value.insert("binary".into(), json!(true));
        }
    }
    Ok(Value::Object(value))
}

fn revert(db: &Database, session_id: &str, object: &Map<String, Value>) -> Result<Value> {
    let operation_id = object
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    let checkpoint_id = object
        .get("checkpointId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let paths: Vec<&str> = object
        .get("paths")
        .and_then(Value::as_array)
        .filter(|paths| !paths.is_empty() && paths.len() <= 500)
        .ok_or_else(|| anyhow!("invalid_paths"))?
        .iter()
        .map(|path| path.as_str().ok_or_else(|| anyhow!("invalid_path")))
        .collect::<Result<_>>()?;
    let expected = object
        .get("expectedFingerprints")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    let scope = session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
    let deadline = Instant::now() + REVIEW_BUDGET;
    let store = Store::open(db, &scope.root, deadline)?;
    let (tree, extra) = ready_tree(&checkpoint_row(db, session_id, checkpoint_id)?)?;
    // Preflight every file before changing any of them.
    let mut plan = Vec::new();
    for path in &paths {
        validate_relative(path)?;
        let current = current_file(&scope.root, path)?;
        let wanted = match expected.get(*path) {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => return Err(anyhow!("invalid_fingerprints")),
        };
        if current.as_deref().map(fingerprint).as_deref() != wanted {
            return Err(anyhow!("file_conflict"));
        }
        plan.push((
            *path,
            store.blob(&tree, path, &extra, deadline)?,
            current.is_some(),
        ));
    }
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    let mut restored = Vec::new();
    let mut recycled = Vec::new();
    for (path, content, exists) in plan {
        match content {
            Some(bytes) => {
                let target = if exists {
                    scoped_path(&scope.root, path, true)?
                } else {
                    contained_parent_for(&scope.root, path)?
                };
                // Never write through a predictable sibling temp name (F24).
                replace_file_atomically(&scope.root, &target, &bytes)?;
                restored.push(path.to_owned());
            }
            None if exists => {
                recycle(&scoped_path(&scope.root, path, false)?)?;
                recycled.push(path.to_owned());
            }
            None => {}
        }
    }
    let result = json!({"restored":restored,"recycled":recycled});
    db.transaction(|tx| {
        complete(
            tx,
            operation_id,
            "review.revert",
            &result,
            Some((&scope.project_id, scope.worktree_path.as_deref())),
        )
    })?;
    Ok(result)
}

/// One immutable file in an independent review snapshot. `None` means omitted
/// by the checkpoint capture bound, rather than an empty change.
#[derive(Debug)]
pub(crate) struct ReviewFile {
    pub path: String,
    pub status: String,
    pub diff: Option<String>,
    pub binary: bool,
}

/// Drain a read-only Git diff without retaining more than the remaining prompt
/// budget. Overflow drops the whole file; draining keeps the child from blocking
/// on a full pipe. Like run_git, this never takes optional index locks.
pub(crate) fn bounded_unified_diff(root: &Path, args: &[&str], env: &[(&str, &OsStr)], limit: usize, deadline: Instant) -> Result<Option<String>> {
    use std::{io::Read, process::{Command, Stdio}};
    if Instant::now() >= deadline { return Ok(None); }
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(["-c", "core.quotepath=off"]).args(args)
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (key, value) in env { command.env(key, value); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("git_failed"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("git_failed"))?;
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        (&mut stdout).take(limit as u64 + 1).read_to_end(&mut bytes)?;
        std::io::copy(&mut stdout, &mut std::io::sink())?;
        Ok::<_,std::io::Error>(bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        (&mut stderr).take(8192).read_to_end(&mut bytes)?;
        std::io::copy(&mut stderr, &mut std::io::sink())?;
        Ok::<_,std::io::Error>(bytes)
    });
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Ok(None); }
        std::thread::sleep(Duration::from_millis(5));
    };
    let bytes = output.join().map_err(|_| anyhow!("git_failed"))??;
    let errors = errors.join().map_err(|_| anyhow!("git_failed"))??;
    if !status.success() { return Err(anyhow!("git_failed: {}",String::from_utf8_lossy(&errors).trim())); }
    Ok((bytes.len() <= limit).then(|| String::from_utf8_lossy(&bytes).into_owned()))
}

pub(crate) fn binary_diff_paths(numstat: &[u8]) -> std::collections::HashSet<String> {
    String::from_utf8_lossy(numstat).split('\0').filter_map(|record| {
        record.strip_prefix("-\t-\t").map(str::to_owned)
    }).collect()
}

/// Capture once, then diff the two trees using the checkpoint's private object
/// store. No per-file re-snapshot, and no writes to the repository's index/refs.
pub(crate) fn unified_snapshot(db: &Database, session_id: &str, from_id: &str, to_id: Option<&str>) -> Result<Vec<ReviewFile>> {
    let scope = session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
    let (from, mut extra) = ready_tree(&checkpoint_row(db, session_id, from_id)?)?;
    let deadline = Instant::now() + REVIEW_BUDGET;
    let store = Store::open(db, &scope.root, deadline)?;
    let (to, skipped) = match to_id {
        Some(id) => {
            let (tree, stores) = ready_tree(&checkpoint_row(db, session_id, id)?)?;
            extra.extend(stores);
            let skipped = checkpoint_json(db, id)?["skipped"].as_array().cloned().unwrap_or_default();
            (tree, skipped.into_iter().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>())
        }
        None => { let snapshot = store.snapshot(deadline)?; (snapshot.tree, snapshot.skipped) }
    };
    let env = store.env(None, &extra)?;
    let borrowed: Vec<_> = env.iter().map(|(key,value)| (*key,value.as_os_str())).collect();
    let relative = format!("--relative={}", store.prefix);
    let binary_paths = binary_diff_paths(&store.run(&["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", &relative, &from, &to], &env, None, deadline)?);
    let (mut remaining, mut exhausted) = (crate::agent_review::DIFF_BUDGET, false);
    let mut files = Vec::new();
    for file in store.changes(&from, &to, &extra, deadline)? {
        let path = file["path"].as_str().unwrap().to_owned();
        let full_path = format!("{}{}", store.prefix, path);
        let binary = binary_paths.contains(&path);
        let diff = if binary { Some(String::new()) } else if exhausted { None } else {
            bounded_unified_diff(&store.top, &["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", &relative, &from, &to, "--", &full_path], &borrowed, remaining, deadline)?
        };
        files.push(crate::agent_review::retain_file(ReviewFile { path, status: file["status"].as_str().unwrap().to_owned(), diff, binary }, &mut remaining, &mut exhausted));
    }
    for path in skipped {
        if !files.iter().any(|file| file.path == path) {
            files.push(ReviewFile { path, status: "M".into(), diff: None, binary: false });
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::git;

    fn setup() -> (tempfile::TempDir, Database, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo 仓库");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(&repo, &["config", "user.email", "qa@example.test"]).unwrap();
        git(&repo, &["config", "user.name", "QA"]).unwrap();
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        fs::write(repo.join("gone.txt"), "bye\n").unwrap();
        fs::write(repo.join(".gitignore"), "ignored/\n").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "init"]).unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let db = Database::open(&data.join("db.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let session = db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s1',?,'t','codex','chat','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                    [&project.id],
                )?;
                Ok("s1".to_owned())
            })
            .unwrap();
        (temp, db, repo, session)
    }

    fn call(db: &Database, method: &str, params: Value) -> Result<Value> {
        dispatch(db, method, &params).map(Option::unwrap)
    }

    fn ready_tree_for(db: &Database, checkpoint: &str) -> String {
        let row = checkpoint_row(db, "s1", checkpoint).unwrap();
        assert_eq!(row.status, "ready");
        row.tree.unwrap()
    }

    #[test]
    fn persistent_index_reuses_the_tree_and_captures_changed_untracked_and_deleted_files() {
        let (_temp, db, repo, _session) = setup();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        let first = store.snapshot(deadline()).unwrap();
        let private_before = fs::read(&store.private_index).unwrap();
        let second = store.snapshot(deadline()).unwrap();
        assert_eq!(second.tree, first.tree);
        assert_eq!(fs::read(&store.private_index).unwrap(), private_before);

        fs::write(repo.join("a.txt"), "two\n").unwrap();
        fs::write(repo.join("new.txt"), "new\n").unwrap();
        fs::remove_file(repo.join("gone.txt")).unwrap();
        let changed = store.snapshot(deadline()).unwrap();
        assert_eq!(
            store
                .blob(&changed.tree, "a.txt", &[], deadline())
                .unwrap()
                .unwrap(),
            b"two\n"
        );
        assert_eq!(
            store
                .blob(&changed.tree, "new.txt", &[], deadline())
                .unwrap()
                .unwrap(),
            b"new\n"
        );
        assert!(store
            .blob(&changed.tree, "gone.txt", &[], deadline())
            .unwrap()
            .is_none());
        fs::remove_file(repo.join("new.txt")).unwrap();
        let deleted = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&deleted.tree, "new.txt", &[], deadline())
            .unwrap()
            .is_none());
    }

    #[test]
    fn persistent_index_rehashes_a_racily_clean_file() {
        use std::fs::FileTimes;

        let (_temp, db, repo, _session) = setup();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        store.snapshot(deadline()).unwrap();
        let env = store.env(Some(&store.private_index), &[]).unwrap();
        store
            .run(&["update-index", "--refresh"], &env, None, deadline())
            .unwrap();
        let stamp = fs::metadata(repo.join("a.txt")).unwrap().modified().unwrap();
        fs::File::options()
            .write(true)
            .open(&store.private_index)
            .unwrap()
            .set_times(FileTimes::new().set_modified(stamp))
            .unwrap();
        fs::write(repo.join("a.txt"), "two\n").unwrap();
        fs::File::options()
            .write(true)
            .open(repo.join("a.txt"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(stamp))
            .unwrap();

        let snapshot = store.snapshot(deadline()).unwrap();
        assert_eq!(
            store
                .blob(&snapshot.tree, "a.txt", &[], deadline())
                .unwrap()
                .unwrap(),
            b"two\n"
        );
    }

    #[test]
    fn changed_ignore_rules_remove_private_only_paths() {
        let (_temp, db, repo, _session) = setup();
        let deadline = || Instant::now() + TURN_BUDGET;
        let global_ignore = repo.join("relative-ignore");
        git(
            &repo,
            &[
                "config",
                "core.excludesFile",
                "relative-ignore",
            ],
        )
        .unwrap();
        let store = Store::open(&db, &repo, deadline()).unwrap();
        fs::create_dir(repo.join("generated")).unwrap();
        fs::write(repo.join("generated").join("output.txt"), "generated\n").unwrap();
        let included = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&included.tree, "generated/output.txt", &[], deadline())
            .unwrap()
            .is_some());

        fs::write(repo.join(".gitignore"), "ignored/\ngenerated/\n").unwrap();
        let ignored = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&ignored.tree, "generated/output.txt", &[], deadline())
            .unwrap()
            .is_none());

        fs::write(repo.join("external.txt"), "external\n").unwrap();
        let included = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&included.tree, "external.txt", &[], deadline())
            .unwrap()
            .is_some());
        let (_, paths) = repo_paths_until(&repo, deadline()).unwrap();
        let info = paths.common.join("info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("exclude"), "external.txt\n").unwrap();
        let ignored = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&ignored.tree, "external.txt", &[], deadline())
            .unwrap()
            .is_none());

        fs::write(repo.join("global.txt"), "global\n").unwrap();
        let included = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&included.tree, "global.txt", &[], deadline())
            .unwrap()
            .is_some());
        fs::write(global_ignore, "global.txt\n").unwrap();
        let ignored = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&ignored.tree, "global.txt", &[], deadline())
            .unwrap()
            .is_none());

        fs::create_dir(repo.join("self-ignored")).unwrap();
        fs::write(repo.join("self-ignored").join("prior.txt"), "prior\n").unwrap();
        let included = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&included.tree, "self-ignored/prior.txt", &[], deadline())
            .unwrap()
            .is_some());
        fs::write(repo.join("self-ignored").join(".gitignore"), "*\n").unwrap();
        let ignored = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&ignored.tree, "self-ignored/prior.txt", &[], deadline())
            .unwrap()
            .is_none());
    }

    #[test]
    fn default_global_ignore_uses_xdg_then_home_without_mutating_process_environment() {
        assert_eq!(
            default_global_ignore_from(
                Some(OsStr::new("/xdg")),
                Some(OsStr::new("/home")),
                None,
            ),
            Some(PathBuf::from("/xdg").join("git").join("ignore"))
        );
        assert_eq!(
            default_global_ignore_from(None, Some(OsStr::new("/home")), None),
            Some(PathBuf::from("/home").join(".config").join("git").join("ignore"))
        );
    }

    #[test]
    fn newly_created_include_file_invalidates_cached_ignore_discovery() {
        let (_temp, db, repo, _session) = setup();
        let include = repo.parent().unwrap().join("missing-include.config");
        let excludes = repo.parent().unwrap().join("included-ignore");
        git(
            &repo,
            &["config", "include.path", include.to_str().unwrap()],
        )
        .unwrap();
        fs::write(repo.join("included.txt"), "included\n").unwrap();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        let first = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&first.tree, "included.txt", &[], deadline())
            .unwrap()
            .is_some());

        fs::write(
            &include,
            format!(
                "[core]\n\texcludesFile = \"{}\"\n",
                excludes.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        fs::write(&excludes, "included.txt\n").unwrap();
        let refreshed = Store::open(&db, &repo, deadline()).unwrap();
        let second = refreshed.snapshot(deadline()).unwrap();
        assert!(refreshed
            .blob(&second.tree, "included.txt", &[], deadline())
            .unwrap()
            .is_none());
    }

    #[test]
    fn branch_conditional_include_invalidates_discovery_at_the_same_tree() {
        let (_temp, db, repo, _session) = setup();
        let include = repo.parent().unwrap().join("feature.config");
        let excludes = repo.parent().unwrap().join("feature-ignore");
        fs::write(
            &include,
            format!(
                "[core]\n\texcludesFile = \"{}\"\n",
                excludes.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        fs::write(&excludes, "branch-only.txt\n").unwrap();
        git(
            &repo,
            &[
                "config",
                "includeIf.onbranch:feature.path",
                include.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(&repo, &["branch", "feature"]).unwrap();
        fs::write(repo.join("branch-only.txt"), "branch\n").unwrap();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        let first = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&first.tree, "branch-only.txt", &[], deadline())
            .unwrap()
            .is_some());

        git(&repo, &["switch", "-q", "feature"]).unwrap();
        let refreshed = Store::open(&db, &repo, deadline()).unwrap();
        let second = refreshed.snapshot(deadline()).unwrap();
        assert!(refreshed
            .blob(&second.tree, "branch-only.txt", &[], deadline())
            .unwrap()
            .is_none());
    }

    #[test]
    fn public_index_change_resets_the_private_index_without_writing_the_public_one() {
        let (_temp, db, repo, _session) = setup();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        store.snapshot(deadline()).unwrap();
        fs::create_dir(repo.join("ignored")).unwrap();
        fs::write(repo.join("ignored").join("tracked.txt"), "tracked\n").unwrap();
        git(&repo, &["add", "-f", "ignored/tracked.txt"]).unwrap();
        let public_index = fs::read(repo.join(".git").join("index")).unwrap();
        let snapshot = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&snapshot.tree, "ignored/tracked.txt", &[], deadline())
            .unwrap()
            .is_some());
        assert_eq!(fs::read(repo.join(".git").join("index")).unwrap(), public_index);
    }

    #[test]
    fn split_index_is_flattened_privately_without_touching_public_index_files() {
        let (_temp, db, repo, session) = setup();
        git(&repo, &["config", "core.splitIndex", "true"]).unwrap();
        fs::write(repo.join("a.txt"), "staged\n").unwrap();
        git(&repo, &["add", "a.txt"]).unwrap();
        git(&repo, &["update-index", "--split-index"]).unwrap();
        fs::write(repo.join("a.txt"), "worktree one\n").unwrap();
        fs::write(repo.join("untracked.txt"), "untracked\n").unwrap();

        let git_dir = repo.join(".git");
        let public_index = git_dir.join("index");
        let sentinel = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        let set_sentinel = |path: &Path| {
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(sentinel))
                .unwrap();
        };
        set_sentinel(&public_index);
        let shared_paths = || {
            let mut paths: Vec<PathBuf> = fs::read_dir(&git_dir)
                .unwrap()
                .map(Result::unwrap)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(OsStr::to_str)
                        .is_some_and(|name| name.starts_with("sharedindex."))
                })
                .collect();
            paths.sort();
            paths
        };
        let shared = shared_paths();
        assert!(!shared.is_empty());
        for path in &shared {
            set_sentinel(path);
        }
        let public_before = (
            fs::read(&public_index).unwrap(),
            fs::metadata(&public_index).unwrap().modified().unwrap(),
        );
        let shared_before: Vec<_> = shared
            .iter()
            .map(|path| {
                (
                    path.file_name().unwrap().to_owned(),
                    fs::read(path).unwrap(),
                    fs::metadata(path).unwrap().modified().unwrap(),
                )
            })
            .collect();

        let first = capture_before_turn(&db, &session, "split-first", "split").unwrap();
        let first_tree = ready_tree_for(&db, &first);
        let deadline = Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline).unwrap();
        assert_eq!(
            store
                .blob(&first_tree, "a.txt", &[], deadline)
                .unwrap()
                .unwrap(),
            b"worktree one\n"
        );
        assert_eq!(
            store
                .blob(&first_tree, "untracked.txt", &[], deadline)
                .unwrap()
                .unwrap(),
            b"untracked\n"
        );

        fs::write(repo.join("a.txt"), "worktree two\n").unwrap();
        let second = capture_before_turn(&db, &session, "split-second", "split").unwrap();
        let second_tree = ready_tree_for(&db, &second);
        assert_eq!(
            store
                .blob(
                    &second_tree,
                    "a.txt",
                    &[],
                    Instant::now() + TURN_BUDGET,
                )
                .unwrap()
                .unwrap(),
            b"worktree two\n"
        );

        assert_eq!(fs::read(&public_index).unwrap(), public_before.0);
        assert_eq!(
            fs::metadata(&public_index).unwrap().modified().unwrap(),
            public_before.1
        );
        let shared_after: Vec<_> = shared_paths()
            .iter()
            .map(|path| {
                (
                    path.file_name().unwrap().to_owned(),
                    fs::read(path).unwrap(),
                    fs::metadata(path).unwrap().modified().unwrap(),
                )
            })
            .collect();
        assert_eq!(shared_after, shared_before);
    }

    #[test]
    fn sha256_split_index_uses_a_matching_private_repository_format() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("sha256");
        fs::create_dir(&repo).unwrap();
        if git(
            &repo,
            &["init", "-q", "-b", "main", "--object-format=sha256"],
        )
        .is_err()
        {
            return;
        }
        git(&repo, &["config", "core.splitIndex", "true"]).unwrap();
        fs::write(repo.join("sha.txt"), "sha256 worktree\n").unwrap();
        git(&repo, &["add", "sha.txt"]).unwrap();
        git(&repo, &["update-index", "--split-index"]).unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let db = Database::open(&data.join("db.sqlite")).unwrap();
        let deadline = Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline).unwrap();
        let snapshot = store.snapshot(deadline).unwrap();
        assert_eq!(
            store
                .blob(
                    &snapshot.tree,
                    "sha.txt",
                    &[],
                    Instant::now() + TURN_BUDGET,
                )
                .unwrap()
                .unwrap(),
            b"sha256 worktree\n"
        );
    }

    #[test]
    fn linked_worktree_split_index_is_never_freshened_publicly() {
        let (temp, db, repo, _session) = setup();
        let linked = temp.path().join("linked worktree");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(&linked, &["config", "core.splitIndex", "true"]).unwrap();
        fs::write(linked.join("a.txt"), "linked staged\n").unwrap();
        git(&linked, &["add", "a.txt"]).unwrap();
        git(&linked, &["update-index", "--split-index"]).unwrap();
        fs::write(linked.join("a.txt"), "linked worktree\n").unwrap();
        let (_, paths) = repo_paths_until(&linked, Instant::now() + TURN_BUDGET).unwrap();
        let git_dir = paths.index.parent().unwrap();
        let mut shared: Vec<PathBuf> = fs::read_dir(git_dir)
            .unwrap()
            .map(Result::unwrap)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with("sharedindex."))
            })
            .collect();
        shared.sort();
        assert!(!shared.is_empty());
        let sentinel = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        for path in std::iter::once(&paths.index).chain(shared.iter()) {
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(sentinel))
                .unwrap();
        }
        let public_index = fs::read(&paths.index).unwrap();
        let shared_before: Vec<_> = shared
            .iter()
            .map(|path| (path.clone(), fs::read(path).unwrap()))
            .collect();
        let deadline = Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &linked, deadline).unwrap();
        let first = store.snapshot(deadline).unwrap();
        assert_eq!(
            store
                .blob(
                    &first.tree,
                    "a.txt",
                    &[],
                    Instant::now() + TURN_BUDGET,
                )
                .unwrap()
                .unwrap(),
            b"linked worktree\n"
        );
        store.snapshot(Instant::now() + TURN_BUDGET).unwrap();
        assert_eq!(fs::read(&paths.index).unwrap(), public_index);
        assert_eq!(
            fs::metadata(&paths.index).unwrap().modified().unwrap(),
            sentinel
        );
        let shared_after: Vec<_> = shared
            .iter()
            .map(|path| {
                assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), sentinel);
                (path.clone(), fs::read(path).unwrap())
            })
            .collect();
        assert_eq!(shared_after, shared_before);
    }

    #[test]
    fn missing_private_index_in_an_unborn_repository_never_reuses_a_stale_tree() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("unborn");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let db = Database::open(&data.join("db.sqlite")).unwrap();
        let deadline = || Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline()).unwrap();
        fs::write(repo.join("only.txt"), "only\n").unwrap();
        let first = store.snapshot(deadline()).unwrap();
        assert!(store
            .blob(&first.tree, "only.txt", &[], deadline())
            .unwrap()
            .is_some());
        fs::remove_file(&store.private_index).unwrap();
        fs::remove_file(repo.join("only.txt")).unwrap();
        let second = store.snapshot(deadline()).unwrap();
        assert_ne!(second.tree, first.tree);
        assert!(store
            .blob(&second.tree, "only.txt", &[], deadline())
            .unwrap()
            .is_none());
    }

    #[test]
    fn concurrent_checkpoints_share_the_private_object_writer_without_failures() {
        let (_temp, db, repo, session) = setup();
        let second_session = db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) SELECT 's-concurrent',project_id,'t2','codex','chat','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM sessions WHERE id=?",
                    [&session],
                )?;
                Ok("s-concurrent".to_owned())
            })
            .unwrap();
        for index in 0..128 {
            fs::write(repo.join(format!("same-{index}.txt")), b"same object\n").unwrap();
        }
        let db = Arc::new(db);
        let gate = Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        let sessions = [session, second_session];
        for (index, session) in sessions.clone().into_iter().enumerate() {
            let db = Arc::clone(&db);
            let gate = Arc::clone(&gate);
            workers.push(std::thread::spawn(move || {
                gate.wait();
                capture_before_turn(&db, &session, &format!("concurrent-{index}"), "same")
                    .unwrap()
            }));
        }
        gate.wait();
        let checkpoints: Vec<String> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let trees: Vec<String> = checkpoints
            .iter()
            .zip(sessions.iter())
            .map(|(checkpoint, session)| {
                let row = checkpoint_row(&db, session, checkpoint).unwrap();
                assert_eq!(row.status, "ready");
                row.tree.unwrap()
            })
            .collect();
        assert_eq!(trees[0], trees[1]);
    }

    #[test]
    fn corrupt_private_index_records_failure_and_the_next_capture_recovers_cold() {
        let (_temp, db, repo, session) = setup();
        let deadline = Instant::now() + TURN_BUDGET;
        let store = Store::open(&db, &repo, deadline).unwrap();
        store.snapshot(deadline).unwrap();
        fs::write(&store.private_index, b"not an index").unwrap();

        let failed = capture(&db, &session, "turn", Some("corrupt"), Some("x"), TURN_BUDGET)
            .unwrap();
        let row = checkpoint_row(&db, &session, &failed).unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.tree.is_none());
        assert!(!store.private_index.exists());

        let recovered = capture_before_turn(&db, &session, "after-corrupt", "x").unwrap();
        ready_tree_for(&db, &recovered);
    }

    #[test]
    fn shared_object_writer_wait_obeys_the_checkpoint_deadline() {
        let (_temp, db, repo, _session) = setup();
        let store = Store::open(&db, &repo, Instant::now() + TURN_BUDGET).unwrap();
        let _held = store.writer_lock.lock().unwrap();
        let started = Instant::now();
        let error = match store.snapshot(Instant::now() + Duration::from_millis(25)) {
            Ok(_) => panic!("the held writer lock must consume the deadline"),
            Err(error) => error,
        };
        assert_eq!(
            error.to_string(),
            "git_timeout"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn explicit_turn_attachment_corrects_a_speculative_mismatch_and_delayed_events_do_not_steal() {
        let (_temp, db, _repo, session) = setup();
        let first = capture_before_turn(&db, &session, "attach-1", "first").unwrap();
        attach_turn(&db, &first, Some("turn-1"));
        let second = capture_before_turn(&db, &session, "attach-2", "second").unwrap();

        attach_turn_to_latest(&db, &session, "turn-1");
        assert!(checkpoint_row(&db, &session, &second).unwrap().tree.is_some());
        let untagged: Option<String> = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT turn_id FROM review_checkpoints WHERE id=?",
                    [&second],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(untagged, None);

        db.transaction(|tx| {
            tx.execute(
                "UPDATE review_checkpoints SET turn_id='turn-1' WHERE id=?",
                [&second],
            )?;
            Ok(())
        })
        .unwrap();
        attach_turn(&db, &second, Some("turn-2"));
        assert_eq!(
            checkpoint_json(&db, &second).unwrap()["turnId"],
            "turn-2"
        );
    }

    #[test]
    #[ignore = "opt-in synthetic checkpoint timing probe"]
    fn checkpoint_performance_probe() {
        let (_temp, db, repo, _session) = setup();
        let tracked = repo.join("tracked");
        fs::create_dir(&tracked).unwrap();
        for index in 0..3000 {
            fs::write(tracked.join(format!("file-{index}.txt")), format!("tracked {index}\n"))
                .unwrap();
        }
        git(&repo, &["add", "tracked"]).unwrap();
        git(&repo, &["commit", "-qm", "fixture"]).unwrap();
        let build = repo.join("untracked-build");
        fs::create_dir(&build).unwrap();
        for index in 0..5000 {
            fs::write(build.join(format!("object-{index}.o")), b"same object\n").unwrap();
        }
        for index in 0..8 {
            fs::File::create(build.join(format!("large-{index}.bin")))
                .unwrap()
                .set_len(8 * 1024 * 1024)
                .unwrap();
        }
        let store = Store::open(&db, &repo, Instant::now() + TURN_BUDGET).unwrap();
        let started = Instant::now();
        store.snapshot(Instant::now() + TURN_BUDGET).unwrap();
        let first = started.elapsed();
        let mut repeated = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            store.snapshot(Instant::now() + TURN_BUDGET).unwrap();
            repeated.push(started.elapsed());
        }
        eprintln!("checkpoint performance: first={first:?}, repeated={repeated:?}");
    }

    #[test]
    fn checkpoints_capture_review_and_revert_without_touching_the_repository() {
        let (temp, db, repo, session) = setup();
        // Uncommitted state before the turn is part of the baseline.
        fs::write(repo.join("a.txt"), "one\nlocal\n").unwrap();
        let index_before = fs::read(repo.join(".git").join("index")).unwrap();
        let refs_before = git(&repo, &["for-each-ref"]).unwrap();
        let objects_before = git(&repo, &["count-objects", "-v"]).unwrap();

        let checkpoint = capture_before_turn(&db, &session, "send-1", "Fix   the\nbug").unwrap();
        attach_turn(&db, &checkpoint, Some("turn-1"));
        assert_eq!(
            capture_before_turn(&db, &session, "send-1", "again").unwrap(),
            checkpoint
        );

        // The "agent" edits, adds (including an ignored file) and deletes.
        fs::write(repo.join("a.txt"), "one\nlocal\nagent\n").unwrap();
        fs::create_dir(repo.join("src")).unwrap();
        fs::write(repo.join("src").join("新.ts"), "new\n").unwrap();
        fs::create_dir(repo.join("ignored")).unwrap();
        fs::write(repo.join("ignored").join("x"), "x").unwrap();
        fs::remove_file(repo.join("gone.txt")).unwrap();

        let listed = call(&db, "review.list", json!({"sessionId":session})).unwrap();
        assert_eq!(listed["available"], true);
        assert_eq!(listed["checkpoints"][0]["turnId"], "turn-1");
        assert_eq!(listed["checkpoints"][0]["label"], "Fix the bug");
        assert_eq!(
            listed["checkpoints"][0]["status"], "ready",
            "{}",
            listed["checkpoints"][0]["error"]
        );

        let changes = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint}),
        )
        .unwrap();
        let mut files: Vec<(String, String)> = changes["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap().to_owned(),
                    file["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![
                ("a.txt".to_owned(), "M".to_owned()),
                ("gone.txt".to_owned(), "D".to_owned()),
                ("src/新.ts".to_owned(), "A".to_owned()),
            ]
        );

        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap();
        assert_eq!(diff["oldText"], "one\nlocal\n");
        assert_eq!(diff["newText"], "one\nlocal\nagent\n");
        assert_eq!(diff["exists"], true);
        let current = diff["fingerprint"].as_str().unwrap().to_owned();

        // Stale fingerprints are refused before anything changes.
        assert!(call(&db, "review.revert", json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":"stale"},"operationId":"r0"})).unwrap_err().to_string().contains("file_conflict"));
        let reverted = call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt","gone.txt"],"expectedFingerprints":{"a.txt":current,"gone.txt":null},"operationId":"r1"}),
        )
        .unwrap();
        assert_eq!(reverted["restored"], json!(["a.txt", "gone.txt"]));
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            "one\nlocal\n"
        );
        assert_eq!(fs::read_to_string(repo.join("gone.txt")).unwrap(), "bye\n");

        // The repository itself was never written by checkpointing or review.
        assert_eq!(
            fs::read(repo.join(".git").join("index")).unwrap(),
            index_before
        );
        assert_eq!(git(&repo, &["for-each-ref"]).unwrap(), refs_before);
        assert_eq!(
            git(&repo, &["count-objects", "-v"]).unwrap(),
            objects_before
        );
        assert!(temp.path().join("data").join("review-objects").is_dir());

        let manual = call(
            &db,
            "review.checkpoint",
            json!({"sessionId":session,"kind":"baseline","operationId":"cp"}),
        )
        .unwrap();
        assert_eq!(manual["kind"], "baseline");
        let since = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":manual["id"]}),
        )
        .unwrap();
        assert_eq!(since["files"], json!([]));
        let between = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint,"to":manual["id"]}),
        )
        .unwrap();
        assert_eq!(between["files"], json!([{"path":"src/新.ts","status":"A","added":1,"removed":0}]));
    }

    fn store_oid(store: &Store, tree: &str, path: &str) -> String {
        let env = store.env(None, &[]).unwrap();
        String::from_utf8(
            store
                .run(
                    &["rev-parse", &format!("{tree}:{path}")],
                    &env,
                    None,
                    Instant::now() + TURN_BUDGET,
                )
                .unwrap(),
        )
        .unwrap()
        .trim()
        .to_owned()
    }

    fn writable_store_object(store: &Store, oid: &str) -> PathBuf {
        let path = store.objects.join(&oid[..2]).join(&oid[2..]);
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[test]
    fn a_missing_checkpoint_blob_fails_closed_and_never_touches_the_worktree() {
        let (_temp, db, repo, session) = setup();
        // Uncommitted bytes live only in the private review store.
        fs::write(repo.join("a.txt"), "private baseline\n").unwrap();
        let checkpoint = capture_before_turn(&db, &session, "send-missing-blob", "change").unwrap();
        fs::write(repo.join("a.txt"), "later content\n").unwrap();
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap();
        assert_eq!(diff["oldText"], "private baseline\n");
        let fingerprint = diff["fingerprint"].as_str().unwrap().to_owned();

        let store = Store::open(&db, &repo, Instant::now() + TURN_BUDGET).unwrap();
        let tree = ready_tree_for(&db, &checkpoint);
        fs::remove_file(writable_store_object(&store, &store_oid(&store, &tree, "a.txt"))).unwrap();

        let error = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        let error = call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":fingerprint},"operationId":"revert-missing-blob"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            "later content\n",
            "a revert must not change a file it cannot verify"
        );
    }

    #[test]
    fn a_corrupt_checkpoint_blob_fails_closed_and_never_touches_the_worktree() {
        let (_temp, db, repo, session) = setup();
        fs::write(repo.join("a.txt"), "private baseline\n").unwrap();
        let checkpoint = capture_before_turn(&db, &session, "send-corrupt-blob", "change").unwrap();
        fs::write(repo.join("a.txt"), "later content\n").unwrap();
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap();
        let fingerprint = diff["fingerprint"].as_str().unwrap().to_owned();

        let store = Store::open(&db, &repo, Instant::now() + TURN_BUDGET).unwrap();
        let tree = ready_tree_for(&db, &checkpoint);
        let path = writable_store_object(&store, &store_oid(&store, &tree, "a.txt"));
        fs::write(&path, b"not a git object").unwrap();

        let error = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        let error = call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":fingerprint},"operationId":"revert-corrupt-blob"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "later content\n");
    }

    #[test]
    fn an_unavailable_checkpoint_store_fails_closed_and_never_touches_the_worktree() {
        let (temp, db, repo, session) = setup();
        fs::write(repo.join("a.txt"), "private baseline\n").unwrap();
        let checkpoint = capture_before_turn(&db, &session, "send-missing-store", "change").unwrap();
        fs::write(repo.join("a.txt"), "later content\n").unwrap();
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap();
        let fingerprint = diff["fingerprint"].as_str().unwrap().to_owned();

        let store = Store::open(&db, &repo, Instant::now() + TURN_BUDGET).unwrap();
        fs::rename(&store.objects, temp.path().join("unavailable-review-objects")).unwrap();

        let error = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        let error = call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":fingerprint},"operationId":"revert-missing-store"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checkpoint_unavailable"), "{error}");
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "later content\n");
    }

    #[test]
    fn a_verified_absent_baseline_file_keeps_the_recycle_flow() {
        let (_temp, db, repo, session) = setup();
        let checkpoint = capture_before_turn(&db, &session, "send-absent", "add a file").unwrap();
        fs::write(repo.join("added.txt"), "added later\n").unwrap();
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"added.txt"}),
        )
        .unwrap();
        assert_eq!(diff["exists"], true);
        assert_eq!(diff["oldText"], "");
        let fingerprint = diff["fingerprint"].as_str().unwrap().to_owned();
        match call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["added.txt"],"expectedFingerprints":{"added.txt":fingerprint},"operationId":"revert-absent"}),
        ) {
            Ok(value) => {
                assert_eq!(value["recycled"], json!(["added.txt"]));
                assert!(!repo.join("added.txt").exists());
            }
            // Volumes without a Recycle Bin refuse instead of deleting.
            Err(error) => assert!(error.to_string().contains("recycle_unavailable"), "{error}"),
        }
    }

    #[test]
    fn completion_checkpoint_pairs_the_turn_and_counts_changed_files() {
        let (_temp, db, repo, session) = setup();
        let before = capture_before_turn(&db, &session, "send-pair", "edit files").unwrap();
        attach_turn(&db, &before, Some("turn-pair"));
        fs::write(repo.join("a.txt"), "changed\n").unwrap();
        fs::write(repo.join("new.txt"), "new\n").unwrap();
        fs::remove_file(repo.join("gone.txt")).unwrap();
        let review = capture_after_turn(&db, &session, "turn-pair").unwrap();
        assert_eq!(review.from, before);
        assert_eq!(review.file_count, 3);
        assert_ne!(review.from, review.to);
        fs::write(repo.join("after-completion.txt"), "not part of this turn\n").unwrap();
        assert_eq!(capture_after_turn(&db, &session, "turn-pair").unwrap(), review);
    }

    #[test]
    fn fast_completion_pairs_without_the_send_attaching_the_turn_id() {
        let (_temp, db, repo, session) = setup();
        let before = capture_before_turn(&db, &session, "send-fast", "edit").unwrap();
        // `chat.turn.started` projection tags the newest untagged checkpoint;
        // the completion can then pair even though `chat.send` never returned.
        attach_turn_to_latest(&db, &session, "turn-fast");
        fs::write(repo.join("a.txt"), "fast\n").unwrap();
        let review = capture_after_turn(&db, &session, "turn-fast").unwrap();
        assert_eq!(review.from, before);
        assert_eq!(review.file_count, 1);
        // Fallback: a completion that beat even the `chat.turn.started`
        // projection still adopts the newest untagged pre-turn checkpoint.
        let before2 = capture_before_turn(&db, &session, "send-fast-2", "edit again").unwrap();
        fs::write(repo.join("a.txt"), "faster\n").unwrap();
        let review2 = capture_after_turn(&db, &session, "turn-fast-2").unwrap();
        assert_eq!(review2.from, before2);
        assert_eq!(review2.file_count, 1);
    }

    #[test]
    fn after_turn_capture_runs_off_the_caller_and_still_attaches() {
        let (_temp, db, _repo, session) = setup();
        let db = Arc::new(db);
        crate::chat_projection::record(
            &db,
            &session,
            Some("turn-async"),
            "chat.item",
            &json!({"item":{"id":"assistant-async"},"parts":[{"type":"text","text":"answer"}]}),
        )
        .unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        after_turn_worker(
            Arc::clone(&db),
            session.clone(),
            "turn-async".to_owned(),
            move |_db, _session, _turn| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Some(crate::domain::ChatTurnReview {
                    from: "before".into(),
                    to: "after".into(),
                    file_count: 2,
                })
            },
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the projection caller returns before the capture finishes"
        );
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the worker started its capture");
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let attached = db
                .chat_items(&session)
                .unwrap()
                .iter()
                .any(|item| item.turn_review.is_some());
            if attached {
                break;
            }
            assert!(Instant::now() < deadline, "the review attaches once the capture completes");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn non_git_roots_report_unavailable_without_rows() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain");
        fs::create_dir(&plain).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        let project = db
            .add_project(plain.to_str().unwrap(), Some("p"), "op")
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s2',?,'t','shell','terminal','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [&project.id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(capture_before_turn(&db, "s2", "op-1", "x").is_none());
        let listed = call(&db, "review.list", json!({"sessionId":"s2"})).unwrap();
        assert_eq!(listed["available"], false);
        assert_eq!(listed["reason"], "git_unavailable");
    }

    #[test]
    fn expired_discovery_budget_records_failure_without_touching_repository() {
        let (temp, db, repo, session) = setup();
        let index_before = fs::read(repo.join(".git").join("index")).unwrap();
        let refs_before = git(&repo, &["for-each-ref"]).unwrap();
        let objects_before = git(&repo, &["count-objects", "-v"]).unwrap();

        let started = Instant::now();
        let checkpoint = capture(
            &db,
            &session,
            "turn",
            Some("expired-discovery"),
            Some("x"),
            Duration::ZERO,
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));

        let row = db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT store,tree,status,error FROM review_checkpoints WHERE id=?",
                    [&checkpoint],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(row.0, None);
        assert_eq!(row.1, None);
        assert_eq!(row.2, "failed");
        assert_eq!(row.3.as_deref(), Some("git_timeout"));
        assert_eq!(fs::read(repo.join(".git").join("index")).unwrap(), index_before);
        assert_eq!(git(&repo, &["for-each-ref"]).unwrap(), refs_before);
        assert_eq!(git(&repo, &["count-objects", "-v"]).unwrap(), objects_before);
        assert!(!temp.path().join("data").join("review-objects").exists());
    }

    #[test]
    fn subdirectory_roots_only_review_their_own_files() {
        let (_temp, db, repo, session) = setup();
        fs::create_dir(repo.join("pkg")).unwrap();
        fs::write(repo.join("pkg").join("in.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "pkg"]).unwrap();
        let project = db
            .add_project(
                repo.join("pkg").to_str().unwrap(),
                Some("pkg"),
                "project-pkg",
            )
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET project_id=? WHERE id=?",
                params![project.id, session],
            )?;
            Ok(())
        })
        .unwrap();
        let checkpoint = capture_before_turn(&db, &session, "send-sub", "x").unwrap();
        fs::write(repo.join("pkg").join("in.txt"), "b\n").unwrap();
        fs::write(repo.join("a.txt"), "outside\n").unwrap();
        let changes = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint}),
        )
        .unwrap();
        assert_eq!(changes["files"], json!([{"path":"in.txt","status":"M","added":1,"removed":1}]));
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"in.txt"}),
        )
        .unwrap();
        assert_eq!(diff["oldText"], "a\n");
    }
}
