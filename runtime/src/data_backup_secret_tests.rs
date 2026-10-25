use super::*;

#[test]
fn excludes_connection_secrets_and_website_data_but_keeps_app_storage() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("runtime");
    let profile = temp.path().join("desktop");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&profile).unwrap();
    let config = RuntimeConfig {
        data_dir: data.clone(),
        database_path: data.join("threadterm-v3.sqlite3"),
        credential_path: data.join("runtime.credential"),
        pipe_base: r"\\.\pipe\backup-secret-fixture".into(),
    };
    let db = Database::open(&config.database_path).unwrap();
    for path in [
        "runtime.credential",
        "remote-access-cert.pem",
        "remote-access-key.pem",
        "remote-access-key.tmp-fixture",
        "remote-access-cert.tmp-fixture",
        "plugins/example/api-token.txt",
        "plugins/example/private.key",
        "plugins/example/.env",
        "plugins/token-counter/api-key.json",
        "plugins/token-counter/signing.ppk",
    ] {
        let path = data.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"F19B-CONNECTION-SECRET-NEVER-ARCHIVE").unwrap();
    }
    for path in [
        "Network/Cookies",
        "Cookies",
        "Partitions/threadterm-browser/IndexedDB/site/data",
        "Session Storage/site",
        "IndexedDB/site/data",
        "Local State",
    ] {
        let path = profile.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"F19B-WEBSITE-COOKIE-NEVER-ARCHIVE").unwrap();
    }
    for path in [
        "Local Storage/leveldb/app-state",
        "browser-preferences.json",
        "Crash Reports/historical.dmp",
    ] {
        let path = profile.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"owned-nonsecret-app-state").unwrap();
    }
    fs::write(
        data.join("opaque.bin"),
        b"-----BEGIN OPENSSH PRIVATE KEY-----\nF19B-CONNECTION-SECRET-NEVER-ARCHIVE",
    )
    .unwrap();
    fs::create_dir_all(data.join("plugins/private-tools/src")).unwrap();
    fs::write(
        data.join("plugins/private-tools/plugin.json"),
        b"{\"name\":\"private-tools\"}",
    )
    .unwrap();
    fs::write(
        data.join("plugins/private-tools/src/token-counter.ts"),
        b"const example = '-----BEGIN PRIVATE KEY-----';",
    )
    .unwrap();
    fs::write(
        data.join("plugins/token-counter/plugin.json"),
        b"{\"name\":\"token-counter\"}",
    )
    .unwrap();
    fs::write(data.join("runtime.log.1"), b"retained-log").unwrap();
    let target = temp.path().join("backup.sqlite3");
    create(&config, &db, &target, &profile).unwrap();
    let archive = Connection::open(&target).unwrap();
    let manifest: Manifest = serde_json::from_str(
        &archive
            .query_row(
                "SELECT body FROM backup_documents WHERE name='manifest.json'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(
        !manifest
            .files
            .iter()
            .any(|entry| entry.path == "runtime/runtime.credential"),
        "runtime credential must be excluded"
    );
    for (resource, reason) in [
        ("runtime/runtime.credential", "recreated on start"),
        ("runtime/remote-access-key.pem", "pair mobile devices again"),
        (
            "runtime/remote-access-key.tmp-fixture",
            "pair mobile devices again",
        ),
        ("runtime/opaque.bin", "pair mobile devices again"),
        ("desktop/Network", "sign in again"),
        ("desktop/Partitions", "sign in again"),
    ] {
        assert!(
            manifest
                .excluded
                .iter()
                .any(|entry| entry.resource == resource && entry.reason.contains(reason)),
            "missing exclusion/reason: {resource}"
        );
    }
    for path in [
        "desktop/Local Storage/leveldb/app-state",
        "desktop/browser-preferences.json",
        "desktop/Crash Reports/historical.dmp",
        "runtime/runtime.log.1",
        "runtime/plugins/private-tools/plugin.json",
        "runtime/plugins/private-tools/src/token-counter.ts",
        "runtime/plugins/token-counter/plugin.json",
    ] {
        assert!(
            manifest.files.iter().any(|entry| entry.path == path),
            "missing own data: {path}"
        );
    }
    let mut query = archive
        .prepare("SELECT path,data FROM backup_chunks")
        .unwrap();
    for row in query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .unwrap()
    {
        let (path, bytes) = row.unwrap();
        assert!(
            !bytes
                .windows(b"F19B-CONNECTION-SECRET-NEVER-ARCHIVE".len())
                .any(|part| part == b"F19B-CONNECTION-SECRET-NEVER-ARCHIVE"),
            "secret payload: {path}"
        );
        assert!(
            !bytes
                .windows(b"F19B-WEBSITE-COOKIE-NEVER-ARCHIVE".len())
                .any(|part| part == b"F19B-WEBSITE-COOKIE-NEVER-ARCHIVE"),
            "website payload: {path}"
        );
    }
    assert_eq!(verify(&target).unwrap()["verified"], true);
}
