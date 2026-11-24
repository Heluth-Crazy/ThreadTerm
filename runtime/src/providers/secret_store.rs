//! Small per-user secrets for agents (an Antigravity API key). Kept in their own files under the data folder, never
//! in settings (which are backed up and shown to clients). On Windows the bytes are sealed with DPAPI for the current
//! user; elsewhere the file is readable by its owner only.
use anyhow::{Context, Result};
use std::path::Path;

#[cfg(windows)]
const ENTROPY: &[u8] = b"ThreadTerm agent secret v1";

pub(crate) fn write(path: &Path, secret: &[u8]) -> Result<()> {
    let sealed = seal(secret)?;
    let parent = path.parent().context("secret path has no folder")?;
    std::fs::create_dir_all(parent).context("creating the secrets folder")?;
    let staging = path.with_extension("tmp");
    write_private(&staging, &sealed)?;
    std::fs::rename(&staging, path).context("replacing the stored secret")?;
    Ok(())
}

pub(crate) fn read(path: &Path) -> Result<Vec<u8>> {
    unseal(&std::fs::read(path).context("reading the stored secret")?)
}

#[cfg(windows)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).context("writing the secret")
}

#[cfg(not(windows))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
        .context("writing the secret")?;
    file.write_all(bytes).context("writing the secret")
}

#[cfg(not(windows))]
fn seal(secret: &[u8]) -> Result<Vec<u8>> {
    Ok(secret.to_vec())
}

#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

#[cfg(windows)]
fn seal(secret: &[u8]) -> Result<Vec<u8>> {
    dpapi(secret, true)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    dpapi(sealed, false)
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let length = u32::try_from(input.len()).context("secret is too large")?;
    let data_in = CRYPT_INTEGER_BLOB { cbData: length, pbData: input.as_ptr().cast_mut() };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr().cast_mut() };
    let mut data_out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: the input blobs point at live slices for the duration of the call; DPAPI allocates `data_out` with
    // LocalAlloc, which is copied and released below.
    let ok = unsafe {
        if protect {
            CryptProtectData(&data_in, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut data_out)
        } else {
            CryptUnprotectData(&data_in, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut data_out)
        }
    };
    if ok == 0 || data_out.pbData.is_null() {
        anyhow::bail!(
            "Windows could not {} the secret: {}",
            if protect { "protect" } else { "unprotect" },
            std::io::Error::last_os_error()
        );
    }
    // SAFETY: DPAPI returned `cbData` bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize) }.to_vec();
    // SAFETY: `pbData` was allocated by DPAPI with LocalAlloc and is freed once.
    unsafe { LocalFree(data_out.pbData.cast()) };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_secret_round_trips_and_is_not_stored_in_the_clear_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets").join("example");
        super::write(&path, b"secret-value-123").unwrap();
        assert_eq!(super::read(&path).unwrap(), b"secret-value-123");
        #[cfg(windows)]
        assert!(!std::fs::read(&path).unwrap().windows(16).any(|window| window == b"secret-value-123"));
        super::write(&path, b"second").unwrap();
        assert_eq!(super::read(&path).unwrap(), b"second");
    }
}
