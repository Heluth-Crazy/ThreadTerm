//! Single-file, chunked SQLite archives. No external archiver or provider access.
use crate::{config::RuntimeConfig, db::Database};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

const FORMAT: &str = "threadterm-data-backup";
const CHUNK: usize = 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    path: String,
    size_bytes: u64,
    sha256: String,
    sqlite: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Excluded {
    resource: String,
    reason: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    created_at: String,
    files: Vec<Entry>,
    excluded: Vec<Excluded>,
}
pub(crate) struct Scratch(pub(crate) PathBuf);
impl Scratch {
    pub(crate) fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("threadterm-backup-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        let scratch = Self(path);
        secure_path(&scratch.0, true)?;
        Ok(scratch)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn secure_path(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        let _ = directory;
        crate::windows_security::restrict_file_to_current_user(path)
            .context("Cannot protect backup credentials; choose a private folder on a filesystem supporting access permissions")?;
    }
    Ok(())
}
pub(crate) fn private_file(path: &Path) -> Result<fs::File> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    secure_path(path, false)?;
    Ok(file)
}
struct PartialArchive(PathBuf);
impl Drop for PartialArchive {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn publish_no_replace(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let canonical_source = fs::canonicalize(source)?;
        let canonical_target = fs::canonicalize(
            target
                .parent()
                .ok_or_else(|| anyhow!("Invalid backup parent"))?,
        )?
        .join(
            target
                .file_name()
                .ok_or_else(|| anyhow!("Invalid backup file name"))?,
        );
        let source: Vec<_> = canonical_source
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let target: Vec<_> = canonical_target
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                0,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target)
            .context("Publishing backup without overwriting an existing file")?;
        fs::remove_file(source)?;
    }
    Ok(())
}
fn publish_archive(
    staged: &Path,
    target: &Path,
    validate: impl Fn(&Path) -> Result<Value>,
) -> Result<Value> {
    let partial = PartialArchive(
        target.with_file_name(format!(".threadterm-backup-{}.partial", Uuid::new_v4())),
    );
    let mut output = private_file(&partial.0)?;
    std::io::copy(&mut fs::File::open(staged)?, &mut output)?;
    output.sync_all()?;
    drop(output);
    validate(&partial.0)?;
    publish_no_replace(&partial.0, target)?;
    match validate(target) {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = fs::remove_file(target);
            Err(error)
        }
    }
}
fn read_only(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}
fn integrity(path: &Path) -> Result<()> {
    integrity_connection(&read_only(path)?, path)
}
fn immutable_archive(path: &Path) -> Result<Connection> {
    let canonical = crate::git_read::plain_path(&fs::canonicalize(path)?);
    let mut uri =
        reqwest::Url::from_file_path(canonical).map_err(|_| anyhow!("Invalid backup file path"))?;
    uri.query_pairs_mut().append_pair("immutable", "1");
    Ok(Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )?)
}
fn integrity_connection(conn: &Connection, path: &Path) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA integrity_check")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows != ["ok"] {
        bail!("SQLite integrity check failed: {}", path.display());
    }
    Ok(())
}
fn sqlite(path: &Path) -> Result<bool> {
    let mut header = [0; 16];
    let mut file = fs::File::open(path)?;
    Ok(file.read(&mut header)? == 16 && &header == b"SQLite format 3\0")
}
#[derive(Debug)]
struct SnapshotLocked(PathBuf);
impl std::fmt::Display for SnapshotLocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SQLite snapshot remained locked: {}", self.0.display())
    }
}
impl std::error::Error for SnapshotLocked {}
#[derive(Debug)]
struct SnapshotChanged;
impl std::fmt::Display for SnapshotChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SQLite recovery files changed during capture")
    }
}
impl std::error::Error for SnapshotChanged {}

fn recovery_path(source: &Path, suffix: &str) -> PathBuf {
    let mut path = source.as_os_str().to_os_string();
    path.push(suffix);
    path.into()
}
type RecoverySignature = std::collections::BTreeMap<&'static str, (u64, String)>;
fn recovery_io_error(error: std::io::Error) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        SnapshotChanged.into()
    } else {
        error.into()
    }
}
fn recovery_signature(source: &Path) -> Result<RecoverySignature> {
    let mut signature = RecoverySignature::new();
    for suffix in ["", "-wal", "-journal"] {
        let path = recovery_path(source, suffix);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {
                continue
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || crate::git_read::plain_path(&fs::canonicalize(&path).map_err(recovery_io_error)?)
                != crate::git_read::plain_path(&path)
        {
            bail!("Unsafe SQLite recovery file: {}", path.display());
        }
        let mut input = fs::File::open(&path)
            .map_err(recovery_io_error)?
            .take(metadata.len());
        let mut digest = Sha256::new();
        let mut size = 0;
        let mut buffer = [0; CHUNK];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            digest.update(&buffer[..count]);
        }
        if size != metadata.len() || input.get_ref().metadata()?.len() != size {
            return Err(SnapshotChanged.into());
        }
        signature.insert(suffix, (size, hex::encode(digest.finalize())));
    }
    Ok(signature)
}
fn locked_desktop_snapshot(
    source: &Path,
    target: &Path,
    mut after_copy: impl FnMut(usize) -> Result<()>,
) -> Result<()> {
    for attempt in 0..3 {
        let copied = Scratch::new()?;
        let input = copied.0.join("recovery.sqlite");
        let capture = (|| -> Result<()> {
            let before = recovery_signature(source)?;
            for (suffix, (size, _)) in &before {
                let mut output = private_file(&recovery_path(&input, suffix))?;
                let original = match fs::File::open(recovery_path(source, suffix)) {
                    Ok(file) => file,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Err(SnapshotChanged.into())
                    }
                    Err(error) => return Err(error.into()),
                };
                let mut original = original.take(*size);
                if std::io::copy(&mut original, &mut output)? != *size {
                    return Err(SnapshotChanged.into());
                }
            }
            after_copy(attempt)?;
            if before != recovery_signature(&input)? || before != recovery_signature(source)? {
                return Err(SnapshotChanged.into());
            }
            // Recover the private WAL/hot journal without consulting Chromium's live locks.
            let recovered = Connection::open(&input)?;
            integrity_connection(&recovered, &input)?;
            drop(recovered);
            snapshot(&input, target)
        })();
        match capture {
            Ok(()) => return Ok(()),
            Err(error) if error.downcast_ref::<SnapshotChanged>().is_some() => continue,
            Err(error) => return Err(error),
        }
    }
    bail!("SQLite recovery files kept changing: {}", source.display())
}
fn snapshot_is_locked(error: &anyhow::Error) -> bool {
    error.downcast_ref::<SnapshotLocked>().is_some()
        || error.chain().any(|cause| {
            matches!(cause.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if matches!(code.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        })
}
fn snapshot(source: &Path, target: &Path) -> Result<()> {
    let src = read_only(source)?;
    src.busy_timeout(std::time::Duration::from_millis(100))?;
    let mut dst = Connection::open(target)?;
    {
        use rusqlite::backup::StepResult;
        let backup = rusqlite::backup::Backup::new(&src, &mut dst)?;
        let mut blocked = None;
        loop {
            match backup.step(128)? {
                StepResult::Done => break,
                StepResult::More => blocked = None,
                StepResult::Busy | StepResult::Locked => {
                    if blocked
                        .get_or_insert_with(std::time::Instant::now)
                        .elapsed()
                        >= std::time::Duration::from_secs(5)
                    {
                        return Err(SnapshotLocked(source.to_owned()).into());
                    }
                }
                _ => bail!("Unexpected SQLite snapshot state: {}", source.display()),
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    drop(dst);
    integrity(target)
}
fn excluded(manifest: &mut Manifest, resource: impl Into<String>, reason: &str) {
    manifest.excluded.push(Excluded {
        resource: resource.into(),
        reason: reason.into(),
    });
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && !name.contains(':')
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn add_file(
    archive: &mut Connection,
    scratch: &Scratch,
    manifest: &mut Manifest,
    source: &Path,
    name: String,
    main_db: Option<&Database>,
) -> Result<()> {
    if !safe_name(&name) {
        bail!("Unsupported backup file name: {name}");
    }
    let is_sqlite = main_db.is_some() || sqlite(source)?;
    let staged = scratch.0.join("snapshot.sqlite");
    if is_sqlite {
        drop(private_file(&staged)?);
    }
    let payload = if let Some(db) = main_db {
        db.backup_to(&staged)?;
        integrity(&staged)?;
        &staged
    } else if is_sqlite {
        if let Err(error) = snapshot(source, &staged) {
            if !name.starts_with("desktop/") || !snapshot_is_locked(&error) {
                return Err(error);
            }
            for suffix in ["", "-wal", "-shm", "-journal"] {
                match fs::remove_file(recovery_path(&staged, suffix)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            drop(private_file(&staged)?);
            locked_desktop_snapshot(source, &staged, |_| Ok(()))?;
        }
        &staged
    } else {
        source
    };
    let mut input = fs::File::open(payload)?;
    let expected = input.metadata()?.len();
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let tx = archive.transaction()?;
    let mut buffer = [0u8; CHUNK];
    let mut sequence = 0i64;
    loop {
        let limit = if name == "runtime/runtime.log" {
            expected.saturating_sub(size).min(CHUNK as u64) as usize
        } else {
            CHUNK
        };
        let count = input.read(&mut buffer[..limit])?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        size += count as u64;
        tx.execute(
            "INSERT INTO backup_chunks(path,sequence,data) VALUES (?,?,?)",
            params![name, sequence, &buffer[..count]],
        )?;
        sequence += 1;
    }
    if size != expected {
        bail!("File changed during backup: {name}");
    }
    let sha = hex::encode(digest.finalize());
    tx.execute(
        "INSERT INTO backup_files(path,size_bytes,sha256,sqlite) VALUES (?,?,?,?)",
        params![name, size, sha, is_sqlite],
    )?;
    tx.commit()?;
    manifest.files.push(Entry {
        path: name,
        size_bytes: size,
        sha256: sha,
        sqlite: is_sqlite,
    });
    drop(input);
    if is_sqlite {
        fs::remove_file(staged)?;
    }
    Ok(())
}
fn transient(name: &str, desktop: bool) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    base.ends_with("-wal")
        || base.ends_with("-shm")
        || base.ends_with("-journal")
        || base == "LOCK"
        || base == "lockfile"
        || base == "DevToolsActivePort"
        || base.starts_with("Singleton")
        || name == "review-indexes"
        || (desktop
            && name.split('/').any(|part| {
                matches!(
                    part,
                    "Cache"
                        | "Code Cache"
                        | "GPUCache"
                        | "DawnCache"
                        | "DawnGraphiteCache"
                        | "DawnWebGPUCache"
                        | "GrShaderCache"
                        | "ShaderCache"
                        | "blob_storage"
                        | "Shared Dictionary"
                        | "declarative_performance_observer.db"
                        | "DIPS"
                        | "Trust Tokens"
                )
            }))
}
const WEBSITE_SECRET_REASON: &str = "website sign-ins and site data of the built-in browser (secret) — sign in again after a restore";
const IDENTITY_SECRET_REASON: &str =
    "device pairing identity (secret) — pair mobile devices again after a restore";
fn secret_reason(name: &str, desktop: bool, directory: bool) -> Option<&'static str> {
    let parts = name
        .split('/')
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let base = parts.last()?.as_str();
    if base == "runtime.credential" || base.starts_with("runtime.credential.") {
        return Some("recreated on start");
    }
    if desktop
        && parts.iter().any(|part| {
            matches!(
                part.as_str(),
                "partitions"
                    | "network"
                    | "session storage"
                    | "indexeddb"
                    | "service worker"
                    | "webstorage"
                    | "storage"
                    | "file system"
                    | "databases"
                    | "local state"
                    | "secure preferences"
                    | "local extension settings"
                    | "session extension settings"
                    | "extension state"
                    | "sharedstorage"
                    | "shared_proto_db"
            )
        })
    {
        return Some(WEBSITE_SECRET_REASON);
    }
    if desktop
        && [
            "cookies",
            "login data",
            "web data",
            "quotaManager",
            "transportsecurity",
            "reporting and nel",
        ]
        .iter()
        .any(|candidate| {
            base == candidate.to_ascii_lowercase()
                || base.starts_with(&format!("{}-", candidate.to_ascii_lowercase()))
        })
    {
        return Some(WEBSITE_SECRET_REASON);
    }
    if !directory
        && (base.starts_with("remote-access-key.")
            || base.starts_with("remote-access-cert.")
            || base.starts_with(".env")
            || matches!(
                base,
                "auth.json" | "oauth.json" | "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
            )
            || [
                ".key", ".p12", ".pfx", ".ppk", ".der", ".jwk", ".key.pem", "_key.pem", "-key.pem",
            ]
            .iter()
            .any(|suffix| base.ends_with(suffix))
            || ((base.rsplit_once('.').is_none()
                || ["json", "txt", "token", "credential", "secret", "pem"]
                    .contains(&base.rsplit('.').next().unwrap_or("")))
                && base.split(['.', '-', '_']).any(|word| {
                    matches!(
                        word,
                        "key"
                            | "token"
                            | "tokens"
                            | "credential"
                            | "credentials"
                            | "secret"
                            | "secrets"
                            | "private"
                    )
                })))
    {
        return Some(IDENTITY_SECRET_REASON);
    }
    None
}
fn private_key_file(source: &Path) -> Result<bool> {
    let mut buffer = [0; 4096];
    let count = fs::File::open(source)?.read(&mut buffer)?;
    let prefix = String::from_utf8_lossy(&buffer[..count]);
    let first = prefix
        .trim_start_matches('\u{feff}')
        .trim_start()
        .lines()
        .next()
        .unwrap_or("")
        .trim_end();
    Ok(first.starts_with("PuTTY-User-Key-File-")
        || [
            "PRIVATE KEY",
            "ENCRYPTED PRIVATE KEY",
            "RSA PRIVATE KEY",
            "DSA PRIVATE KEY",
            "EC PRIVATE KEY",
            "OPENSSH PRIVATE KEY",
            "PGP PRIVATE KEY BLOCK",
        ]
        .iter()
        .any(|kind| first == format!("-----BEGIN {kind}-----")))
}
fn walk(
    archive: &mut Connection,
    scratch: &Scratch,
    manifest: &mut Manifest,
    root: &Path,
    directory: &Path,
    prefix: &str,
    db: &Database,
    skip: &[PathBuf],
    desktop: bool,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source = entry.path();
        let relative = source
            .strip_prefix(root)?
            .to_str()
            .ok_or_else(|| anyhow!("Unsupported backup file name"))?
            .replace('\\', "/");
        let name = format!("{prefix}/{relative}");
        if skip.iter().any(|path| source == *path) {
            continue;
        }
        let kind = entry.file_type()?;
        if let Some(reason) = secret_reason(&relative, desktop, kind.is_dir()) {
            excluded(manifest, name, reason);
            continue;
        }
        if transient(&relative, desktop) {
            excluded(
                manifest,
                name,
                "Rebuilt cache, SQLite sidecar captured by online backup, or transient lock",
            );
            continue;
        }
        if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
            excluded(
                manifest,
                name,
                "External link or non-regular resource; never followed out of ThreadTerm data",
            );
            continue;
        }
        if kind.is_dir() {
            walk(
                archive, scratch, manifest, root, &source, prefix, db, skip, desktop,
            )?;
        } else {
            if private_key_file(&source).with_context(|| format!("Backup failed: {name}"))? {
                excluded(manifest, name, IDENTITY_SECRET_REASON);
                continue;
            }
            add_file(
                archive,
                scratch,
                manifest,
                &source,
                name.clone(),
                if fs::canonicalize(db.path())? == source {
                    Some(db)
                } else {
                    None
                },
            )
            .map_err(|error| anyhow!("Backup failed: {name}: {error:#}"))?;
        }
    }
    Ok(())
}

pub(crate) fn create(
    config: &RuntimeConfig,
    db: &Database,
    target: &Path,
    desktop_root: &Path,
) -> Result<Value> {
    if !target.is_absolute()
        || !target.parent().is_some_and(Path::is_dir)
        || target.exists()
        || !desktop_root.is_dir()
    {
        bail!("invalid_backup_path");
    }
    let data = fs::canonicalize(&config.data_dir)?;
    let desktop = fs::canonicalize(desktop_root)?;
    let destination = fs::canonicalize(target.parent().unwrap())?.join(
        target
            .file_name()
            .ok_or_else(|| anyhow!("invalid_backup_path"))?,
    );
    if destination.starts_with(&data) || destination.starts_with(&desktop) {
        bail!("Backup destination must be outside ThreadTerm data");
    }
    let scratch = Scratch::new()?;
    let staged_archive = scratch.0.join("archive.sqlite3");
    drop(private_file(&staged_archive)?);
    let mut archive = Connection::open(&staged_archive)?;
    archive.execute_batch("CREATE TABLE backup_files(path TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,sqlite INTEGER NOT NULL); CREATE TABLE backup_chunks(path TEXT NOT NULL,sequence INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(path,sequence)); CREATE TABLE backup_documents(name TEXT PRIMARY KEY,body TEXT NOT NULL);")?;
    let mut manifest = Manifest {
        format: FORMAT.into(),
        version: 1,
        created_at: chrono::Utc::now().to_rfc3339(),
        files: Vec::new(),
        excluded: Vec::new(),
    };
    for resource in [
        "~/.claude",
        "~/.codex",
        "~/.kimi",
        "~/.gemini",
        "~/.local/share/opencode",
        "~/.pi",
        "~/.grok",
        "configured provider history folders",
    ] {
        excluded(
            &mut manifest,
            resource,
            "Provider-owned history remains external; use that provider's backup tools",
        );
    }
    excluded(
        &mut manifest,
        "project repositories and worktrees",
        "User source code remains external; back it up separately",
    );
    excluded(
        &mut manifest,
        "Electron caches and SQLite WAL/SHM files",
        "Caches are rebuilt; database sidecars are included in online SQLite snapshots",
    );
    let state = db.snapshot()?;
    let mut external = state
        .projects
        .iter()
        .map(|p| PathBuf::from(&p.path))
        .chain(
            state
                .sessions
                .iter()
                .filter_map(|s| s.worktree_path.as_ref().map(PathBuf::from)),
        )
        .collect::<Vec<_>>();
    let worktrees = db.transaction(|tx| {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='worktrees')",
            [],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(Vec::new());
        }
        let mut stmt = tx.prepare("SELECT path FROM worktrees")?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(paths)
    })?;
    external.extend(worktrees.into_iter().map(PathBuf::from));
    external.sort();
    external.dedup();
    for path in &external {
        excluded(
            &mut manifest,
            path.to_string_lossy(),
            "User repository or worktree; not owned by ThreadTerm",
        );
    }
    let mut skip = external
        .iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect::<Vec<_>>();
    // Snapshot the known owned databases even when a file is a symbolic link.
    let main_name = db
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Invalid database name"))?;
    add_file(
        &mut archive,
        &scratch,
        &mut manifest,
        db.path(),
        format!("runtime/{main_name}"),
        Some(db),
    )?;
    skip.push(data.join(main_name));
    let ledger = data.join("usage-ledger.sqlite");
    if ledger.is_file() {
        add_file(
            &mut archive,
            &scratch,
            &mut manifest,
            &ledger,
            "runtime/usage-ledger.sqlite".into(),
            None,
        )?;
        skip.push(ledger);
    }
    // TEMP can itself be nested inside a data root. Never archive our own staging tree.
    skip.push(fs::canonicalize(&scratch.0)?);
    let mut runtime_skip = skip.clone();
    if desktop != data && desktop.starts_with(&data) {
        runtime_skip.push(desktop.clone());
    }
    walk(
        &mut archive,
        &scratch,
        &mut manifest,
        &data,
        &data,
        "runtime",
        db,
        &runtime_skip,
        data == desktop,
    )?;
    let mut desktop_skip = skip.clone();
    if data != desktop && data.starts_with(&desktop) {
        desktop_skip.push(data.clone());
    }
    if data != desktop {
        walk(
            &mut archive,
            &scratch,
            &mut manifest,
            &desktop,
            &desktop,
            "desktop",
            db,
            &desktop_skip,
            true,
        )?;
    }
    archive.execute(
        "INSERT INTO backup_documents(name,body) VALUES ('manifest.json',?)",
        [serde_json::to_string_pretty(&manifest)?],
    )?;
    drop(archive);
    let verified = publish_archive(&staged_archive, target, verify)?;
    Ok(
        json!({"path":crate::git_read::plain_path(target),"sizeBytes":fs::metadata(target)?.len(),"format":"threadterm-sqlite-archive-v1","verification":verified}),
    )
}

pub(crate) fn verify(path: &Path) -> Result<Value> {
    if !path.is_absolute() || !path.is_file() {
        bail!("invalid_backup_path");
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        if Path::new(&sidecar).exists() {
            bail!(
                "Backup has an external SQLite sidecar: {}",
                Path::new(&sidecar).display()
            );
        }
    }
    // Immutable URI prevents a sidecar created after the check above from entering the verified state.
    let archive = immutable_archive(path)?;
    integrity_connection(&archive, path)
        .with_context(|| format!("Backup archive integrity failed: {}", path.display()))?;
    let raw: String = archive
        .query_row(
            "SELECT body FROM backup_documents WHERE name='manifest.json'",
            [],
            |r| r.get(0),
        )
        .context("Missing manifest.json")?;
    if raw.len() > 32 * 1024 * 1024 {
        bail!("manifest.json is too large");
    }
    let manifest: Manifest = serde_json::from_str(&raw).context("Invalid manifest.json")?;
    if manifest.format != FORMAT || manifest.version != 1 || manifest.files.is_empty() {
        bail!("Unsupported manifest.json");
    }
    let scratch = Scratch::new()?;
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !safe_name(&entry.path) || !seen.insert(&entry.path) {
            bail!("Invalid manifest entry: {}", entry.path);
        }
        let checked = (|| -> Result<()> {
            let stored: (u64, String, bool) = archive.query_row(
                "SELECT size_bytes,sha256,sqlite FROM backup_files WHERE path=?",
                [&entry.path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            if stored != (entry.size_bytes, entry.sha256.clone(), entry.sqlite) {
                bail!("manifest metadata mismatch");
            }
            let extracted = scratch.0.join("verify.sqlite");
            let mut file = if entry.sqlite {
                Some(private_file(&extracted)?)
            } else {
                None
            };
            let mut stmt = archive.prepare(
                "SELECT sequence,data FROM backup_chunks WHERE path=? ORDER BY sequence",
            )?;
            let mut rows = stmt.query([&entry.path])?;
            let mut digest = Sha256::new();
            let mut size = 0u64;
            let mut sequence = 0i64;
            while let Some(row) = rows.next()? {
                if row.get::<_, i64>(0)? != sequence {
                    bail!("missing data chunk");
                }
                let bytes = row.get_ref(1)?.as_blob()?;
                if bytes.is_empty() || bytes.len() > CHUNK {
                    bail!("invalid data chunk");
                }
                digest.update(bytes);
                size += bytes.len() as u64;
                sequence += 1;
                if let Some(file) = &mut file {
                    file.write_all(bytes)?;
                }
            }
            drop(file);
            if size != entry.size_bytes || hex::encode(digest.finalize()) != entry.sha256 {
                bail!("size or SHA-256 mismatch");
            }
            if entry.sqlite {
                integrity(&extracted)?;
                fs::remove_file(extracted)?;
            }
            total += size;
            Ok(())
        })();
        checked.with_context(|| format!("Backup verification failed: {}", entry.path))?;
    }
    let mut all =
        archive.prepare("SELECT path FROM backup_files UNION SELECT path FROM backup_chunks")?;
    for path in all.query_map([], |row| row.get::<_, String>(0))? {
        let name = path?;
        if !seen.contains(&name) {
            bail!("Backup contains a file absent from manifest.json: {name}");
        }
    }
    Ok(
        json!({"verified":true,"files":manifest.files.len(),"sizeBytes":total,"checkedAt":chrono::Utc::now().to_rfc3339()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, RuntimeConfig, Database, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let profile = temp.path().join("profile");
        fs::create_dir(&data).unwrap();
        fs::create_dir(&profile).unwrap();
        let config = RuntimeConfig {
            database_path: data.join("threadterm-v3.sqlite3"),
            credential_path: data.join("runtime.credential"),
            data_dir: data,
            pipe_base: r"\\.\pipe\backup-test".into(),
        };
        let db = Database::open(&config.database_path).unwrap();
        let target = temp.path().join("backup.sqlite3");
        (temp, config, db, profile, target)
    }
    fn manifest(path: &Path) -> Manifest {
        let conn = read_only(path).unwrap();
        let raw: String = conn
            .query_row(
                "SELECT body FROM backup_documents WHERE name='manifest.json'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn extract(path: &Path, name: &str) -> Vec<u8> {
        let conn = read_only(path).unwrap();
        let mut bytes = Vec::new();
        let mut stmt = conn
            .prepare("SELECT data FROM backup_chunks WHERE path=? ORDER BY sequence")
            .unwrap();
        for row in stmt.query_map([name], |r| r.get::<_, Vec<u8>>(0)).unwrap() {
            bytes.extend(row.unwrap());
        }
        bytes
    }
    #[test]
    fn complete_archive_snapshots_databases_assets_plugins_and_verifies_hashes() {
        let (_temp, config, db, profile, target) = fixture();
        let ledger = Connection::open(config.data_dir.join("usage-ledger.sqlite")).unwrap();
        ledger.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE usage(n INTEGER); INSERT INTO usage VALUES(7);").unwrap();
        let files = [
            ("plugins/example/plugin.json", b"{plugin}".as_slice()),
            ("review-objects/store/objects/example", b"checkpoint"),
            ("review-git/store/HEAD", b"ref: refs/heads/main"),
            ("runtime.credential", b"secret"),
            ("future-owned-data.bin", b"future"),
            ("runtime.log", b"current diagnostic log"),
            ("runtime.log.1", b"retained diagnostic log"),
        ];
        for (path, bytes) in files {
            let path = config.data_dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        fs::create_dir_all(profile.join("page-comments")).unwrap();
        fs::write(profile.join("page-comments/shot.png"), b"image").unwrap();
        fs::write(profile.join("browser-preferences.json"), b"{}").unwrap();
        fs::create_dir_all(profile.join("Crash Reports")).unwrap();
        fs::write(
            profile.join("Crash Reports/historical.dmp"),
            b"owned diagnostic",
        )
        .unwrap();
        fs::create_dir_all(profile.join("Cache")).unwrap();
        fs::write(profile.join("Cache/rebuilt"), b"cache").unwrap();
        let repository = config.data_dir.join("user-repo");
        fs::create_dir(&repository).unwrap();
        fs::write(repository.join("private.rs"), b"source").unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO projects(id,name,path,created_at) VALUES('p','Project',?,'now')",
                [repository.to_str().unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
        let result = create(&config, &db, &target, &profile).unwrap();
        assert_eq!(result["verification"]["verified"], true);
        let manifest = manifest(&target);
        for name in [
            "runtime/threadterm-v3.sqlite3",
            "runtime/usage-ledger.sqlite",
            "desktop/page-comments/shot.png",
            "desktop/browser-preferences.json",
            "desktop/Crash Reports/historical.dmp",
            "runtime/plugins/example/plugin.json",
            "runtime/review-git/store/HEAD",
            "runtime/review-objects/store/objects/example",
            "runtime/future-owned-data.bin",
            "runtime/runtime.log",
            "runtime/runtime.log.1",
        ] {
            let entry = manifest
                .files
                .iter()
                .find(|entry| entry.path == name)
                .unwrap_or_else(|| panic!("missing {name}"));
            let bytes = extract(&target, name);
            assert_eq!(entry.size_bytes, bytes.len() as u64);
            assert_eq!(entry.sha256, hex::encode(Sha256::digest(&bytes)));
        }
        assert!(!manifest.files.iter().any(|e| e.path.contains("user-repo")
            || e.path.contains("/Cache/")
            || e.path.ends_with("-wal")));
        for resource in [
            "~/.claude",
            "~/.codex",
            "~/.kimi",
            "~/.gemini",
            "~/.local/share/opencode",
            "~/.pi",
            "~/.grok",
            "project repositories and worktrees",
            "desktop/Cache",
        ] {
            assert!(
                manifest
                    .excluded
                    .iter()
                    .any(|e| e.resource == resource && !e.reason.is_empty()),
                "missing exclusion {resource}"
            );
        }
        let copy = _temp.path().join("ledger-copy.sqlite");
        fs::write(&copy, extract(&target, "runtime/usage-ledger.sqlite")).unwrap();
        assert_eq!(
            read_only(&copy)
                .unwrap()
                .query_row("SELECT n FROM usage", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert!(verify(&target).unwrap()["files"].as_u64().unwrap() >= 9);
        assert!(create(&config, &db, &target, &profile).is_err());
        assert!(create(
            &config,
            &db,
            &config.data_dir.join("recursive.sqlite3"),
            &profile
        )
        .is_err());
    }
    #[test]
    fn missing_or_corrupt_payload_names_the_file() {
        let (_temp, config, db, profile, target) = fixture();
        fs::write(config.data_dir.join("owned.bin"), b"correct").unwrap();
        create(&config, &db, &target, &profile).unwrap();
        let conn = Connection::open(&target).unwrap();
        conn.execute(
            "UPDATE backup_chunks SET data=? WHERE path='runtime/owned.bin'",
            [b"corrupt".as_slice()],
        )
        .unwrap();
        let error = format!("{:#}", verify(&target).unwrap_err());
        assert!(
            error.contains("runtime/owned.bin") && error.contains("SHA-256"),
            "{error}"
        );
        conn.execute(
            "DELETE FROM backup_chunks WHERE path='runtime/owned.bin'",
            [],
        )
        .unwrap();
        assert!(format!("{:#}", verify(&target).unwrap_err()).contains("runtime/owned.bin"));
        conn.execute(
            "DELETE FROM backup_files WHERE path='runtime/owned.bin'",
            [],
        )
        .unwrap();
        assert!(format!("{:#}", verify(&target).unwrap_err()).contains("runtime/owned.bin"));
    }
    #[test]
    fn sqlite_integrity_is_checked_even_when_manifest_hashes_match() {
        let (_temp, config, db, profile, target) = fixture();
        create(&config, &db, &target, &profile).unwrap();
        let conn = Connection::open(&target).unwrap();
        let bytes = b"not a database";
        let sha = hex::encode(Sha256::digest(bytes));
        let mut manifest = manifest(&target);
        let entry = manifest
            .files
            .iter_mut()
            .find(|e| e.path == "runtime/threadterm-v3.sqlite3")
            .unwrap();
        entry.size_bytes = bytes.len() as u64;
        entry.sha256 = sha.clone();
        conn.execute("DELETE FROM backup_chunks WHERE path=?", [&entry.path])
            .unwrap();
        conn.execute(
            "INSERT INTO backup_chunks VALUES(?,0,?)",
            params![entry.path, bytes.as_slice()],
        )
        .unwrap();
        conn.execute(
            "UPDATE backup_files SET size_bytes=?,sha256=? WHERE path=?",
            params![entry.size_bytes, sha, entry.path],
        )
        .unwrap();
        conn.execute(
            "UPDATE backup_documents SET body=? WHERE name='manifest.json'",
            [serde_json::to_string(&manifest).unwrap()],
        )
        .unwrap();
        assert!(
            format!("{:#}", verify(&target).unwrap_err()).contains("runtime/threadterm-v3.sqlite3")
        );
    }
}

#[cfg(test)]
#[path = "data_backup_review_tests.rs"]
mod review_tests;

#[cfg(test)]
#[path = "data_backup_secret_tests.rs"]
mod secret_tests;
