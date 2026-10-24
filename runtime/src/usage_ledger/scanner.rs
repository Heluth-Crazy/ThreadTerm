use super::{
    discovery::Root,
    facts::{Fact, ReaderState, PARSER_VERSION},
    readers, store,
};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(test)]
use rusqlite::{Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufRead, BufReader, Error, ErrorKind, Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::UNIX_EPOCH,
};

const MAX_LINE: usize = 8 * 1024 * 1024;
const PREFIX: u64 = 4096;
const MAX_ZSTD_WINDOW: u64 = 64 * 1024 * 1024;

#[cfg(test)]
#[derive(Default)]
struct ScanProfile {
    read: std::time::Duration,
    parse: std::time::Duration,
    write: std::time::Duration,
    admission: std::time::Duration,
    reconcile: std::time::Duration,
    commit: std::time::Duration,
    checkpoint: std::time::Duration,
}

#[cfg(test)]
thread_local! {
    static SCAN_PROFILE: std::cell::RefCell<Option<ScanProfile>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn profile_begin() {
    if std::env::var_os("UA1R_PROFILE").is_some() {
        SCAN_PROFILE.with(|profile| *profile.borrow_mut() = Some(ScanProfile::default()));
    }
}

#[cfg(test)]
fn profile_add(
    kind: fn(&mut ScanProfile) -> &mut std::time::Duration,
    elapsed: std::time::Duration,
) {
    SCAN_PROFILE.with(|profile| {
        if let Some(profile) = profile.borrow_mut().as_mut() {
            *kind(profile) += elapsed;
        }
    });
}

#[cfg(test)]
fn profile_print(provider: &str) {
    SCAN_PROFILE.with(|profile| {
        if let Some(profile) = profile.borrow_mut().take() {
            eprintln!(
                "UA1R_PROFILE provider={provider} readUs={} parseUs={} writeUs={} admissionUs={} reconcileUs={} commitUs={} checkpointUs={}",
                profile.read.as_micros(),
                profile.parse.as_micros(),
                profile.write.as_micros(),
                profile.admission.as_micros(),
                profile.reconcile.as_micros(),
                profile.commit.as_micros(),
                profile.checkpoint.as_micros(),
            );
        }
    });
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub files_found: u64,
    pub files_read: u64,
    #[serde(skip)]
    pub compressed_files_found: u64,
    #[serde(skip)]
    pub compressed_files_read: u64,
    pub bytes_read: u64,
    pub facts: u64,
    pub problems: BTreeMap<String, u64>,
    pub cancelled: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Cursor {
    size: u64,
    mtime: String,
    offset: u64,
    prefix_len: u64,
    prefix_hash: String,
    #[serde(default)]
    content_hash: String,
    parser_version: u32,
    #[serde(default)]
    exhausted: bool,
    state: ReaderState,
}

struct SerializedCursor {
    cursor: String,
    problems: String,
    last_read: String,
}

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS usage_sources (
        id TEXT PRIMARY KEY,provider TEXT NOT NULL,cursor TEXT NOT NULL,problems TEXT NOT NULL,last_read TEXT NOT NULL,missing INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS usage_scan_providers (
        provider TEXT PRIMARY KEY,root TEXT NOT NULL,status TEXT NOT NULL,stats TEXT NOT NULL,last_read TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_native_coverage (
        provider TEXT NOT NULL,native_session_id TEXT NOT NULL,source TEXT NOT NULL,covered_at TEXT NOT NULL,
        PRIMARY KEY(provider,native_session_id,source));")?;
    if !has_column(conn, "usage_sources", "missing")? {
        conn.execute(
            "ALTER TABLE usage_sources ADD COLUMN missing INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in columns {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn mark_missing_sources(
    conn: &Connection,
    provider: &str,
    seen_sources: &BTreeSet<String>,
) -> Result<()> {
    let write_started = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    tx.execute(
        "UPDATE usage_sources SET missing=1 WHERE provider=?",
        [provider],
    )?;
    for id in seen_sources {
        tx.execute("UPDATE usage_sources SET missing=0 WHERE id=?", [id])?;
    }
    tx.commit()?;
    store::record_write_duration(write_started);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn problem(stats: &mut ScanStats, kind: &str) {
    *stats.problems.entry(kind.into()).or_default() += 1;
}

fn candidate_error(stats: &mut ScanStats, error: &anyhow::Error) {
    // Scans may surface a database or filesystem failure. Keep the diagnostic
    // content-free: native paths and provider bytes must never reach stats.
    problem(stats, "unreadable");
    if let Some(rusqlite::Error::SqliteFailure(code, _)) = error.downcast_ref::<rusqlite::Error>() {
        problem(stats, &format!("database_error_{}", code.extended_code));
    } else if let Some(io) = error.downcast_ref::<std::io::Error>() {
        let kind = match io.kind() {
            ErrorKind::NotFound => "not_found",
            ErrorKind::PermissionDenied => "permission_denied",
            ErrorKind::InvalidData => "invalid_data",
            ErrorKind::UnexpectedEof => "unexpected_eof",
            ErrorKind::TimedOut => "timed_out",
            _ => "other",
        };
        problem(stats, &format!("io_error_{kind}"));
    } else {
        problem(stats, "scanner_error");
    }
}

fn database_busy(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(code, _)) if matches!(code.extended_code, 5 | 261 | 517)
    )
}

fn file_id(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_owned());
    hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
}

fn prefix(file: &mut File, len: u64, stats: &mut ScanStats) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut buf = vec![0; len as usize];
    file.read_exact(&mut buf)?;
    stats.bytes_read += len;
    Ok(hex::encode(Sha256::digest(&buf)))
}

/// Feeds ruzstd while retaining the compressed-byte digest required by its
/// whole-file cursor. This avoids a separate full pass before decoding.
struct HashingFile {
    file: File,
    hash: Sha256,
}

impl HashingFile {
    fn new(file: File) -> Self {
        Self {
            file,
            hash: Sha256::new(),
        }
    }

    fn position(&mut self) -> std::io::Result<u64> {
        self.file.stream_position()
    }

    fn preflight_zstd(&mut self) -> std::result::Result<u64, ZstdHeaderError> {
        zstd_window_size(&mut self.file)
    }

    fn digest(&self) -> String {
        hex::encode(self.hash.clone().finalize())
    }
}

impl Read for HashingFile {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.file.read(buffer)?;
        self.hash.update(&buffer[..read]);
        Ok(read)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZstdHeaderError {
    Invalid,
    WindowTooLarge,
}

/// Reads only the fixed-size Zstandard frame header before constructing ruzstd.
/// `StreamingDecoder` retains its declared history window while producing output,
/// so this cap prevents a malformed header from causing a large allocation.
fn zstd_window_size(file: &mut File) -> std::result::Result<u64, ZstdHeaderError> {
    let offset = file
        .stream_position()
        .map_err(|_| ZstdHeaderError::Invalid)?;
    let result = zstd_window_size_at_current_offset(file);
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| ZstdHeaderError::Invalid)?;
    result
}

fn zstd_window_size_at_current_offset(
    file: &mut File,
) -> std::result::Result<u64, ZstdHeaderError> {
    let mut header = [0_u8; 18];
    file.read_exact(&mut header[..5])
        .map_err(|_| ZstdHeaderError::Invalid)?;
    if u32::from_le_bytes(header[..4].try_into().expect("four-byte magic")) != 0xFD2F_B528 {
        return Err(ZstdHeaderError::Invalid);
    }
    let descriptor = header[4];
    if descriptor & 0x08 != 0 {
        return Err(ZstdHeaderError::Invalid);
    }
    let single_segment = descriptor & 0x20 != 0;
    let dictionary_len = match descriptor & 0x03 {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 4,
        _ => unreachable!(),
    };
    let content_len = match descriptor >> 6 {
        0 if single_segment => 1,
        0 => 0,
        1 => 2,
        2 => 4,
        3 => 8,
        _ => unreachable!(),
    };
    let window_len = if single_segment { 0 } else { 1 };
    let header_len = 5 + window_len + dictionary_len + content_len;
    file.read_exact(&mut header[5..header_len])
        .map_err(|_| ZstdHeaderError::Invalid)?;
    let window = if single_segment {
        let start = 5 + dictionary_len;
        let mut size = 0_u64;
        for (index, byte) in header[start..start + content_len].iter().enumerate() {
            size |= u64::from(*byte) << (index * 8);
        }
        if content_len == 2 {
            size += 256;
        }
        size
    } else {
        let descriptor = header[5];
        let exponent = descriptor >> 3;
        let mantissa = descriptor & 0x07;
        let base = 1_u64 << (10 + u64::from(exponent));
        base + (base / 8) * u64::from(mantissa)
    };
    if window > MAX_ZSTD_WINDOW {
        Err(ZstdHeaderError::WindowTooLarge)
    } else {
        Ok(window)
    }
}

/// Concatenated Zstandard frames are valid archives. ruzstd's convenience
/// reader stops at one frame, so advance to a validated next frame ourselves.
struct MultiFrameZstdReader {
    decoder:
        Option<ruzstd::decoding::StreamingDecoder<HashingFile, ruzstd::decoding::FrameDecoder>>,
    file_len: u64,
    problem: Option<&'static str>,
    complete: bool,
    content_hash: Option<String>,
}

impl MultiFrameZstdReader {
    fn new(mut file: HashingFile, file_len: u64) -> std::io::Result<Self> {
        match file.preflight_zstd() {
            Ok(_) => {}
            Err(ZstdHeaderError::WindowTooLarge) => {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "unsupported zstd window",
                ));
            }
            Err(ZstdHeaderError::Invalid) => {
                return Err(Error::new(ErrorKind::InvalidData, "invalid zstd header"));
            }
        }
        let decoder = ruzstd::decoding::StreamingDecoder::new(file)
            .map_err(|_| Error::new(ErrorKind::InvalidData, "invalid zstd frame"))?;
        Ok(Self {
            decoder: Some(decoder),
            file_len,
            problem: None,
            complete: false,
            content_hash: None,
        })
    }

    fn next_frame(&mut self) -> std::io::Result<bool> {
        let decoder = self
            .decoder
            .take()
            .expect("decoder is present while reading");
        let mut file = decoder.into_inner();
        let offset = file.position()?;
        if offset >= self.file_len {
            self.complete = offset == self.file_len;
            self.content_hash = self.complete.then(|| file.digest());
            return Ok(false);
        }
        match file.preflight_zstd() {
            Ok(_) => {}
            Err(ZstdHeaderError::WindowTooLarge) => {
                self.problem = Some("unsupported_zstd_window");
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "unsupported zstd window",
                ));
            }
            Err(ZstdHeaderError::Invalid) => {
                self.problem = Some("invalid_zstd");
                return Err(Error::new(ErrorKind::InvalidData, "invalid zstd frame"));
            }
        }
        let decoder = ruzstd::decoding::StreamingDecoder::new(file).map_err(|_| {
            self.problem = Some("invalid_zstd");
            Error::new(ErrorKind::InvalidData, "invalid zstd frame")
        })?;
        self.decoder = Some(decoder);
        Ok(true)
    }

    fn content_hash(&self) -> Option<String> {
        self.complete.then(|| self.content_hash.clone()).flatten()
    }
}

impl Read for MultiFrameZstdReader {
    fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = self
                .decoder
                .as_mut()
                .expect("decoder is present while reading")
                .read(target);
            match read {
                Ok(0) if self.next_frame()? => continue,
                result => return result,
            }
        }
    }
}

/// Codex rollout files contain many non-usage event frames.  Parsing those
/// large JSON values only to have the reader discard them dominated first scans.
/// Keep every frame that can affect reader state or emit a usage fact.
fn needs_json_parse(provider: &str, line: &[u8]) -> bool {
    if provider != "codex" {
        return true;
    }
    // `response_item` is not read by the Codex ledger reader. Its transcript
    // text can contain strings such as `token_count`, which must not turn the
    // generic fallback below into an expensive JSON parse.
    if root_json_type(line).is_some_and(|kind| kind == b"response_item") {
        return false;
    }
    let Ok(line) = std::str::from_utf8(line) else {
        // Keep malformed bytes on the normal parser path so diagnostics retain
        // the existing invalid-json accounting rather than silently skipping.
        return true;
    };
    [
        "\"session_meta\"",
        "\"turn_context\"",
        "\"token_usage_record\"",
        "\"token_count\"",
    ]
    .into_iter()
    .any(|needle| line.contains(needle))
}

/// Returns an unescaped root `type` value found before a nested value. A
/// partial, escaped, reordered-after-nesting, or malformed prefix returns
/// `None`, preserving the conservative substring fallback.
fn root_json_type(line: &[u8]) -> Option<&[u8]> {
    let input = &line[..line.len().min(512)];
    let mut at = 0;
    skip_json_whitespace(input, &mut at);
    if *input.get(at)? != b'{' {
        return None;
    }
    at += 1;
    loop {
        skip_json_whitespace(input, &mut at);
        if *input.get(at)? == b'}' {
            return None;
        }
        let key = json_plain_string(input, &mut at)?;
        skip_json_whitespace(input, &mut at);
        if *input.get(at)? != b':' {
            return None;
        }
        at += 1;
        skip_json_whitespace(input, &mut at);
        if key == b"type" {
            return json_plain_string(input, &mut at);
        }
        match *input.get(at)? {
            b'"' => {
                json_plain_string(input, &mut at)?;
            }
            b'{' | b'[' => return None,
            _ => {
                while let Some(byte) = input.get(at) {
                    if matches!(*byte, b',' | b'}') || byte.is_ascii_whitespace() {
                        break;
                    }
                    at += 1;
                }
            }
        }
        skip_json_whitespace(input, &mut at);
        match *input.get(at)? {
            b',' => at += 1,
            b'}' => return None,
            _ => return None,
        }
    }
}

fn skip_json_whitespace(input: &[u8], at: &mut usize) {
    while input
        .get(*at)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        *at += 1;
    }
}

fn json_plain_string<'a>(input: &'a [u8], at: &mut usize) -> Option<&'a [u8]> {
    if *input.get(*at)? != b'"' {
        return None;
    }
    let start = *at + 1;
    *at = start;
    while let Some(byte) = input.get(*at) {
        match *byte {
            b'"' => {
                let value = &input[start..*at];
                *at += 1;
                return Some(value);
            }
            b'\\' | 0..=0x1F => return None,
            _ => *at += 1,
        }
    }
    None
}

pub fn scan(
    root: &Root,
    conn: &Connection,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(&str, &ScanStats),
) -> Result<ScanStats> {
    #[cfg(test)]
    profile_begin();
    let mut stats = ScanStats::default();
    if root.provider == "gemini" {
        problem(&mut stats, "not_supported_yet");
        save_provider(conn, root, "not_supported_yet", &stats)?;
        store::force_checkpoint_index_connection(conn)?;
        #[cfg(test)]
        profile_print(&root.provider);
        return Ok(stats);
    }
    let mut found = false;
    let mut seen_sources = BTreeSet::new();
    for tree in &root.trees {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let meta = match fs::symlink_metadata(tree) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                problem(&mut stats, "unreadable");
                continue;
            }
        };
        found = true;
        if meta.file_type().is_symlink() {
            problem(&mut stats, "symlink_skipped");
            continue;
        }
        if meta.is_file() {
            if let Err(error) = scan_candidate(
                root,
                tree,
                conn,
                cancelled,
                &mut stats,
                progress,
                &mut seen_sources,
            ) {
                if database_busy(&error) {
                    return Err(error);
                }
                candidate_error(&mut stats, &error);
            }
            progress(&root.provider, &stats);
            continue;
        }
        // A stack of directory iterators bounds memory by depth, not file count.
        let mut stack = match fs::read_dir(tree) {
            Ok(entries) => vec![entries],
            Err(_) => {
                problem(&mut stats, "unreadable");
                continue;
            }
        };
        while !stack.is_empty() && !cancelled.load(Ordering::Relaxed) {
            let next = stack.last_mut().and_then(Iterator::next);
            match next {
                None => {
                    stack.pop();
                }
                Some(Err(_)) => problem(&mut stats, "unreadable"),
                Some(Ok(entry)) => {
                    let Ok(kind) = entry.file_type() else {
                        problem(&mut stats, "unreadable");
                        continue;
                    };
                    if kind.is_symlink() {
                        continue;
                    }
                    if kind.is_dir() {
                        if stack.len() >= 64 {
                            problem(&mut stats, "depth_limit");
                            continue;
                        }
                        match fs::read_dir(entry.path()) {
                            Ok(entries) => stack.push(entries),
                            Err(_) => problem(&mut stats, "unreadable"),
                        }
                    } else if kind.is_file() {
                        if let Err(error) = scan_candidate(
                            root,
                            &entry.path(),
                            conn,
                            cancelled,
                            &mut stats,
                            progress,
                            &mut seen_sources,
                        ) {
                            if database_busy(&error) {
                                return Err(error);
                            }
                            candidate_error(&mut stats, &error);
                        }
                        progress(&root.provider, &stats);
                    }
                }
            }
        }
    }
    stats.cancelled = cancelled.load(Ordering::Relaxed);
    if !stats.cancelled {
        mark_missing_sources(conn, &root.provider, &seen_sources)?;
    }
    let status = if stats.cancelled {
        "cancelled"
    } else if !found {
        "not_installed"
    } else if stats.problems.is_empty() {
        "ready"
    } else {
        "partial"
    };
    save_provider(conn, root, status, &stats)?;
    store::force_checkpoint_index_connection(conn)?;
    progress(&root.provider, &stats);
    #[cfg(test)]
    profile_print(&root.provider);
    Ok(stats)
}

fn save_provider(conn: &Connection, root: &Root, status: &str, stats: &ScanStats) -> Result<()> {
    let root_path = root.path.to_string_lossy().into_owned();
    let stats = serde_json::to_string(stats)?;
    let last_read = chrono::Utc::now().to_rfc3339();
    let sql = "INSERT INTO usage_scan_providers(provider,root,status,stats,last_read) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET root=excluded.root,status=excluded.status,stats=excluded.stats,last_read=excluded.last_read";
    if conn.is_autocommit() {
        let write_started = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        tx.execute(
            sql,
            params![root.provider, root_path, status, stats, last_read],
        )?;
        tx.commit()?;
        store::record_write_duration(write_started);
        store::checkpoint_index_connection(conn)?;
    } else {
        conn.execute(
            sql,
            params![root.provider, root_path, status, stats, last_read],
        )?;
    }
    Ok(())
}

fn scan_candidate(
    root: &Root,
    path: &Path,
    conn: &Connection,
    cancelled: &AtomicBool,
    stats: &mut ScanStats,
    progress: &mut dyn FnMut(&str, &ScanStats),
    seen_sources: &mut BTreeSet<String>,
) -> Result<()> {
    if !super::discovery::accepted(&root.provider, path) {
        return Ok(());
    }
    stats.files_found += 1;
    let compressed = path.extension().is_some_and(|extension| extension == "zst");
    if compressed {
        stats.compressed_files_found += 1;
    }
    let id = file_id(path);
    // Discovery saw this candidate even if a later metadata/open operation is
    // denied. That is an unreadable source, not a source that disappeared.
    seen_sources.insert(id.clone());
    let before_problems = stats.problems.clone();
    let prior: Option<(String, String)> = conn
        .query_row(
            "SELECT cursor,problems FROM usage_sources WHERE id=?",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let cursor: Cursor = prior
        .as_ref()
        .and_then(|(s, _)| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let old_problems: BTreeMap<String, u64> = prior
        .as_ref()
        .and_then(|(_, p)| serde_json::from_str(p).ok())
        .unwrap_or_default();
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => {
            problem(stats, "unreadable");
            return Ok(());
        }
    };
    let size = meta.len();
    let mut mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|t| t.as_nanos().to_string())
        .unwrap_or_default();
    if root.provider == "opencode" && path.file_name().is_some_and(|s| s == "opencode.db") {
        let wal = std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        if let Ok(meta) = fs::metadata(wal) {
            mtime.push_str(&format!(
                ":{}:{}",
                meta.len(),
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|t| t.as_nanos())
                    .unwrap_or(0)
            ));
        }
    }
    if cursor.parser_version == PARSER_VERSION
        && cursor.size == size
        && cursor.mtime == mtime
        && cursor.exhausted
    {
        for (kind, count) in old_problems {
            *stats.problems.entry(kind).or_default() += count;
        }
        return Ok(());
    }
    stats.files_read += 1;
    if compressed {
        stats.compressed_files_read += 1;
    }
    let source = format!("native:{id}@");
    if root.provider == "opencode" && path.file_name().is_some_and(|s| s == "opencode.db") {
        store::remove_source(conn, &source)?;
        let mut pending = Vec::new();
        let mut covered = BTreeSet::new();
        let mut emit = |mut fact: Fact| -> Result<()> {
            fact.source = format!("{source}{}", fact.key);
            covered.insert(fact.native_session_id.clone());
            pending.push(fact);
            stats.facts += 1;
            if pending.len() >= 128 {
                flush(conn, &mut pending, &mut covered, &root.provider, &source)?;
                if stats.facts % 2048 == 0 {
                    progress(&root.provider, stats);
                }
            }
            Ok(())
        };
        match readers::opencode::read_database(path, &mut emit, cancelled) {
            Ok(read) => {
                stats.bytes_read += read.bytes_read;
                flush(conn, &mut pending, &mut covered, &root.provider, &source)?;
                for s in read.covered_sessions {
                    store::cover_session(conn, &root.provider, &s, &source)?;
                }
                for p in read.problems {
                    problem(stats, &p);
                }
            }
            Err(_) => {
                store::remove_source(conn, &source)?;
                problem(stats, "unreadable_or_unsupported_database");
                return Ok(());
            }
        }
        if !cancelled.load(Ordering::Relaxed) {
            let c = Cursor {
                size,
                mtime,
                parser_version: PARSER_VERSION,
                exhausted: true,
                ..Default::default()
            };
            save_cursor(
                conn,
                &id,
                &root.provider,
                &c,
                &file_problems(stats, &before_problems),
            )?;
        }
        return Ok(());
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => {
            problem(stats, "unreadable");
            return Ok(());
        }
    };
    if root.provider == "opencode" && path.extension().is_some_and(|value| value == "json") {
        store::remove_source(conn, &source)?;
        if size > MAX_LINE as u64 {
            problem(stats, "record_too_large");
            return Ok(());
        }
        stats.bytes_read += size;
        match serde_json::from_reader::<_, Value>(BufReader::new(file.take(MAX_LINE as u64))) {
            Ok(value) => {
                let mut state = super::source_metadata::initial_state(&root.provider, path);
                let mut parsed = readers::parse(&root.provider, &value, 0, &id, &mut state);
                for fact in &mut parsed.facts {
                    fact.source = format!("{source}0");
                    stats.facts += 1;
                }
                let mut covered = parsed.covered_sessions.into_iter().collect();
                flush(
                    conn,
                    &mut parsed.facts,
                    &mut covered,
                    &root.provider,
                    &source,
                )?;
                for kind in parsed.problems {
                    problem(stats, &kind);
                }
            }
            Err(_) => problem(stats, "invalid_json"),
        }
        let cursor = Cursor {
            size,
            mtime,
            offset: size,
            parser_version: PARSER_VERSION,
            exhausted: true,
            ..Default::default()
        };
        save_cursor(
            conn,
            &id,
            &root.provider,
            &cursor,
            &file_problems(stats, &before_problems),
        )?;
        return Ok(());
    }
    if compressed {
        match zstd_window_size(&mut file) {
            Ok(_) => {}
            Err(ZstdHeaderError::WindowTooLarge) => {
                problem(stats, "unsupported_zstd_window");
                return Ok(());
            }
            Err(ZstdHeaderError::Invalid) => {
                problem(stats, "invalid_zstd");
                return Ok(());
            }
        }
        // Decoder construction happens before changing persisted facts so a
        // malformed first frame retains the last successful scan. Its source
        // hashes compressed bytes during this same pass.
        file.seek(SeekFrom::Start(0))?;
        let mut reader = BufReader::with_capacity(
            64 * 1024,
            MultiFrameZstdReader::new(HashingFile::new(file), size)
                .map_err(|_| anyhow::anyhow!("invalid zstd history"))?,
        );
        store::remove_source(conn, &source)?;
        let mut cursor = Cursor {
            size,
            mtime,
            parser_version: PARSER_VERSION,
            state: super::source_metadata::initial_state(&root.provider, path),
            ..Default::default()
        };
        let result = scan_lines(
            &mut reader,
            root,
            conn,
            cancelled,
            stats,
            progress,
            &id,
            &source,
            &before_problems,
            &mut cursor,
            &mut |reader, cursor| {
                if let Some(content_hash) = reader.get_mut().content_hash() {
                    cursor.content_hash = content_hash;
                }
            },
        );
        if let Some(kind) = reader.get_mut().problem.take() {
            problem(stats, kind);
            return Ok(());
        }
        result?;
        return Ok(());
    }
    let resume = cursor.parser_version == PARSER_VERSION
        && size >= cursor.size
        && cursor.offset <= size
        && cursor.prefix_len <= size
        && !cursor.prefix_hash.is_empty()
        && prefix(&mut file, cursor.prefix_len, stats)? == cursor.prefix_hash
        && (size > cursor.size || mtime == cursor.mtime);
    let mut cursor = if resume {
        for (kind, count) in old_problems {
            if kind != "truncated_last_line" {
                *stats.problems.entry(kind).or_default() += count;
            }
        }
        cursor
    } else {
        store::remove_source(conn, &source)?;
        Cursor {
            state: super::source_metadata::initial_state(&root.provider, path),
            ..Default::default()
        }
    };
    cursor.exhausted = false;
    cursor.size = size;
    cursor.mtime = mtime;
    cursor.parser_version = PARSER_VERSION;
    cursor.prefix_len = size.min(PREFIX);
    cursor.prefix_hash = prefix(&mut file, cursor.prefix_len, stats)?;
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file.take(size - cursor.offset));
    scan_lines(
        &mut reader,
        root,
        conn,
        cancelled,
        stats,
        progress,
        &id,
        &source,
        &before_problems,
        &mut cursor,
        &mut |_, _| {},
    )
}

fn scan_lines<R, F>(
    reader: &mut R,
    root: &Root,
    conn: &Connection,
    cancelled: &AtomicBool,
    stats: &mut ScanStats,
    progress: &mut dyn FnMut(&str, &ScanStats),
    id: &str,
    source: &str,
    before_problems: &BTreeMap<String, u64>,
    cursor: &mut Cursor,
    finalize_cursor: &mut F,
) -> Result<()>
where
    R: BufRead,
    F: FnMut(&mut R, &mut Cursor),
{
    let mut lines = 0;
    let mut fact_limit = 32usize;
    let mut facts = Vec::new();
    let mut replaced = Vec::new();
    let mut covered = BTreeSet::new();
    let mut line = Vec::new();
    while !cancelled.load(Ordering::Relaxed) {
        let start = cursor.offset;
        #[cfg(test)]
        let read_started = std::time::Instant::now();
        let (consumed, complete, oversized) = bounded_line(&mut *reader, &mut line)?;
        #[cfg(test)]
        profile_add(|profile| &mut profile.read, read_started.elapsed());
        stats.bytes_read += consumed;
        if consumed == 0 {
            break;
        }
        if !complete && root.provider != "opencode" {
            problem(stats, "truncated_last_line");
            break;
        }
        cursor.offset += consumed;
        if oversized {
            problem(stats, "record_too_large");
            continue;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        #[cfg(test)]
        let parse_started = std::time::Instant::now();
        if !needs_json_parse(&root.provider, &line) {
            #[cfg(test)]
            profile_add(|profile| &mut profile.parse, parse_started.elapsed());
            continue;
        }
        let value: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => {
                problem(stats, "invalid_json");
                #[cfg(test)]
                profile_add(|profile| &mut profile.parse, parse_started.elapsed());
                continue;
            }
        };
        let mut parsed = readers::parse(&root.provider, &value, start, &id, &mut cursor.state);
        replaced.extend(parsed.replaced_keys);
        for fact in &mut parsed.facts {
            fact.source = format!("{source}{start}");
            stats.facts += 1;
        }
        facts.extend(parsed.facts);
        covered.extend(parsed.covered_sessions);
        for p in parsed.problems {
            problem(stats, &p);
        }
        #[cfg(test)]
        profile_add(|profile| &mut profile.parse, parse_started.elapsed());
        lines += 1;
        if facts.len() >= fact_limit || replaced.len() >= 128 || lines % 256 == 0 {
            let cursor = serialize_cursor(&cursor, &file_problems(stats, &before_problems))?;
            if let Some(held) = flush_reconciled(
                conn,
                &mut facts,
                &mut replaced,
                &mut covered,
                &root.provider,
                &source,
                &id,
                &root.provider,
                Some(&cursor),
            )? {
                if held > std::time::Duration::from_millis(25) {
                    fact_limit = (fact_limit / 2).max(1);
                } else if held < std::time::Duration::from_millis(8) {
                    fact_limit = (fact_limit + 8).min(128);
                }
            }
            progress(&root.provider, stats);
            // The transaction and any scheduled checkpoint have both completed.
            // Give an interactive connection a predictable admission opportunity
            // before the scanner prepares another batch.
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    cursor.exhausted = !cancelled.load(Ordering::Relaxed);
    finalize_cursor(reader, cursor);
    let cursor = serialize_cursor(&cursor, &file_problems(stats, &before_problems))?;
    flush_reconciled(
        conn,
        &mut facts,
        &mut replaced,
        &mut covered,
        &root.provider,
        &source,
        &id,
        &root.provider,
        Some(&cursor),
    )?;
    Ok(())
}

fn flush_reconciled(
    conn: &Connection,
    facts: &mut Vec<Fact>,
    replaced: &mut Vec<String>,
    covered: &mut BTreeSet<String>,
    provider: &str,
    source: &str,
    cursor_id: &str,
    cursor_provider: &str,
    cursor: Option<&SerializedCursor>,
) -> Result<Option<std::time::Duration>> {
    if facts.is_empty() && replaced.is_empty() && covered.is_empty() && cursor.is_none() {
        return Ok(None);
    }
    #[cfg(test)]
    let write_profile_started = std::time::Instant::now();
    #[cfg(test)]
    let admission_started = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    #[cfg(test)]
    profile_add(
        |profile| &mut profile.admission,
        admission_started.elapsed(),
    );
    let held_started = std::time::Instant::now();
    #[cfg(test)]
    let reconcile_started = std::time::Instant::now();
    store::upsert_facts(&tx, facts)?;
    store::remove_fact_keys(&tx, replaced)?;
    for session in covered.iter() {
        store::cover_session(&tx, provider, session, source)?;
    }
    if let Some(cursor) = cursor {
        save_serialized_cursor(&tx, cursor_id, cursor_provider, cursor)?;
    }
    #[cfg(test)]
    profile_add(
        |profile| &mut profile.reconcile,
        reconcile_started.elapsed(),
    );
    #[cfg(test)]
    let commit_started = std::time::Instant::now();
    tx.commit()?;
    #[cfg(test)]
    profile_add(|profile| &mut profile.commit, commit_started.elapsed());
    let held = held_started.elapsed();
    store::record_write_duration(held_started);
    #[cfg(test)]
    let checkpoint_started = std::time::Instant::now();
    store::checkpoint_index_connection(conn)?;
    #[cfg(test)]
    profile_add(
        |profile| &mut profile.checkpoint,
        checkpoint_started.elapsed(),
    );
    #[cfg(test)]
    profile_add(
        |profile| &mut profile.write,
        write_profile_started.elapsed(),
    );
    facts.clear();
    replaced.clear();
    covered.clear();
    Ok(Some(held))
}

fn flush(
    conn: &Connection,
    facts: &mut Vec<Fact>,
    covered: &mut BTreeSet<String>,
    provider: &str,
    source: &str,
) -> Result<()> {
    if !facts.is_empty() {
        store::upsert_facts(conn, facts)?;
        facts.clear();
    }
    for session in covered.iter() {
        store::cover_session(conn, provider, session, source)?;
    }
    covered.clear();
    Ok(())
}

fn file_problems(stats: &ScanStats, before: &BTreeMap<String, u64>) -> BTreeMap<String, u64> {
    stats
        .problems
        .iter()
        .filter_map(|(key, value)| {
            let count = value.saturating_sub(*before.get(key).unwrap_or(&0));
            (count > 0).then(|| (key.clone(), count))
        })
        .collect()
}

fn save_cursor(
    conn: &Connection,
    id: &str,
    provider: &str,
    cursor: &Cursor,
    problems: &BTreeMap<String, u64>,
) -> Result<()> {
    let cursor = serialize_cursor(cursor, problems)?;
    if conn.is_autocommit() {
        let write_started = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        save_serialized_cursor(&tx, id, provider, &cursor)?;
        tx.commit()?;
        store::record_write_duration(write_started);
        store::checkpoint_index_connection(conn)?;
    } else {
        save_serialized_cursor(conn, id, provider, &cursor)?;
    }
    Ok(())
}

fn serialize_cursor(cursor: &Cursor, problems: &BTreeMap<String, u64>) -> Result<SerializedCursor> {
    Ok(SerializedCursor {
        cursor: serde_json::to_string(cursor)?,
        problems: serde_json::to_string(problems)?,
        last_read: chrono::Utc::now().to_rfc3339(),
    })
}

fn save_serialized_cursor(
    conn: &Connection,
    id: &str,
    provider: &str,
    cursor: &SerializedCursor,
) -> Result<()> {
    conn.execute(
        "INSERT INTO usage_sources(id,provider,cursor,problems,last_read) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,problems=excluded.problems,last_read=excluded.last_read",
        params![
            id,
            provider,
            &cursor.cursor,
            &cursor.problems,
            &cursor.last_read
        ],
    )?;
    Ok(())
}

fn bounded_line(
    reader: &mut (impl BufRead + ?Sized),
    line: &mut Vec<u8>,
) -> Result<(u64, bool, bool)> {
    line.clear();
    let mut consumed = 0;
    let mut oversized = false;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok((consumed, false, oversized));
        }
        let end = find_newline(buf).map(|p| p + 1);
        let take = end.unwrap_or(buf.len());
        if line.len() + take <= MAX_LINE && !oversized {
            line.extend_from_slice(&buf[..take]);
        } else {
            oversized = true;
            line.clear();
        }
        consumed += take as u64;
        reader.consume(take);
        if end.is_some() {
            return Ok((consumed, true, oversized));
        }
    }
}

/// Checks eight ASCII bytes at once, then confirms the rare candidate byte.
/// This avoids a scalar iterator step for every decoded Codex byte without an
/// additional dependency.
fn find_newline(bytes: &[u8]) -> Option<usize> {
    const LOW_BITS: u64 = 0x0101_0101_0101_0101;
    const HIGH_BITS: u64 = 0x8080_8080_8080_8080;
    const NEWLINES: u64 = 0x0A0A_0A0A_0A0A_0A0A;
    let mut chunks = bytes.chunks_exact(8);
    for (chunk_index, chunk) in chunks.by_ref().enumerate() {
        let word = u64::from_ne_bytes(chunk.try_into().expect("eight-byte chunk"));
        let differs = word ^ NEWLINES;
        if differs.wrapping_sub(LOW_BITS) & !differs & HIGH_BITS != 0 {
            if let Some(offset) = chunk.iter().position(|byte| *byte == b'\n') {
                return Some(chunk_index * 8 + offset);
            }
        }
    }
    let tail = chunks.remainder();
    tail.iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| bytes.len() - tail.len() + offset)
}

pub fn sources(conn: &Connection) -> Result<Value> {
    let mut statement = conn.prepare(
        "SELECT provider,root,status,stats,last_read,
            (SELECT COUNT(*) FROM usage_sources WHERE usage_sources.provider=usage_scan_providers.provider AND missing=1)
         FROM usage_scan_providers ORDER BY provider",
    )?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    let mut providers = Vec::new();
    for row in rows {
        let (provider, root, status, stats, last_read, missing_sources) = row?;
        providers.push(json!({"provider":provider,"root":root,"status":status,"lastRead":last_read,
            "stats":serde_json::from_str::<Value>(&stats)?,"missingSources":missing_sources,"bucketsReported": match provider.as_str() {
                "claude" => vec!["input","cacheRead","cacheWrite5m","cacheWrite1h","cacheWriteUnknown","output"],
                "opencode" | "pi" | "kimi" => vec!["input","cacheRead","cacheWriteUnknown","output","reasoning"],
                "grok" => vec!["input","cacheRead","output"],
                "gemini" => vec![],
                _ => vec!["input","cacheRead","cacheWrite5m","output","reasoning"],
            }}));
    }
    Ok(json!({"providers":providers,"parserVersion":PARSER_VERSION}))
}

pub fn rebuild(conn: &Connection) -> Result<()> {
    let cancelled = AtomicBool::new(false);
    rebuild_cancellable(conn, &cancelled)?;
    Ok(())
}

/// Rebuild native facts before replacing scanner cursors.  If the store's
/// cancellable rebuild stops early, retained cursors still describe the old,
/// intact native index and can safely resume on the next refresh.
pub fn rebuild_cancellable(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    if !store::rebuild_native_cancellable(conn, cancelled)? {
        return Ok(false);
    }
    let write_started = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    tx.execute_batch(
        "DELETE FROM usage_sources; DELETE FROM usage_native_coverage; DELETE FROM usage_scan_providers;",
    )?;
    tx.commit()?;
    store::record_write_duration(write_started);
    store::checkpoint_index_connection(conn)?;
    Ok(true)
}

#[cfg(test)]
mod scanner_revision_tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::io::Read;

    fn scratch() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.sqlite");
        let db = crate::db::Database::open(&path).unwrap();
        drop(db);
        let conn = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
        (dir, conn)
    }

    fn zstd(data: &[u8]) -> Vec<u8> {
        use ruzstd::encoding::{CompressionLevel, FrameCompressor};

        let mut output = Vec::new();
        let mut compressor = FrameCompressor::new(CompressionLevel::Fastest);
        compressor.set_source(data);
        compressor.set_drain(&mut output);
        compressor.compress();
        output
    }

    #[test]
    fn codex_prefilter_skips_response_item_transcript_keywords() {
        let line = br#"{"timestamp":"2026-01-02T03:04:05Z","type":"response_item","payload":{"text":"token_count token_usage_record"}}"#;
        assert_eq!(root_json_type(line), Some(&b"response_item"[..]));
        assert!(!needs_json_parse("codex", line));
        // A nested object before root type cannot prove the event is irrelevant.
        assert!(needs_json_parse(
            "codex",
            br#"{"payload":{"text":"token_count"},"type":"response_item"}"#
        ));
    }

    #[test]
    fn newline_search_finds_word_and_tail_positions() {
        assert_eq!(find_newline(b"abcdefgh\n"), Some(8));
        assert_eq!(find_newline(b"abc"), None);
        assert_eq!(find_newline(b"\nabcdef"), Some(0));
    }

    #[test]
    fn scanner_propagates_a_competing_database_writer() {
        let (dir, conn) = scratch();
        let history = dir.path().join("history");
        fs::create_dir(&history).unwrap();
        fs::write(
            history.join("session.jsonl"),
            "{\"sessionId\":\"s\",\"requestId\":\"r\",\"timestamp\":\"2026-01-02T03:04:05Z\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":1}}}\n",
        )
        .unwrap();
        // Establish the scan connection's ordinary read state before another
        // connection takes the writer lease. The scan must return BUSY, never
        // label this native history file unreadable.
        conn.query_row("SELECT COUNT(*) FROM usage_sources", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
        let other = Connection::open(crate::usage_ledger::ledger_db::path_for(
            &dir.path().join("ledger.sqlite"),
        ))
        .unwrap();
        let blocker = Transaction::new_unchecked(&other, TransactionBehavior::Immediate).unwrap();
        let root = Root {
            provider: "claude".into(),
            path: history.clone(),
            trees: vec![history],
        };
        let error = scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap_err();
        assert!(database_busy(&error));
        drop(blocker);
    }

    #[test]
    fn compressed_codex_rollout_is_streamed_and_uses_a_whole_file_cursor() {
        let (dir, conn) = scratch();
        let history = dir.path().join("history");
        fs::create_dir(&history).unwrap();
        let first_frame = format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"thread-z"}}),
            json!({"timestamp":"2026-01-02T03:04:05Z","type":"token_usage_record","payload":{"thread_id":"thread-z","response_id":"response-one","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":3}}})
        );
        let second_frame = format!(
            "{}\n",
            json!({"timestamp":"2026-01-02T03:04:06Z","type":"token_usage_record","payload":{"thread_id":"thread-z","response_id":"response-two","usage":{"input_tokens":7,"cached_input_tokens":1,"output_tokens":4}}})
        );
        assert!(needs_json_parse("codex", first_frame.as_bytes()));
        let first_compressed = zstd(first_frame.as_bytes());
        let second_compressed = zstd(second_frame.as_bytes());
        let mut compressed = first_compressed.clone();
        compressed.extend_from_slice(&second_compressed);
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(compressed.as_slice()).unwrap();
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, first_frame.as_bytes());
        let path = history.join("rollout.jsonl.zst");
        fs::write(&path, &compressed).unwrap();
        let root = Root {
            provider: "codex".into(),
            path: history.clone(),
            trees: vec![history],
        };
        let cancelled = AtomicBool::new(false);
        let first = scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        assert_eq!(first.facts, 2, "{first:?}");
        assert_eq!(first.compressed_files_found, 1);
        assert_eq!(first.compressed_files_read, 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let cursor: String = conn
            .query_row("SELECT cursor FROM usage_sources", [], |row| row.get(0))
            .unwrap();
        let cursor: Cursor = serde_json::from_str(&cursor).unwrap();
        assert_eq!(
            cursor.content_hash,
            hex::encode(Sha256::digest(&compressed))
        );
        let unchanged = scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        assert_eq!(unchanged.files_read, 0);
        assert_eq!(unchanged.compressed_files_found, 1);
        assert_eq!(unchanged.compressed_files_read, 0);
        assert_eq!(unchanged.bytes_read, 0);
        // A non-single-segment second frame with an exponent of 31 declares a
        // near-maximum window. It is rejected from its six-byte header before
        // ruzstd can allocate decoder history, and only the stable problem key
        // reaches scan statistics.
        let mut malicious = first_compressed;
        malicious.extend_from_slice(&[0x28, 0xB5, 0x2F, 0xFD, 0x00, 0xF8]);
        fs::write(&path, malicious).unwrap();
        let rejected = scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        assert_eq!(rejected.problems.get("unsupported_zstd_window"), Some(&1));
        assert!(!rejected.problems.keys().any(|kind| kind.contains("frame")));
    }

    #[test]
    fn missing_source_keeps_facts_and_is_reported_until_rebuild() {
        let (dir, conn) = scratch();
        let history = dir.path().join("history");
        fs::create_dir(&history).unwrap();
        let path = history.join("session.jsonl");
        fs::write(&path, "{\"sessionId\":\"s\",\"requestId\":\"r\",\"timestamp\":\"2026-01-02T03:04:05Z\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":1}}}\n").unwrap();
        let root = Root {
            provider: "claude".into(),
            path: history.clone(),
            trees: vec![history],
        };
        let cancelled = AtomicBool::new(false);
        scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        fs::remove_file(path).unwrap();
        scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(sources(&conn).unwrap()["providers"][0]["missingSources"], 1);
        let cancelled = AtomicBool::new(true);
        assert!(!rebuild_cancellable(&conn, &cancelled).unwrap());
        assert_eq!(sources(&conn).unwrap()["providers"][0]["missingSources"], 1);
        rebuild(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn claude_request_id_tombstone_blocks_later_fallback_archive_snapshot() {
        use std::io::Write;

        let (dir, conn) = scratch();
        let history = dir.path().join("history");
        fs::create_dir(&history).unwrap();
        let path = history.join("session.jsonl");
        let fallback = json!({
            "sessionId":"s","timestamp":"2026-01-02T03:04:05Z",
            "message":{"id":"m","usage":{"input_tokens":3,"output_tokens":1}}
        });
        let identified = json!({
            "sessionId":"s","requestId":"r","timestamp":"2026-01-02T03:04:06Z",
            "message":{"id":"m","usage":{"input_tokens":7,"output_tokens":2}}
        });
        fs::write(&path, format!("{fallback}\n{identified}\n")).unwrap();
        let root = Root {
            provider: "claude".into(),
            path: history.clone(),
            trees: vec![history],
        };
        let cancelled = AtomicBool::new(false);
        scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        let archive = json!({
            "sessionId":"s","timestamp":"2026-01-02T03:04:07Z",
            "message":{"id":"m","usage":{"input_tokens":99,"output_tokens":99}}
        });
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "{archive}"
        )
        .unwrap();
        scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*),SUM(input_tokens) FROM usage_facts",
                [],
                |row| { Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)) }
            )
            .unwrap(),
            (1, 7)
        );
    }
}
