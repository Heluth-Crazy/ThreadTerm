//! Durable desktop upload identities. Authority is the paired user, not a connection.
use crate::db::Database;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_SIZE: u64 = 256 * 1024 * 1024;
const MAX_CHUNK: usize = crate::host_files::CHUNK_BYTES;
static UPLOAD_GATE: Mutex<()> = Mutex::new(());

pub fn recover(db: &Database, data: &Path) -> Result<()> {
    if !data.join("attachments").is_dir() {
        return Ok(());
    }
    let _guard = UPLOAD_GATE.lock().map_err(|_| anyhow!("upload_lock"))?;
    initialize(db)?;
    cleanup(db, data)?;
    // A crash can precede publication of the first receipt. Never follow links or
    // recurse: only expired UUID transfer folders and their regular files are owned.
    for entry in fs::read_dir(data.join("attachments"))? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir()
            || uuid::Uuid::parse_str(&id).is_err()
            || lookup(db, &id)?.is_some()
            || entry
                .metadata()?
                .modified()?
                .elapsed()
                .unwrap_or_default()
                .as_secs()
                < 86400
        {
            continue;
        }
        for file in fs::read_dir(entry.path())? {
            let file = file?;
            if file.file_type()?.is_file() {
                fs::remove_file(file.path())?;
            }
        }
        match fs::remove_dir(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Keep peer review reference publication atomic with respect to asset cleanup.
pub fn with_reference_lock<T>(action: impl FnOnce() -> Result<T>) -> Result<T> {
    let _guard = UPLOAD_GATE.lock().map_err(|_| anyhow!("upload_lock"))?;
    action()
}

pub fn dispatch(db: &Database, data: &Path, method: &str, p: &Value) -> Result<Option<Value>> {
    if !matches!(method, "attachment.upload" | "attachment.read") {
        return Ok(None);
    }
    let _guard = UPLOAD_GATE.lock().map_err(|_| anyhow!("upload_lock"))?;
    initialize(db)?;
    cleanup(db, data)?;
    if method == "attachment.read" {
        let id = text(p, "assetId")?;
        let record = lookup(db, id)?
            .filter(|r| r.done)
            .ok_or_else(|| anyhow!("asset_not_found"))?;
        let path = asset_path(data, &record.id, &record.name);
        let offset = p
            .get("offset")
            .map(Value::as_u64)
            .unwrap_or(Some(0))
            .ok_or_else(|| anyhow!("invalid_offset"))?;
        let limit = p
            .get("limit")
            .map(Value::as_u64)
            .unwrap_or(Some(MAX_CHUNK as u64))
            .filter(|n| *n > 0 && *n <= MAX_CHUNK as u64)
            .ok_or_else(|| anyhow!("invalid_limit"))?;
        if offset > record.size {
            return Err(anyhow!("invalid_offset"));
        }
        let mut file = fs::File::open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != record.size {
            return Err(anyhow!("asset_changed"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = Vec::new();
        let expected = limit.min(record.size - offset);
        file.take(expected).read_to_end(&mut chunk)?;
        if chunk.len() as u64 != expected {
            return Err(anyhow!("asset_changed"));
        }
        return Ok(Some(
            json!({"assetId":id,"hostPath":path.to_string_lossy(),"name":record.name,
            "size":record.size,"offset":offset,"chunk":STANDARD.encode(&chunk),"eof":offset+chunk.len() as u64>=record.size}),
        ));
    }
    let id = text(p, "uploadId")?;
    // IDs are opaque UUIDs, never filesystem components supplied by the caller.
    uuid::Uuid::parse_str(id).map_err(|_| anyhow!("invalid_upload_id"))?;
    let session = text(p, "sessionId")?;
    if db.session_by_id(session)?.is_none() {
        return Err(anyhow!("session_not_found"));
    }
    let name = text(p, "name")?;
    if name.len() > 240
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
        || matches!(name, "." | "..")
        || name.ends_with([' ', '.'])
    {
        return Err(anyhow!("invalid_name"));
    }
    let size = p["size"]
        .as_u64()
        .filter(|s| *s <= MAX_SIZE)
        .ok_or_else(|| anyhow!("invalid_size"))?;
    let offset = p["offset"]
        .as_u64()
        .ok_or_else(|| anyhow!("invalid_offset"))?;
    let final_chunk = p["final"]
        .as_bool()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let encoded = p["chunk"]
        .as_str()
        .filter(|s| s.len() <= MAX_CHUNK.div_ceil(3) * 4)
        .ok_or_else(|| anyhow!("invalid_chunk"))?;
    let bytes = STANDARD.decode(encoded)?;
    if bytes.len() > MAX_CHUNK
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > size)
        || final_chunk && offset + bytes.len() as u64 != size
    {
        return Err(anyhow!("invalid_chunk"));
    }
    let root = data.join("attachments").join(id);
    let path = asset_path(data, id, name);
    let record = match lookup(db, id)? {
        Some(record) => record,
        None => {
            if offset != 0 {
                return Err(anyhow!("invalid_offset"));
            }
            fs::create_dir_all(&root)?;
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&path)?;
            db.transaction(|tx| { tx.execute("INSERT INTO attachment_uploads(id,session_id,name,size,received,done,updated_at) VALUES(?,?,?,?,0,0,unixepoch())",params![id,session,name,size])?; Ok(()) })?;
            lookup(db, id)?.ok_or_else(|| anyhow!("upload_missing"))?
        }
    };
    if record.session != session || record.name != name || record.size != size {
        return Err(anyhow!("upload_conflict"));
    }
    let mut file = OpenOptions::new().read(true).write(true).open(&path)?;
    if offset < record.received || record.done {
        if offset + bytes.len() as u64 > record.received {
            return Err(anyhow!("invalid_offset"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut prior = vec![0; bytes.len()];
        file.read_exact(&mut prior)?;
        if prior != bytes {
            return Err(anyhow!("upload_conflict"));
        }
    } else {
        if offset != record.received {
            return Err(anyhow!("invalid_offset"));
        }
        // Recovery after a crash between disk write and receipt publication.
        file.set_len(record.received)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    let received = record.received.max(offset + bytes.len() as u64);
    let done = record.done || final_chunk;
    db.transaction(|tx| {
        tx.execute(
            "UPDATE attachment_uploads SET received=?,done=?,updated_at=unixepoch() WHERE id=?",
            params![received, done, id],
        )?;
        Ok(())
    })?;
    Ok(Some(if done {
        json!({"assetId":id,"hostPath":path.to_string_lossy(),"offset":received})
    } else {
        json!({"offset":received})
    }))
}

fn text<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| { tx.execute_batch("CREATE TABLE IF NOT EXISTS attachment_uploads(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,received INTEGER NOT NULL,done INTEGER NOT NULL,updated_at INTEGER NOT NULL);")?; Ok(()) })
}
struct Upload {
    id: String,
    session: String,
    name: String,
    size: u64,
    received: u64,
    done: bool,
}
fn lookup(db: &Database, id: &str) -> Result<Option<Upload>> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT id,session_id,name,size,received,done FROM attachment_uploads WHERE id=?",
                [id],
                |r| {
                    Ok(Upload {
                        id: r.get(0)?,
                        session: r.get(1)?,
                        name: r.get(2)?,
                        size: r.get(3)?,
                        received: r.get(4)?,
                        done: r.get(5)?,
                    })
                },
            )
            .optional()?)
    })
}
fn asset_path(data: &Path, id: &str, name: &str) -> PathBuf {
    data.join("attachments").join(id).join(name)
}

pub fn validate_reference(db: &Database, data: &Path, path: &str) -> Result<()> {
    initialize(db)?;
    let candidate = Path::new(path);
    let id = candidate
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("invalid_asset_reference"))?;
    let record = lookup(db, id)?
        .filter(|r| r.done)
        .ok_or_else(|| anyhow!("invalid_asset_reference"))?;
    if candidate != asset_path(data, &record.id, &record.name) {
        return Err(anyhow!("invalid_asset_reference"));
    }
    Ok(())
}

/// Called on asset traffic; no filesystem work is performed under the DB lock.
pub fn cleanup(db: &Database, data: &Path) -> Result<()> {
    let mut after = String::new();
    loop {
        let candidates: Vec<(String,String,bool)> = db.transaction(|tx| {
        let mut s = tx.prepare("SELECT id,name,(done=0 AND updated_at<unixepoch()-86400) FROM attachment_uploads u WHERE id>? AND ((done=0 AND updated_at<unixepoch()-86400) OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=u.session_id)) ORDER BY id LIMIT 128")?;
        let rows=s.query_map([&after],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?; Ok(rows)
    })?;
        let Some(last) = candidates.last() else {
            break;
        };
        after = last.0.clone();
        for (id, name, expired) in candidates {
            let path = asset_path(data, &id, &name);
            let referenced = !expired && db.transaction(|tx| Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM review_draft_assets a JOIN review_drafts d ON d.draft_id=a.draft_id WHERE d.deleted=0 AND a.path=?)",
            [path.to_string_lossy().as_ref()], |r| r.get::<_,bool>(0))?))?;
            if referenced {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            let _ = fs::remove_dir(data.join("attachments").join(&id));
            db.transaction(|tx| {
                tx.execute("DELETE FROM attachment_uploads WHERE id=?", [&id])?;
                Ok(())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Database) {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db")).unwrap();
        db.transaction(|tx|{tx.execute("INSERT INTO projects(id,name,path,created_at) VALUES('p','P',?,'t')",[temp.path().to_str().unwrap()])?;tx.execute("INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s','p','S','codex','chat','idle','t','t')",[])?;Ok(())}).unwrap();
        (temp, db)
    }
    #[test]
    fn chunks_offsets_final_retry_and_second_controller_read() {
        let (temp, db) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let mut p = json!({"uploadId":id,"sessionId":"s","name":"log.txt","size":MAX_CHUNK+3,"offset":0,"chunk":STANDARD.encode(vec![b'a';MAX_CHUNK]),"final":false});
        assert_eq!(
            dispatch(&db, temp.path(), "attachment.upload", &p)
                .unwrap()
                .unwrap()["offset"],
            MAX_CHUNK
        );
        dispatch(&db, temp.path(), "attachment.upload", &p).unwrap();
        p["offset"] = json!(MAX_CHUNK + 1);
        p["chunk"] = json!(STANDARD.encode(b"bc"));
        assert!(dispatch(&db, temp.path(), "attachment.upload", &p).is_err());
        p["offset"] = json!(MAX_CHUNK);
        p["chunk"] = json!(STANDARD.encode(b"end"));
        p["final"] = json!(true);
        let final_result = dispatch(&db, temp.path(), "attachment.upload", &p).unwrap();
        assert_eq!(
            final_result,
            dispatch(&db, temp.path(), "attachment.upload", &p).unwrap()
        );
        // Read intentionally has no principal ownership: paired controllers share user authority.
        let read = dispatch(
            &db,
            temp.path(),
            "attachment.read",
            &json!({"assetId":id,"offset":MAX_CHUNK,"limit":3}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            STANDARD.decode(read["chunk"].as_str().unwrap()).unwrap(),
            b"end"
        );
        db.transaction(|tx| {
            tx.execute("DELETE FROM sessions WHERE id='s'", [])?;
            Ok(())
        })
        .unwrap();
        assert!(dispatch(&db, temp.path(), "attachment.read", &json!({"assetId":id})).is_err());
        assert!(!Path::new(final_result.unwrap()["hostPath"].as_str().unwrap()).exists());
    }
    #[test]
    fn interrupted_upload_expires() {
        let (temp, db) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        dispatch(&db,temp.path(),"attachment.upload",&json!({"uploadId":id,"sessionId":"s","name":"x","size":2,"offset":0,"chunk":STANDARD.encode(b"x"),"final":false})).unwrap();
        db.transaction(|tx| {
            tx.execute("UPDATE attachment_uploads SET updated_at=0", [])?;
            Ok(())
        })
        .unwrap();
        cleanup(&db, temp.path()).unwrap();
        assert!(lookup(&db, &id).unwrap().is_none());
        assert!(!asset_path(temp.path(), &id, "x").exists());
    }

    #[test]
    fn startup_cleans_expired_files_without_a_receipt_but_keeps_recent_transfers() {
        let (temp, db) = fixture();
        let old = uuid::Uuid::new_v4().to_string();
        let recent = uuid::Uuid::new_v4().to_string();
        for id in [&old, &recent] {
            let path = asset_path(temp.path(), id, "partial");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"partial").unwrap();
        }
        // Windows directory handles need FILE_FLAG_BACKUP_SEMANTICS.
        #[cfg(windows)]
        let directory = {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
            };
            OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(temp.path().join("attachments").join(&old))
                .unwrap()
        };
        #[cfg(not(windows))]
        let directory = fs::File::open(temp.path().join("attachments").join(&old)).unwrap();
        directory
            .set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
            .unwrap();
        drop(directory);
        recover(&db, temp.path()).unwrap();
        assert!(!asset_path(temp.path(), &old, "partial").exists());
        assert!(asset_path(temp.path(), &recent, "partial").exists());
    }

    #[test]
    fn retry_conflicts_and_changed_assets_are_rejected() {
        let (temp, db) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let mut p = json!({"uploadId":id,"sessionId":"s","name":"log.txt","size":3,"offset":0,"chunk":STANDARD.encode(b"one"),"final":true});
        let result = dispatch(&db, temp.path(), "attachment.upload", &p)
            .unwrap()
            .unwrap();
        p["chunk"] = json!(STANDARD.encode(b"two"));
        assert!(dispatch(&db, temp.path(), "attachment.upload", &p).is_err());
        assert_eq!(
            fs::read(result["hostPath"].as_str().unwrap()).unwrap(),
            b"one"
        );
        fs::write(result["hostPath"].as_str().unwrap(), b"changed").unwrap();
        assert!(dispatch(&db, temp.path(), "attachment.read", &json!({"assetId":id})).is_err());
    }

    #[test]
    fn review_retains_asset_after_session_deletion_and_receipt_survives_reopen() {
        let (temp, db) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let p = json!({"uploadId":id,"sessionId":"s","name":"shot.png","size":3,"offset":0,"chunk":STANDARD.encode(b"png"),"final":true});
        let result = dispatch(&db, temp.path(), "attachment.upload", &p)
            .unwrap()
            .unwrap();
        let second = Database::open(&temp.path().join("db")).unwrap();
        assert_eq!(
            result,
            dispatch(&second, temp.path(), "attachment.upload", &p)
                .unwrap()
                .unwrap()
        );
        let path = result["hostPath"].as_str().unwrap();
        crate::review_drafts::validate_host_assets(&db, temp.path(), &json!({"assetPaths":[path]}))
            .unwrap();
        assert!(crate::review_drafts::validate_host_assets(
            &db,
            temp.path(),
            &json!({"assetPaths":["C:/client/shot.png"]})
        )
        .is_err());
        crate::review_drafts::mutate(&db,"reviewDrafts.upsert",&json!({"draftId":"d","draft":{"body":"review"},"assetPaths":[path],"expectedRevision":0,"operationId":"save"})).unwrap();
        db.transaction(|tx| {
            tx.execute("DELETE FROM sessions WHERE id='s'", [])?;
            Ok(())
        })
        .unwrap();
        dispatch(
            &second,
            temp.path(),
            "attachment.read",
            &json!({"assetId":id}),
        )
        .unwrap();
        assert!(Path::new(path).exists());
        crate::review_drafts::mutate(
            &db,
            "reviewDrafts.delete",
            &json!({"draftId":"d","expectedRevision":1,"operationId":"delete"}),
        )
        .unwrap();
        assert!(dispatch(
            &second,
            temp.path(),
            "attachment.read",
            &json!({"assetId":id})
        )
        .is_err());
        assert!(!Path::new(path).exists());
    }

    #[test]
    fn another_desktop_principal_reads_the_uploaded_asset_through_service_dispatch() {
        let (temp, db) = fixture();
        let root = temp.path();
        let db = std::sync::Arc::new(db);
        let service = crate::service::RuntimeService::with_test_providers(
            crate::config::RuntimeConfig {
                data_dir: root.to_owned(),
                database_path: root.join("db"),
                credential_path: root.join("credential"),
                pipe_base: "attachment-test".into(),
            },
            db,
            vec![],
        );
        let id = uuid::Uuid::new_v4().to_string();
        let call = |principal: &str, method: &str, params: Value| {
            service
                .dispatch(
                    principal,
                    crate::domain::RpcRequest {
                        v: 1,
                        id: uuid::Uuid::new_v4().to_string(),
                        method: method.into(),
                        params,
                    },
                )
                .unwrap()
        };
        for method in [
            "filesystem.browse",
            "filesystem.preview.read",
            "attachment.upload",
            "attachment.read",
        ] {
            assert!(!crate::peer::DENIED_METHODS.contains(&method));
        }
        let uploaded = call(
            "peer:controller-a:one",
            "attachment.upload",
            json!({"uploadId":id,"sessionId":"s","name":"a.log","size":3,"offset":0,"chunk":STANDARD.encode(b"log"),"final":true}),
        );
        let read = call(
            "peer:controller-b:two",
            "attachment.read",
            json!({"assetId":uploaded["assetId"]}),
        );
        assert_eq!(
            STANDARD.decode(read["chunk"].as_str().unwrap()).unwrap(),
            b"log"
        );
    }
}
