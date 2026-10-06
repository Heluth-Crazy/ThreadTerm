use super::*;
use serde_json::json;
use std::{path::Path, sync::Arc, thread};

#[cfg(windows)]
#[test]
fn shell_program_paths_have_native_windows_separators() {
    for shell in ["cmd", "powershell", "pwsh"] {
        match shell_command(shell, "echo ready") {
            Ok((program, _)) => assert!(!program.contains('/'), "{shell}: {program}"),
            Err(error) if shell == "pwsh" => assert_eq!(error.to_string(), "shell_unavailable"),
            Err(error) => panic!("{shell}: {error:#}"),
        }
    }
}

#[cfg(windows)]
#[test]
fn real_cmd_quick_launch_uses_its_shell_program_and_preserves_inherited_term() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-real-cmd");
    let runtime = service(root.path(), Arc::clone(&db));
    let command = "(echo \"a b\"& echo TERM=%TERM%& echo PRIVATE=%THREADTERM_V3_TEST_ORIGINAL_TERM%) > result.txt & type result.txt & exit /b 0";
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id, "name":"Real CMD", "command":command,
        "shell":"cmd", "cwd":"", "kind":"task", "env":[], "operationId":"save-real-cmd"
    }), "save-real-cmd")).unwrap();
    let result = runtime.dispatch("test", rpc("quickLaunch.run", json!({
        "commandId":saved["id"], "cwd":root.path().to_string_lossy(), "operationId":"run-real-cmd"
    }), "run-real-cmd")).unwrap();
    let id = result["session"]["id"].as_str().unwrap();
    let expected = format!("\"a b\"\r\nTERM={}\r\nPRIVATE=%THREADTERM_V3_TEST_ORIGINAL_TERM%\r\n", std::env::var("TERM").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "%TERM%".into()));
    let output = wait_output(&db, id, "PRIVATE=%THREADTERM_V3_TEST_ORIGINAL_TERM%\r\n");
    assert_eq!(std::fs::read_to_string(root.path().join("result.txt")).unwrap(), expected);
    // ConPTY inserts erase/cursor/style sequences between printed lines.
    let vt = regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))").unwrap();
    assert!(vt.replace_all(&output, "").contains(&expected), "exact CMD output missing: {output:?}");
    wait_inactive(&db, id);
    let session = db.session_by_id(id).unwrap().unwrap();
    assert_eq!(session.exit_code, Some(0));
    assert_eq!(session.run.unwrap().shell, "cmd");
    runtime.shutdown();
}

fn test_db() -> (tempfile::TempDir, Arc<Database>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    crate::workspace_services::initialize(&db).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    crate::retry_scheduler::initialize(&db).unwrap();
    (root, db)
}

fn project(db: &Database, root: &Path, operation: &str) -> String {
    db.add_project(&root.to_string_lossy(), Some("Quick Launch"), operation)
        .unwrap()
        .id
}

fn save_params(project_id: &str, operation: &str) -> Value {
    json!({
        "projectId": project_id, "name": "Dev server", "command": "echo ready",
        "shell": "cmd", "cwd": "", "kind": "service", "env": [],
        "operationId": operation
    })
}

fn service(root: &Path, db: Arc<Database>) -> crate::service::RuntimeService {
    crate::service::RuntimeService::new(
        crate::config::RuntimeConfig {
            data_dir: root.to_owned(),
            database_path: root.join("runtime.sqlite"),
            credential_path: root.join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-quick-launch-test".into(),
        },
        db,
    )
}

fn rpc(method: &str, params: Value, id: &str) -> crate::domain::RpcRequest {
    crate::domain::RpcRequest {
        v: 1,
        id: id.into(),
        method: method.into(),
        params,
    }
}

fn output_text(db: &Database, session_id: &str) -> String {
    String::from_utf8_lossy(
        &db.output_from(session_id, 0, 1024 * 1024)
            .unwrap()
            .into_iter()
            .flat_map(|(_, data)| data)
            .collect::<Vec<_>>(),
    )
    .into_owned()
}

fn wait_output(db: &Database, session_id: &str, needle: &str) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let text = output_text(db, session_id);
        if text.contains(needle) || std::time::Instant::now() >= deadline {
            return text;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn wait_inactive(db: &Database, session_id: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let status = db.session_by_id(session_id).unwrap().unwrap().status;
        if !matches!(status.as_str(), "starting" | "running" | "idle" | "waiting") {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "session {session_id} stayed {status}"
        );
        thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn command_crud_creation_order_revision_and_replay() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project");
    let first = dispatch(
        &db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.save",
        &save_params(&project_id, "save-a"),
    )
    .unwrap();
    let replay = dispatch(
        &db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.save",
        &save_params(&project_id, "save-a"),
    )
    .unwrap();
    assert_eq!(first, replay);
    let second = dispatch(&db, &PtyManager::new(Arc::new(crate::output::OutputStore::default())), "quickLaunch.save", &json!({"projectId":project_id,"name":"Build","command":"echo build","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"save-b"})).unwrap();
    let listed = dispatch(
        &db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.list",
        &json!({"projectId":project_id}),
    )
    .unwrap();
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            first["id"].as_str().unwrap(),
            second["id"].as_str().unwrap()
        ]
    );
    let conflict = dispatch(&db, &PtyManager::new(Arc::new(crate::output::OutputStore::default())), "quickLaunch.save", &json!({"projectId":project_id,"id":first["id"],"expectedRevision":2,"name":"Changed","command":"echo changed","shell":"cmd","cwd":"","kind":"service","env":[],"operationId":"stale"})).unwrap_err();
    assert_eq!(conflict.to_string(), "revision_conflict");
    let deleted = dispatch(
        &db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.delete",
        &json!({"id":first["id"],"expectedRevision":1,"operationId":"delete"}),
    )
    .unwrap();
    assert!(deleted.is_null());
    assert_eq!(
        dispatch(
            &db,
            &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
            "quickLaunch.list",
            &json!({"projectId":project_id})
        )
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn command_limit_is_exactly_one_hundred() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-cap");
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    for index in 0..100 {
        let value = dispatch(
            &db,
            &pty,
            "quickLaunch.save",
            &json!({"projectId":project_id,"name":format!("c{index}"),"command":"echo x","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":format!("cap-{index}")}),
        );
        assert!(value.is_ok(), "command {index}: {value:?}");
    }
    assert_eq!(dispatch(&db, &pty, "quickLaunch.save", &json!({"projectId":project_id,"name":"overflow","command":"echo x","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"cap-overflow"})).unwrap_err().to_string(), "too_many_commands");
}

#[test]
fn save_enforces_protocol_bounds_utf16_and_unknown_fields() {
    let base = json!({"projectId":"p","name":"x","command":"echo x","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"o"});
    assert!(validate("quickLaunch.save", &base).is_ok());
    assert!(validate("quickLaunch.save", &json!({"projectId":"p","name":"x","command":"😀".repeat(4001),"shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"o"})).is_err());
    assert_eq!(validate("quickLaunch.save", &json!({"projectId":"p","name":"x","command":"a\nb","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"o"})).unwrap_err().to_string(), "cmd_single_line");
    for cwd in [
        "..",
        "a/../b",
        r"C:\repo",
        "/repo",
        r"\\server\share",
        "a|b",
    ] {
        let mut value = base.clone();
        value["cwd"] = json!(cwd);
        assert!(validate("quickLaunch.save", &value).is_err(), "{cwd}");
    }
    let mut unknown = base.clone();
    unknown["extra"] = json!(true);
    assert!(validate("quickLaunch.save", &unknown).is_err());
    let mut duplicate = base.clone();
    duplicate["env"] = json!([{"name":"Path","value":"A"},{"name":"PATH","value":"B"}]);
    assert!(validate("quickLaunch.save", &duplicate).is_err());
}

#[test]
fn save_accepts_the_contract_maximum_environment_shape() {
    // Validation is intentionally per-variable: the protocol permits all 32
    // values at 8192 UTF-16 units, independently of their aggregate size.
    let env: Vec<Value> = (0..32)
        .map(|index| json!({"name":format!("QL_MAX_{index}"),"value":"x".repeat(8192)}))
        .collect();
    assert!(validate("quickLaunch.save", &json!({"projectId":"p","name":"maximum","command":"echo x","shell":"cmd","cwd":"","kind":"task","env":env,"operationId":"maximum-env"})).is_ok());
}

#[test]
fn unicode_whitespace_matches_the_wire_trim_contract() {
    let mut value = save_params("p", "trim");
    for field in ["name", "command"] {
        value[field] = json!("\u{feff}");
        assert!(validate("quickLaunch.save", &value).is_err());
        value[field] = json!("\u{85}");
        assert!(validate("quickLaunch.save", &value).is_ok());
        value = save_params("p", "trim");
    }
    assert_eq!(trim_wire("\u{feff}Name\u{a0}"), "Name");
}

#[test]
fn launch_directory_rejects_traversal_missing_and_junction_escape() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("inside")).unwrap();
    assert_eq!(
        launch_directory(root.path(), "inside").unwrap(),
        root.path().join("inside").canonicalize().unwrap()
    );
    assert_eq!(
        launch_directory(root.path(), "..").unwrap_err().to_string(),
        "cwd_outside_root"
    );
    assert_eq!(
        launch_directory(root.path(), "missing")
            .unwrap_err()
            .to_string(),
        "cwd_missing"
    );
    #[cfg(windows)]
    {
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join("escape");
        use std::os::windows::process::CommandExt;
        let payload = format!(
            r#""mklink /J "{}" "{}"""#,
            link.display(),
            outside.path().display()
        );
        let result = std::process::Command::new("cmd.exe")
            .creation_flags(0x08000000)
            .args(["/D", "/S", "/C"])
            .raw_arg(payload)
            .status()
            .unwrap();
        assert!(result.success());
        assert_eq!(
            launch_directory(root.path(), "escape")
                .unwrap_err()
                .to_string(),
            "cwd_outside_root"
        );
    }
}

#[test]
fn environment_expansion_is_case_insensitive_and_does_not_chain_overrides() {
    let inherited = vec![
        ("PATH".to_owned(), "base".to_owned()),
        ("HOME".to_owned(), "home".to_owned()),
    ];
    assert_eq!(expand(r"C:\tools;%path%", &inherited), r"C:\tools;base");
    assert_eq!(expand("%missing%/%HOME%", &inherited), "%missing%/home");
    // Values expand only from the inherited environment, independently of form order.
    assert_eq!(expand("%NEW%:%PATH%", &inherited), "%NEW%:base");
}

#[test]
fn scanner_handles_ansi_utf8_split_urls_servers_wildcards_and_cap() {
    let mut scanner = OutputObserver::default();
    assert_eq!(scanner.feed(b"\x1b["), None);
    assert_eq!(scanner.feed(b"32m  Local: http://local"), None);
    assert_eq!(
        scanner.feed("host:5173/\x1b[0m\n".as_bytes()),
        Some("http://localhost:5173/".into())
    );
    let mut utf8 = OutputObserver::default();
    assert_eq!(utf8.feed(b"\x1b]0;title\x1b"), None);
    let line = "\\\u{2713} http://127.0.0.1:3000/x),\n".as_bytes();
    assert_eq!(utf8.feed(&line[..13]), None);
    assert_eq!(
        utf8.feed(&line[13..]),
        Some("http://127.0.0.1:3000/x".into())
    );
    for (line, expected) in [
        ("ready http://0.0.0.0:5173/.", "http://localhost:5173/"),
        ("Tomcat started on port 8080", "http://localhost:8080/"),
        ("Jetty started on ports: 9090", "http://localhost:9090/"),
    ] {
        assert_eq!(detect_url(line, true), Some(expected.into()));
    }
    assert_eq!(detect_url("http://192.168.1.7:3000/", true), None);
    let mut capped = OutputObserver::default();
    assert_eq!(capped.feed(&vec![b'x'; SCAN_LIMIT]), None);
    assert!(capped.is_done());
    let partial = b"http://localhost:517";
    let mut boundary = vec![b' '; SCAN_LIMIT - partial.len()];
    boundary.extend_from_slice(partial);
    let mut capped_url = OutputObserver::default();
    assert_eq!(capped_url.feed(&boundary), None);
    assert_eq!(capped_url.feed(b"3/\n"), None);
    let mut tail = OutputObserver::default();
    assert_eq!(tail.feed(&vec![b'x'; 700]), None);
    assert!(tail.tail.chars().count() <= 512);
    let mut eof = OutputObserver::default();
    assert_eq!(eof.feed(b"http://localhost:4444/"), None);
    assert_eq!(eof.finish(), Some("http://localhost:4444/".into()));
}

#[test]
fn powershell_adapter_preserves_exit_contract_in_encoded_script() {
    let encoded = powershell_script("cmd /c exit 7");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let script = String::from_utf16(&units).unwrap();
    assert!(script.contains("$global:LASTEXITCODE = 0"));
    assert!(script.contains("if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }"));
    assert!(script.contains("if (-not $ok) { exit 1 }"));
}

#[cfg(windows)]
#[test]
fn powershell_adapter_propagates_native_and_cmdlet_exit_codes() {
    for (command, expected) in [
        ("exit 3", 3),
        ("cmd.exe /D /S /C exit 7", 7),
        ("Write-Error 'quick-launch-test'", 1),
        ("Write-Output ok", 0),
    ] {
        let (program, args) = shell_command("powershell", command).unwrap();
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new(program)
            .args(args)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(expected), "{command}");
    }
}

#[test]
fn output_url_replaces_configured_url_and_run_survives_command_deletion() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-run");
    let command = dispatch(&db, &PtyManager::new(Arc::new(crate::output::OutputStore::default())), "quickLaunch.save", &json!({"projectId":project_id,"name":"Saved","command":"echo x","shell":"cmd","cwd":"","kind":"service","env":[{"name":"PATH","value":"C:\\tools;%PATH%"}],"previewUrl":"http://localhost:3000/","operationId":"save-run"})).unwrap();
    let session = db
        .create_session(crate::db::CreateSession {
            project_id: Some(&project_id),
            title: Some("Saved"),
            provider: "custom",
            mode: "terminal",
            native_id: None,
            operation_id: "session-run",
        })
        .unwrap();
    let snapshot = command.to_string();
    db.transaction(|tx| {
        tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at) VALUES(?,?,?,?,?,?,?,0,?)", rusqlite::params![&session.id, command["id"].as_str().unwrap(), project_id, root.path().to_string_lossy(), snapshot, "http://localhost:3000/", "configured", "now"])?;
        Ok(())
    }).unwrap();
    observe_output(&db, &session.id, "http://localhost:5173/").unwrap();
    let before_delete = db.session_by_id(&session.id).unwrap().unwrap();
    assert_eq!(
        before_delete.run.unwrap().url.as_deref(),
        Some("http://localhost:5173/")
    );
    dispatch(
        &db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.delete",
        &json!({"id":command["id"],"expectedRevision":1,"operationId":"delete-running"}),
    )
    .unwrap();
    let retained = db.session_by_id(&session.id).unwrap().unwrap().run.unwrap();
    assert_eq!(retained.command_id, command["id"]);
    assert_eq!(retained.name, "Saved");
    assert_eq!(retained.url_source.as_deref(), Some("output"));
}

#[test]
fn ordinary_sessions_have_no_run_projection() {
    let (_root, db) = test_db();
    let session = db
        .create_session(crate::db::CreateSession {
            project_id: None,
            title: None,
            provider: "shell",
            mode: "terminal",
            native_id: None,
            operation_id: "ordinary",
        })
        .unwrap();
    assert!(db
        .session_by_id(&session.id)
        .unwrap()
        .unwrap()
        .run
        .is_none());
    assert!(serde_json::to_value(session).unwrap().get("run").is_none());
}

#[cfg(windows)]
#[test]
fn rerun_uses_immutable_snapshot_after_edit_and_delete() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-rerun");
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id,"name":"Snapshot","command":"Write-Output ('SNAP>' + $env:QL_SNAPSHOT)","shell":"powershell","cwd":"","kind":"task",
        "env":[{"name":"QL_SNAPSHOT","value":"original"}],"operationId":"snapshot-save"
    }), "snapshot-save")).unwrap();
    let first = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"snapshot-run"}), "snapshot-run")).unwrap();
    let first_id = first["session"]["id"].as_str().unwrap().to_owned();
    assert!(wait_output(&db, &first_id, "SNAP>original").contains("SNAP>original"));
    wait_inactive(&db, &first_id);
    let edited = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id,"id":saved["id"],"expectedRevision":1,"name":"Edited","command":"Write-Output bad","shell":"powershell","cwd":"","kind":"service",
        "env":[{"name":"QL_SNAPSHOT","value":"changed"}],"operationId":"snapshot-edit"
    }), "snapshot-edit")).unwrap();
    runtime
        .dispatch(
            "test",
            rpc(
                "quickLaunch.delete",
                json!({"id":edited["id"],"expectedRevision":2,"operationId":"snapshot-delete"}),
                "snapshot-delete",
            ),
        )
        .unwrap();
    let rerun = runtime
        .dispatch(
            "test",
            rpc(
                "session.rerun",
                json!({"sessionId":first_id,"operationId":"snapshot-rerun"}),
                "snapshot-rerun",
            ),
        )
        .unwrap();
    let rerun_id = rerun["id"].as_str().unwrap().to_owned();
    let text = wait_output(&db, &rerun_id, "SNAP>original");
    assert!(text.contains("SNAP>original"), "{text}");
    wait_inactive(&db, &rerun_id);
    let association = db.session_by_id(&rerun_id).unwrap().unwrap().run.unwrap();
    assert_eq!(association.command_id, saved["id"]);
    assert_eq!(association.name, "Snapshot");
    assert_eq!(association.kind, "task");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn run_environment_is_case_insensitive_expanded_and_scoped_to_its_snapshot() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-env");
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id,"name":"Environment","command":"Write-Output ('ENV>' + $env:QL_PROBE + '|' + $env:THREADTERM_V3_BOOTSTRAP_COMMAND + '|' + $env:THREADTERM_V3_BOOTSTRAP_GATE + '|' + $env:Path)","shell":"powershell","cwd":"","kind":"task",
        "env":[{"name":"ql_probe","value":"only-this-run"},{"name":"threadterm_v3_bootstrap_command","value":"user-command"},{"name":"THREADTERM_v3_BOOTSTRAP_GATE","value":"user-gate"},{"name":"Path","value":"C:\\ql;%PATH%"}],"operationId":"env-save"
    }), "env-save")).unwrap();
    let run = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"env-run"}), "env-run")).unwrap();
    let session_id = run["session"]["id"].as_str().unwrap().to_owned();
    let text = wait_output(
        &db,
        &session_id,
        "ENV>only-this-run|user-command|user-gate|C:\\ql;",
    );
    assert!(
        text.contains("ENV>only-this-run|user-command|user-gate|C:\\ql;"),
        "{text}"
    );
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn run_overrides_do_not_leak_to_an_ordinary_terminal() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-no-leak");
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id,"name":"Scoped","command":"Write-Output ('SCOPED>' + $env:QL_ONLY_THIS_RUN)","shell":"powershell","cwd":"","kind":"task",
        "env":[{"name":"QL_ONLY_THIS_RUN","value":"present"}],"operationId":"scope-save"
    }), "scope-save")).unwrap();
    let quick = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"scope-run"}), "scope-run")).unwrap();
    let quick_id = quick["session"]["id"].as_str().unwrap().to_owned();
    assert!(wait_output(&db, &quick_id, "SCOPED>present").contains("SCOPED>present"));
    let ordinary = runtime.dispatch("test", rpc("session.create", json!({
        "projectId":project_id,"cwd":root.path().to_string_lossy(),"provider":"shell","mode":"terminal","executable":"powershell.exe",
        "args":["-NoLogo","-EncodedCommand",powershell_script("Write-Output ('ORDINARY>' + $env:QL_ONLY_THIS_RUN)")],"operationId":"ordinary-run"
    }), "ordinary-run")).unwrap();
    let ordinary_text = wait_output(&db, ordinary["id"].as_str().unwrap(), "ORDINARY>");
    assert!(ordinary_text.contains("ORDINARY>"));
    assert!(
        !ordinary_text.contains("ORDINARY>present"),
        "{ordinary_text}"
    );
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn one_command_runs_independently_in_two_registered_worktrees() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-worktrees");
    let one = root.path().join("one");
    let two = root.path().join("two");
    std::fs::create_dir(&one).unwrap();
    std::fs::create_dir(&two).unwrap();
    db.transaction(|tx| {
        tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,?,?,0,0)", rusqlite::params!["one", project_id, one.to_string_lossy(), "one", "head"])?;
        tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,?,?,0,0)", rusqlite::params!["two", project_id, two.to_string_lossy(), "two", "head"])?;
        Ok(())
    }).unwrap();
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId":project_id,"name":"Two roots","shell":"powershell","cwd":"","kind":"service","env":[],
        "command":"if ((Get-Location).Path.EndsWith('one')) {[Console]::Out.WriteLine('http://localhost:5101/')} else {[Console]::Out.WriteLine('http://localhost:5102/')}; Start-Sleep -Seconds 30","operationId":"roots-save"
    }), "roots-save")).unwrap();
    let run = |cwd: &Path, operation: &str| {
        runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":cwd.to_string_lossy(),"operationId":operation}), operation)).unwrap()
    };
    let first = run(&one, "roots-one");
    let second = run(&two, "roots-two");
    let first_id = first["session"]["id"].as_str().unwrap().to_owned();
    let second_id = second["session"]["id"].as_str().unwrap().to_owned();
    assert_ne!(first_id, second_id);
    assert!(wait_output(&db, &first_id, "localhost:5101").contains("localhost:5101"));
    assert!(wait_output(&db, &second_id, "localhost:5102").contains("localhost:5102"));
    assert_eq!(
        db.session_by_id(&first_id)
            .unwrap()
            .unwrap()
            .run
            .unwrap()
            .url
            .as_deref(),
        Some("http://localhost:5101/")
    );
    assert_eq!(
        db.session_by_id(&second_id)
            .unwrap()
            .unwrap()
            .run
            .unwrap()
            .url
            .as_deref(),
        Some("http://localhost:5102/")
    );
    for (id, operation) in [(first_id, "roots-stop-one"), (second_id, "roots-stop-two")] {
        runtime
            .dispatch(
                "test",
                rpc(
                    "session.stop",
                    json!({"sessionId":id,"operationId":operation,"force":true}),
                    operation,
                ),
            )
            .unwrap();
    }
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn concurrent_run_admits_one_session_then_stop_marks_intent() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-concurrent");
    let runtime = Arc::new(service(root.path(), Arc::clone(&db)));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({"projectId":project_id,"name":"Slow","command":"Start-Sleep -Seconds 30","shell":"powershell","cwd":"","kind":"service","env":[],"operationId":"save-slow"}), "save-slow")).unwrap();
    let command_id = saved["id"].as_str().unwrap().to_owned();
    let cwd = root.path().to_string_lossy().to_string();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut joins = Vec::new();
    for index in 0..2 {
        let runtime = Arc::clone(&runtime);
        let command_id = command_id.clone();
        let cwd = cwd.clone();
        let barrier = Arc::clone(&barrier);
        joins.push(thread::spawn(move || {
            barrier.wait();
            runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":command_id,"cwd":cwd,"operationId":format!("run-{index}")}), &format!("run-{index}"))).unwrap()
        }));
    }
    barrier.wait();
    let first = joins.remove(0).join().unwrap();
    let second = joins.remove(0).join().unwrap();
    let first_id = first["session"]["id"].as_str().unwrap();
    assert_eq!(first_id, second["session"]["id"].as_str().unwrap());
    assert_eq!([&first, &second].iter().filter(|result| result["existing"] == json!(false)).count(), 1);
    assert_eq!([&first, &second].iter().filter(|result| result["existing"] == json!(true)).count(), 1);
    let sessions = db.snapshot().unwrap().sessions;
    assert_eq!(sessions.len(), 1);
    assert!(matches!(sessions[0].status.as_str(), "starting" | "running" | "idle" | "waiting"));
    runtime
        .dispatch(
            "test",
            rpc(
                "session.stop",
                json!({"sessionId":first_id,"operationId":"stop-slow","force":true}),
                "stop-slow",
            ),
        )
        .unwrap();
    let stopped = db.session_by_id(first_id).unwrap().unwrap();
    assert_eq!(stopped.run.unwrap().stop_requested, Some(true));
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn real_run_output_updates_only_its_run_projection() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-output");
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({
        "projectId": project_id, "name": "Output", "shell": "powershell", "cwd": "", "kind": "service", "env": [],
        "command": "[Console]::Out.Write('http://local'); Start-Sleep -Milliseconds 20; [Console]::Out.WriteLine('host:5173/'); Start-Sleep -Seconds 30",
        "operationId": "save-output"
    }), "save-output")).unwrap();
    let run = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"run-output"}), "run-output")).unwrap();
    let session_id = run["session"]["id"].as_str().unwrap().to_owned();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let url = loop {
        let url = db
            .session_by_id(&session_id)
            .unwrap()
            .unwrap()
            .run
            .and_then(|run| run.url);
        if url.is_some() || std::time::Instant::now() >= deadline {
            break url;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    };
    runtime
        .dispatch(
            "test",
            rpc(
                "session.stop",
                json!({"sessionId":session_id,"operationId":"stop-output","force":true}),
                "stop-output",
            ),
        )
        .unwrap();
    runtime.shutdown();
    assert_eq!(url.as_deref(), Some("http://localhost:5173/"));
}

#[cfg(windows)]
#[test]
fn maximum_environment_values_reach_the_shell_without_private_carriers() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "big-project");
    let runtime = service(root.path(), Arc::clone(&db));
    let env: Vec<_> = (0..32)
        .map(|index| json!({"name":format!("QL_BIG_{index}"),"value":"\u{1}".repeat(8192)}))
        .collect();
    let script = "foreach ($i in 0..31) {if ([Environment]::GetEnvironmentVariable(\"QL_BIG_$i\").Length -ne 8192) {exit 3}}; if (@([Environment]::GetEnvironmentVariables().Keys | Where-Object {$_ -like 'THREADTERM_V3_BOOTSTRAP_ENV_*'}).Count) {exit 4}; Write-Output 'BIG>ok'";
    let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({"projectId":project_id,"name":"Big env","command":script,"shell":"powershell","cwd":"","kind":"task","env":env,"operationId":"big-save"}), "big-save")).unwrap();
    let result = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"big-run"}), "big-run")).unwrap();
    let id = result["session"]["id"].as_str().unwrap();
    let output = wait_output(&db, id, "BIG>ok");
    wait_inactive(&db, id);
    runtime.shutdown();
    assert!(output.contains("BIG>ok"), "{output}");
    assert_eq!(db.session_by_id(id).unwrap().unwrap().exit_code, Some(0));
}

#[cfg(windows)]
#[test]
fn control_heavy_cmd_payload_uses_a_bounded_verbatim_carrier() {
    let payload = format!("echo {}", "\u{1}".repeat(7995));
    let root = tempfile::tempdir().unwrap();
    let gate = crate::bootstrap::BootstrapGate::new().unwrap();
    let mut command = gate
        .command(
            "cmd.exe",
            &["/D".into(), "/S".into(), "/C".into(), payload.clone()],
            root.path().to_str().unwrap(),
        )
        .unwrap();
    crate::bootstrap::application_environment(&mut command, &[]).unwrap();
    let config = command
        .get_env("THREADTERM_V3_BOOTSTRAP_COMMAND")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(config.encode_utf16().count() < 32767);
    let config: Value = serde_json::from_str(config).unwrap();
    assert_eq!(
        command
            .get_env(config["payload_ref"].as_str().unwrap())
            .unwrap(),
        std::ffi::OsStr::new(&payload)
    );
}

#[test]
fn run_reports_named_cwd_errors_and_command_not_found() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "cwd-project");
    let runtime = service(root.path(), Arc::clone(&db));
    let saved = runtime
        .dispatch(
            "test",
            rpc(
                "quickLaunch.save",
                save_params(&project_id, "cwd-save"),
                "cwd-save",
            ),
        )
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    let child = root.path().join("child");
    std::fs::create_dir(&child).unwrap();
    let missing = root.path().join("missing");
    for (cwd, code) in [
        (outside.path(), "cwd_outside_root"),
        (child.as_path(), "cwd_outside_root"),
        (missing.as_path(), "cwd_missing"),
    ] {
        let error = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":cwd.to_string_lossy(),"operationId":format!("bad-{code}-{}",cwd.display())}), "bad-cwd")).unwrap_err();
        assert_eq!(error.code, code);
    }
    let error = runtime.dispatch("test", rpc("quickLaunch.run",json!({"commandId":"missing","cwd":root.path().to_string_lossy(),"operationId":"no-command"}),"no-command")).unwrap_err();
    assert_eq!(error.code, "command_not_found");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn stopped_run_ends_quietly_but_a_failed_run_still_needs_attention() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-quiet-stop");
    let runtime = service(root.path(), Arc::clone(&db));
    let cwd = root.path().to_string_lossy().to_string();
    let inbox = |id: &str| -> Option<(String, bool)> {
        db.transaction(|tx| Ok(tx.query_row("SELECT kind,read FROM inbox WHERE session_id=?", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))).optional()?)).unwrap()
    };
    let mut run = |name: &str, command: &str, kind: &str| -> String {
        let saved = runtime.dispatch("test", rpc("quickLaunch.save", json!({"projectId":project_id,"name":name,"command":command,"shell":"cmd","cwd":"","kind":kind,"env":[],"operationId":format!("save-{name}")}), &format!("save-{name}"))).unwrap();
        let started = runtime.dispatch("test", rpc("quickLaunch.run", json!({"commandId":saved["id"],"cwd":cwd,"operationId":format!("run-{name}")}), &format!("run-{name}"))).unwrap();
        started["session"]["id"].as_str().unwrap().to_owned()
    };
    let service_id = run("server", "ping -n 30 127.0.0.1 > nul", "service");
    runtime.dispatch("test", rpc("session.stop", json!({"sessionId":service_id,"operationId":"stop-server","force":true}), "stop-server")).unwrap();
    wait_inactive(&db, &service_id);
    assert_eq!(db.session_by_id(&service_id).unwrap().unwrap().run.unwrap().stop_requested, Some(true));
    assert_eq!(inbox(&service_id), None, "a run the user stopped must not ask for attention");
    let failed_id = run("broken", "exit 3", "task");
    wait_inactive(&db, &failed_id);
    assert_eq!(inbox(&failed_id), Some(("failed".to_owned(), false)), "a failing run still needs attention");
    runtime.shutdown();
}
