//! Review regressions for durable request bindings, admission fencing and reruns.
use super::*;
use std::{sync::mpsc, thread};

struct Fixture {
    root: tempfile::TempDir,
    db: Arc<Database>,
    pty: PtyManager,
    project: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let project = db.add_project(&root.path().to_string_lossy(),Some("Review"),"review-project").unwrap().id;
        let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
        Self { root,db,pty,project }
    }
    fn command(&self, name: &str, text: &str, depends: &[String]) -> QuickLaunchCommand {
        let value = super::super::dispatch(&self.db,&self.pty,"quickLaunch.save",&json!({
            "projectId":self.project,"name":name,"command":text,"shell":"cmd","cwd":"","kind":"task",
            "env":[],"dependsOn":depends,"operationId":format!("save-{name}")
        })).unwrap();
        serde_json::from_value(value).unwrap()
    }
    fn root(&self) -> String { self.root.path().canonicalize().unwrap().to_string_lossy().into_owned() }
}
impl Drop for Fixture {
    fn drop(&mut self) { self.pty.terminate_all(&self.db); }
}
fn until(mut ready: impl FnMut()->bool) {
    let deadline = Instant::now()+Duration::from_secs(12);
    while !ready() {
        assert!(Instant::now()<deadline,"review fixture timed out");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn dependency_reservation_rejects_an_operation_owned_by_another_method_before_launch() {
    let fixture = Fixture::new();
    let dependency = fixture.command("prepare","echo dependency> collision.txt",&[]);
    let target = fixture.command("target","echo target> collision.txt",&[dependency.id.clone()]);
    fixture.db.transaction(|tx|complete(tx,"collision","quickLaunch.save",&Value::Null)).unwrap();
    let error = run_dependencies(&fixture.db,&fixture.pty,&target,&fixture.root(),"collision","quickLaunch.run",None,None).unwrap_err();
    assert_eq!(error.to_string(),"invalid_request");
    let counts: (i64,i64,i64) = fixture.db.transaction(|tx|Ok(tx.query_row(
        "SELECT (SELECT COUNT(*) FROM quick_launch_setup_runs),(SELECT COUNT(*) FROM quick_launch_sequence_operations),(SELECT COUNT(*) FROM sessions)",[],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)).unwrap();
    assert_eq!(counts,(0,0,0));
    assert!(!fixture.root.path().join("collision.txt").exists());
}

#[test]
fn interrupted_reservation_without_a_session_never_restarts_its_dependencies() {
    let fixture = Fixture::new();
    let dependency = fixture.command("prepare","echo dependency> unlaunched.txt",&[]);
    let target = fixture.command("target","echo target> unlaunched.txt",&[dependency.id.clone()]);
    let guard = ADMISSION.lock().unwrap();
    let (id,_) = fixture.db.transaction(|tx|reserve_dependencies(tx,&target,&fixture.root(),"unlaunched","quickLaunch.run",None,None)).unwrap();
    fixture.db.transaction(|tx|{tx.execute("UPDATE quick_launch_setup_runs SET state='interrupted' WHERE id=?",[&id])?;Ok(())}).unwrap();
    drop(guard);
    let error = run_dependencies(&fixture.db,&fixture.pty,&target,&fixture.root(),"unlaunched","quickLaunch.run",None,None).unwrap_err();
    assert_eq!(error.to_string(),"dependency_failed: prepare");
    assert_eq!(fixture.db.transaction(|tx|dependency_binding(tx,"unlaunched","quickLaunch.run")).unwrap().as_deref(),Some(id.as_str()));
    assert!(fixture.db.snapshot().unwrap().sessions.is_empty());
    assert!(!fixture.root.path().join("unlaunched.txt").exists());
}

#[cfg(windows)]
#[test]
fn interrupted_caller_replays_bound_sequence_without_repeating_dependency_side_effects() {
    for method in ["quickLaunch.run","chat.tool.run.start"] {
        let fixture = Fixture::new();
        let dependency = fixture.command("prepare","echo dependency>> effects.txt",&[]);
        let target = fixture.command("target","echo target>> effects.txt",&[dependency.id.clone()]);
        let root = fixture.root();
        let guard = ADMISSION.lock().unwrap();
        let (id,created) = fixture.db.transaction(|tx|reserve_dependencies(tx,&target,&root,"crashed-request",method,None,None)).unwrap();
        let binding_before_launch = fixture.db.transaction(|tx|dependency_binding(tx,"crashed-request",method)).unwrap();
        let launched = start_step_locked(&fixture.db,&fixture.pty,&id).unwrap().unwrap();
        until(|| fixture.db.session_by_id(launched["session"]["id"].as_str().unwrap()).unwrap()
            .is_some_and(|session|session.status=="exited"));
        // Model loss of the process after the external effect but before the
        // caller result was recorded. Admission keeps the continuation queued.
        fixture.db.transaction(|tx| {
            tx.execute("UPDATE quick_launch_setup_runs SET state='interrupted' WHERE id=?",[&id])?;
            Ok(())
        }).unwrap();
        drop(guard);
        assert!(created);
        assert_eq!(binding_before_launch.as_deref(),Some(id.as_str()));
        assert!(fixture.db.operation("crashed-request").unwrap().is_none());
        let reopened = Arc::new(Database::open(&fixture.root.path().join("runtime.sqlite")).unwrap());
        let replay = run_dependencies(&reopened,&fixture.pty,&target,&root,"crashed-request",method,None,None).unwrap();
        assert_eq!(replay["sequenceId"],id);
        assert_eq!(replay["sequence"]["state"],"interrupted");
        assert_eq!(replay["session"]["id"],launched["session"]["id"]);
        assert_eq!(std::fs::read_to_string(fixture.root.path().join("effects.txt")).unwrap().trim(),"dependency");
        let sequences: i64 = reopened.transaction(|tx|Ok(tx.query_row("SELECT COUNT(*) FROM quick_launch_setup_runs",[],|row|row.get(0))?)).unwrap();
        assert_eq!(sequences,1);
    }
}

#[cfg(windows)]
#[test]
fn both_cancellation_paths_fence_inflight_target_admission_and_queued_continuations() {
    for scoped in [false,true] {
        let fixture = Fixture::new();
        let dependency = fixture.command("prepare","exit /b 0",&[]);
        let target = fixture.command("target","echo target> admitted.txt",&[dependency.id.clone()]);
        let root = fixture.root();
        let guard = ADMISSION.lock().unwrap();
        let (id,_) = fixture.db.transaction(|tx|reserve_dependencies(tx,&target,&root,"admitting","quickLaunch.run",None,None)).unwrap();
        fixture.db.transaction(|tx|{tx.execute("UPDATE quick_launch_setup_runs SET step=1 WHERE id=?",[&id])?;Ok(())}).unwrap();
        let (entered_tx,entered_rx) = mpsc::channel();
        let (done_tx,done_rx) = mpsc::channel();
        let db = Arc::clone(&fixture.db);
        let project = fixture.project.clone();
        let cancel_root = root.clone();
        let cancel_id = id.clone();
        let worker = thread::spawn(move || {
            entered_tx.send(()).unwrap();
            let result = if scoped { cancel_scoped_sequence(&db,&cancel_id,&project,&cancel_root).map(Option::unwrap) }
                else { cancel_sequence(&db,SequenceCancel{id:cancel_id,operation_id:"cancel-admitting".into()}) };
            done_tx.send(result).unwrap();
        });
        entered_rx.recv().unwrap();
        let returned_before_launch_finished = done_rx.recv_timeout(Duration::from_millis(100)).ok();
        // Complete the in-flight target admission before releasing its fence.
        let launched = start_step_locked(&fixture.db,&fixture.pty,&id).unwrap();
        drop(guard);
        assert!(returned_before_launch_finished.is_none(),"cancel returned while target launch still held admission");
        let result = done_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        worker.join().unwrap();
        assert!(launched.is_some());
        assert_eq!(result["state"],"completed","must not falsely report cancellation of an admitted target");

        let guard = ADMISSION.lock().unwrap();
        let (queued,_) = fixture.db.transaction(|tx|reserve_dependencies(tx,&target,&root,"queued","quickLaunch.run",None,None)).unwrap();
        drop(guard);
        let result = if scoped { cancel_scoped_sequence(&fixture.db,&queued,&fixture.project,&root).unwrap().unwrap() }
            else { cancel_sequence(&fixture.db,SequenceCancel{id:queued.clone(),operation_id:"cancel-queued".into()}).unwrap() };
        assert_eq!(result["state"],"cancelled");
        let guard = ADMISSION.lock().unwrap();
        let continuation = start_step_locked(&fixture.db,&fixture.pty,&queued).unwrap();
        drop(guard);
        assert!(continuation.is_none());
        assert!(fixture.db.transaction(|tx|read_run(tx,&queued)).unwrap().session_ids.is_empty());
    }
}

#[cfg(windows)]
#[test]
fn terminal_rerun_satisfies_snapshot_dependencies_and_returns_the_target_session() {
    let fixture = Fixture::new();
    let dependency = fixture.command("prepare","echo dependency>> order.txt & ping -n 2 127.0.0.1 > nul",&[]);
    let target = fixture.command("target","echo target>> order.txt",&[dependency.id.clone()]);
    let started = run_dependencies(&fixture.db,&fixture.pty,&target,&fixture.root(),"initial","quickLaunch.run",None,None).unwrap();
    let sequence = started["sequenceId"].as_str().unwrap();
    until(|| fixture.db.transaction(|tx|read_run(tx,sequence)).unwrap().state=="completed");
    let original = fixture.db.transaction(|tx|read_run(tx,sequence)).unwrap().session_ids.last().unwrap().clone();
    until(|| fixture.db.session_by_id(&original).unwrap().unwrap().status=="exited");
    fixture.db.transaction(|tx|complete(tx,"rerun-collision","quickLaunch.save",&Value::Null)).unwrap();
    let collision = super::super::rerun(&fixture.db,&fixture.pty,&json!({"sessionId":original,"operationId":"rerun-collision"})).unwrap_err();
    assert_eq!(collision.to_string(),"invalid_request");
    std::fs::write(fixture.root.path().join("order.txt"),"").unwrap();
    // Run again is defined by the immutable source snapshot, including its edges.
    super::super::dispatch(&fixture.db,&fixture.pty,"quickLaunch.save",&json!({
        "id":target.id,"projectId":fixture.project,"expectedRevision":1,"name":"target",
        "command":"echo edited>> order.txt","shell":"cmd","cwd":"","kind":"task","env":[],"dependsOn":[],"operationId":"edit-target"
    })).unwrap();
    let params = json!({"sessionId":original,"operationId":"terminal-run-again"});
    let result = super::super::rerun(&fixture.db,&fixture.pty,&params).unwrap().unwrap();
    assert!(result.get("session").is_none());
    assert!(result["id"].as_str().is_some());
    assert_eq!(result["run"]["commandId"],target.id);
    assert_ne!(result["id"],original);
    until(|| std::fs::read_to_string(fixture.root.path().join("order.txt")).unwrap().contains("target"));
    let order = std::fs::read_to_string(fixture.root.path().join("order.txt")).unwrap();
    assert_eq!(order.lines().map(str::trim).collect::<Vec<_>>(),vec!["dependency","target"]);
    let source: String = fixture.db.transaction(|tx|Ok(tx.query_row("SELECT source_session_id FROM session_launch_configs WHERE session_id=?",[result["id"].as_str().unwrap()],|row|row.get(0))?)).unwrap();
    assert_eq!(source,original);
    let replay = super::super::rerun(&fixture.db,&fixture.pty,&params).unwrap().unwrap();
    assert_eq!(replay,result);
}
