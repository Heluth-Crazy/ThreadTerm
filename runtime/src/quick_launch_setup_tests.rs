use super::*;
use serde_json::json;
use std::{path::Path, sync::Arc, thread, time::{Duration, Instant}};

#[test]
fn recovery_consumes_a_creation_committed_before_its_setup_hook() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db,root.path(),"recovery-project");
    let path = root.path().join("created-before-crash");
    register_worktree(&db,&project,&path,"created-before-crash");
    let runtime = setup_service(root.path(),Arc::clone(&db));
    let task = save_command(&runtime,&project,"setup","exit /b 0","task","recovery-command");
    save_setup(&runtime,&project,&[task["id"].as_str().unwrap().into()],0,"recovery-save");
    let worktree = json!({"id":"created-before-crash","projectId":project,"path":path.canonicalize().unwrap().to_string_lossy()});
    db.transaction(|tx| complete(tx,"creation-before-crash","worktree.create",&worktree)).unwrap();
    mark_setup_runs_interrupted(&db).unwrap();
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    setup_after_worktree_create(&db,&pty,&worktree);
    assert!(setup_status(&runtime,&project).is_empty());
    // Delegate hooks use the canonical root rather than the worktree id.
    setup_after_worktree_create(&db,&pty,&json!({"projectId":project,"path":path.to_string_lossy()}));
    assert!(setup_status(&runtime,&project).is_empty());
    runtime.shutdown();
}

#[test]
fn continuation_preparation_error_marks_the_sequence_failed() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db,root.path(),"corrupt-sequence-project");
    let runtime = setup_service(root.path(),Arc::clone(&db));
    let now = Utc::now().to_rfc3339();
    db.transaction(|tx| {
        tx.execute("INSERT INTO quick_launch_setup_runs(id,project_id,root,command_ids_json,names_json,snapshots_json,step,state,session_ids_json,trigger,created_at,updated_at) VALUES('corrupt-sequence',?,?,'[\"task\"]','[\"Task\"]','invalid-json',0,'running','[]','manual',?,?)",rusqlite::params![project,root.path().to_string_lossy(),now,now])?;
        Ok(())
    }).unwrap();
    start_next_setup_step(Arc::clone(&db),PtyManager::new(Arc::new(crate::output::OutputStore::default())),"corrupt-sequence".into());
    let failed = wait_setup_state(&runtime,&project,"failed");
    assert!(failed.get("exitCode").is_none());
    assert_eq!(failed["sessionIds"],json!([]));
    runtime.shutdown();
}

fn setup_test_db() -> (tempfile::TempDir, Arc<Database>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    crate::workspace_services::initialize(&db).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    crate::retry_scheduler::initialize(&db).unwrap();
    (root, db)
}

fn setup_project(db: &Database, root: &Path, operation: &str) -> String {
    db.add_project(&root.to_string_lossy(), Some("Setup tests"), operation)
        .unwrap()
        .id
}

fn setup_service(root: &Path, db: Arc<Database>) -> crate::service::RuntimeService {
    crate::service::RuntimeService::new(
        crate::config::RuntimeConfig {
            data_dir: root.to_owned(),
            database_path: root.join("runtime.sqlite"),
            credential_path: root.join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-setup-test".into(),
        },
        db,
    )
}

fn setup_rpc(method: &str, params: serde_json::Value, id: &str) -> crate::domain::RpcRequest {
    crate::domain::RpcRequest { v: 1, id: id.into(), method: method.into(), params }
}

fn save_command(
    runtime: &crate::service::RuntimeService,
    project_id: &str,
    name: &str,
    command: &str,
    kind: &str,
    operation: &str,
) -> serde_json::Value {
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.save", json!({
        "projectId":project_id,"name":name,"command":command,"shell":"cmd",
        "cwd":"","kind":kind,"env":[],"operationId":operation
    }), operation)).unwrap()
}

fn save_setup(
    runtime: &crate::service::RuntimeService,
    project_id: &str,
    ids: &[String],
    revision: i64,
    operation: &str,
) -> serde_json::Value {
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.save", json!({
        "projectId":project_id,"commandIds":ids,"expectedRevision":revision,"operationId":operation
    }), operation)).unwrap()
}

fn setup_status(runtime: &crate::service::RuntimeService, project_id: &str) -> Vec<serde_json::Value> {
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.status", json!({"projectId":project_id}), "setup-status"))
        .unwrap().as_array().unwrap().clone()
}

fn wait_setup_state(runtime: &crate::service::RuntimeService, project_id: &str, state: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let status = setup_status(runtime, project_id);
        if let Some(run) = status.into_iter().find(|run| run["state"] == state) { return run; }
        assert!(Instant::now() < deadline, "setup never reached {state}");
        thread::sleep(Duration::from_millis(25));
    }
}

fn register_worktree(db: &Database, project_id: &str, path: &Path, id: &str) {
    std::fs::create_dir_all(path).unwrap();
    db.transaction(|tx| {
        tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,?,?,0,0)",
            rusqlite::params![id, project_id, path.to_string_lossy(), id, "head"])?;
        Ok(())
    }).unwrap();
}

#[test]
fn setup_save_validates_unknown_non_task_duplicates_limit_and_revision() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-validation-project");
    let other_root = root.path().join("other-project");
    std::fs::create_dir(&other_root).unwrap();
    let other = setup_project(&db, &other_root, "setup-validation-other");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let task = save_command(&runtime, &project, "task", "exit /b 0", "task", "setup-validation-task");
    let service = save_command(&runtime, &project, "service", "exit /b 0", "service", "setup-validation-service");
    let foreign = save_command(&runtime, &other, "foreign", "exit /b 0", "task", "setup-validation-foreign");
    let id = task["id"].as_str().unwrap().to_owned();
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.read", json!({"projectId":project}), "setup-pristine-read")).unwrap(), json!({"projectId":project,"revision":0,"commandIds":[]}));
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.save", json!({"projectId":project,"commandIds":["missing"],"expectedRevision":0,"operationId":"setup-missing"}), "setup-missing")).unwrap_err().code, "command_not_found");
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.save", json!({"projectId":project,"commandIds":[foreign["id"]],"expectedRevision":0,"operationId":"setup-foreign"}), "setup-foreign")).unwrap_err().code, "command_not_found");
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.save", json!({"projectId":project,"commandIds":[service["id"]],"expectedRevision":0,"operationId":"setup-service"}), "setup-service")).unwrap_err().code, "not_a_task");
    assert!(validate("quickLaunch.setup.save", &json!({"projectId":project,"commandIds":[id,id],"expectedRevision":0,"operationId":"setup-duplicate"})).is_err());
    assert!(validate("quickLaunch.setup.save", &json!({"projectId":project,"commandIds":vec!["x";21],"expectedRevision":0,"operationId":"setup-limit"})).is_err());
    let saved = save_setup(&runtime, &project, &[task["id"].as_str().unwrap().to_owned()], 0, "setup-good");
    assert_eq!(saved["revision"], 1);
    assert_eq!(save_setup(&runtime, &project, &[task["id"].as_str().unwrap().to_owned()], 0, "setup-good"), saved, "setup saves are operation-idempotent");
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.save", json!({"projectId":project,"commandIds":[],"expectedRevision":0,"operationId":"setup-stale"}), "setup-stale")).unwrap_err().code, "revision_conflict");
    let many: Vec<_> = (0..20).map(|index| save_command(&runtime, &project, &format!("many-{index}"), "exit /b 0", "task", &format!("setup-many-{index}"))["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(save_setup(&runtime, &project, &many, 1, "setup-twenty")["commandIds"].as_array().unwrap().len(), 20);
    runtime.shutdown();
}

#[test]
fn setup_delete_removes_saved_command_and_bumps_revision() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-delete-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let first = save_command(&runtime, &project, "first", "exit /b 0", "task", "setup-delete-first");
    let second = save_command(&runtime, &project, "second", "exit /b 0", "task", "setup-delete-second");
    save_setup(&runtime, &project, &[first["id"].as_str().unwrap().into(), second["id"].as_str().unwrap().into()], 0, "setup-delete-save");
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.delete", json!({"id":first["id"],"expectedRevision":1,"operationId":"setup-delete-command"}), "setup-delete-command")).unwrap();
    let saved = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.read", json!({"projectId":project}), "setup-delete-read")).unwrap();
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["commandIds"], json!([second["id"]]));
    runtime.shutdown();
}

#[test]
fn setup_run_reports_empty_and_retry_without_a_prior_sequence() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-empty-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    for (from_step, operation, code) in [(None, "setup-empty-run", "setup_empty"), (Some(0), "setup-no-prior-retry", "invalid_step")] {
        let mut params = json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":operation});
        if let Some(from_step) = from_step { params["fromStep"] = json!(from_step); }
        assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", params, operation)).unwrap_err().code, code);
    }
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn setup_runs_real_commands_one_at_a_time_and_projects_step_metadata() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-chain-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let commands: Vec<_> = (0..3).map(|step| save_command(&runtime, &project, &format!("step-{step}"), &format!("echo step-{step}>> setup-order.txt"), "task", &format!("setup-chain-save-{step}"))["id"].as_str().unwrap().to_owned()).collect();
    save_setup(&runtime, &project, &commands, 0, "setup-chain-configure");
    let started = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-chain-run"}), "setup-chain-run")).unwrap();
    let session = started["sessionIds"][0].as_str().unwrap();
    let run = db.session_by_id(session).unwrap().unwrap().run.unwrap();
    assert_eq!(run.setup.as_ref().unwrap().step, 0);
    assert_eq!(run.setup.as_ref().unwrap().total, 3);
    let completed = wait_setup_state(&runtime, &project, "completed");
    assert_eq!(completed["step"], 2);
    assert_eq!(completed["sessionIds"].as_array().unwrap().len(), 3);
    assert_eq!(std::fs::read_to_string(root.path().join("setup-order.txt")).unwrap().replace("\r\n", "\n"), "step-0\nstep-1\nstep-2\n");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn setup_failure_retry_uses_snapshot_and_stop_cancels() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-retry-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let first = save_command(&runtime, &project, "first", "echo first>> retry-order.txt", "task", "setup-retry-first");
    let failing = save_command(&runtime, &project, "failing", "if exist allow-step2 (echo second>> retry-order.txt) else (exit /b 3)", "task", "setup-retry-failing");
    let last = save_command(&runtime, &project, "last", "echo third>> retry-order.txt", "task", "setup-retry-last");
    save_setup(&runtime, &project, &[first["id"].as_str().unwrap().into(), failing["id"].as_str().unwrap().into(), last["id"].as_str().unwrap().into()], 0, "setup-retry-configure");
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-retry-run"}), "setup-retry-run")).unwrap();
    let failed = wait_setup_state(&runtime, &project, "failed");
    assert_eq!(failed["step"], 1);
    assert_eq!(failed["exitCode"], 3);
    // Retry must use the original snapshots even after its saved command and
    // the saved setup list disappear.
    let edited = runtime.dispatch("setup-test", setup_rpc("quickLaunch.save", json!({
        "projectId":project,"id":failing["id"],"expectedRevision":1,"name":"renamed",
        "command":"exit /b 8","shell":"cmd","cwd":"","kind":"task","env":[],"operationId":"setup-retry-edit"
    }), "setup-retry-edit")).unwrap();
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.delete", json!({"id":edited["id"],"expectedRevision":2,"operationId":"setup-retry-delete"}), "setup-retry-delete")).unwrap();
    std::fs::write(root.path().join("allow-step2"), "yes").unwrap();
    let retried = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"fromStep":1,"operationId":"setup-retry-from-failure"}), "setup-retry-from-failure")).unwrap();
    assert_eq!(retried["trigger"], "retry");
    let completed = wait_setup_state(&runtime, &project, "completed");
    assert_eq!(completed["sessionIds"].as_array().unwrap().len(), 3);
    assert_eq!(std::fs::read_to_string(root.path().join("retry-order.txt")).unwrap().replace("\r\n", "\n"), "first\nsecond\nthird\n");
    assert_eq!(runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"fromStep":3,"operationId":"setup-invalid-step"}), "setup-invalid-step")).unwrap_err().code, "invalid_step");
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-cancel-command");
    let revision = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.read", json!({"projectId":project}), "setup-cancel-read")).unwrap()["revision"].as_i64().unwrap();
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into()], revision, "setup-cancel-configure");
    let active = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-cancel-run"}), "setup-cancel-run")).unwrap();
    let session = active["sessionIds"][0].as_str().unwrap();
    runtime.dispatch("setup-test", setup_rpc("session.stop", json!({"sessionId":session,"operationId":"setup-cancel-stop","force":true}), "setup-cancel-stop")).unwrap();
    wait_setup_state(&runtime, &project, "cancelled");
    // A launch-time error fails the sequence at its attempted step without an
    // invented process exit code.
    let bad = runtime.dispatch("setup-test", setup_rpc("quickLaunch.save", json!({
        "projectId":project,"name":"missing cwd","command":"exit /b 0","shell":"cmd",
        "cwd":"does-not-exist","kind":"task","env":[],"operationId":"setup-launch-failure-command"
    }), "setup-launch-failure-command")).unwrap();
    let revision = runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.read", json!({"projectId":project}), "setup-launch-failure-read")).unwrap()["revision"].as_i64().unwrap();
    save_setup(&runtime, &project, &[bad["id"].as_str().unwrap().into()], revision, "setup-launch-failure-configure");
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-launch-failure-run"}), "setup-launch-failure-run")).unwrap();
    let launch_failed = wait_setup_state(&runtime, &project, "failed");
    assert!(launch_failed.get("exitCode").is_none() || launch_failed["exitCode"].is_null());
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn setup_hooks_start_once_per_worktree_and_interruption_never_resumes() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-hook-project");
    let worktree = root.path().join("created-worktree");
    let replayed_without_setup = root.path().join("replayed-without-setup");
    register_worktree(&db, &project, &worktree, "created-worktree");
    register_worktree(&db, &project, &replayed_without_setup, "replayed-without-setup");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    // A successful worktree.create with no configured list is still consumed.
    // Replaying that operation after setup is enabled must not retroactively run it.
    setup_after_worktree_create(&db, &pty, &json!({"projectId":project,"path":replayed_without_setup.to_string_lossy()}));
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-hook-command");
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into()], 0, "setup-hook-configure");
    setup_after_worktree_create(&db, &pty, &json!({"projectId":project,"path":replayed_without_setup.to_string_lossy()}));
    assert!(setup_status(&runtime, &project).is_empty(), "a replay after enabling setup must remain a no-op");
    setup_after_worktree_create(&db, &pty, &json!({"projectId":project,"path":worktree.to_string_lossy()}));
    setup_after_worktree_create(&db, &pty, &json!({"projectId":project,"path":worktree.to_string_lossy()}));
    let running = wait_setup_state(&runtime, &project, "running");
    assert_eq!(running["trigger"], "worktree.create");
    assert_eq!(setup_status(&runtime, &project).len(), 1, "replayed worktree hook must not create a second sequence");
    mark_setup_runs_interrupted(&db).unwrap();
    let interrupted = wait_setup_state(&runtime, &project, "interrupted");
    thread::sleep(Duration::from_millis(150));
    assert_eq!(setup_status(&runtime, &project)[0]["id"], interrupted["id"]);
    let session = running["sessionIds"][0].as_str().unwrap();
    let _ = pty.stop(&db, session, true);
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn setup_never_admits_two_active_sequences_in_one_root() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-admission-project");
    let runtime = Arc::new(setup_service(root.path(), Arc::clone(&db)));
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-admission-command");
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into()], 0, "setup-admission-configure");
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut starts = Vec::new();
    for operation in ["setup-admission-first", "setup-admission-second"] {
        let runtime = Arc::clone(&runtime);
        let project = project.clone();
        let cwd = root.path().to_string_lossy().to_string();
        let barrier = Arc::clone(&barrier);
        starts.push(thread::spawn(move || {
            barrier.wait();
            runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":cwd,"operationId":operation}), operation)).unwrap()
        }));
    }
    barrier.wait();
    let first = starts.remove(0).join().unwrap();
    let second = starts.remove(0).join().unwrap();
    assert_eq!(first["id"], second["id"]);
    assert_eq!(setup_status(&runtime, &project).len(), 1);
    runtime.dispatch("setup-test", setup_rpc("session.stop", json!({"sessionId":first["sessionIds"][0],"operationId":"setup-admission-stop","force":true}), "setup-admission-stop")).unwrap();
    wait_setup_state(&runtime, &project, "cancelled");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn runtime_shutdown_interrupts_setup_without_resuming_later_steps() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-shutdown-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-shutdown-slow");
    let next = save_command(&runtime, &project, "next", "echo resumed> must-not-exist.txt", "task", "setup-shutdown-next");
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into(), next["id"].as_str().unwrap().into()], 0, "setup-shutdown-configure");
    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-shutdown-run"}), "setup-shutdown-run")).unwrap();
    wait_setup_state(&runtime, &project, "running");
    runtime.shutdown();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let state: String = db.transaction(|tx| Ok(tx.query_row("SELECT state FROM quick_launch_setup_runs ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0))?)).unwrap();
        if state == "interrupted" { break; }
        assert!(Instant::now() < deadline, "shutdown did not interrupt the setup sequence: {state}");
        thread::sleep(Duration::from_millis(25));
    }
    thread::sleep(Duration::from_millis(150));
    assert!(!root.path().join("must-not-exist.txt").exists());
}

#[cfg(windows)]
#[test]
fn worktree_create_dispatch_replays_setup_hook_without_starting_twice() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-worktree-dispatch-project");
    for args in [vec!["init"], vec!["-c", "user.name=Setup Test", "-c", "user.email=setup@test.invalid", "commit", "--allow-empty", "-m", "initial"]] {
        assert!(std::process::Command::new("git").args(args).current_dir(root.path()).status().unwrap().success());
    }
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-worktree-dispatch-command");
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into()], 0, "setup-worktree-dispatch-configure");
    let target = root.path().join("created-worktree");
    let params = json!({"projectId":project,"path":target.to_string_lossy(),"branch":"setup-test-branch","createBranch":true,"operationId":"setup-worktree-dispatch-create"});
    let created = runtime.dispatch("setup-test", setup_rpc("worktree.create", params.clone(), "setup-worktree-dispatch-create")).unwrap();
    assert_eq!(created["path"], target.canonicalize().unwrap().to_string_lossy().to_string());
    let running = wait_setup_state(&runtime, &project, "running");
    assert_eq!(running["trigger"], "worktree.create");
    let replay = runtime.dispatch("setup-test", setup_rpc("worktree.create", params, "setup-worktree-dispatch-create")).unwrap();
    assert_eq!(replay, created);
    assert_eq!(setup_status(&runtime, &project).len(), 1);
    runtime.dispatch("setup-test", setup_rpc("session.stop", json!({"sessionId":running["sessionIds"][0],"operationId":"setup-worktree-dispatch-stop","force":true}), "setup-worktree-dispatch-stop")).unwrap();
    wait_setup_state(&runtime, &project, "cancelled");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn delegate_worktree_creation_starts_the_same_setup_hook() {
    let (root, db) = setup_test_db();
    let repo = root.path().join("delegate-repo");
    std::fs::create_dir(&repo).unwrap();
    let project = setup_project(&db, &repo, "setup-delegate-project");
    for args in [vec!["init"], vec!["-c", "user.name=Setup Test", "-c", "user.email=setup@test.invalid", "commit", "--allow-empty", "-m", "initial"]] {
        assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
    }
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let slow = save_command(&runtime, &project, "slow", "ping -n 30 127.0.0.1 > nul", "task", "setup-delegate-command");
    save_setup(&runtime, &project, &[slow["id"].as_str().unwrap().into()], 0, "setup-delegate-configure");
    let parent = db.create_session(crate::db::CreateSession { project_id: Some(&project), title: Some("parent"), provider: "codex", mode: "chat", native_id: None, operation_id: "setup-delegate-parent" }).unwrap();
    db.transaction(|tx| {
        tx.execute("UPDATE sessions SET worktree_path=? WHERE id=?", rusqlite::params![repo.to_string_lossy(), parent.id])?;
        Ok(())
    }).unwrap();
    let parent = db.session_by_id(&parent.id).unwrap().unwrap();
    let (path, _) = crate::delegation::create_worktree(&db, &parent, &repo.to_string_lossy(), "codex", "setup", "setup-delegate").unwrap();
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    setup_after_worktree_create(&db, &pty, &json!({"projectId":project,"path":path}));
    let running = wait_setup_state(&runtime, &project, "running");
    assert_eq!(running["trigger"], "worktree.create");
    let session = running["sessionIds"][0].as_str().unwrap();
    let _ = pty.stop(&db, session, true);
    wait_setup_state(&runtime, &project, "cancelled");
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn completed_setup_steps_do_not_add_inbox_items() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-quiet-inbox-completed-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let first = save_command(&runtime, &project, "first", "exit /b 0", "task", "setup-quiet-inbox-completed-first");
    let second = save_command(&runtime, &project, "second", "exit /b 0", "task", "setup-quiet-inbox-completed-second");
    save_setup(&runtime, &project, &[first["id"].as_str().unwrap().into(), second["id"].as_str().unwrap().into()], 0, "setup-quiet-inbox-completed-configure");

    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-quiet-inbox-completed-run"}), "setup-quiet-inbox-completed-run")).unwrap();
    let completed = wait_setup_state(&runtime, &project, "completed");
    assert_eq!(completed["sessionIds"].as_array().unwrap().len(), 2);
    for session_id in completed["sessionIds"].as_array().unwrap() {
        let count: i64 = db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM inbox WHERE session_id=?", [session_id.as_str().unwrap()], |row| row.get(0))?)).unwrap();
        assert_eq!(count, 0, "completed setup step must not add an Inbox item");
    }
    runtime.shutdown();
}

#[cfg(windows)]
#[test]
fn failed_setup_step_adds_only_its_failed_inbox_item() {
    let (root, db) = setup_test_db();
    let project = setup_project(&db, root.path(), "setup-quiet-inbox-failed-project");
    let runtime = setup_service(root.path(), Arc::clone(&db));
    let first = save_command(&runtime, &project, "first", "exit /b 0", "task", "setup-quiet-inbox-failed-first");
    let second = save_command(&runtime, &project, "second", "exit /b 7", "task", "setup-quiet-inbox-failed-second");
    save_setup(&runtime, &project, &[first["id"].as_str().unwrap().into(), second["id"].as_str().unwrap().into()], 0, "setup-quiet-inbox-failed-configure");

    runtime.dispatch("setup-test", setup_rpc("quickLaunch.setup.run", json!({"projectId":project,"cwd":root.path().to_string_lossy(),"operationId":"setup-quiet-inbox-failed-run"}), "setup-quiet-inbox-failed-run")).unwrap();
    let failed = wait_setup_state(&runtime, &project, "failed");
    let sessions = failed["sessionIds"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let inbox: Vec<(String, String)> = db.transaction(|tx| {
        let mut statement = tx.prepare("SELECT session_id,kind FROM inbox WHERE session_id IN (?,?)")?;
        let rows = statement.query_map([sessions[0].as_str().unwrap(), sessions[1].as_str().unwrap()], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0], (sessions[1].as_str().unwrap().to_owned(), "failed".to_owned()));
    runtime.shutdown();
}
