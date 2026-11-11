//! Bounded Word document chunks (`design.md` §4.1): the read shape `filesystem.preview.read`
//! already has, narrowed to `.docx .docm`, the Office size cap and a signature check at offset 0.
//!
//! The host resolves and contains the path (workspace scope or a registered external file) before
//! calling here, so this module only opens the file it is given. It never parses the document: the
//! sandboxed viewer does that from the streamed bytes.
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const CHUNK_BYTES: u64 = 1024 * 1024;
/// D2/R3: one definition per language lives in the sheet core, which the runtime already depends on.
pub const MAX_DOCUMENT_BYTES: u64 = threadterm_sheet_core::OFFICE_PREVIEW_MAX_BYTES;
const ZIP_SIGNATURE: &[u8] = b"PK\x03\x04";
const OLE2_SIGNATURE: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// The extension allow list; the signature decides whether a `.docx` is really a Word file.
pub fn is_word_document(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("docx") || value.eq_ignore_ascii_case("docm"))
}

/// S8: an OLE2 container under a zip-family extension is a password-protected Office file;
/// anything else that is not a zip is a damaged/unsupported document. JSZip cannot tell them apart.
fn check_signature(bytes: &[u8]) -> Result<()> {
    if bytes.starts_with(ZIP_SIGNATURE) {
        return Ok(());
    }
    if bytes.starts_with(OLE2_SIGNATURE) {
        return Err(anyhow!("document_protected"));
    }
    Err(anyhow!("unsupported_document"))
}

#[cfg(windows)]
fn file_identity(file: &fs::File) -> Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}
#[cfg(unix)]
fn file_identity(file: &fs::File) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let info = file.metadata()?;
    Ok((info.dev(), info.ino()))
}

/// One `PreviewChunk` (`design.md` §4.1). `limit` is bounded to one 1 MiB chunk by the caller too.
pub fn read_page(path: &Path, offset: u64, limit: u64) -> Result<Value> {
    if !is_word_document(path) {
        return Err(anyhow!("unsupported_document"));
    }
    if offset == 0 && limit == 0 {
        return Err(anyhow!("invalid_limit"));
    }
    if limit > CHUNK_BYTES {
        return Err(anyhow!("invalid_limit"));
    }
    let mut file = fs::File::open(path).map_err(|error| {
        anyhow!(if error.kind() == std::io::ErrorKind::NotFound {
            "file_not_found"
        } else {
            "file_unavailable"
        })
    })?;
    let identity = file_identity(&file)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(anyhow!("file_not_file"));
    }
    if before.len() > MAX_DOCUMENT_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    if offset > before.len() {
        return Err(anyhow!("invalid_offset"));
    }
    if offset == 0 {
        let mut signature = [0u8; 8];
        let read = (&mut file).take(8).read(&mut signature)?;
        check_signature(&signature[..read])?;
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    (&mut file).take(limit).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let current = file_identity(&fs::File::open(path).map_err(|_| anyhow!("file_changed"))?)?;
    if before.len() != after.len()
        || before.modified()? != after.modified()?
        || identity != current
    {
        return Err(anyhow!("file_changed"));
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "size": before.len(),
        "offset": offset,
        "fingerprint": format!("{}:{}:{}:{:?}", identity.0, identity.1, before.len(), before.modified()?),
        "chunk": STANDARD.encode(&bytes),
        "eof": offset + bytes.len() as u64 >= before.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join(name);
        fs::write(&path, bytes).unwrap();
        (folder, path)
    }

    #[test]
    fn extension_and_signature_decide_the_error() {
        let (_folder, zip) = temp("a.docx", b"PK\x03\x04rest");
        let page = read_page(&zip, 0, 1024).unwrap();
        assert_eq!(STANDARD.decode(page["chunk"].as_str().unwrap()).unwrap(), b"PK\x03\x04rest");
        assert_eq!(page["eof"], true);

        let (_folder, ole) = temp("b.docx", OLE2_SIGNATURE);
        assert_eq!(read_page(&ole, 0, 1024).unwrap_err().to_string(), "document_protected");
        let (_folder, text) = temp("c.docx", b"not a zip");
        assert_eq!(read_page(&text, 0, 1024).unwrap_err().to_string(), "unsupported_document");
        let (_folder, wrong) = temp("d.doc", b"PK\x03\x04rest");
        assert_eq!(read_page(&wrong, 0, 1024).unwrap_err().to_string(), "unsupported_document");
        let (_folder, empty) = temp("e.docx", b"");
        assert_eq!(read_page(&empty, 0, 1024).unwrap_err().to_string(), "unsupported_document");
    }

    #[test]
    fn chunks_are_bounded_and_report_offsets_and_eof() {
        let mut bytes = b"PK\x03\x04".to_vec();
        bytes.resize(3 * CHUNK_BYTES as usize, b'x');
        let (_folder, path) = temp("big.docx", &bytes);
        let first = read_page(&path, 0, CHUNK_BYTES).unwrap();
        assert_eq!(first["eof"], false);
        assert_eq!(first["offset"], 0);
        assert_eq!(first["size"], bytes.len());
        let chunk = STANDARD.decode(first["chunk"].as_str().unwrap()).unwrap();
        assert_eq!(chunk.len(), CHUNK_BYTES as usize);
        let last = read_page(&path, 2 * CHUNK_BYTES, CHUNK_BYTES).unwrap();
        assert_eq!(last["eof"], true);
        assert_eq!(last["offset"], 2 * CHUNK_BYTES);
        assert!(read_page(&path, bytes.len() as u64 + 1, 1).is_err());
    }

    #[test]
    fn a_late_chunk_does_not_re_read_the_signature_but_a_changed_file_is_refused() {
        let (_folder, path) = temp("late.docx", b"PK\x03\x04late chunk");
        let late = read_page(&path, 4, 4).unwrap();
        assert_eq!(STANDARD.decode(late["chunk"].as_str().unwrap()).unwrap(), b"late");
        let fingerprint = late["fingerprint"].clone();
        fs::write(&path, b"PK\x03\x04changed now").unwrap();
        assert_ne!(read_page(&path, 4, 4).unwrap()["fingerprint"], fingerprint);
    }

    #[test]
    fn the_office_cap_is_the_shared_100_mib_constant() {
        assert_eq!(MAX_DOCUMENT_BYTES, 100 * 1024 * 1024);
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("huge.docx");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
        assert_eq!(read_page(&path, 0, 1).unwrap_err().to_string(), "file_too_large");
    }
}
