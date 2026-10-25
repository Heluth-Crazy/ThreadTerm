use super::*;

#[test]
fn sqlite_snapshot_reports_a_persistently_locked_file_instead_of_hanging() {
    let scratch = Scratch::new().unwrap();
    let source = scratch.0.join("locked.sqlite");
    let owner = Connection::open(&source).unwrap();
    owner
        .execute_batch("CREATE TABLE owned(value); BEGIN EXCLUSIVE;")
        .unwrap();
    let started = std::time::Instant::now();
    let error = snapshot(&source, &scratch.0.join("snapshot.sqlite")).unwrap_err();
    assert!(error.to_string().contains("locked.sqlite"), "{error:#}");
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
}

#[test]
fn corrupt_sqlite_is_not_classified_as_a_lock_retry() {
    let scratch = Scratch::new().unwrap();
    let source = scratch.0.join("corrupt.sqlite");
    let owner = Connection::open(&source).unwrap();
    owner
        .execute_batch("CREATE TABLE owned(value); INSERT INTO owned VALUES(1);")
        .unwrap();
    drop(owner);
    let mut bytes = fs::read(&source).unwrap();
    bytes[100] = 0xff;
    fs::write(&source, bytes).unwrap();
    let error = snapshot(&source, &scratch.0.join("saved.sqlite")).unwrap_err();
    assert!(
        !snapshot_is_locked(&error),
        "corruption must fail without a recovery-set retry: {error:#}"
    );
}

#[test]
fn locked_desktop_wal_capture_retries_changes_and_keeps_committed_rows() {
    let scratch = Scratch::new().unwrap();
    let source = scratch.0.join("cookies.sqlite");
    let owner = Connection::open(&source).unwrap();
    owner.execute_batch("PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE cookies(name TEXT); INSERT INTO cookies VALUES('committed-wal');").unwrap();
    assert!(fs::metadata(recovery_path(&source, "-wal")).unwrap().len() > 32);
    let target = scratch.0.join("saved.sqlite");
    drop(private_file(&target).unwrap());
    let mut attempts = 0;
    locked_desktop_snapshot(&source, &target, |attempt| {
        attempts += 1;
        if attempt == 0 {
            owner.execute("INSERT INTO cookies VALUES('during-copy')", [])?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(attempts, 2);
    let saved = Connection::open(&target).unwrap();
    assert_eq!(
        saved
            .query_row("SELECT count(*) FROM cookies", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        saved
            .query_row(
                "SELECT count(*) FROM cookies WHERE name='committed-wal'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    drop(saved);
    let unstable_target = scratch.0.join("unstable.sqlite");
    drop(private_file(&unstable_target).unwrap());
    let mut attempts = 0;
    let error = locked_desktop_snapshot(&source, &unstable_target, |_| {
        attempts += 1;
        owner.execute("INSERT INTO cookies VALUES('changing')", [])?;
        Ok(())
    })
    .unwrap_err();
    assert_eq!(attempts, 3);
    assert!(error.to_string().contains("cookies.sqlite"));
    assert_eq!(fs::metadata(&unstable_target).unwrap().len(), 0);
}

#[test]
fn locked_desktop_capture_recovers_an_uncommitted_rollback_journal() {
    let scratch = Scratch::new().unwrap();
    let source = scratch.0.join("rollback.sqlite");
    let owner = Connection::open(&source).unwrap();
    owner.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE owned(id INTEGER PRIMARY KEY,value TEXT); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<64) INSERT INTO owned SELECT x,printf('%04096d',x) FROM n; BEGIN EXCLUSIVE; UPDATE owned SET value=printf('%04096d',999);").unwrap();
    assert!(
        fs::metadata(recovery_path(&source, "-journal"))
            .unwrap()
            .len()
            > 512
    );
    let target = scratch.0.join("saved.sqlite");
    drop(private_file(&target).unwrap());
    locked_desktop_snapshot(&source, &target, |_| Ok(())).unwrap();
    let saved = Connection::open(&target).unwrap();
    let original: bool = saved
        .query_row(
            "SELECT value=printf('%04096d',1) FROM owned WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        original,
        "private recovery must roll back uncommitted source pages"
    );
}
use std::collections::BTreeSet;

struct Fixture {
    _temp: tempfile::TempDir,
    config: RuntimeConfig,
    db: Database,
    profile: PathBuf,
    target: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let profile = temp.path().join("profile");
    fs::create_dir(&data).unwrap();
    fs::create_dir(&profile).unwrap();
    let config = RuntimeConfig {
        database_path: data.join("threadterm-v3.sqlite3"),
        credential_path: data.join("runtime.credential"),
        data_dir: data,
        pipe_base: r"\\.\pipe\backup-review-test".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    let target = temp.path().join("backup.sqlite3");
    Fixture {
        _temp: temp,
        config,
        db,
        profile,
        target,
    }
}

fn read_manifest(path: &Path) -> Manifest {
    let archive = read_only(path).unwrap();
    let body: String = archive
        .query_row(
            "SELECT body FROM backup_documents WHERE name='manifest.json'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&body).unwrap()
}

fn extract(path: &Path, name: &str) -> Vec<u8> {
    let archive = read_only(path).unwrap();
    let mut statement = archive
        .prepare("SELECT data FROM backup_chunks WHERE path=? ORDER BY sequence")
        .unwrap();
    let mut bytes = Vec::new();
    for row in statement
        .query_map([name], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
    {
        bytes.extend(row.unwrap());
    }
    bytes
}

fn names(path: &Path) -> BTreeSet<String> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn failed_publication_verification_removes_the_partial_and_target() {
    let temp = tempfile::tempdir().unwrap();
    let staged = temp.path().join("staged.sqlite3");
    let target = temp.path().join("backup.sqlite3");
    fs::write(&staged, b"staged backup").unwrap();
    let before = names(temp.path());

    let error =
        publish_archive(&staged, &target, |_| bail!("forced verification failure")).unwrap_err();

    assert!(format!("{error:#}").contains("forced verification failure"));
    assert!(!target.exists());
    assert_eq!(
        names(temp.path()),
        before,
        "partial archive leaked after failure"
    );
}

#[test]
fn publication_race_never_overwrites_the_winner_and_cleans_the_partial() {
    let temp = tempfile::tempdir().unwrap();
    let staged = temp.path().join("staged.sqlite3");
    let target = temp.path().join("backup.sqlite3");
    fs::write(&staged, b"our backup").unwrap();

    let result = publish_archive(&staged, &target, |_| {
        fs::write(&target, b"race winner")?;
        Ok(json!({"verified": true}))
    });

    assert!(
        result.is_err(),
        "an occupied destination must not be replaced"
    );
    assert_eq!(fs::read(&target).unwrap(), b"race winner");
    assert_eq!(
        names(temp.path()),
        BTreeSet::from(["backup.sqlite3".into(), "staged.sqlite3".into()]),
        "failed no-clobber publication leaked a partial archive"
    );
}

#[test]
fn verifier_names_extra_file_and_orphan_chunk_paths() {
    let fixture = fixture();
    create(
        &fixture.config,
        &fixture.db,
        &fixture.target,
        &fixture.profile,
    )
    .unwrap();
    let archive = Connection::open(&fixture.target).unwrap();
    let empty_sha = hex::encode(Sha256::digest([]));
    archive
        .execute(
            "INSERT INTO backup_files(path,size_bytes,sha256,sqlite) VALUES('runtime/extra.bin',0,?,0)",
            [empty_sha],
        )
        .unwrap();
    let extra = format!("{:#}", verify(&fixture.target).unwrap_err());
    assert!(extra.contains("runtime/extra.bin"), "{extra}");
    archive
        .execute(
            "DELETE FROM backup_files WHERE path='runtime/extra.bin'",
            [],
        )
        .unwrap();
    archive
        .execute(
            "INSERT INTO backup_chunks(path,sequence,data) VALUES('runtime/orphan.bin',0,X'01')",
            [],
        )
        .unwrap();
    let orphan = format!("{:#}", verify(&fixture.target).unwrap_err());
    assert!(orphan.contains("runtime/orphan.bin"), "{orphan}");
}

#[test]
fn verifier_names_a_missing_manifest_and_rejects_external_sidecars() {
    let fixture = fixture();
    create(
        &fixture.config,
        &fixture.db,
        &fixture.target,
        &fixture.profile,
    )
    .unwrap();
    let mut wal = fixture.target.as_os_str().to_os_string();
    wal.push("-wal");
    fs::write(&wal, b"external state").unwrap();
    let sidecar = format!("{:#}", verify(&fixture.target).unwrap_err());
    assert!(sidecar.contains("backup.sqlite3-wal"), "{sidecar}");
    fs::remove_file(&wal).unwrap();

    Connection::open(&fixture.target)
        .unwrap()
        .execute(
            "DELETE FROM backup_documents WHERE name='manifest.json'",
            [],
        )
        .unwrap();
    let missing = format!("{:#}", verify(&fixture.target).unwrap_err());
    assert!(missing.contains("manifest.json"), "{missing}");
}

#[cfg(any(unix, windows))]
fn symlink_file_for_test(source: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(source, link);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(source, link);
    match result {
        Ok(()) => true,
        #[cfg(windows)]
        Err(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314) =>
        {
            false
        }
        Err(error) => panic!("creating database symlink: {error}"),
    }
}

#[cfg(any(unix, windows))]
#[test]
fn main_database_is_snapshotted_even_when_its_file_is_a_symlink() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let profile = temp.path().join("profile");
    fs::create_dir(&data).unwrap();
    fs::create_dir(&profile).unwrap();
    let real_database = temp.path().join("outside.sqlite3");
    drop(Connection::open(&real_database).unwrap());
    let database_path = data.join("threadterm-v3.sqlite3");
    if !symlink_file_for_test(&real_database, &database_path) {
        return;
    }
    let config = RuntimeConfig {
        data_dir: data,
        database_path,
        credential_path: temp.path().join("unused-credential"),
        pipe_base: r"\\.\pipe\backup-symlink-test".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    db.transaction(|transaction| {
        transaction.execute_batch(
            "CREATE TABLE backup_review_marker(value TEXT); INSERT INTO backup_review_marker VALUES('present');",
        )?;
        Ok(())
    })
    .unwrap();
    let target = temp.path().join("backup.sqlite3");
    create(&config, &db, &target, &profile).unwrap();
    let manifest = read_manifest(&target);
    assert_eq!(
        manifest
            .files
            .iter()
            .filter(|entry| entry.path == "runtime/threadterm-v3.sqlite3")
            .count(),
        1
    );
    let extracted = temp.path().join("extracted.sqlite3");
    fs::write(
        &extracted,
        extract(&target, "runtime/threadterm-v3.sqlite3"),
    )
    .unwrap();
    assert_eq!(
        read_only(&extracted)
            .unwrap()
            .query_row("SELECT value FROM backup_review_marker", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "present"
    );
}

#[test]
fn nested_runtime_and_desktop_roots_are_archived_once() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let data = profile.join("runtime-data");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("owned.bin"), b"runtime").unwrap();
    fs::write(profile.join("browser-preferences.json"), b"{}").unwrap();
    let config = RuntimeConfig {
        database_path: data.join("threadterm-v3.sqlite3"),
        credential_path: data.join("runtime.credential"),
        data_dir: data,
        pipe_base: r"\\.\pipe\backup-overlap-test".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    let target = temp.path().join("backup.sqlite3");
    create(&config, &db, &target, &profile).unwrap();
    let paths = read_manifest(&target)
        .files
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    assert!(paths.contains(&"runtime/owned.bin".into()));
    assert!(paths.contains(&"desktop/browser-preferences.json".into()));
    assert_eq!(
        paths
            .iter()
            .filter(|path| path.ends_with("threadterm-v3.sqlite3"))
            .count(),
        1,
        "the nested runtime database was archived through both roots"
    );
    assert!(
        !paths
            .iter()
            .any(|path| path.starts_with("desktop/runtime-data/")),
        "the nested runtime root was duplicated under desktop/"
    );
}

#[test]
fn equal_runtime_and_desktop_root_excludes_both_cache_and_runtime_transients() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("shared-data");
    fs::create_dir(&data).unwrap();
    fs::create_dir(data.join("Cache")).unwrap();
    fs::write(data.join("Cache/rebuilt.bin"), b"cache").unwrap();
    fs::write(data.join("runtime.log"), b"diagnostic").unwrap();
    fs::write(data.join("LOCK"), b"transient").unwrap();
    fs::write(data.join("owned.bin"), b"owned").unwrap();
    let config = RuntimeConfig {
        database_path: data.join("threadterm-v3.sqlite3"),
        credential_path: data.join("runtime.credential"),
        data_dir: data.clone(),
        pipe_base: r"\\.\pipe\backup-equal-root-test".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    let target = temp.path().join("backup.sqlite3");
    create(&config, &db, &target, &data).unwrap();
    let manifest = read_manifest(&target);
    assert!(
        manifest
            .files
            .iter()
            .any(|entry| entry.path == "runtime/owned.bin"),
        "durable files in the shared root remain included"
    );
    assert!(
        manifest.files.iter().all(|entry| {
            entry.path != "runtime/LOCK" && !entry.path.starts_with("runtime/Cache/")
        }),
        "a shared root must not turn rebuildable desktop/runtime files into backup payloads"
    );
    assert!(manifest
        .files
        .iter()
        .any(|entry| entry.path == "runtime/runtime.log"));
    for resource in ["runtime/LOCK", "runtime/Cache"] {
        assert!(
            manifest
                .excluded
                .iter()
                .any(|entry| entry.resource == resource),
            "missing shared-root exclusion {resource}"
        );
    }
}

#[test]
fn walk_skips_a_staging_tree_nested_inside_the_source_root() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("owned.bin"), b"owned").unwrap();
    let config = RuntimeConfig {
        database_path: data.join("threadterm-v3.sqlite3"),
        credential_path: data.join("runtime.credential"),
        data_dir: data.clone(),
        pipe_base: r"\\.\pipe\backup-nested-scratch-test".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    let scratch = Scratch(data.join("threadterm-backup-staging"));
    fs::create_dir(&scratch.0).unwrap();
    secure_path(&scratch.0, true).unwrap();
    let archive_path = scratch.0.join("archive.sqlite3");
    drop(private_file(&archive_path).unwrap());
    let mut archive = Connection::open(&archive_path).unwrap();
    archive.execute_batch("CREATE TABLE backup_files(path TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,sqlite INTEGER NOT NULL); CREATE TABLE backup_chunks(path TEXT NOT NULL,sequence INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(path,sequence)); CREATE TABLE backup_documents(name TEXT PRIMARY KEY,body TEXT NOT NULL);").unwrap();
    let mut manifest = Manifest {
        format: FORMAT.into(),
        version: 1,
        created_at: "test".into(),
        files: Vec::new(),
        excluded: Vec::new(),
    };
    let root = fs::canonicalize(&data).unwrap();
    let skipped = fs::canonicalize(&scratch.0).unwrap();
    walk(
        &mut archive,
        &scratch,
        &mut manifest,
        &root,
        &root,
        "runtime",
        &db,
        &[skipped],
        false,
    )
    .unwrap();
    assert!(manifest
        .files
        .iter()
        .any(|entry| entry.path == "runtime/owned.bin"));
    assert!(manifest
        .files
        .iter()
        .all(|entry| !entry.path.contains("threadterm-backup-staging")));
}

#[cfg(unix)]
#[test]
fn scratch_and_published_archives_are_private_on_unix() {
    use std::os::unix::fs::PermissionsExt;

    let scratch = Scratch::new().unwrap();
    assert_eq!(
        fs::metadata(&scratch.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
    drop(scratch);

    let fixture = fixture();
    create(
        &fixture.config,
        &fixture.db,
        &fixture.target,
        &fixture.profile,
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
