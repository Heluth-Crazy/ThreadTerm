//! Which executable this runtime is (11-26). The runtime is a detached daemon shared by every desktop of one
//! user and data folder, so a desktop from a newer package can find a daemon an older package left running. The
//! desktop compares this digest with the runtime bundled beside it and offers to restart the daemon when they differ
//! (desktop/src/main.ts `checkLocalRuntime`); before, it worked with the old daemon without a word.

use sha2::{Digest, Sha256};
use std::sync::OnceLock;

static IDENTITY: OnceLock<Option<Identity>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// Lowercase hex SHA-256 of the executable file.
    pub sha256: String,
    pub path: String,
}

/// Hashes the running executable once, at startup, before the pipes open: every authenticated frame then carries it
/// (Codex review 11-26: a background hash let the first desktops connect before it was known). About 30 ms for a
/// release build. Release builds only, unless `THREADTERM_V3_BUILD_IDENTITY=1` (QA probes of a debug runtime); a
/// desktop treats a missing identity as unknown and asks nothing.
pub fn start() {
    let wanted = !cfg!(debug_assertions)
        || std::env::var_os("THREADTERM_V3_BUILD_IDENTITY").as_deref() == Some("1".as_ref());
    let _ = IDENTITY.set(wanted.then(compute).flatten());
}

/// The identity: unknown before `start`, in debug builds without the variable, and when hashing failed.
pub fn current() -> Option<&'static Identity> {
    IDENTITY.get()?.as_ref()
}

fn compute() -> Option<Identity> {
    let path = std::env::current_exe().ok()?;
    Some(Identity { sha256: digest_file(&path)?, path: path.to_string_lossy().into_owned() })
}

fn digest_file(path: &std::path::Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_is_the_sha256_of_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.exe");
        // Larger than one copy buffer, so the stream is hashed in pieces.
        let bytes: Vec<u8> = (0..200_000u32).map(|value| (value % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(digest_file(&path).unwrap(), hex::encode(Sha256::digest(&bytes)));
        assert_eq!(digest_file(&dir.path().join("missing.exe")), None);
    }
}
