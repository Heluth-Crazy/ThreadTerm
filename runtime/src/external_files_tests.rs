use super::*;
use tempfile::TempDir;

struct Fixture {
    db: Database,
    temp: TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        workspace::initialize(&db).unwrap();
        Self { db, temp }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, bytes).unwrap();
        path
    }
    fn open(&self, path: &Path) -> Value {
        dispatch(
            &self.db,
            "filesystem.external.open",
            &json!({"path":path,"source":"dialog"}),
        )
        .unwrap()
        .unwrap()["file"]
            .clone()
    }
    fn count(&self) -> i64 {
        self.db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT COUNT(*) FROM external_files", [], |r| r.get(0))?)
            })
            .unwrap()
    }
    fn session(&self, cwd: &Path, provider: &str) -> String {
        crate::session_configs::initialize(&self.db).unwrap();
        let root = self.path("workspace");
        fs::create_dir_all(&root).unwrap();
        let project = self
            .db
            .add_project(root.to_str().unwrap(), None, "project")
            .unwrap();
        let session = self
            .db
            .create_session(crate::db::CreateSession {
                project_id: Some(&project.id),
                title: None,
                provider,
                mode: "chat",
                native_id: None,
                operation_id: "session",
            })
            .unwrap();
        self.db
            .bind_session(&session.id, Some(root.to_str().unwrap()), None)
            .unwrap();
        crate::session_configs::save_new(
            &self.db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: provider.into(),
                mode: "chat".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                project_id: Some(project.id),
                title: None,
                executable: None,
                args: Vec::new(),
            },
            None,
        )
        .unwrap();
        session.id
    }
}

fn call(f: &Fixture, method: &str, params: Value) -> Value {
    dispatch(&f.db, &format!("filesystem.external.{method}"), &params)
        .unwrap()
        .unwrap()
}
fn fails(f: &Fixture, method: &str, params: Value, code: &str) {
    assert_eq!(
        dispatch(&f.db, &format!("filesystem.external.{method}"), &params)
            .unwrap_err()
            .to_string(),
        code
    );
}

#[test]
fn absolute_open_has_real_metadata_stable_identity_and_display_path() {
    let f = Fixture::new();
    let path = f.file("outside.txt", b"hello");
    let first = f.open(&path);
    let second = f.open(&path.parent().unwrap().join("./outside.txt"));
    assert_eq!(first["id"], second["id"]);
    assert_eq!(f.count(), 1);
    assert_eq!(
        first["path"],
        display_path(&path.canonicalize().unwrap()).unwrap()
    );
    assert_eq!(first["name"], "outside.txt");
    assert_eq!(first["size"], 5);
    assert_eq!(first["image"], false);
    assert!(second["openedAt"].as_str() >= first["openedAt"].as_str());
    assert_eq!(
        first["modifiedAt"],
        modified(&fs::metadata(path).unwrap()).unwrap()
    );
    assert_eq!(
        lookup(&f.db, first["id"].as_str().unwrap()).unwrap(),
        f.path("outside.txt")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
}

#[test]
fn relative_session_paths_and_inside_workspace_reuse_scope_validation() {
    let f = Fixture::new();
    let cwd = f.path("workspace/sub");
    fs::create_dir_all(&cwd).unwrap();
    let session = f.session(&cwd, "codex");
    let external = f.file("outside.txt", b"outside");
    let result = call(
        &f,
        "open",
        json!({"path":"../../outside.txt","source":"link","sessionId":session}),
    );
    assert_eq!(
        result["file"]["path"],
        display_path(&external.canonicalize().unwrap()).unwrap()
    );
    fs::write(cwd.join("inside.txt"), "inside").unwrap();
    let result = call(
        &f,
        "open",
        json!({"path":"inside.txt","source":"drop","sessionId":session}),
    );
    assert_eq!(result["inWorkspace"]["path"], "sub/inside.txt");
    assert!(result["inWorkspace"]["projectId"].is_string());
    assert_eq!(f.count(), 1);
    fails(
        &f,
        "open",
        json!({"path":external,"source":"dialog","sessionId":"missing"}),
        "file_reference_session_not_found",
    );
    f.db.transaction(|tx| {
        tx.execute(
            "UPDATE sessions SET provider='claude' WHERE id=?",
            [&session],
        )?;
        Ok(())
    })
    .unwrap();
    fails(
        &f,
        "open",
        json!({"path":external,"source":"link","sessionId":session}),
        "file_reference_scope_mismatch",
    );
}

#[test]
fn shell_relative_paths_remain_unproven_and_cannot_bypass_scope() {
    let f = Fixture::new();
    let cwd = f.path("workspace");
    fs::create_dir(&cwd).unwrap();
    let session = f.session(&cwd, "shell");
    fails(
        &f,
        "open",
        json!({"path":"../outside.txt","source":"link","sessionId":session}),
        "file_reference_relative_requires_absolute",
    );
}

#[test]
fn rejects_missing_directory_relative_device_ads_control_and_long_paths() {
    let f = Fixture::new();
    fails(
        &f,
        "open",
        json!({"path":f.path("missing"),"source":"dialog"}),
        "external_file_not_found",
    );
    fails(
        &f,
        "open",
        json!({"path":f.temp.path(),"source":"dialog"}),
        "external_file_not_file",
    );
    for path in [
        "relative.txt".to_owned(),
        r"\\.\pipe\external-test".into(),
        r"\\?\GLOBALROOT\Device\NamedPipe\external-test".into(),
        r"\??\pipe\external-test".into(),
        format!("{}:stream", f.path("file.txt").display()),
        "a\0b".into(),
        "a\nb".into(),
        "a\u{7f}b".into(),
        "x".repeat(16 * 1024 + 1),
    ] {
        fails(
            &f,
            "open",
            json!({"path":path,"source":"dialog"}),
            "invalid_path",
        );
    }
    #[cfg(windows)]
    for path in [f.path("NUL"), f.path("con.txt"), f.path("COM1")] {
        fails(
            &f,
            "open",
            json!({"path":path,"source":"dialog"}),
            "invalid_path",
        );
    }
    assert_eq!(f.count(), 0);
}

#[test]
fn validates_sources_session_shape_and_forget_operations() {
    let f = Fixture::new();
    let path = f.file("a", b"a");
    for params in [
        json!({"path":path,"source":"agent"}),
        json!({"path":path,"source":"dialog","sessionId":3}),
        json!({"path":path,"source":"dialog","sessionId":""}),
    ] {
        fails(&f, "open", params, "invalid_request");
    }
    let file = f.open(&path);
    fails(&f, "forget", json!({"id":file["id"]}), "invalid_request");
    for source in ["dialog", "drop", "link", "recent"] {
        assert_eq!(
            call(&f, "open", json!({"path":path,"source":source}))["file"]["id"],
            file["id"]
        );
    }
}

#[test]
fn text_reads_are_readonly_bounded_fingerprinted_and_do_not_write() {
    let f = Fixture::new();
    let path = f.file("text.md", "你好\nhello".as_bytes());
    let file = f.open(&path);
    let before = f
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?))
        .unwrap();
    let doc = call(&f, "read", json!({"id":file["id"]}));
    assert_eq!(doc["content"], "你好\nhello");
    assert_eq!(doc["readonly"], true);
    assert_eq!(
        doc["fingerprint"],
        workspace::fingerprint("你好\nhello".as_bytes())
    );
    assert_eq!(doc["modifiedAt"], file["modifiedAt"]);
    assert_eq!(doc["path"], file["path"]);
    call(&f, "list", json!({}));
    let after = f
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?))
        .unwrap();
    assert_eq!(before, after);
    fs::write(&path, vec![b'a'; workspace::MAX_DOCUMENT_BYTES]).unwrap();
    assert_eq!(
        call(&f, "read", json!({"id":file["id"]}))["size"],
        workspace::MAX_DOCUMENT_BYTES
    );
    fs::write(&path, vec![b'a'; workspace::MAX_DOCUMENT_BYTES + 1]).unwrap();
    fails(&f, "read", json!({"id":file["id"]}), "file_too_large");
    for bytes in [vec![b'a', 0], vec![0xff, 0xfe]] {
        fs::write(&path, bytes).unwrap();
        fails(&f, "read", json!({"id":file["id"]}), "binary_file");
    }
    fails(&f, "read", json!({"id":"unknown"}), "external_file_unknown");
    fs::remove_file(&path).unwrap();
    fails(
        &f,
        "read",
        json!({"id":file["id"]}),
        "external_file_not_found",
    );
    fs::create_dir(&path).unwrap();
    fails(
        &f,
        "read",
        json!({"id":file["id"]}),
        "external_file_not_file",
    );
    fails(
        &f,
        "image",
        json!({"id":file["id"]}),
        "external_file_not_file",
    );
}

#[test]
fn images_use_magic_bytes_and_a_four_megabyte_cap() {
    let f = Fixture::new();
    let path = f.file("picture.PNG", b"\x89PNG\r\n\x1a\nimage");
    let file = f.open(&path);
    assert_eq!(file["image"], true);
    for (bytes, mime) in [
        (b"\x89PNG\r\n\x1a\nimage".as_slice(), "image/png"),
        (b"\xff\xd8\xfftest".as_slice(), "image/jpeg"),
        (b"GIF89atest".as_slice(), "image/gif"),
        (b"RIFFxxxxWEBPtest".as_slice(), "image/webp"),
    ] {
        fs::write(&path, bytes).unwrap();
        let image = call(&f, "image", json!({"id":file["id"]}));
        assert_eq!(image["mime"], mime);
        assert_eq!(image["data"], BASE64.encode(bytes));
    }
    let mut bytes = vec![1; workspace::MAX_IMAGE_BYTES as usize];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    fs::write(&path, &bytes).unwrap();
    call(&f, "image", json!({"id":file["id"]}));
    bytes.push(1);
    fs::write(&path, &bytes).unwrap();
    fails(&f, "image", json!({"id":file["id"]}), "image_too_large");
    fs::write(&path, "text").unwrap();
    fails(&f, "image", json!({"id":file["id"]}), "unsupported_image");
    fails(
        &f,
        "image",
        json!({"id":"missing"}),
        "external_file_unknown",
    );
    fs::remove_file(path).unwrap();
    fails(
        &f,
        "image",
        json!({"id":file["id"]}),
        "external_file_not_found",
    );
}

#[test]
fn recent_list_is_ordered_capped_has_exists_and_storage_is_bounded() {
    let f = Fixture::new();
    let mut last = Value::Null;
    for n in 0..205 {
        last = f.open(&f.file(&format!("{n}.txt"), b"a"));
    }
    assert_eq!(f.count(), 200);
    let recent = call(&f, "list", json!({}));
    let files = recent["files"].as_array().unwrap();
    assert_eq!(files.len(), 30);
    assert_eq!(files[0]["id"], last["id"]);
    assert!(files
        .windows(2)
        .all(|pair| pair[0]["openedAt"].as_str() >= pair[1]["openedAt"].as_str()));
    assert!(files.iter().all(|file| file["exists"] == true));
    let oldest_retained =
        f.db.transaction(|tx| {
            Ok(tx.query_row(
                "SELECT name FROM external_files ORDER BY opened_at,rowid LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert_eq!(oldest_retained, "5.txt");
    let reopened = f.open(&f.path("5.txt"));
    assert_eq!(
        call(&f, "list", json!({}))["files"][0]["id"],
        reopened["id"]
    );
    fs::remove_file(f.path("5.txt")).unwrap();
    let listed = call(&f, "list", json!({}));
    assert_eq!(listed["files"][0]["exists"], false);
    assert_eq!(listed["files"][0]["size"], 0);
    assert_eq!(listed["files"][0]["modifiedAt"], "");
}

#[test]
fn forget_is_idempotent_and_never_deletes_the_source_file() {
    let f = Fixture::new();
    let path = f.file("keep.txt", b"keep");
    let file = f.open(&path);
    let params = json!({"id":file["id"],"operationId":"forget-one"});
    assert!(call(&f, "forget", params.clone()).is_null());
    assert!(call(&f, "forget", params).is_null());
    call(
        &f,
        "forget",
        json!({"id":file["id"],"operationId":"forget-two"}),
    );
    assert_eq!(f.count(), 0);
    assert_eq!(fs::read(path).unwrap(), b"keep");
    assert!(dispatch(
        &f.db,
        "filesystem.external.forget",
        &json!({"id":"other","operationId":"forget-one"})
    )
    .unwrap_err()
    .to_string()
    .starts_with("operation_conflict:"));
}

fn symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    if let Err(error) = result {
        eprintln!("SKIP symlink creation unavailable: {error}");
        return false;
    }
    true
}

#[test]
fn symlinks_show_the_canonical_target_and_reads_revalidate_replacements() {
    let f = Fixture::new();
    let target = f.file("target.txt", b"target");
    let link = f.path("link.txt");
    if !symlink(&target, &link) {
        return;
    }
    assert_eq!(f.open(&link)["id"], f.open(&target)["id"]);
    assert_eq!(
        f.open(&link)["path"],
        display_path(&target.canonicalize().unwrap()).unwrap()
    );
    let original = f.file("original.txt", b"original");
    let file = f.open(&original);
    fs::remove_file(&original).unwrap();
    if !symlink(&target, &original) {
        return;
    }
    let doc = call(&f, "read", json!({"id":file["id"]}));
    assert_eq!(doc["content"], "target");
    assert_eq!(doc["path"], f.open(&target)["path"]);
}

#[cfg(unix)]
#[test]
fn unix_sockets_and_fifos_are_rejected_without_opening_them() {
    use std::os::unix::net::UnixListener;
    let f = Fixture::new();
    let socket = f.path("socket");
    let _listener = UnixListener::bind(&socket).unwrap();
    fails(
        &f,
        "open",
        json!({"path":socket,"source":"drop"}),
        "external_file_not_file",
    );
    let fifo = f.path("fifo");
    let status = std::process::Command::new("mkfifo").arg(&fifo).status();
    if status.is_ok_and(|s| s.success()) {
        fails(
            &f,
            "open",
            json!({"path":fifo,"source":"drop"}),
            "external_file_not_file",
        );
    }
}

#[test]
fn no_external_mutation_method_is_dispatched() {
    let f = Fixture::new();
    for method in ["write", "rename", "delete"] {
        assert!(
            dispatch(&f.db, &format!("filesystem.external.{method}"), &json!({}))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn recents_changes_publish_events_once_and_reads_remain_quiet() {
    let f = Fixture::new();
    let file = f.open(&f.file("events.txt", b"events"));
    let count = || {
        f.db.transaction(|tx| Ok(tx.query_row(
        "SELECT COUNT(*) FROM outbox WHERE event='state.changed' AND json_extract(data,'$.kind')='externalFiles'",
        [], |r| r.get::<_, i64>(0))?)).unwrap()
    };
    assert_eq!(count(), 1);
    call(&f, "read", json!({"id":file["id"]}));
    call(&f, "list", json!({}));
    assert_eq!(count(), 1);
    let forget = json!({"id":file["id"],"operationId":"forget-event"});
    call(&f, "forget", forget.clone());
    call(&f, "forget", forget);
    call(
        &f,
        "forget",
        json!({"id":file["id"],"operationId":"forget-missing"}),
    );
    assert_eq!(count(), 2);
}

#[cfg(windows)]
#[test]
fn junctions_inside_the_workspace_show_the_external_target() {
    use std::os::windows::process::CommandExt;
    let f = Fixture::new();
    let cwd = f.path("workspace");
    fs::create_dir(&cwd).unwrap();
    let session = f.session(&cwd, "codex");
    let target = f.path("outside");
    fs::create_dir(&target).unwrap();
    let path = target.join("notes.txt");
    fs::write(&path, b"outside").unwrap();
    let link = cwd.join("linked");
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .creation_flags(0x08000000)
        .output();
    if !output.is_ok_and(|out| out.status.success()) {
        eprintln!("SKIP junction creation unavailable");
        return;
    }
    let result = call(
        &f,
        "open",
        json!({"path":"linked/notes.txt","source":"link","sessionId":session}),
    );
    assert_eq!(
        result["file"]["path"],
        display_path(&path.canonicalize().unwrap()).unwrap()
    );
    assert_eq!(
        call(&f, "read", json!({"id":result["file"]["id"]}))["content"],
        "outside"
    );
}

#[test]
fn unc_and_drive_display_forms_do_not_change_operational_paths() {
    let suffix = "server\\share\\folder\\file.txt";
    let canonical = format!(r"\\?\UNC\{suffix}");
    assert_eq!(
        display_path(Path::new(&canonical)).unwrap(),
        format!(r"\\{suffix}")
    );
    let f = Fixture::new();
    let path = f.file("space 中文.txt", b"a");
    let file = f.open(&path);
    assert_eq!(call(&f, "read", json!({"id":file["id"]}))["content"], "a");
    #[cfg(windows)]
    {
        let raw = lookup(&f.db, file["id"].as_str().unwrap()).unwrap();
        assert!(raw.starts_with(r"\\?\"));
        assert!(!file["path"].as_str().unwrap().starts_with(r"\\?\"));
    }
}
