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
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_command_id: Option<String>,
    #[serde(skip)]
    started_by: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SequenceCancel {
    id: String,
    operation_id: String,
}

pub(super) fn decode_snapshot(raw: &str) -> serde_json::Result<(QuickLaunchCommand, Option<SetupStep>, Option<SetupStep>)> {
    let mut value: Value = serde_json::from_str(raw)?;
    let step = value.as_object_mut().and_then(|object| object.remove("setup"))
        .map(serde_json::from_value).transpose()?;
    let sequence = value.as_object_mut().and_then(|object| object.remove("sequence"))
        .map(serde_json::from_value).transpose()?;
    Ok((serde_json::from_value(value)?, step, sequence))
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
        "quickLaunch.sequence.cancel" => {
            let p: SequenceCancel = serde_json::from_value(value.clone())?;
            required(&p.id)?;
            required(&p.operation_id)?;
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

const RUN_COLUMNS: &str = "id,project_id,root,command_ids_json,names_json,step,state,session_ids_json,exit_code,trigger,created_at,updated_at,target_command_id,started_by";
fn run_row(r: &Row<'_>) -> rusqlite::Result<SetupRun> {
    fn strings(r: &Row<'_>, column: usize) -> rusqlite::Result<Vec<String>> {
        serde_json::from_str(&r.get::<_, String>(column)?).map_err(|e|
            rusqlite::Error::FromSqlConversionFailure(column,rusqlite::types::Type::Text,Box::new(e)))
    }
    let mut run = SetupRun { id:r.get(0)?, project_id:r.get(1)?, root:r.get(2)?, command_ids:strings(r,3)?,
        names:strings(r,4)?, step:r.get(5)?, state:r.get(6)?, session_ids:strings(r,7)?, exit_code:r.get(8)?, error:None,
        trigger:r.get(9)?, created_at:r.get(10)?, updated_at:r.get(11)?, target_command_id:r.get(12)?, started_by:r.get(13)? };
    if run.trigger == "depends_on" && run.state == "failed" {
        run.error = Some(format!("dependency_failed: {}",run.names.get(run.step).map(String::as_str).unwrap_or("unknown")));
    }
    Ok(run)
}
fn read_run(tx: &Transaction<'_>, id: &str) -> Result<SetupRun> {
    Ok(tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE id=?"), [id],run_row)?)
}
fn latest_setup(tx: &Transaction<'_>, project: &str, root: &str) -> Result<Option<SetupRun>> {
    Ok(tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE project_id=? AND root=? AND target_command_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1"),
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
                // One latest setup row per root plus one latest dependency sequence per
                // target. A dependency launch must never hide setup's last-run state.
                let mut stmt = tx.prepare(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs r WHERE project_id=? AND NOT EXISTS(SELECT 1 FROM quick_launch_setup_runs newer WHERE newer.project_id=r.project_id AND newer.root=r.root AND COALESCE(newer.target_command_id,'')=COALESCE(r.target_command_id,'') AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid))) ORDER BY root,target_command_id"))?;
                let runs = stmt.query_map([p.project_id],run_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(serde_json::to_value(runs)?)
            })
        }
        "quickLaunch.setup.run" => run_setup(db, pty, serde_json::from_value(value.clone())?, false),
        "quickLaunch.sequence.cancel" => cancel_sequence(db, serde_json::from_value(value.clone())?),
        _ => Err(anyhow!("unknown_method")),
    }
}

pub(crate) fn root_for_setup(db: &Database, project: &str, cwd: &str) -> Result<PathBuf> {
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
        let previous = latest_setup(tx, &p.project_id, &root)?;
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
            step, state:"running".into(), session_ids, exit_code:None, error:None,
            trigger:if automatic { "worktree.create" } else if p.from_step.is_some() { "retry" } else { "manual" }.into(),
            target_command_id:None, started_by:None, created_at:now.clone(), updated_at:now };
        tx.execute("INSERT INTO quick_launch_setup_runs(id,project_id,root,command_ids_json,names_json,snapshots_json,step,state,session_ids_json,exit_code,trigger,created_at,updated_at,target_command_id,started_by) VALUES(?,?,?,?,?,?,?,'running',?,NULL,?,?,?,NULL,NULL)",
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

/// Start a saved command through the shared durable runner when it has dependencies.
/// The caller holds no database connection; admission covers reservation and the first
/// launch, then later steps re-enter through `start_next_setup_step`.
pub(super) fn run_dependencies(
    db: &Arc<Database>,
    pty: &PtyManager,
    target: &QuickLaunchCommand,
    cwd: &str,
    operation_id: &str,
    method: &str,
    started_by: Option<&str>,
    source_session_id: Option<&str>,
) -> Result<Value> {
    let guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
    if let Some(result) = replayed_operation(db, operation_id, method)? { return Ok(result); }
    let root = root_for_setup(db, &target.project_id, cwd)?.to_string_lossy().into_owned();
    let target_active = db.transaction(|tx| Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id LEFT JOIN session_organization o ON o.session_id=s.id WHERE q.command_id=? AND q.root=? AND s.status IN ('starting','running','idle','waiting') AND COALESCE(json_extract(o.data,'$.archived'),0)=0)",
        params![target.id,root],|row|row.get::<_,bool>(0))?))?;
    // A bound request always observes its original sequence, even if a different
    // request has since started the target or the prior sequence was interrupted.
    let bound = db.transaction(|tx| dependency_binding(tx,operation_id,method))?;
    if bound.is_none() && target_active {
        return start(db,pty,target,&root,operation_id,method,source_session_id,None,started_by);
    }
    let reserved = db.transaction(|tx| reserve_dependencies(tx,target,&root,operation_id,method,started_by,source_session_id))?;
    let first = if reserved.1 { start_step_locked(db,pty,&reserved.0)? } else { None };
    if method == "session.rerun" {
        drop(guard);
        return wait_for_rerun_target(db,&reserved.0,operation_id);
    }
    let result = dependency_launch_value(db,&reserved.0,first.as_ref()
        .and_then(|value|value.get("existing")).and_then(Value::as_bool).unwrap_or(!reserved.1))?;
    db.transaction(|tx| complete(tx,operation_id,method,&result))?;
    Ok(result)
}

fn dependency_binding(tx: &Transaction<'_>, operation: &str, method: &str) -> Result<Option<String>> {
    let binding: Option<(String,String)> = tx.query_row(
        "SELECT method,sequence_id FROM quick_launch_sequence_operations WHERE operation_id=?",[operation],
        |row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    match binding {
        Some((saved,id)) if saved == method => Ok(Some(id)),
        Some(_) => Err(anyhow!("invalid_request")),
        None => Ok(None),
    }
}

// The request binding commits with the sequence, before any external side effect.
// A crash cannot turn that same caller operation into another sequence.
fn reserve_dependencies(tx: &Transaction<'_>, target: &QuickLaunchCommand, root: &str,
    operation: &str, method: &str, started_by: Option<&str>, source: Option<&str>) -> Result<(String,bool)> {
    let recorded: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id=?)",[operation],|row|row.get(0))?;
    if recorded { return Err(anyhow!("invalid_request")); }
    if let Some(id) = dependency_binding(tx,operation,method)? { return Ok((id,false)); }
    let existing = tx.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE project_id=? AND root=? AND target_command_id=? AND state='running' ORDER BY created_at DESC,rowid DESC LIMIT 1"),
        params![target.project_id,root,target.id],run_row).optional()?;
    let (id,created) = if let Some(run) = existing { (run.id,false) } else {
        let mut commands = Vec::with_capacity(target.depends_on.len()+1);
        for id in &target.depends_on {
            let command = tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"),
                params![id,target.project_id],command_row).optional()?.ok_or_else(|| anyhow!("dependency_failed: {id}"))?;
            commands.push(command);
        }
        commands.push(target.clone());
        let now = Utc::now().to_rfc3339();
        let run = SetupRun {
            id:uuid::Uuid::new_v4().to_string(), project_id:target.project_id.clone(), root:root.into(),
            command_ids:commands.iter().map(|command|command.id.clone()).collect(),
            names:commands.iter().map(|command|command.name.clone()).collect(), step:0,
            state:"running".into(), session_ids:Vec::new(), exit_code:None, error:None,
            trigger:"depends_on".into(), target_command_id:Some(target.id.clone()),
            started_by:started_by.map(str::to_owned), created_at:now.clone(), updated_at:now,
        };
        tx.execute("INSERT INTO quick_launch_setup_runs(id,project_id,root,command_ids_json,names_json,snapshots_json,step,state,session_ids_json,exit_code,trigger,created_at,updated_at,target_command_id,started_by) VALUES(?,?,?,?,?,?,0,'running','[]',NULL,'depends_on',?,?,?,?)",
            params![run.id,run.project_id,run.root,serde_json::to_string(&run.command_ids)?,serde_json::to_string(&run.names)?,serde_json::to_string(&commands)?,run.created_at,run.updated_at,run.target_command_id,run.started_by])?;
        setup_changed(tx,&run.project_id)?;
        (run.id,true)
    };
    tx.execute("INSERT INTO quick_launch_sequence_operations(operation_id,method,sequence_id,source_session_id) VALUES(?,?,?,?)",
        params![operation,method,id,source])?;
    Ok((id,created))
}

fn dependency_launch_value(db: &Database, id: &str, existing: bool) -> Result<Value> {
    let run = db.transaction(|tx| read_run(tx,id))?;
    let Some(session_id) = run.session_ids.first() else {
        return Err(anyhow!("dependency_failed: {}",run.names.get(run.step).map(String::as_str).unwrap_or("unknown")));
    };
    let session = db.session_by_id(session_id)?.ok_or_else(|| anyhow!("session_not_found"))?;
    Ok(json!({"session":session,"existing":existing,"sequence":run,"sequenceId":id}))
}

pub(super) fn replay_dependency_operation(db: &Database, operation: &str, method: &str) -> Result<Option<Value>> {
    // A rerun must return the target Session, never the first prerequisite.
    // Its caller delegates back to the existing runner and waits without admission.
    if method == "session.rerun" { return Ok(None); }
    let id = db.transaction(|tx| dependency_binding(tx,operation,method))?;
    id.map(|id|dependency_launch_value(db,&id,true)).transpose()
}

fn wait_for_rerun_target(db: &Database, id: &str, operation: &str) -> Result<Value> {
    loop {
        let guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
        let run = db.transaction(|tx| read_run(tx,id))?;
        if let Some(session) = run.session_ids.get(run.command_ids.len()-1) {
            let result = serde_json::to_value(db.session_by_id(session)?.ok_or_else(||anyhow!("session_not_found"))?)?;
            db.transaction(|tx| {
                if operation_tx(tx,operation)?.is_none() { complete(tx,operation,"session.rerun",&result)?; }
                Ok(())
            })?;
            return Ok(result);
        }
        if run.state != "running" {
            return Err(anyhow!("dependency_failed: {}",run.names.get(run.step).map(String::as_str).unwrap_or("unknown")));
        }
        drop(guard);
        std::thread::sleep(SERVICE_POLL);
    }
}

fn cancel_sequence(db: &Database, p: SequenceCancel) -> Result<Value> {
    cancel_sequence_fenced(db,&p.id,None,Some(&p.operation_id))?.ok_or_else(||anyhow!("run_not_found"))
}

// Both user and caller-scoped cancellation wait for in-flight PTY admission.
// A queued continuation must re-check the cancelled row under this same lock.
fn cancel_sequence_fenced(db: &Database, id: &str, scope: Option<(&str,&str)>, operation: Option<&str>) -> Result<Option<Value>> {
    let _guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
    db.transaction(|tx| {
        if let Some(operation) = operation {
            if let Some(result) = operation_tx(tx,operation)? { return Ok(Some(result)); }
        }
        let run = tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE id=?"),[id],run_row).optional()?;
        let Some(mut run) = run else { return Ok(None); };
        if scope.is_some_and(|(project,root)|run.project_id!=project || run.root!=root || run.target_command_id.is_none()) {
            return Ok(None);
        }
        if run.state == "running" {
            run.state = "cancelled".into();
            run.updated_at = Utc::now().to_rfc3339();
            tx.execute("UPDATE quick_launch_setup_runs SET state='cancelled',updated_at=? WHERE id=? AND state='running'",
                params![run.updated_at,run.id])?;
            setup_changed(tx,&run.project_id)?;
        }
        let result = serde_json::to_value(&run)?;
        if let Some(operation) = operation { complete(tx,operation,"quickLaunch.sequence.cancel",&result)?; }
        Ok(Some(result))
    })
}

pub(crate) fn sequence_for_session(db: &Database, session: &str) -> Result<Option<Value>> {
    db.transaction(|tx| {
        let raw: Option<String> = tx.query_row(
            "SELECT COALESCE(json_extract(snapshot_json,'$.sequence'),json_extract(snapshot_json,'$.setup')) FROM quick_launch_runs WHERE session_id=?",
            [session],|row|row.get(0)).optional()?.flatten();
        let Some(raw) = raw else { return Ok(None); };
        let step: SetupStep = serde_json::from_str(&raw)?;
        let run = read_run(tx,&step.run_id)?;
        Ok(Some(serde_json::to_value(run)?))
    })
}

pub(crate) fn sequence_by_id(db: &Database, id: &str, project: &str, root: &str) -> Result<Option<(Value,Option<String>)>> {
    db.transaction(|tx| {
        let run = tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM quick_launch_setup_runs WHERE id=? AND project_id=? AND root=? AND target_command_id IS NOT NULL"),
            params![id,project,root],run_row).optional()?;
        let Some(run) = run else { return Ok(None); };
        let started_by = run.started_by.clone();
        Ok(Some((serde_json::to_value(run)?,started_by)))
    })
}

pub(crate) fn cancel_scoped_sequence(db: &Database, id: &str, project: &str, root: &str) -> Result<Option<Value>> {
    cancel_sequence_fenced(db,id,Some((project,root)),None)
}

pub(super) fn attach_session(tx: &Transaction<'_>, step: &SetupStep, session: &str) -> Result<()> {
    let mut run = read_run(tx, &step.run_id)?;
    if run.state != "running" || run.step != step.step { return Err(anyhow!("invalid_step")); }
    let raw: String = tx.query_row("SELECT snapshot_json FROM quick_launch_runs WHERE session_id=?",[session],|r|r.get(0))?;
    let mut snapshot: Value = serde_json::from_str(&raw)?;
    // An active task/service can satisfy a later sequence too. Keep the first
    // owner's event hook intact; reused steps are observed from the durable row.
    if snapshot.get("sequence").is_none() && snapshot.get("setup").is_none() {
        snapshot["sequence"] = serde_json::to_value(step)?;
        if run.trigger != "depends_on" { snapshot["setup"] = serde_json::to_value(step)?; }
        tx.execute("UPDATE quick_launch_runs SET snapshot_json=? WHERE session_id=?",params![snapshot.to_string(),session])?;
    }
    if run.session_ids.last().map(String::as_str) != Some(session) { run.session_ids.push(session.to_owned()); }
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

const SERVICE_NONE_GRACE: chrono::Duration = chrono::Duration::seconds(3);
const DEPENDENCY_TIMEOUT: chrono::Duration = chrono::Duration::seconds(120);
const SERVICE_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, PartialEq)]
pub(super) enum ServiceDecision { Wait, Satisfied, Failed, Cancelled }

pub(super) fn service_decision(
    now: chrono::DateTime<Utc>,
    step_started: chrono::DateTime<Utc>,
    process_started: chrono::DateTime<Utc>,
    status: &str,
    readiness: Option<&str>,
    stop_requested: bool,
) -> ServiceDecision {
    if stop_requested { return ServiceDecision::Cancelled; }
    if !matches!(status,"starting"|"running"|"idle"|"waiting") { return ServiceDecision::Failed; }
    if readiness == Some("ready") || readiness == Some("none") && now-process_started >= SERVICE_NONE_GRACE {
        return ServiceDecision::Satisfied;
    }
    if now-step_started >= DEPENDENCY_TIMEOUT { return ServiceDecision::Failed; }
    ServiceDecision::Wait
}

fn step_succeeded(tx: &Transaction<'_>, run: &SetupRun) -> Result<Option<String>> {
    let (state,step,next) = if run.step+1 == run.command_ids.len() {
        ("completed",run.step,None)
    } else {
        ("running",run.step+1,Some(run.id.clone()))
    };
    let changed_run = tx.execute("UPDATE quick_launch_setup_runs SET state=?,step=?,exit_code=NULL,updated_at=? WHERE id=? AND state='running' AND step=?",
        params![state,step,Utc::now().to_rfc3339(),run.id,run.step])? != 0;
    if changed_run { setup_changed(tx,&run.project_id)?; }
    Ok(changed_run.then_some(next).flatten())
}

fn step_failed(tx: &Transaction<'_>, run: &SetupRun, exit: Option<i32>, cancelled: bool) -> Result<()> {
    if tx.execute("UPDATE quick_launch_setup_runs SET state=?,exit_code=?,updated_at=? WHERE id=? AND state='running' AND step=?",
        params![if cancelled {"cancelled"} else {"failed"},exit,Utc::now().to_rfc3339(),run.id,run.step])? != 0 {
        setup_changed(tx,&run.project_id)?;
    }
    Ok(())
}

fn service_step_at(db: &Database, id: &str, expected_step: usize, session: &str, now: chrono::DateTime<Utc>) -> Result<(ServiceDecision,Option<String>)> {
    db.transaction(|tx| {
        let run = read_run(tx,id)?;
        if run.state != "running" || run.step != expected_step || run.session_ids.last().map(String::as_str) != Some(session) {
            return Ok((ServiceDecision::Cancelled,None));
        }
        let (status,readiness,started,stop_requested,exit): (String,Option<String>,String,bool,Option<i32>) = tx.query_row(
            "SELECT s.status,q.readiness,q.started_at,q.stop_requested,s.exit_code FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id WHERE q.session_id=?",
            [session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        let step_started = chrono::DateTime::parse_from_rfc3339(&run.updated_at)?.with_timezone(&Utc);
        let process_started = chrono::DateTime::parse_from_rfc3339(&started)?.with_timezone(&Utc);
        let decision = service_decision(now,step_started,process_started,&status,readiness.as_deref(),stop_requested);
        match decision {
            ServiceDecision::Satisfied => Ok((decision,step_succeeded(tx,&run)?)),
            ServiceDecision::Failed => { step_failed(tx,&run,exit,false)?; Ok((decision,None)) }
            ServiceDecision::Cancelled => {
                if run.state == "running" && stop_requested { step_failed(tx,&run,None,true)?; }
                Ok((decision,None))
            }
            ServiceDecision::Wait => Ok((decision,None)),
        }
    })
}

fn wait_for_service(db: Arc<Database>, pty: PtyManager, id: String, step: usize, session: String) {
    std::thread::spawn(move || loop {
        match service_step_at(&db,&id,step,&session,Utc::now()) {
            Ok((ServiceDecision::Wait,_)) => std::thread::sleep(SERVICE_POLL),
            Ok((ServiceDecision::Satisfied,Some(next))) => {
                start_next_setup_step(Arc::clone(&db),pty.clone(),next);
                break;
            }
            Ok(_) => break,
            Err(error) => {
                eprintln!("Run sequence {id} readiness wait failed: {error}");
                let _ = fail_step(&db,&id);
                break;
            }
        }
    });
}

fn task_step_at(db: &Database, id: &str, expected_step: usize, session: &str, now: chrono::DateTime<Utc>, timeout: bool) -> Result<(ServiceDecision,Option<String>)> {
    db.transaction(|tx| {
        let run = read_run(tx,id)?;
        if run.state != "running" || run.step != expected_step || run.session_ids.last().map(String::as_str) != Some(session) {
            return Ok((ServiceDecision::Cancelled,None));
        }
        let (status,stop_requested,exit): (String,bool,Option<i32>) = tx.query_row(
            "SELECT s.status,q.stop_requested,s.exit_code FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id WHERE q.session_id=?",
            [session],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        if stop_requested { step_failed(tx,&run,None,true)?; return Ok((ServiceDecision::Cancelled,None)); }
        if matches!(status.as_str(),"starting"|"running"|"idle"|"waiting") {
            let step_started = chrono::DateTime::parse_from_rfc3339(&run.updated_at)?.with_timezone(&Utc);
            if !timeout || now-step_started < DEPENDENCY_TIMEOUT { return Ok((ServiceDecision::Wait,None)); }
            step_failed(tx,&run,None,false)?;
            return Ok((ServiceDecision::Failed,None));
        }
        if exit == Some(0) { return Ok((ServiceDecision::Satisfied,step_succeeded(tx,&run)?)); }
        step_failed(tx,&run,exit,false)?;
        Ok((ServiceDecision::Failed,None))
    })
}

fn wait_for_task(db: Arc<Database>, pty: PtyManager, id: String, step: usize, session: String, timeout: bool) {
    std::thread::spawn(move || loop {
        match task_step_at(&db,&id,step,&session,Utc::now(),timeout) {
            Ok((ServiceDecision::Wait,_)) => std::thread::sleep(SERVICE_POLL),
            Ok((ServiceDecision::Satisfied,Some(next))) => {
                start_next_setup_step(Arc::clone(&db),pty.clone(),next);
                break;
            }
            Ok(_) => break,
            Err(error) => {
                eprintln!("Run sequence {id} task wait failed: {error}");
                let _ = fail_step(&db,&id);
                break;
            }
        }
    });
}

fn session_sequence_owner(db: &Database, session: &str) -> Result<Option<String>> {
    db.transaction(|tx| {
        let raw: Option<String> = tx.query_row("SELECT json_extract(snapshot_json,'$.sequence') FROM quick_launch_runs WHERE session_id=?",
            [session],|row|row.get(0)).optional()?.flatten();
        raw.map(|raw|serde_json::from_str::<SetupStep>(&raw).map(|step|step.run_id)).transpose().map_err(Into::into)
    })
}

fn start_step_locked(db: &Arc<Database>, pty: &PtyManager, id: &str) -> Result<Option<Value>> {
    let (run, commands) = db.transaction(|tx| {
        let run = read_run(tx,id)?;
        let raw: String = tx.query_row("SELECT snapshots_json FROM quick_launch_setup_runs WHERE id=?",[id],|r|r.get(0))?;
        Ok((run,serde_json::from_str::<Vec<QuickLaunchCommand>>(&raw)?))
    })?;
    if run.state != "running" { return Ok(None); }
    if commands.get(run.step).is_none_or(|command| command.kind != "task" && command.kind != "service")
        || run.trigger != "depends_on" && commands[run.step].kind != "task" {
        fail_step(db,id)?;
        return Ok(None);
    }
    let step = SetupStep {run_id:run.id.clone(),step:run.step,total:commands.len()};
    let source: Option<String> = if run.target_command_id.as_deref() == Some(commands[run.step].id.as_str()) {
        db.transaction(|tx| Ok(tx.query_row("SELECT source_session_id FROM quick_launch_sequence_operations WHERE sequence_id=? AND source_session_id IS NOT NULL ORDER BY rowid LIMIT 1",[id],|row|row.get(0)).optional()?.flatten()))?
    } else { None };
    let result = start(db,pty,&commands[run.step],&run.root,&format!("sequence:{}:{}",run.id,run.step),"quickLaunch.run",source.as_deref(),Some(&step),run.started_by.as_deref());
    match result {
        Ok(value) => {
            let session = &value["session"];
            if session["status"] == "error" { fail_step(db,id)?; }
            else if run.target_command_id.as_deref() == Some(commands[run.step].id.as_str()) {
                db.transaction(|tx| {
                    let current = read_run(tx,id)?;
                    step_succeeded(tx,&current)
                })?;
            }
            else if run.trigger == "depends_on" && commands[run.step].kind == "task" {
                wait_for_task(Arc::clone(db),pty.clone(),id.to_owned(),run.step,session["id"].as_str().unwrap_or("").to_owned(),true);
                if session["status"] == "exited" {
                    if let Some(next) = setup_terminal_exited(db,session["id"].as_str().unwrap_or(""),session["exitCode"].as_i64().map(|n|n as i32),false)? {
                        start_next_setup_step(Arc::clone(db),pty.clone(),next);
                    }
                }
            }
            else if commands[run.step].kind == "task" && value["existing"] == true
                && session_sequence_owner(db,session["id"].as_str().unwrap_or(""))?.as_deref() != Some(id) {
                wait_for_task(Arc::clone(db),pty.clone(),id.to_owned(),run.step,session["id"].as_str().unwrap_or("").to_owned(),false);
            }
            else if commands[run.step].kind == "task" && session["status"] == "exited" {
                if let Some(next) = setup_terminal_exited(db,session["id"].as_str().unwrap_or(""),session["exitCode"].as_i64().map(|n|n as i32),false)? {
                    start_next_setup_step(Arc::clone(db),pty.clone(),next);
                }
            }
            else if commands[run.step].kind == "service" {
                wait_for_service(Arc::clone(db),pty.clone(),id.to_owned(),run.step,session["id"].as_str().unwrap_or("").to_owned());
            }
            return Ok(Some(value));
        }
        Err(error) => {
            eprintln!("Worktree setup {id} step {} could not start: {error}",run.step);
            fail_step(db,id)?;
        }
    }
    Ok(None)
}

/// One primary-key lookup for an ordinary terminal; sequences alone do further work.
/// Returns a continuation only after committing the transition, with no locks retained.
pub(crate) fn setup_terminal_exited(db: &Database, session: &str, code: Option<i32>, stopped: bool) -> Result<Option<String>> {
    db.transaction(|tx| {
        let source: Option<(Option<String>,bool)> = tx.query_row(
            "SELECT COALESCE(json_extract(snapshot_json,'$.sequence'),json_extract(snapshot_json,'$.setup')),stop_requested FROM quick_launch_runs WHERE session_id=?",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((Some(raw),stop_requested)) = source else { return Ok(None); };
        let step: SetupStep = serde_json::from_str(&raw)?;
        let run = read_run(tx,&step.run_id)?;
        if run.state != "running" || run.step != step.step || run.session_ids.last().map(String::as_str) != Some(session) { return Ok(None); }
        if stopped || stop_requested { step_failed(tx,&run,None,true)?; return Ok(None); }
        let raw: String = tx.query_row("SELECT snapshots_json FROM quick_launch_setup_runs WHERE id=?",[&run.id],|r|r.get(0))?;
        let commands: Vec<QuickLaunchCommand> = serde_json::from_str(&raw)?;
        if run.target_command_id.as_deref() == commands.get(run.step).map(|command|command.id.as_str()) {
            return step_succeeded(tx,&run);
        }
        if commands.get(run.step).is_none_or(|command|command.kind != "task") || code != Some(0) {
            step_failed(tx,&run,code,false)?;
            return Ok(None);
        }
        step_succeeded(tx,&run)
    })
}

pub(crate) fn start_next_setup_step(db: Arc<Database>, pty: PtyManager, id: String) {
    std::thread::spawn(move || {
        let result = (|| {
            let _guard = ADMISSION.lock().map_err(|_| anyhow!("quick launch admission poisoned"))?;
            start_step_locked(&db,&pty,&id).map(|_|())
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

#[cfg(test)]
#[path = "run_sequence_review_tests.rs"]
mod review_tests;
