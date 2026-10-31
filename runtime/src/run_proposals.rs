//! Pending run suggestions. Only the local UI decision routes can write saved commands.
use super::*;
use chrono::Duration as ChronoDuration;

pub(crate) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS run_proposals (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        root TEXT NOT NULL, session_id TEXT NOT NULL, target_command_id TEXT,
        name TEXT NOT NULL, command TEXT NOT NULL, shell TEXT NOT NULL, cwd TEXT NOT NULL,
        kind TEXT NOT NULL, env_json TEXT NOT NULL, preview_url TEXT, reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','superseded','expired')),
        base_revision INTEGER, created_at TEXT NOT NULL, decided_at TEXT, decided_command_id TEXT);
        CREATE INDEX IF NOT EXISTS run_proposals_scope ON run_proposals(project_id,root,state,created_at);")?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalInput {
    name: String,
    command: String,
    reason: String,
    id: Option<String>,
    cwd: Option<String>,
    shell: Option<String>,
    kind: Option<String>,
    env: Option<Vec<EnvVar>>,
    preview_url: Option<String>,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    project_id: String,
    cwd: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Accept {
    proposal_id: String,
    operation_id: String,
    edits: Option<Edits>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edits {
    name: Option<String>,
    command: Option<String>,
    shell: Option<String>,
    cwd: Option<String>,
    kind: Option<String>,
    env: Option<Vec<SaveEnv>>,
    depends_on: Option<Vec<String>>,
    preview_url: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reject {
    proposal_id: String,
    operation_id: String,
}

fn reject_nulls(p: &Value, keys: &[&str]) -> Result<()> {
    if keys
        .iter()
        .any(|key| p.get(key).is_some_and(Value::is_null))
    {
        return Err(anyhow!("invalid_request"));
    }
    Ok(())
}

/// Proposal fields are later shown verbatim in the human review UI. Keep the same
/// Unicode-format boundary as detected-command approval cards: a zero-width or bidi
/// character must never turn an executable proposal into harmless-looking text.
/// A PowerShell command may deliberately retain CR/LF script bytes; no other field
/// may contain a control character except a tab.
fn proposal_unprintable(value: &str, allow_command_newlines: bool) -> bool {
    value.chars().any(|c| {
        crate::chat_tools::unprintable(c) && !(allow_command_newlines && matches!(c, '\r' | '\n'))
    })
}

fn reject_unprintable_fields(
    name: &str,
    command: &str,
    reason: &str,
    shell: &str,
    cwd: &str,
    kind: &str,
    env: &[EnvVar],
    preview: Option<&str>,
    command_shell_known: bool,
) -> Result<()> {
    let allow_command_newlines = !command_shell_known || matches!(shell, "powershell" | "pwsh");
    if [name, reason, shell, cwd, kind]
        .into_iter()
        .any(|value| proposal_unprintable(value, false))
        || proposal_unprintable(command, allow_command_newlines)
        || env.iter().any(|item| {
            proposal_unprintable(&item.name, false) || proposal_unprintable(&item.value, false)
        })
        || preview.is_some_and(|value| proposal_unprintable(value, false))
    {
        return Err(anyhow!("detected_command_unprintable"));
    }
    Ok(())
}
pub(crate) fn validate(method: &str, p: &Value) -> Result<()> {
    if method == "quickLaunch.proposals.accept" {
        reject_nulls(p, &["edits"])?;
        if let Some(edits) = p.get("edits") {
            reject_nulls(
                edits,
                &[
                    "name",
                    "command",
                    "shell",
                    "cwd",
                    "kind",
                    "env",
                    "previewUrl",
                    "dependsOn",
                ],
            )?;
        }
    }
    match method {
        "quickLaunch.proposals.list" => {
            let p: Scope = serde_json::from_value(p.clone())?;
            required(&p.project_id)?;
            required(&p.cwd)?;
        }
        "quickLaunch.proposals.accept" => {
            let p: Accept = serde_json::from_value(p.clone())?;
            required(&p.proposal_id)?;
            required(&p.operation_id)?;
        }
        "quickLaunch.proposals.reject" => {
            let p: Reject = serde_json::from_value(p.clone())?;
            required(&p.proposal_id)?;
            required(&p.operation_id)?;
        }
        _ => return Err(anyhow!("unknown_method")),
    }
    Ok(())
}

fn expire(tx: &Transaction<'_>) -> Result<()> {
    let cutoff = (Utc::now() - ChronoDuration::days(7)).to_rfc3339();
    if tx.execute("UPDATE run_proposals SET state='expired',decided_at=? WHERE state='pending' AND created_at<=?",
        params![Utc::now().to_rfc3339(), cutoff])? != 0 {
        changed(tx, "quickLaunch.proposals", None)?;
    }
    Ok(())
}
const COLUMNS: &str = "id,project_id,root,session_id,target_command_id,name,command,shell,cwd,kind,env_json,preview_url,reason,state,base_revision,created_at,decided_at,decided_command_id";
fn proposal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let raw: String = row.get(10)?;
    let env: Value = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let mut value = json!({"id":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,
        "root":row.get::<_,String>(2)?,"sessionId":row.get::<_,String>(3)?,
        "name":row.get::<_,String>(5)?,"command":row.get::<_,String>(6)?,"shell":row.get::<_,String>(7)?,
        "cwd":row.get::<_,String>(8)?,"kind":row.get::<_,String>(9)?,"env":env,
        "reason":row.get::<_,String>(12)?,"state":row.get::<_,String>(13)?,"createdAt":row.get::<_,String>(15)?});
    for (key, column) in [
        ("targetCommandId", 4),
        ("previewUrl", 11),
        ("decidedAt", 16),
        ("decidedCommandId", 17),
    ] {
        if let Some(v) = row.get::<_, Option<String>>(column)? {
            value[key] = json!(v);
        }
    }
    if let Some(v) = row.get::<_, Option<i64>>(14)? {
        value["baseRevision"] = json!(v);
    }
    Ok(value)
}
fn read(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    tx.query_row(
        &format!("SELECT {COLUMNS} FROM run_proposals WHERE id=?"),
        [id],
        proposal_row,
    )
    .optional()?
    .ok_or_else(|| anyhow!("run_proposal_not_found"))
}
fn receipt(tx: &Transaction<'_>, id: &str, method: &str) -> Result<Option<Value>> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT method,result FROM operations WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((m, result)) if m == method => Ok(Some(serde_json::from_str(&result)?)),
        Some(_) => Err(anyhow!("invalid_request")),
        None => Ok(None),
    }
}

/// Called only after the Run tool has authorized its grant, worktree and delegate write capability.
/// `requestId` has already been namespaced by caller and method.
pub(crate) fn propose(
    db: &Database,
    session: &str,
    project: &str,
    root: &str,
    p: &Value,
) -> Result<Value> {
    reject_nulls(p, &["id", "cwd", "shell", "kind", "env", "previewUrl"])?;
    let p: ProposalInput = serde_json::from_value(p.clone())?;
    required(&p.request_id)?;
    if p.reason.trim().is_empty() || p.reason.chars().count() > 2000 {
        return Err(anyhow!("invalid_request"));
    }
    if [p.request_id.as_str(), p.id.as_deref().unwrap_or("")]
        .iter()
        .any(|value| proposal_unprintable(value, false))
    {
        return Err(anyhow!("detected_command_unprintable"));
    }
    // Reject supplied display/execution text before a receipt, proposal, expiry or
    // supersede write. An omitted shell can be inherited from an update target, so
    // only that CR/LF shell rule is deferred until target resolution below.
    reject_unprintable_fields(
        &p.name,
        &p.command,
        &p.reason,
        p.shell.as_deref().unwrap_or(""),
        p.cwd.as_deref().unwrap_or(""),
        p.kind.as_deref().unwrap_or(""),
        p.env.as_deref().unwrap_or(&[]),
        p.preview_url.as_deref(),
        p.shell.is_some(),
    )?;
    db.transaction(|tx| {
        if let Some(value) = receipt(tx,&p.request_id,"chat.tool.run.propose")? { return Ok(value); }
        let target = if let Some(id) = &p.id {
            Some(tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"),params![id,project],command_row)
                .optional()?.ok_or_else(||anyhow!("run_not_found"))?)
        } else { None };
        let base = target.as_ref().map(|c|c.revision);
        let cwd = p.cwd.clone().unwrap_or_else(||target.as_ref().map_or_else(String::new,|c|c.cwd.clone()));
        let shell = p.shell.clone().unwrap_or_else(||target.as_ref().map_or_else(||"cmd".into(),|c|c.shell.clone()));
        let kind = p.kind.clone().unwrap_or_else(||target.as_ref().map_or_else(||"service".into(),|c|c.kind.clone()));
        let inherited_env = target.as_ref().map_or_else(Vec::new, |c| c.env.iter().map(|item| SaveEnv {
            name:item.name.clone(), value:(!crate::run_repo_config::is_secret_reference(&item.value)).then(||item.value.clone()),
            secret:crate::run_repo_config::is_secret_reference(&item.value).then_some(true),
        }).collect::<Vec<_>>());
        let env = p.env.as_ref().map(|env| env.iter().map(|item| SaveEnv {name:item.name.clone(),value:Some(item.value.clone()),secret:None}).collect::<Vec<_>>()).unwrap_or(inherited_env);
        let printable_env = env.iter().filter_map(|item| item.value.as_ref().map(|value|EnvVar{name:item.name.clone(),value:value.clone()})).collect::<Vec<_>>();
        let preview = p.preview_url.clone().or_else(||target.as_ref().and_then(|c|c.preview_url.clone()));
        // Check the complete snapshot too: omitted update fields inherit the saved
        // target and must be safe for the same human review surface.
        reject_unprintable_fields(
            &p.name,
            &p.command,
            &p.reason,
            &shell,
            &cwd,
            &kind,
            &printable_env,
            preview.as_deref(),
            true,
        )?;
        validate_command_fields(&p.name,&p.command,&shell,&cwd,&kind,&env,preview.as_deref())?;
        expire(tx)?;
        let now = Utc::now().to_rfc3339();
        // NULL means a new entry with no shared target identity. Keep unrelated new suggestions.
        if let Some(target_id) = &p.id {
            tx.execute("UPDATE run_proposals SET state='superseded',decided_at=? WHERE project_id=? AND root=? AND session_id=? AND target_command_id=? AND state='pending'",
                params![now,project,root,session,target_id])?;
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM run_proposals WHERE project_id=? AND state='pending'",[project],|r|r.get(0))?;
        if count >= 20 { return Err(anyhow!("too_many_proposals")); }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO run_proposals(id,project_id,root,session_id,target_command_id,name,command,shell,cwd,kind,env_json,preview_url,reason,state,base_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
            params![id,project,root,session,p.id,trim_wire(&p.name),p.command,shell,cwd,kind,serde_json::to_string(&env)?,preview,p.reason,base,now])?;
        let result = json!({"proposalId":id,"state":"pending"});
        complete(tx,&p.request_id,"chat.tool.run.propose",&result)?;
        changed(tx,"quickLaunch.proposals",None)?;
        Ok(result)
    })
}
fn scoped_rows(
    tx: &Transaction<'_>,
    project: &str,
    root: &str,
    session: Option<&str>,
    pending: bool,
) -> Result<Vec<Value>> {
    let condition = if pending {
        "state='pending'"
    } else {
        "state!='pending'"
    };
    let order = if pending { "created_at" } else { "decided_at" };
    let limit = if pending { 20 } else { 10 };
    let mut stmt = tx.prepare(&format!("SELECT {COLUMNS} FROM run_proposals WHERE project_id=? AND root=? AND (? IS NULL OR session_id=?) AND {condition} ORDER BY {order} DESC,rowid DESC LIMIT {limit}"))?;
    let rows = stmt
        .query_map(params![project, root, session, session], proposal_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub(crate) fn list(db: &Database, p: &Value) -> Result<Value> {
    let p: Scope = serde_json::from_value(p.clone())?;
    let root = root_for_setup(db, &p.project_id, &p.cwd)?
        .to_string_lossy()
        .into_owned();
    db.transaction(|tx| {
        expire(tx)?;
        let mut pending = scoped_rows(tx,&p.project_id,&root,None,true)?;
        for value in &mut pending {
            if let Some(id) = value["targetCommandId"].as_str() {
                let command = tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"),params![id,p.project_id],command_row).optional()?;
                if let Some(command) = command {
                    value["dependsOn"] = json!(command.depends_on);
                    value["target"] = public_command_value(tx, &command)?;
                }
            }
        }
        Ok(json!({"pending":pending,"decided":scoped_rows(tx,&p.project_id,&root,None,false)?}))
    })
}
pub(crate) fn list_for_session(
    db: &Database,
    project: &str,
    root: &str,
    session: &str,
) -> Result<Value> {
    db.transaction(|tx| {
        expire(tx)?;
        let mut rows = scoped_rows(tx,project,root,Some(session),true)?;
        rows.extend(scoped_rows(tx,project,root,Some(session),false)?);
        Ok(json!(rows.into_iter().map(|row| {
            let mut value = json!({"proposalId":row["id"],"name":row["name"],"state":row["state"],"createdAt":row["createdAt"]});
            for key in ["targetCommandId","decidedCommandId"] { if let Some(v) = row.get(key) { value[key] = v.clone(); } }
            value
        }).collect::<Vec<_>>()))
    })
}
pub(crate) fn accept(db: &Database, p: &Value) -> Result<Value> {
    validate("quickLaunch.proposals.accept", p)?;
    let p: Accept = serde_json::from_value(p.clone())?;
    db.transaction(|tx| {
        if let Some(value) = receipt(tx,&p.operation_id,"quickLaunch.proposals.accept")? { return Ok(value); }
        expire(tx)?;
        let proposal = read(tx,&p.proposal_id)?;
        if proposal["state"] != "pending" { return Err(anyhow!("run_proposal_not_pending")); }
        let edits = p.edits.unwrap_or_default();
        let name = edits.name.unwrap_or_else(||proposal["name"].as_str().unwrap().into());
        let command = edits.command.unwrap_or_else(||proposal["command"].as_str().unwrap().into());
        let shell = edits.shell.unwrap_or_else(||proposal["shell"].as_str().unwrap().into());
        let cwd = edits.cwd.unwrap_or_else(||proposal["cwd"].as_str().unwrap().into());
        let kind = edits.kind.unwrap_or_else(||proposal["kind"].as_str().unwrap().into());
        let env = edits.env.unwrap_or(serde_json::from_value(proposal["env"].clone())?);
        let preview = edits.preview_url.or_else(||proposal["previewUrl"].as_str().map(str::to_owned)).filter(|s|!s.is_empty());
        let project = proposal["projectId"].as_str().unwrap();
        let id = proposal["targetCommandId"].as_str().map(str::to_owned);
        let depends_on = match edits.depends_on {
            Some(dependencies) => dependencies,
            None => id.as_ref().map(|id| tx.query_row(&format!("SELECT {COMMAND_COLUMNS} FROM quick_launch_commands WHERE id=? AND project_id=?"), params![id,project], command_row).optional())
                .transpose()?.flatten().map_or_else(Vec::new, |target|target.depends_on),
        };
        let save = Save { project_id:project.into(), id, expected_revision:proposal["baseRevision"].as_i64(),
            name, command, shell, cwd, kind, env, depends_on, preview_url:preview, repo_source:None, operation_id:p.operation_id.clone(), run_id:None };
        let saved = save_command_tx(tx, &save, &std::collections::HashMap::new())?;
        tx.execute("UPDATE run_proposals SET state='accepted',decided_at=?,decided_command_id=? WHERE id=?",params![Utc::now().to_rfc3339(),saved.id,p.proposal_id])?;
        let result = public_command_value(tx, &saved)?;
        complete(tx,&p.operation_id,"quickLaunch.proposals.accept",&result)?;
        changed(tx,"quickLaunch.commands",None)?; changed(tx,"quickLaunch.proposals",None)?;
        Ok(result)
    })
}
pub(crate) fn reject(db: &Database, p: &Value) -> Result<Value> {
    validate("quickLaunch.proposals.reject", p)?;
    let p: Reject = serde_json::from_value(p.clone())?;
    db.transaction(|tx| {
        if let Some(value) = receipt(tx, &p.operation_id, "quickLaunch.proposals.reject")? {
            return Ok(value);
        }
        expire(tx)?;
        if read(tx, &p.proposal_id)?["state"] != "pending" {
            return Err(anyhow!("run_proposal_not_pending"));
        }
        tx.execute(
            "UPDATE run_proposals SET state='rejected',decided_at=? WHERE id=?",
            params![Utc::now().to_rfc3339(), p.proposal_id],
        )?;
        complete(
            tx,
            &p.operation_id,
            "quickLaunch.proposals.reject",
            &Value::Null,
        )?;
        changed(tx, "quickLaunch.proposals", None)?;
        Ok(Value::Null)
    })
}

#[cfg(test)]
#[path = "run_proposals_tests.rs"]
mod tests;
