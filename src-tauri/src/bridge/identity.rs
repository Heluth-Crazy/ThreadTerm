//! Persistent secure-bridge desktop identity (TLS cert + computerId).
//!
//! Stored under the managed data root with atomic write + backup recovery.
//! Corrupt primary falls back to a valid backup. If neither is valid, the
//! secure bridge reports `identity_error` and requires explicit rotation.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{distributions::Alphanumeric, Rng};
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const IDENTITY_FORMAT_VERSION: u32 = 1;
const IDENTITY_FILE_NAME: &str = "bridge-identity.json";
const IDENTITY_BACKUP_NAME: &str = "bridge-identity.previous.json";
const COMPUTER_ID_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureBridgeIdentity {
    pub format_version: u32,
    pub computer_id: String,
    /// PEM-encoded certificate.
    pub certificate_pem: String,
    /// PEM-encoded PKCS#8 private key.
    pub private_key_pem: String,
    /// Lowercase hex SHA-256 over the certificate DER.
    pub fingerprint_sha256: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityLoadError {
    Missing,
    Corrupt { reason: String },
}

impl std::fmt::Display for IdentityLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => write!(f, "Secure bridge identity is missing."),
            Self::Corrupt { reason } => {
                write!(f, "Secure bridge identity is unusable: {reason}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureIdentityStatus {
    Ready {
        computer_id: String,
        fingerprint_sha256: String,
        fingerprint_short: String,
        recovered_backup: bool,
    },
    IdentityError {
        reason: String,
    },
    Missing,
}

impl SecureIdentityStatus {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Ready { .. } => "ready",
            Self::IdentityError { .. } => "identity_error",
            Self::Missing => "missing",
        }
    }
}

pub struct SecureIdentityStore {
    state_dir: PathBuf,
    lock: Mutex<()>,
    cached: Mutex<Option<SecureBridgeIdentity>>,
}

impl SecureIdentityStore {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            state_dir,
            lock: Mutex::new(()),
            cached: Mutex::new(None),
        }
    }

    pub fn identity_path(&self) -> PathBuf {
        self.state_dir.join(IDENTITY_FILE_NAME)
    }

    pub fn backup_path(&self) -> PathBuf {
        self.state_dir.join(IDENTITY_BACKUP_NAME)
    }

    /// Load existing identity or generate a new one on first use.
    pub fn load_or_create(&self) -> Result<SecureBridgeIdentity, IdentityLoadError> {
        match self.load() {
            Ok((identity, recovered)) => {
                if recovered {
                    // Persist recovered backup into primary so next start is clean.
                    if let Err(error) = self.write_identity(&identity) {
                        tracing::warn!(error = %error, "Failed to rewrite recovered bridge identity");
                    }
                }
                Ok(identity)
            }
            Err(IdentityLoadError::Missing) => {
                let identity =
                    generate_identity().map_err(|reason| IdentityLoadError::Corrupt { reason })?;
                self.write_identity(&identity)
                    .map_err(|reason| IdentityLoadError::Corrupt { reason })?;
                Ok(identity)
            }
            Err(error) => Err(error),
        }
    }

    /// Load without creating. Uses backup when primary is corrupt.
    pub fn load(&self) -> Result<(SecureBridgeIdentity, bool), IdentityLoadError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let primary = self.identity_path();
        let backup = self.backup_path();

        if primary.exists() {
            match parse_identity_file(&primary) {
                Ok(identity) => {
                    self.cache(identity.clone());
                    return Ok((identity, false));
                }
                Err(primary_error) => {
                    if backup.exists() {
                        match parse_identity_file(&backup) {
                            Ok(identity) => {
                                tracing::warn!(
                                    primary_error = %primary_error,
                                    "Recovered secure bridge identity from backup"
                                );
                                self.cache(identity.clone());
                                return Ok((identity, true));
                            }
                            Err(backup_error) => {
                                return Err(IdentityLoadError::Corrupt {
                                    reason: format!(
                                        "primary: {primary_error}; backup: {backup_error}"
                                    ),
                                });
                            }
                        }
                    }
                    return Err(IdentityLoadError::Corrupt {
                        reason: primary_error,
                    });
                }
            }
        }

        if backup.exists() {
            match parse_identity_file(&backup) {
                Ok(identity) => {
                    self.cache(identity.clone());
                    return Ok((identity, true));
                }
                Err(reason) => {
                    return Err(IdentityLoadError::Corrupt { reason });
                }
            }
        }

        Err(IdentityLoadError::Missing)
    }

    pub fn status(&self) -> SecureIdentityStatus {
        match self.load() {
            Ok((identity, recovered)) => SecureIdentityStatus::Ready {
                computer_id: identity.computer_id,
                fingerprint_short: fingerprint_short(&identity.fingerprint_sha256),
                fingerprint_sha256: identity.fingerprint_sha256,
                recovered_backup: recovered,
            },
            Err(IdentityLoadError::Missing) => SecureIdentityStatus::Missing,
            Err(IdentityLoadError::Corrupt { reason }) => {
                SecureIdentityStatus::IdentityError { reason }
            }
        }
    }

    /// Explicit rotation: replace identity and return the new document.
    /// Callers must revoke secure-workspace tokens after rotation.
    pub fn rotate(&self) -> Result<SecureBridgeIdentity, String> {
        let identity = generate_identity()?;
        let mut rotated = identity;
        rotated.rotated_at = Some(now_seconds());
        self.write_identity(&rotated)?;
        Ok(rotated)
    }

    pub fn write_identity(&self, identity: &SecureBridgeIdentity) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        write_identity_atomic(&self.state_dir, identity)?;
        self.cache(identity.clone());
        Ok(())
    }

    #[allow(dead_code)]
    pub fn cached(&self) -> Option<SecureBridgeIdentity> {
        self.cached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn cache(&self, identity: SecureBridgeIdentity) {
        if let Ok(mut guard) = self.cached.lock() {
            *guard = Some(identity);
        }
    }

    /// Build rustls certificate chain + private key for the TLS listener.
    pub fn rustls_materials(
        identity: &SecureBridgeIdentity,
    ) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
        let mut cert_reader = std::io::Cursor::new(identity.certificate_pem.as_bytes());
        let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to parse bridge certificate PEM: {error}"))?;
        if certs.is_empty() {
            return Err("Bridge certificate PEM contained no certificates.".to_string());
        }

        let mut key_reader = std::io::Cursor::new(identity.private_key_pem.as_bytes());
        let key = rustls_pemfile::private_key(&mut key_reader)
            .map_err(|error| format!("Failed to parse bridge private key PEM: {error}"))?
            .ok_or_else(|| "Bridge private key PEM contained no key.".to_string())?;

        // Re-wrap as owned PKCS#8 when possible for rustls.
        let key = match key {
            PrivateKeyDer::Pkcs8(der) => {
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der.secret_pkcs8_der().to_vec()))
            }
            other => other,
        };

        Ok((certs, key))
    }
}

pub fn fingerprint_short(fingerprint_sha256: &str) -> String {
    fingerprint_sha256.chars().take(12).collect()
}

pub fn certificate_fingerprint_sha256(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn fingerprints_match(expected: &str, presented: &str) -> bool {
    expected.eq_ignore_ascii_case(presented)
}

fn generate_identity() -> Result<SecureBridgeIdentity, String> {
    let key_pair =
        KeyPair::generate().map_err(|error| format!("Failed to generate key: {error}"))?;
    let computer_id: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(COMPUTER_ID_LEN)
        .map(char::from)
        .collect();

    let mut params = CertificateParams::new(vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "threadterm.local".to_string(),
    ])
    .map_err(|error| format!("Failed to build certificate params: {error}"))?;
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, format!("ThreadTerm {computer_id}"));
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2049, 12, 31);

    let cert = params
        .self_signed(&key_pair)
        .map_err(|error| format!("Failed to self-sign bridge certificate: {error}"))?;

    let certificate_pem = cert.pem();
    let private_key_pem = key_pair.serialize_pem();
    let der = cert.der();
    let fingerprint_sha256 = certificate_fingerprint_sha256(der.as_ref());

    Ok(SecureBridgeIdentity {
        format_version: IDENTITY_FORMAT_VERSION,
        computer_id,
        certificate_pem,
        private_key_pem,
        fingerprint_sha256,
        created_at: now_seconds(),
        rotated_at: None,
    })
}

fn parse_identity_file(path: &Path) -> Result<SecureBridgeIdentity, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let identity: SecureBridgeIdentity = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    validate_identity(&identity)?;
    Ok(identity)
}

fn validate_identity(identity: &SecureBridgeIdentity) -> Result<(), String> {
    if identity.format_version != IDENTITY_FORMAT_VERSION {
        return Err(format!(
            "Unsupported bridge identity version {}",
            identity.format_version
        ));
    }
    if !(24..=128).contains(&identity.computer_id.len())
        || !identity
            .computer_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid computerId in bridge identity.".to_string());
    }
    if identity.certificate_pem.trim().is_empty() || identity.private_key_pem.trim().is_empty() {
        return Err("Bridge identity is missing certificate material.".to_string());
    }
    if identity.fingerprint_sha256.len() != 64
        || !identity
            .fingerprint_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Bridge identity fingerprint is invalid.".to_string());
    }

    // Ensure PEM material is parseable and fingerprint matches DER.
    let (certs, _key) = SecureIdentityStore::rustls_materials(identity)?;
    let presented = certificate_fingerprint_sha256(certs[0].as_ref());
    if !fingerprints_match(&identity.fingerprint_sha256, &presented) {
        return Err("Bridge identity fingerprint does not match certificate DER.".to_string());
    }
    Ok(())
}

fn write_identity_atomic(state_dir: &Path, identity: &SecureBridgeIdentity) -> Result<(), String> {
    fs::create_dir_all(state_dir)
        .map_err(|error| format!("Could not create {}: {error}", state_dir.display()))?;

    let path = state_dir.join(IDENTITY_FILE_NAME);
    let backup = state_dir.join(IDENTITY_BACKUP_NAME);
    let temp_path = unique_temp_path(&path);
    let bytes = serde_json::to_vec_pretty(identity)
        .map_err(|error| format!("Could not serialize bridge identity: {error}"))?;

    {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Could not create {}: {error}", temp_path.display()))?;
        temp.write_all(&bytes)
            .and_then(|_| temp.sync_all())
            .map_err(|error| format!("Could not persist {}: {error}", temp_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
        }
    }

    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                format!("Could not replace {}: {error}", backup.display())
            })?;
        }
        fs::rename(&path, &backup).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Could not preserve previous bridge identity {}: {error}",
                path.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&temp_path, &path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not activate bridge identity {}: {error}",
            path.display()
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

fn unique_temp_path(target: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("bridge-identity.json");
    target.with_file_name(format!(".{file_name}.{}-{nonce}.tmp", std::process::id()))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "threadterm-bridge-identity-{}-{}-{}",
            std::process::id(),
            now_seconds(),
            nonce
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn load_or_create_persists_identity_atomically() {
        let dir = temp_dir();
        let store = SecureIdentityStore::new(dir.clone());
        let first = store.load_or_create().expect("create identity");
        assert_eq!(first.fingerprint_sha256.len(), 64);
        assert!(store.identity_path().is_file());

        let second = store.load_or_create().expect("reload identity");
        assert_eq!(first.computer_id, second.computer_id);
        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_primary_recovers_from_backup() {
        let dir = temp_dir();
        let store = SecureIdentityStore::new(dir.clone());
        let identity = store.load_or_create().expect("create");
        // Force a second write so backup is created.
        store.write_identity(&identity).expect("rewrite");
        assert!(store.backup_path().is_file());

        fs::write(store.identity_path(), b"{not-json").expect("corrupt primary");
        let (recovered, from_backup) = store.load().expect("recover");
        assert!(from_backup);
        assert_eq!(recovered.computer_id, identity.computer_id);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn both_corrupt_yields_identity_error_without_silent_regeneration() {
        let dir = temp_dir();
        let store = SecureIdentityStore::new(dir.clone());
        fs::write(store.identity_path(), b"{bad").expect("corrupt primary");
        fs::write(store.backup_path(), b"{also-bad").expect("corrupt backup");

        match store.load() {
            Err(IdentityLoadError::Corrupt { .. }) => {}
            other => panic!("expected corrupt error, got {other:?}"),
        }
        match store.status() {
            SecureIdentityStatus::IdentityError { .. } => {}
            other => panic!("expected identity_error status, got {other:?}"),
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rotation_replaces_fingerprint_and_computer_id() {
        let dir = temp_dir();
        let store = SecureIdentityStore::new(dir.clone());
        let first = store.load_or_create().expect("create");
        let second = store.rotate().expect("rotate");
        assert_ne!(first.computer_id, second.computer_id);
        assert_ne!(first.fingerprint_sha256, second.fingerprint_sha256);
        assert!(second.rotated_at.is_some());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fingerprint_is_sha256_of_certificate_der() {
        let dir = temp_dir();
        let store = SecureIdentityStore::new(dir.clone());
        let identity = store.load_or_create().expect("create");
        let (certs, _) = SecureIdentityStore::rustls_materials(&identity).expect("materials");
        let computed = certificate_fingerprint_sha256(certs[0].as_ref());
        assert!(fingerprints_match(&identity.fingerprint_sha256, &computed));

        let _ = fs::remove_dir_all(dir);
    }
}
