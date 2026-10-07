//! Durable, event-driven sequences built on Quick Launch's existing admission path.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupStep {
    pub run_id: String,
    pub step: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRun {
    id: String,
    project_id: String,
    root: String,
    command_ids: Vec<String>,
    names: Vec<String>,
    step: usize,
    state: String,
    session_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    trigger: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupSave {
    project_id: String,
    command_ids: Vec<String>,
    expected_revision: i64,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupStart {
    project_id: String,
    cwd: String,
    from_step: Option<usize>,
    operation_id: String,
}

pub(super) fn decode_snapshot(raw: &str) -> serde_json::Result<(QuickLaunchCommand, Option<SetupStep>)> {
    let mut value: Value = serde_json::from_str(raw)?;
    let step = value.as_object_mut().and_then(|object| object.remove("setup"))
        .map(serde_json::from_value).transpose()?;
    Ok((serde_json::from_value(value)?, step))
}

pub(super) fn validate_setup(method: &str, value: &Value) -> Result<()> {
    match method {
        "quickLaunch.setup.read" | "quickLaunch.setup.status" => {
            let p: List = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
        }
        "quickLaunch.setup.save" => {
            let p: SetupSave = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.operation_id)?;
            let mut unique = HashSet::new();
            if !(0..MAX_SAFE_INTEGER).contains(&p.expected_revision) || p.command_ids.len() > 20
                || p.command_ids.iter().any(|id| id.is_empty() || !unique.insert(id)) {
                return Err(anyhow!("invalid_request"));
            }
        }
        "quickLaunch.setup.run" => {
            if value.get("fromStep").is_some_and(Value::is_null) { return Err(anyhow!("invalid_request")); }
            let p: SetupStart = serde_json::from_value(value.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
            required(&p.operation_id)?;
            if p.from_step.is_some_and(|step| step > 19) { return Err(anyhow!("invalid_step")); }
        }
        _ => return Err(anyhow!("unknown_method")),
    }
    Ok(())
}

fn setup_changed(tx: &Transaction<'_>, project: &str) -> Result<()> {
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![json!({"kind":"quickLaunch.setup","projectId":project}).to_string(), Utc::now().to_rfc3339()])?;
    Ok(())
}

fn read_setup(tx: &Transaction<'_>, project: &str) -> Result<Value> {
    let saved: Option<(i64, String)> = tx.query_row(
        "SELECT revision,command_ids_json FROM quick_launch_setup WHERE project_id=?", [project],
        |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (revision, command_ids) = match saved {
        Some((revision, raw)) => (revision, serde_json::from_str::<Vec<String>>(&raw)?),
        None => (0, Vec::new()),
    };
    Ok(json!({"projectId":project,"revision":revision,"commandIds":command_ids}))
}

pub(super) fn remove_command(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let project: String = tx.query_row("SELECT project_id FROM quick_launch_commands WHERE id=?", [id], |r| r.get(0))?;
    let saved = read_setup(tx, &project)?;
    let mut ids: Vec<String> = serde_json::from_value(saved["commandIds"].clone())?;
    let len = ids.len();
    ids.retain(|item| item != id);
    if len != ids.len() {
        let revision = saved["revision"].as_i64().unwrap_or(0);
        if revision >= MAX_SAFE_INTEGER { return Err(anyhow!("invalid_request")); }
        tx.execute("UPDATE quick_launch_setup SET revision=revision+1,command_ids_json=? WHERE project_id=?",
            params![serde_json::to_string(&ids)?, project])?;
        setup_changed(tx, &project)?;
    }
    Ok(())
}

fn save_setup(db: &Database, p: SetupSave) -> Result<Value> {
    db.transaction(|tx| {
        if let Some(result) = operation_tx(tx, &p.operation_id)? { return Ok(result); }
        let previous = read_setup(tx, &p.project_id)?;
        if previous["revision"].as_i64() != Some(p.expected_revision) { return Err(anyhow!("revision_conflict")); }
        for id in &p.command_ids {
            let command = tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"),
                params![id,p.project_id], command_row).optional()?.ok_or_else(|| anyhow!("command_not_found"))?;
            if command.kind != "task" { return Err(anyhow!("not_a_task")); }
        }
        tx.execute("INSERT INTO quick_launch_setup(project_id,revision,command_ids_json) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,command_ids_json=excluded.command_ids_json",
            params![p.project_id,p.expected_revision+1,serde_json::to_string(&p.command_ids)?])?;
        let result = read_setup(tx, &p.project_id)?;
        complete(tx, &p.operation_id, "quickLaunch.setup.save", &result)?;
        setup_changed(tx, &p.project_id)?;
        Ok(result)
    })
}

const RUN_COLUMNS: &str = "id,project_id,root,command_ids_json,names_json,step,state,session_ids_json,exit_code,trigger,created_at,updated_at";
fn run_row(r: &Row<'_>) -> rusqlite::Result<SetupRun> {
    fn strings(r: &Row<'_>, column: usize) -> rusqlite::Result<Vec<String>> {
        serde_json::from_str(&r.get::<_, String>(column)?).map_err(|e|
            rusqlite::Error::FromSqlConversionFailure(column,rusqlite::types::Type::Text,Box::new(e)))
    }
    Ok(SetupRun { id:r.get(0)?, project_id:r.get(1)?, root:r.get(2)?, command_ids:strings(r,3)?,
        names:strings(r,4)?, step:r.get(5)?, state:r.get(6)?, session_ids:strings(r,7)?, exit_code:r.get(8)?,
        trigger:r.get(9)?, created_at:r.get(10)?, updated_at:r.get(11)? })
}
fn read_run(tx: &Transaction<'_>, id: &str) -> Result<SetupRun> {
    Ok(tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE id=?"), [id],run_row)?)
}
fn latest(tx: &Transaction<'_>, project: &str, root: &str) -> Result<Option<SetupRun>> {
    Ok(tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE project_id=? AND root=? ORDER BY created_at DESC,rowid DESC LIMIT 1"),
        params![project,root],run_row).optional()?)
}

pub(super) fn dispatch_setup(db: &Arc<Database>, pty: &PtyManager, method: &str, value: &Value) -> Result<Value> {
    match method {
        "quickLaunch.setup.read" => {
            let p: List = serde_json::from_value(value.clone())?;
            db.transaction(|tx| read_setup(tx, &p.project_id))
        }
        "quickLaunch.setup.save" => save_setup(db, serde_json::from_value(value.clone())?),
        "quickLaunch.setup.status" => {
            let p: List = serde_json::from_value(value.clone())?;
            db.transaction(|tx| {
                let mut stmt = tx.prepare(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs r WHERE project_id=? AND NOT EXISTS(SELECT 1 FROM quick_launch_setup_runs newer WHERE newer.project_id=r.project_id AND newer.root=r.root AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid))) ORDER BY root"))?;
                let runs = stmt.query_map([p.project_id],run_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(serde_json::to_value(runs)?)
            })
        }
        "quickLaunch.setup.run" => run_setup(db, pty, serde_json::from_value(value.clone())?, false),
        _ => Err(anyhow!("unknown_method")),
    }
}

pub(super) fn root_for_setup(db: &Database, project: &str, cwd: &str) -> Result<PathBuf> {
    if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() { return Err(anyhow!("cwd_missing")); }
    let root = crate::workspace_services::workspace_root_for_cwd(db, project, cwd).map_err(|error| match error.to_string().as_str() {
        "invalid_cwd" => anyhow!("cwd_missing"),
        "cwd_not_in_registered_project" | "selected_project_mismatch" => anyhow!("cwd_outside_root"),
        _ => error,
    })?;
    if Path::new(cwd).canonicalize().map_err(|_| anyhow!("cwd_missing"))? != root { return Err(anyhow!("cwd_outside_root")); }
    Ok(root)
}

fn run_setup(db: &Arc<Database>, pty: &PtyManager, p: SetupStart, automatic: bool) -> Result<Value> {
    let _guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
    if let Some(result) = db.operation(&p.operation_id)? { return Ok(result); }
    if automatic {
        // Consume the creation before any fallible preparation. A replay must
        // never retry an automatic side effect, including a failed preparation.
        db.transaction(|tx| complete(tx,&p.operation_id,"worktree.setup.auto",&Value::Null))?;
        let disabled = db.transaction(|tx| {
            let empty = read_setup(tx,&p.project_id)?["commandIds"].as_array().is_none_or(Vec::is_empty);
            Ok(empty)
        })?;
        if disabled { return Ok(Value::Null); }
    }
    let root = root_for_setup(db, &p.project_id, &p.cwd)?.to_string_lossy().into_owned();
    let reserved = db.transaction(|tx| {
        let previous = latest(tx, &p.project_id, &root)?;
        if let Some(run) = previous.as_ref().filter(|run| run.state == "running" || automatic) {
            let value = serde_json::to_value(run)?;
            if !automatic { complete(tx, &p.operation_id, "quickLaunch.setup.run", &value)?; }
            return Ok((run.id.clone(), false));
        }
        let (commands, step, session_ids) = if let Some(step) = p.from_step {
            let run = previous.ok_or_else(|| anyhow!("invalid_step"))?;
            if step >= run.command_ids.len() { return Err(anyhow!("invalid_step")); }
            let raw: String = tx.query_row("SELECT snapshots_json FROM quick_launch_setup_runs WHERE id=?", [&run.id], |r| r.get(0))?;
            let commands: Vec<QuickLaunchCommand> = serde_json::from_str(&raw)?;
            // Prefix sessions retain their step positions for Open terminal in a retry.
            let sessions = run.session_ids.into_iter().take(step).collect();
            (commands,step,sessions)
        } else {
            let saved = read_setup(tx, &p.project_id)?;
            let ids: Vec<String> = serde_json::from_value(saved["commandIds"].clone())?;
            if ids.is_empty() { return Err(anyhow!("setup_empty")); }
            let mut commands = Vec::new();
            for id in ids {
                let command = tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"), params![id,p.project_id], command_row)
                    .optional()?.ok_or_else(|| anyhow!("command_not_found"))?;
                commands.push(command);
            }
            (commands,0,Vec::new())
        };
        let now = Utc::now().to_rfc3339();
        let run = SetupRun { id:uuid::Uuid::new_v4().to_string(), project_id:p.project_id.clone(), root:root.clone(),
            command_ids:commands.iter().map(|c| c.id.clone()).collect(), names:commands.iter().map(|c| c.name.clone()).collect(),
            step, state:"running".into(), session_ids, exit_code:None,
            trigger:if automatic { "worktree.create" } else if p.from_step.is_some() { "retry" } else { "manual" }.into(),
            created_at:now.clone(), updated_at:now };
        tx.execute("INSERT INTO quick_launch_setup_runs(id,project_id,root,command_ids_json,names_json,snapshots_json,step,state,session_ids_json,exit_code,trigger,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running',?,NULL,?,?,?)",
            params![run.id,run.project_id,run.root,serde_json::to_string(&run.command_ids)?,serde_json::to_string(&run.names)?,serde_json::to_string(&commands)?,run.step,serde_json::to_string(&run.session_ids)?,run.trigger,run.created_at,run.updated_at])?;
        if !automatic { complete(tx, &p.operation_id, "quickLaunch.setup.run", &serde_json::to_value(&run)?)?; }
        setup_changed(tx, &run.project_id)?;
        Ok((run.id, true))
    })?;
    if reserved.1 {
        if let Err(error) = start_step_locked(db, pty, &reserved.0) {
            eprintln!("Worktree setup {} could not start: {error}",reserved.0);
            fail_step(db,&reserved.0)?;
        }
    }
    db.transaction(|tx| {
        let result = serde_json::to_value(read_run(tx,&reserved.0)?)?;
        if !automatic && reserved.1 {
            tx.execute("UPDATE operations SET result=? WHERE id=?",params![result.to_string(),p.operation_id])?;
        }
        Ok(result)
    })
}

pub(super) fn attach_session(tx: &Transaction<'_>, step: &SetupStep, session: &str) -> Result<()> {
    let mut run = read_run(tx, &step.run_id)?;
    if run.state != "running" || run.step != step.step { return Err(anyhow!("invalid_step")); }
    let raw: String = tx.query_row("SELECT snapshot_json FROM quick_launch_runs WHERE session_id=?",[session],|r|r.get(0))?;
    let mut snapshot: Value = serde_json::from_str(&raw)?;
    snapshot["setup"] = serde_json::to_value(step)?;
    tx.execute("UPDATE quick_launch_runs SET snapshot_json=? WHERE session_id=?",params![snapshot.to_string(),session])?;
    run.session_ids.push(session.to_owned());
    tx.execute("UPDATE quick_launch_setup_runs SET session_ids_json=?,updated_at=? WHERE id=?",params![serde_json::to_string(&run.session_ids)?,Utc::now().to_rfc3339(),run.id])?;
    changed(tx, "session.run",Some(session))?;
    setup_changed(tx,&run.project_id)
}

fn fail_step(db: &Database, id: &str) -> Result<()> {
    db.transaction(|tx| {
        let project: Option<String> = tx.query_row("SELECT project_id FROM quick_launch_setup_runs WHERE id=?",[id],|r|r.get(0)).optional()?;
        if tx.execute("UPDATE quick_launch_setup_runs SET state='failed',exit_code=NULL,updated_at=? WHERE id=? AND state='running'", params![Utc::now().to_rfc3339(),id])? != 0 {
            if let Some(project) = project { setup_changed(tx,&project)?; }
        }
        Ok(())
    })
}

fn start_step_locked(db: &Arc<Database>, pty: &PtyManager, id: &str) -> Result<()> {
    let (run, commands) = db.transaction(|tx| {
        let run = read_run(tx,id)?;
        let raw: String = tx.query_row("SELECT snapshots_json FROM quick_launch_setup_runs WHERE id=?",[id],|r|r.get(0))?;
        Ok((run,serde_json::from_str::<Vec<QuickLaunchCommand>>(&raw)?))
    })?;
    if run.state != "running" { return Ok(()); }
    if commands.get(run.step).is_none_or(|command| command.kind != "task") {
        fail_step(db,id)?;
        return Ok(());
    }
    let step = SetupStep {run_id:run.id.clone(),step:run.step,total:commands.len()};
    let result = start(db,pty,&commands[run.step],&run.root,&format!("setup:{}:{}",run.id,run.step),"quickLaunch.run",None,Some(&step));
    match result {
        Ok(value) => {
            let session = &value["session"];
            if session["status"] == "error" { fail_step(db,id)?; }
            // A reused task can exit before attachment; its earlier exit hook had no setup metadata.
            else if session["status"] == "exited" {
                if let Some(next) = setup_terminal_exited(db,session["id"].as_str().unwrap_or(""),session["exitCode"].as_i64().map(|n|n as i32),false)? {
                    start_next_setup_step(Arc::clone(db),pty.clone(),next);
                }
            }
        }
        Err(error) => {
            eprintln!("Worktree setup {id} step {} could not start: {error}",run.step);
            fail_step(db,id)?;
        }
    }
    Ok(())
}

/// One primary-key lookup for an ordinary terminal; sequences alone do further work.
/// Returns a continuation only after committing the transition, with no locks retained.
pub(crate) fn setup_terminal_exited(db: &Database, session: &str, code: Option<i32>, stopped: bool) -> Result<Option<String>> {
    db.transaction(|tx| {
        let source: Option<(Option<String>,bool)> = tx.query_row(
            "SELECT json_extract(snapshot_json,'$.setup'),stop_requested FROM quick_launch_runs WHERE session_id=?",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((Some(raw),stop_requested)) = source else { return Ok(None); };
        let step: SetupStep = serde_json::from_str(&raw)?;
        let run = read_run(tx,&step.run_id)?;
        if run.state != "running" || run.step != step.step || run.session_ids.last().map(String::as_str) != Some(session) { return Ok(None); }
        let (state,next_step,exit) = if stopped || stop_requested { ("cancelled",run.step,None) }
            else if code != Some(0) { ("failed",run.step,code) }
            else if run.step+1 == run.command_ids.len() { ("completed",run.step,None) }
            else { ("running",run.step+1,None) };
        tx.execute("UPDATE quick_launch_setup_runs SET state=?,step=?,exit_code=?,updated_at=? WHERE id=?",params![state,next_step,exit,Utc::now().to_rfc3339(),run.id])?;
        setup_changed(tx,&run.project_id)?;
        Ok((state == "running").then_some(run.id))
    })
}

pub(crate) fn start_next_setup_step(db: Arc<Database>, pty: PtyManager, id: String) {
    std::thread::spawn(move || {
        let result = (|| {
            let _guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
            start_step_locked(&db,&pty,&id)
        })();
        if let Err(error) = result {
            eprintln!("Worktree setup {id} could not advance: {error}");
            if let Err(failure) = fail_step(&db,&id) { eprintln!("Worktree setup {id} could not record failure: {failure}"); }
        }
    });
}

pub fn setup_after_worktree_create(db: &Arc<Database>, pty: &PtyManager, worktree: &Value) {
    let Some(project) = worktree.get("projectId").and_then(Value::as_str) else { return; };
    let Some(cwd) = worktree.get("path").and_then(Value::as_str) else { return; };
    let creation = worktree.get("id").and_then(Value::as_str).map(str::to_owned)
        .unwrap_or_else(|| Path::new(cwd).canonicalize().map(|path|path.to_string_lossy().into_owned()).unwrap_or_else(|_|cwd.to_owned()));
    // Remember even a creation with setup disabled: replaying that creation after
    // setup is enabled must never retroactively execute commands in its worktree.
    let result = (|| -> Result<()> {
        run_setup(db,pty,SetupStart {project_id:project.into(),cwd:cwd.into(),from_step:None,
            operation_id:format!("setup-worktree:{project}:{creation}")},true)?;
        Ok(())
    })();
    if let Err(error) = result { eprintln!("Automatic worktree setup for {cwd} failed: {error}"); }
}

pub fn mark_setup_runs_interrupted(db: &Database) -> Result<()> {
    // Fence both an in-flight launch and queued continuations before shutdown
    // enumerates PTYs. No setup can launch after this recovery/shutdown barrier.
    let _guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
    db.transaction(|tx| {
        // A crash can happen after worktree.create commits but before its hook.
        // Consume historical committed creations during recovery without ever
        // running their commands, including the delegate's canonical-root key.
        for field in ["id", "path"] {
            tx.execute(&format!("INSERT OR IGNORE INTO operations(id,method,result,created_at) SELECT 'setup-worktree:' || json_extract(result,'$.projectId') || ':' || json_extract(result,'$.{field}'), 'worktree.setup.auto', 'null', ? FROM operations WHERE method='worktree.create' AND json_valid(result) AND json_extract(result,'$.projectId') IS NOT NULL AND json_extract(result,'$.{field}') IS NOT NULL"),[Utc::now().to_rfc3339()])?;
        }
        let projects = {
            let mut stmt = tx.prepare("SELECT DISTINCT project_id FROM quick_launch_setup_runs WHERE state='running'")?;
            let rows = stmt.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        tx.execute("UPDATE quick_launch_setup_runs SET state='interrupted',updated_at=? WHERE state='running'",[Utc::now().to_rfc3339()])?;
        for project in projects { setup_changed(tx,&project)?; }
        Ok(())
    })
}
