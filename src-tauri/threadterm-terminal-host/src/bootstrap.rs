use std::{
    fmt, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use terminal_host_protocol::ProtocolVersion;

use crate::HostError;

pub const ENDPOINT_SCHEMA_VERSION: u8 = 1;
pub const MAX_ENDPOINT_BYTES: u64 = 64 * 1024;
pub const SECRET_BYTES: usize = 32;
const BOOTSTRAP_DIRECTORY: &str = "terminal-host";
const ENDPOINT_FILE: &str = "runtime.endpoint.json";
const SECRET_FILE: &str = "runtime.secret";
const CATALOG_FILE: &str = "runtime.sqlite";

#[derive(Clone, Eq, PartialEq)]
pub struct BootstrapPaths {
    root: PathBuf,
    endpoint: PathBuf,
    secret: PathBuf,
    catalog: PathBuf,
}

impl BootstrapPaths {
    /// The input is an operational OS path. It is never converted to a display
    /// string and every runtime artifact is kept under one dedicated child.
    pub fn from_profile_dir(profile_dir: PathBuf) -> Result<Self, HostError> {
        if !profile_dir.is_absolute() {
            return Err(HostError::InvalidArguments);
        }
        reject_reparse_ancestors(&profile_dir)?;
        let profile_dir = fs::canonicalize(profile_dir).map_err(|_| HostError::InvalidArguments)?;
        let root = profile_dir.join(BOOTSTRAP_DIRECTORY);
        Ok(Self {
            endpoint: root.join(ENDPOINT_FILE),
            secret: root.join(SECRET_FILE),
            catalog: root.join(CATALOG_FILE),
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn endpoint(&self) -> &Path {
        &self.endpoint
    }

    pub fn secret(&self) -> &Path {
        &self.secret
    }

    pub fn catalog(&self) -> &Path {
        &self.catalog
    }

    pub fn catalog_sidecars(&self) -> [PathBuf; 2] {
        [
            self.root.join("runtime.sqlite-wal"),
            self.root.join("runtime.sqlite-shm"),
        ]
    }
}

impl fmt::Debug for BootstrapPaths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BootstrapPaths")
            .field("root", &"[redacted-path]")
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEndpoint {
    pub schema_version: u8,
    pub protocol_min: ProtocolVersion,
    pub protocol_max: ProtocolVersion,
    pub runtime_id: String,
    pub pid: u32,
    pub process_start_time: String,
    pub pipe_name: String,
    pub daemon_version: String,
    pub launch_nonce: String,
    pub owner_generation: u64,
}

impl RuntimeEndpoint {
    pub fn validate(&self) -> Result<(), HostError> {
        let valid = self.schema_version == ENDPOINT_SCHEMA_VERSION
            && self.protocol_min.major == self.protocol_max.major
            && self.protocol_min.minor <= self.protocol_max.minor
            && self.pid > 0
            && self.owner_generation > 0
            && valid_identifier(&self.runtime_id)
            && valid_identifier(&self.launch_nonce)
            && valid_identifier(&self.process_start_time)
            && valid_identifier(&self.daemon_version)
            && valid_local_pipe_name(&self.pipe_name);
        valid.then_some(()).ok_or(HostError::InvalidEndpoint)
    }

    pub fn identity(&self) -> EndpointIdentity {
        EndpointIdentity {
            runtime_id: self.runtime_id.clone(),
            launch_nonce: self.launch_nonce.clone(),
            owner_generation: self.owner_generation,
        }
    }
}

impl fmt::Debug for RuntimeEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeEndpoint")
            .field("schema_version", &self.schema_version)
            .field("protocol_min", &self.protocol_min)
            .field("protocol_max", &self.protocol_max)
            .field("runtime_id", &self.runtime_id)
            .field("pid", &self.pid)
            .field("process_start_time", &self.process_start_time)
            .field("pipe_name", &"[redacted-pipe]")
            .field("daemon_version", &self.daemon_version)
            .field("launch_nonce", &self.launch_nonce)
            .field("owner_generation", &self.owner_generation)
            .finish()
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256
}

pub fn valid_local_pipe_name(value: &str) -> bool {
    const PREFIX: &str = r"\\.\pipe\ThreadTerm.TerminalHost.";
    value.strip_prefix(PREFIX).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 160
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    })
}

pub fn prepare_bootstrap_root(paths: &BootstrapPaths) -> Result<(), HostError> {
    let profile = paths.root.parent().ok_or(HostError::InvalidArguments)?;
    if !profile.is_absolute() || !profile.is_dir() {
        return Err(HostError::InvalidArguments);
    }
    reject_reparse_path(profile)?;
    #[cfg(not(windows))]
    fs::create_dir(&paths.root).or_else(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    #[cfg(windows)]
    {
        let sid = crate::windows_security::current_process_sid()?;
        crate::windows_security::create_or_validate_private_directory(&paths.root, &sid)?;
    }
    reject_reparse_path(&paths.root)?;
    #[cfg(windows)]
    {
        let sid = crate::windows_security::current_process_sid()?;
        crate::windows_security::validate_path_acl(&paths.root, &sid)?;
    }
    Ok(())
}

fn reject_reparse_path(path: &Path) -> Result<(), HostError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        let metadata = fs::symlink_metadata(path).map_err(|_| HostError::Security)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(HostError::Security);
        }
    }
    #[cfg(not(windows))]
    if fs::symlink_metadata(path)
        .map_err(|_| HostError::Security)?
        .file_type()
        .is_symlink()
    {
        return Err(HostError::Security);
    }
    Ok(())
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), HostError> {
    for ancestor in path.ancestors() {
        if !ancestor.as_os_str().is_empty() {
            reject_reparse_path(ancestor)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointIdentity {
    pub runtime_id: String,
    pub launch_nonce: String,
    pub owner_generation: u64,
}

pub fn read_endpoint(path: &Path) -> Result<RuntimeEndpoint, HostError> {
    #[cfg(windows)]
    let file = {
        let sid = crate::windows_security::current_process_sid()?;
        let mut attempts = 0;
        loop {
            match crate::windows_security::open_private_file_read(path, &sid) {
                Ok(file) => break file,
                Err(HostError::Io) if attempts < 32 => {
                    attempts += 1;
                    std::thread::yield_now();
                }
                Err(error) => return Err(error),
            }
        }
    };
    #[cfg(not(windows))]
    let file = std::fs::File::open(path).map_err(|_| HostError::InvalidEndpoint)?;
    let length = file
        .metadata()
        .map_err(|_| HostError::InvalidEndpoint)?
        .len();
    if length == 0 || length > MAX_ENDPOINT_BYTES {
        return Err(if length > MAX_ENDPOINT_BYTES {
            HostError::EndpointTooLarge
        } else {
            HostError::InvalidEndpoint
        });
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_ENDPOINT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError::InvalidEndpoint)?;
    if bytes.len() as u64 > MAX_ENDPOINT_BYTES {
        return Err(HostError::EndpointTooLarge);
    }
    let endpoint: RuntimeEndpoint =
        serde_json::from_slice(&bytes).map_err(|_| HostError::InvalidEndpoint)?;
    endpoint.validate()?;
    Ok(endpoint)
}

#[derive(Clone, Eq, PartialEq)]
pub struct Secret([u8; SECRET_BYTES]);

impl Secret {
    pub fn generate() -> Result<Self, HostError> {
        let mut bytes = [0_u8; SECRET_BYTES];
        getrandom::getrandom(&mut bytes).map_err(|_| HostError::SecretUnavailable)?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; SECRET_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn encoded(&self) -> String {
        STANDARD_NO_PAD.encode(self.0)
    }

    pub fn verify_encoded(&self, candidate: &str) -> bool {
        let expected = self.encoded();
        let expected = expected.as_bytes();
        let candidate = candidate.as_bytes();
        let mut difference = candidate.len() ^ expected.len();
        for index in 0..43 {
            difference |= usize::from(
                expected.get(index).copied().unwrap_or(0)
                    ^ candidate.get(index).copied().unwrap_or(0),
            );
        }
        difference == 0
    }

    pub fn verify_bytes(&self, candidate: &[u8]) -> bool {
        let mut difference = candidate.len() ^ SECRET_BYTES;
        for index in 0..SECRET_BYTES {
            difference |= usize::from(self.0[index] ^ candidate.get(index).copied().unwrap_or(0));
        }
        difference == 0
    }

    /// Derive a request digest without exposing the profile authentication
    /// secret. Fields are length-prefixed so no two field partitions have the
    /// same transcript.
    pub fn derive_create_digest(&self, fields: &[&[u8]]) -> [u8; 32] {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC accepts a key of any size");
        mac.update(b"ThreadTerm terminal create digest v1\0");
        mac.update(&(fields.len() as u64).to_le_bytes());
        for field in fields {
            mac.update(&(field.len() as u64).to_le_bytes());
            mac.update(field);
        }
        mac.finalize().into_bytes().into()
    }

    pub fn persist_create_new(&self, path: &Path) -> Result<(), HostError> {
        self.persist_create_new_observed(path, &NoopSecretPublishObserver)
    }

    pub fn persist_create_new_observed(
        &self,
        path: &Path,
        observer: &dyn SecretPublishObserver,
    ) -> Result<(), HostError> {
        let directory = path.parent().ok_or(HostError::SecretUnavailable)?;
        let mut suffix = [0_u8; 16];
        getrandom::getrandom(&mut suffix).map_err(|_| HostError::SecretUnavailable)?;
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temp = directory.join(format!(".{SECRET_FILE}.{suffix}.tmp"));
        let mut cleanup = TempCleanup(Some(temp.clone()));
        #[cfg(not(windows))]
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| HostError::SecretUnavailable)?;
        #[cfg(windows)]
        let mut file = {
            let sid = crate::windows_security::current_process_sid()?;
            crate::windows_security::create_private_file_new(&temp, &sid)
                .map_err(|_| HostError::SecretUnavailable)?
        };
        observer.checkpoint(SecretPublishCheckpoint::TempCreated)?;
        file.write_all(&self.0)
            .and_then(|_| file.flush())
            .map_err(|_| HostError::SecretUnavailable)?;
        observer.checkpoint(SecretPublishCheckpoint::BodyWritten)?;
        file.sync_all().map_err(|_| HostError::SecretUnavailable)?;
        observer.checkpoint(SecretPublishCheckpoint::TempSynced)?;
        drop(file);
        observer.checkpoint(SecretPublishCheckpoint::BeforeInstall)?;
        atomic_install_no_replace(&temp, path).map_err(|_| HostError::SecretUnavailable)?;
        cleanup.0.take();
        observer.checkpoint(SecretPublishCheckpoint::Installed)?;
        #[cfg(windows)]
        {
            let sid = crate::windows_security::current_process_sid()?;
            crate::windows_security::validate_path_acl(path, &sid)
                .map_err(|_| HostError::SecretUnavailable)?;
        }
        sync_parent(directory).map_err(|_| HostError::SecretUnavailable)
    }

    pub fn read(path: &Path) -> Result<Self, HostError> {
        #[cfg(windows)]
        let file = {
            let sid = crate::windows_security::current_process_sid()?;
            crate::windows_security::open_private_file_read(path, &sid)
                .map_err(|_| HostError::SecretUnavailable)?
        };
        #[cfg(not(windows))]
        let mut file = std::fs::File::open(path).map_err(|_| HostError::SecretUnavailable)?;
        let mut bytes = Vec::with_capacity(SECRET_BYTES + 1);
        file.take((SECRET_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| HostError::SecretUnavailable)?;
        let bytes: [u8; SECRET_BYTES] =
            bytes.try_into().map_err(|_| HostError::SecretUnavailable)?;
        Ok(Self(bytes))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretPublishCheckpoint {
    TempCreated,
    BodyWritten,
    TempSynced,
    BeforeInstall,
    Installed,
}

pub trait SecretPublishObserver {
    fn checkpoint(&self, checkpoint: SecretPublishCheckpoint) -> Result<(), HostError>;
}

pub struct NoopSecretPublishObserver;

impl SecretPublishObserver for NoopSecretPublishObserver {
    fn checkpoint(&self, _: SecretPublishCheckpoint) -> Result<(), HostError> {
        Ok(())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret([redacted])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishCheckpoint {
    TempCreated,
    BodyWritten,
    TempSynced,
    BeforeReplace,
    Replaced,
}

pub trait PublishObserver {
    fn checkpoint(&self, checkpoint: PublishCheckpoint) -> Result<(), HostError>;
}

#[derive(Default)]
pub struct NoopPublishObserver;

impl PublishObserver for NoopPublishObserver {
    fn checkpoint(&self, _: PublishCheckpoint) -> Result<(), HostError> {
        Ok(())
    }
}

pub fn publish_endpoint_atomic(
    path: &Path,
    endpoint: &RuntimeEndpoint,
    observer: &dyn PublishObserver,
) -> Result<(), HostError> {
    endpoint.validate()?;
    let body = serde_json::to_vec(endpoint).map_err(|_| HostError::InvalidEndpoint)?;
    if body.len() as u64 > MAX_ENDPOINT_BYTES {
        return Err(HostError::EndpointTooLarge);
    }
    let directory = path.parent().ok_or(HostError::InvalidEndpoint)?;
    let mut suffix = [0_u8; 16];
    getrandom::getrandom(&mut suffix).map_err(|_| HostError::Io)?;
    let suffix = suffix
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temp = directory.join(format!(".{ENDPOINT_FILE}.{suffix}.tmp"));
    let mut cleanup = TempCleanup(Some(temp.clone()));
    #[cfg(not(windows))]
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    #[cfg(windows)]
    let mut file = {
        let sid = crate::windows_security::current_process_sid()?;
        crate::windows_security::create_private_file_new(&temp, &sid)?
    };
    observer.checkpoint(PublishCheckpoint::TempCreated)?;
    file.write_all(&body)?;
    file.flush()?;
    observer.checkpoint(PublishCheckpoint::BodyWritten)?;
    file.sync_all()?;
    observer.checkpoint(PublishCheckpoint::TempSynced)?;
    observer.checkpoint(PublishCheckpoint::BeforeReplace)?;
    drop(file);
    atomic_replace(&temp, path)?;
    cleanup.0.take();
    observer.checkpoint(PublishCheckpoint::Replaced)?;
    #[cfg(windows)]
    {
        let sid = crate::windows_security::current_process_sid()?;
        crate::windows_security::validate_path_acl(path, &sid)?;
    }
    sync_parent(directory)?;
    Ok(())
}

struct TempCleanup(Option<PathBuf>);

impl Drop for TempCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), HostError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            REPLACEFILE_WRITE_THROUGH,
        },
    };
    let destination_exists = destination.exists();
    let destination_is_secure = destination_exists
        && crate::windows_security::current_process_sid()
            .and_then(|sid| crate::windows_security::validate_path_acl(destination, &sid))
            .is_ok();
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if destination_is_secure {
        unsafe {
            ReplaceFileW(
                PCWSTR(destination.as_ptr()),
                PCWSTR(source.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        }
        .map_err(|_| HostError::Io)
    } else {
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|_| HostError::Io)
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), HostError> {
    fs::rename(source, destination).map_err(Into::into)
}

fn sync_parent(directory: &Path) -> Result<(), HostError> {
    #[cfg(not(windows))]
    std::fs::File::open(directory)?.sync_all()?;
    #[cfg(windows)]
    let _ = directory;
    Ok(())
}

#[cfg(windows)]
fn atomic_install_no_replace(source: &Path, destination: &Path) -> Result<(), HostError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH},
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| HostError::Io)
}

#[cfg(not(windows))]
fn atomic_install_no_replace(source: &Path, destination: &Path) -> Result<(), HostError> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)?;
    Ok(())
}

pub struct OwnerCleanupProof {
    identity: EndpointIdentity,
}

impl OwnerCleanupProof {
    pub(crate) fn from_owner_claim(identity: EndpointIdentity) -> Self {
        Self { identity }
    }
}

pub fn cleanup_endpoint_if_owned(
    path: &Path,
    target: &EndpointIdentity,
    proof: &OwnerCleanupProof,
) -> Result<bool, HostError> {
    if &proof.identity != target {
        return Ok(false);
    }
    let current = match read_endpoint(path) {
        Ok(value) => value,
        Err(HostError::InvalidEndpoint) | Err(HostError::EndpointTooLarge) => return Ok(false),
        Err(error) => return Err(error),
    };
    if current.identity() != *target {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|_| HostError::Io)?;
    Ok(true)
}
