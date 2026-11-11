//! Desktop-peer host browsing and bounded, project-contained preview reads.
use crate::{
    db::Database,
    workspace_services::{root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const CHUNK_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 1000;
const MAX_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;

pub fn dispatch(db: &Database, method: &str, p: &Value) -> Result<Option<Value>> {
    match method {
        "filesystem.browse" => Ok(Some(browse(p.get("path").and_then(Value::as_str))?)),
        "filesystem.preview.read" => {
            let project = p["projectId"]
                .as_str()
                .ok_or_else(|| anyhow!("invalid_request"))?;
            let root = db.transaction(|tx| {
                root_for(tx, project, p.get("worktreePath").and_then(Value::as_str))
            })?;
            let path = p["path"].as_str().ok_or_else(|| anyhow!("invalid_path"))?;
            // Reject Windows path forms even on other host platforms.
            if path.contains(':') || path.contains('\\') {
                return Err(anyhow!("invalid_path"));
            }
            let resolved = scoped_path(&root, path, true)?;
            let offset = p["offset"]
                .as_u64()
                .ok_or_else(|| anyhow!("invalid_offset"))?;
            let limit = p["limit"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= CHUNK_BYTES as u64)
                .ok_or_else(|| anyhow!("invalid_limit"))?;
            let mut file = fs::File::open(&resolved)?;
            let identity = file_identity(&file)?;
            let before = file.metadata()?;
            if !before.is_file() {
                return Err(anyhow!("not_a_file"));
            }
            if before.len() > MAX_PREVIEW_BYTES {
                return Err(anyhow!("file_too_large"));
            }
            if offset > before.len() {
                return Err(anyhow!("invalid_offset"));
            }
            if scoped_path(&root, path, true)? != resolved
                || file_identity(&fs::File::open(&resolved)?)? != identity
            {
                return Err(anyhow!("file_changed"));
            }
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = Vec::new();
            (&mut file).take(limit).read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            if scoped_path(&root, path, true)? != resolved
                || before.len() != after.len()
                || before.modified()? != after.modified()?
                || file_identity(&fs::File::open(&resolved)?)? != identity
            {
                return Err(anyhow!("file_changed"));
            }
            Ok(Some(
                json!({"path":resolved.to_string_lossy(),"size":before.len(),"offset":offset,"fingerprint":format!("{}:{}:{}:{:?}",identity.0,identity.1,before.len(),before.modified()?),
                "chunk":STANDARD.encode(&bytes),"eof":offset + bytes.len() as u64 >= before.len()}),
            ))
        }
        "filesystem.document.read" => {
            let project = p["projectId"]
                .as_str()
                .ok_or_else(|| anyhow!("invalid_request"))?;
            let root = db.transaction(|tx| {
                root_for(tx, project, p.get("worktreePath").and_then(Value::as_str))
            })?;
            let path = p["path"].as_str().ok_or_else(|| anyhow!("invalid_path"))?;
            if path.contains(':') || path.contains('\\') {
                return Err(anyhow!("invalid_path"));
            }
            let resolved = scoped_path(&root, path, true)?;
            let offset = p["offset"]
                .as_u64()
                .ok_or_else(|| anyhow!("invalid_offset"))?;
            let limit = p["limit"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= CHUNK_BYTES as u64)
                .ok_or_else(|| anyhow!("invalid_limit"))?;
            let value = crate::document_read::read_page(&resolved, offset, limit)?;
            // The directory entry may have been swapped for an escape while the chunk was read.
            if scoped_path(&root, path, true)? != resolved {
                return Err(anyhow!("file_changed"));
            }
            Ok(Some(value))
        }
        _ => Ok(None),
    }
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

fn browse(path: Option<&str>) -> Result<Value> {
    let Some(path) = path else {
        #[cfg(windows)]
        let paths: Vec<String> = ('A'..='Z')
            .map(|drive| format!("{drive}:\\"))
            .filter(|path| Path::new(path).is_dir())
            .collect();
        #[cfg(not(windows))]
        let paths = vec!["/".to_string()];
        return Ok(
            json!({"entries":paths.into_iter().map(|path| json!({"name":path,"path":path,"kind":"directory","size":0})).collect::<Vec<_>>(),"truncated":false}),
        );
    };
    if !Path::new(path).is_absolute() || path.contains('\0') {
        return Err(anyhow!("invalid_path"));
    }
    // Returned paths are used as project paths, so drop the verbatim prefix Git and Shell misread.
    let root = crate::git_read::plain_path(&Path::new(path).canonicalize()?);
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, entry) in fs::read_dir(&root)?.enumerate() {
        let entry = entry?;
        if index == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(mut meta) = entry.metadata() else {
            continue;
        };
        // A junction or symlink lists as what it points at; a broken one is skipped.
        if meta.file_type().is_symlink() {
            let Ok(target) = fs::metadata(entry.path()) else {
                continue;
            };
            meta = target;
        }
        entries.push(
            json!({"name":entry.file_name().to_string_lossy(),"path":entry.path().to_string_lossy(),
            "kind":if meta.is_dir(){"directory"}else{"file"},"size":meta.len()}),
        );
    }
    // Folders first, then by name ignoring case, as in Explorer.
    entries.sort_by_key(|entry| {
        (
            entry["kind"] != "directory",
            entry["name"].as_str().map(str::to_lowercase),
        )
    });
    Ok(
        json!({"path":root.to_string_lossy(),"parent":root.parent().map(|p|p.to_string_lossy()),"entries":entries,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drives_and_bounded_listing() {
        assert!(!browse(None).unwrap()["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        let temp = tempfile::tempdir().unwrap();
        for n in 0..MAX_ENTRIES + 1 {
            fs::write(temp.path().join(n.to_string()), b"x").unwrap();
        }
        let result = browse(temp.path().to_str()).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), MAX_ENTRIES);
        assert_eq!(result["truncated"], true);
    }
    #[test]
    fn listing_uses_plain_paths_folders_first_and_follows_junctions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.txt"), b"x").unwrap();
        fs::create_dir(temp.path().join("Zeta")).unwrap();
        let target = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(temp.path().join("link"))
            .arg(target.path())
            .status()
            .unwrap()
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(target.path(), temp.path().join("link")).unwrap();
        let result = browse(temp.path().to_str()).unwrap();
        let entries = result["entries"].as_array().unwrap();
        let listed: Vec<_> = entries
            .iter()
            .map(|entry| (entry["name"].as_str().unwrap(), entry["kind"].as_str().unwrap()))
            .collect();
        assert_eq!(
            listed,
            [("link", "directory"), ("Zeta", "directory"), ("a.txt", "file")]
        );
        for path in std::iter::once(&result["path"]).chain(entries.iter().map(|entry| &entry["path"])) {
            assert!(!path.as_str().unwrap().starts_with(r"\\?\"));
        }
    }
    #[test]
    fn preview_large_file_pieces_and_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        let project = db
            .add_project(temp.path().to_str().unwrap(), Some("Host"), "add")
            .unwrap();
        let bytes = vec![b'a'; 7 * CHUNK_BYTES + 13];
        fs::write(temp.path().join("large.html"), &bytes).unwrap();
        let mut collected = Vec::new();
        while collected.len() < bytes.len() {
            let result = dispatch(&db, "filesystem.preview.read", &json!({"projectId":project.id,"path":"large.html","offset":collected.len(),"limit":CHUNK_BYTES})).unwrap().unwrap();
            assert!(serde_json::to_vec(&result).unwrap().len() < 6 * CHUNK_BYTES);
            collected.extend(STANDARD.decode(result["chunk"].as_str().unwrap()).unwrap());
        }
        assert_eq!(collected, bytes);
        for (offset, limit) in [(bytes.len() as u64 + 1, 1), (0, CHUNK_BYTES as u64 + 1)] {
            assert!(dispatch(
                &db,
                "filesystem.preview.read",
                &json!({"projectId":project.id,"path":"large.html","offset":offset,"limit":limit})
            )
            .is_err());
        }
        fs::File::create(temp.path().join("oversize.html"))
            .unwrap()
            .set_len(MAX_PREVIEW_BYTES + 1)
            .unwrap();
        assert!(dispatch(
            &db,
            "filesystem.preview.read",
            &json!({"projectId":project.id,"path":"oversize.html","offset":0,"limit":1})
        )
        .is_err());
        for path in ["../large.html", "C:/outside.html", "a\\..\\outside"] {
            assert!(dispatch(
                &db,
                "filesystem.preview.read",
                &json!({"projectId":project.id,"path":path,"offset":0,"limit":1})
            )
            .is_err());
        }
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("escape.html"), b"secret").unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(temp.path().join("escape"))
            .arg(outside.path())
            .status()
            .unwrap()
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), temp.path().join("escape")).unwrap();
        assert!(dispatch(
            &db,
            "filesystem.preview.read",
            &json!({"projectId":project.id,"path":"escape/escape.html","offset":0,"limit":1})
        )
        .is_err());
    }

    #[test]
    fn document_reads_are_word_only_bounded_and_signature_checked() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        let project = db
            .add_project(temp.path().to_str().unwrap(), Some("Host"), "add")
            .unwrap();
        let mut zip = b"PK\x03\x04".to_vec();
        zip.resize(CHUNK_BYTES + 9, b'x');
        fs::write(temp.path().join("report.docx"), &zip).unwrap();
        fs::write(temp.path().join("macro.docm"), b"PK\x03\x04macro").unwrap();
        fs::write(
            temp.path().join("protected.docx"),
            [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
        )
        .unwrap();
        fs::write(temp.path().join("damaged.docx"), b"not a zip").unwrap();
        fs::write(temp.path().join("notes.txt"), b"PK\x03\x04").unwrap();

        let first = dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":"report.docx","offset":0,"limit":CHUNK_BYTES})).unwrap().unwrap();
        assert_eq!(first["size"], zip.len());
        assert_eq!(first["eof"], false);
        assert_eq!(STANDARD.decode(first["chunk"].as_str().unwrap()).unwrap(), &zip[..CHUNK_BYTES]);
        let last = dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":"report.docx","offset":CHUNK_BYTES,"limit":CHUNK_BYTES})).unwrap().unwrap();
        assert_eq!(last["eof"], true);
        assert_eq!(last["fingerprint"], first["fingerprint"]);
        assert!(dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":"macro.docm","offset":0,"limit":1})).is_ok());
        for (path, code) in [
            ("protected.docx", "document_protected"),
            ("damaged.docx", "unsupported_document"),
            ("notes.txt", "unsupported_document"),
        ] {
            assert_eq!(
                dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":path,"offset":0,"limit":1})).unwrap_err().to_string(),
                code
            );
        }
        fs::File::create(temp.path().join("huge.docx"))
            .unwrap()
            .set_len(crate::document_read::MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        assert_eq!(
            dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":"huge.docx","offset":0,"limit":1})).unwrap_err().to_string(),
            "file_too_large"
        );
        for (offset, limit) in [(zip.len() as u64 + 1, 1), (0, CHUNK_BYTES as u64 + 1)] {
            assert!(dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":"report.docx","offset":offset,"limit":limit})).is_err());
        }
        for path in ["../report.docx", "C:/outside.docx", "a\\..\\outside.docx"] {
            assert!(dispatch(&db, "filesystem.document.read", &json!({"projectId":project.id,"path":path,"offset":0,"limit":1})).is_err());
        }
    }

    #[test]
    fn preview_accepts_only_the_registered_worktree_scope() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        let tree = temp.path().join("worktree");
        let unregistered = temp.path().join("other");
        for path in [&project_root, &tree, &unregistered] {
            fs::create_dir(path).unwrap();
            fs::write(
                path.join("index.html"),
                path.file_name().unwrap().to_string_lossy().as_bytes(),
            )
            .unwrap();
        }
        let db = Database::open(&temp.path().join("db")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        let project = db
            .add_project(project_root.to_str().unwrap(), Some("Host"), "add")
            .unwrap();
        db.transaction(|tx|{tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('tree',?,?,'branch','head',0,0)",rusqlite::params![project.id,tree.canonicalize().unwrap().to_str().unwrap()])?;Ok(())}).unwrap();
        let p = json!({"projectId":project.id,"worktreePath":tree.to_str().unwrap(),"path":"index.html","offset":0,"limit":32});
        let result = dispatch(&db, "filesystem.preview.read", &p)
            .unwrap()
            .unwrap();
        assert_eq!(
            STANDARD.decode(result["chunk"].as_str().unwrap()).unwrap(),
            b"worktree"
        );
        let mut invalid = p;
        invalid["worktreePath"] = json!(unregistered.to_str().unwrap());
        assert!(dispatch(&db, "filesystem.preview.read", &invalid).is_err());
    }
}
