//! Scoped filesystem helpers.  The dispatcher supplies a canonical, registered root;
//! no UI path is ever used as an operating-system path directly.
use crate::db::Database;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| { tx.execute_batch("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, worktree_path TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, content TEXT NOT NULL, base_fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,worktree_path,path)); CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, worktree_path TEXT, revision INTEGER NOT NULL, layout TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE, branch TEXT, head TEXT NOT NULL, is_main INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0);")?; let columns:Vec<String>={let mut s=tx.prepare("PRAGMA table_info(drafts)")?;let values=s.query_map([],|r|r.get(1))?.collect::<rusqlite::Result<_>>()?;values};if !columns.iter().any(|x|x=="worktree_path"){tx.execute_batch("ALTER TABLE drafts RENAME TO drafts_legacy; CREATE TABLE drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, worktree_path TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, content TEXT NOT NULL, base_fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,worktree_path,path)); INSERT INTO drafts(id,project_id,worktree_path,path,content,base_fingerprint,revision,updated_at) SELECT id,project_id,'',path,content,base_fingerprint,revision,updated_at FROM drafts_legacy; DROP TABLE drafts_legacy;")?;} Ok(()) })
}

#[allow(clippy::possible_missing_else)]
pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "filesystem.list"
            | "filesystem.read"
            | "filesystem.image"
            | "filesystem.write"
            | "draft.list"
            | "draft.put"
            | "draft.delete"
            | "workspace.save"
            | "workspace.delete"
            | "git.status"
            | "git.diff"
            | "worktree.list"
            | "worktree.branches"
            | "worktree.relocate"
            | "worktree.create"
            | "worktree.remove"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let operation = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("invalid_request"))
    };
    let result = db.transaction(|tx| {
        let project_id = object.get("projectId").and_then(Value::as_str);
        let worktree_path = object.get("worktreePath").and_then(Value::as_str);
        let root = |id: &str| root_for(tx, id, worktree_path);
        match method {
            "filesystem.list" => { let root = root(project_id.ok_or_else(|| anyhow!("invalid_request"))?)?; let relative=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let dir=scoped_path(&root,relative,true)?; let mut entries=Vec::new(); for item in fs::read_dir(dir)? { let item=item?; let meta=item.file_type()?; let mut entry=serde_json::Map::new(); entry.insert("name".into(),json!(item.file_name().to_string_lossy())); entry.insert("path".into(),json!(if relative.is_empty(){item.file_name().to_string_lossy().to_string()}else{format!("{relative}/{}",item.file_name().to_string_lossy())})); entry.insert("kind".into(),json!(if meta.is_dir(){"directory"}else if meta.is_symlink(){"symlink"}else{"file"})); if let Ok(metadata)=item.metadata(){entry.insert("size".into(),json!(metadata.len()));} entries.push(Value::Object(entry)); } Ok(json!(entries)) }
            "filesystem.read" => { let root=root(project_id.ok_or_else(||anyhow!("invalid_request"))?)?; let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let resolved=scoped_path(&root,path,true)?; let (fingerprint,content)=read_document(&root,path)?; let meta=fs::metadata(resolved)?; Ok(json!({"path":path,"content":content,"fingerprint":fingerprint,"readonly":meta.permissions().readonly(),"size":meta.len(),"modifiedAt":Utc::now().to_rfc3339()})) }
            "filesystem.image" => { let root=root(project_id.ok_or_else(||anyhow!("invalid_request"))?)?; let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let (mime,data)=read_image(&root,path)?; Ok(json!({"mime":mime,"data":BASE64.encode(data)})) }
            "filesystem.write" => { let root=root(project_id.ok_or_else(||anyhow!("invalid_request"))?)?; let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let content=object.get("content").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_content"))?; let expected=object.get("expectedFingerprint").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_request"))?; let op=operation("operationId")?; if let Some(value)=idempotent(tx,op)? { return Ok(value); } let (fingerprint,content)=write_document(&root,path,content,expected)?; complete(tx,op,method,&json!({"path":path,"content":content,"fingerprint":fingerprint,"readonly":false,"size":content.len(),"modifiedAt":Utc::now().to_rfc3339()})) }
            "draft.list" => { let id=project_id.ok_or_else(||anyhow!("invalid_request"))?; if worktree_path.is_some(){root_for(tx,id,worktree_path)?;} let scope=worktree_path.unwrap_or(""); let mut stmt=tx.prepare("SELECT id,project_id,worktree_path,path,content,base_fingerprint,revision,updated_at FROM drafts WHERE project_id=? AND worktree_path=? ORDER BY updated_at")?; let rows=stmt.query_map(params![id,scope],|r| Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"worktreePath":r.get::<_,String>(2)?,"path":r.get::<_,String>(3)?,"content":r.get::<_,String>(4)?,"baseFingerprint":r.get::<_,String>(5)?,"revision":r.get::<_,i64>(6)?,"updatedAt":r.get::<_,String>(7)?})))?; Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?)) }
            "draft.put" => { let id=project_id.ok_or_else(||anyhow!("invalid_request"))?; if worktree_path.is_some(){root_for(tx,id,worktree_path)?;} let scope=worktree_path.unwrap_or(""); let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let content=object.get("content").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_content"))?; if content.len()>MAX_DOCUMENT_BYTES||content.as_bytes().contains(&0){return Err(anyhow!("invalid_content"))} let expected=object.get("expectedRevision").and_then(Value::as_i64).ok_or_else(||anyhow!("invalid_request"))?; let op=operation("operationId")?; if let Some(value)=idempotent(tx,op)? {return Ok(value)} let current:Option<(String,i64)>=tx.query_row("SELECT id,revision FROM drafts WHERE project_id=? AND worktree_path=? AND path=?",params![id,scope,path],|r|Ok((r.get(0)?,r.get(1)?))).optional()?; if current.as_ref().map(|x|x.1).unwrap_or(0)!=expected{return Err(anyhow!("revision_conflict"))} let draft_id=current.map(|x|x.0).unwrap_or_else(||uuid::Uuid::new_v4().to_string()); let revision=expected+1; let base=object.get("baseFingerprint").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_request"))?; let now=Utc::now().to_rfc3339(); tx.execute("INSERT INTO drafts(id,project_id,worktree_path,path,content,base_fingerprint,revision,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,worktree_path,path) DO UPDATE SET content=excluded.content,base_fingerprint=excluded.base_fingerprint,revision=excluded.revision,updated_at=excluded.updated_at",params![draft_id,id,scope,path,content,base,revision,now])?; complete(tx,op,method,&json!({"id":draft_id,"projectId":id,"worktreePath":scope,"path":path,"content":content,"baseFingerprint":base,"revision":revision,"updatedAt":now})) }
            "draft.delete"|"workspace.delete" => { let id=object.get("id").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_request"))?; let expected=object.get("expectedRevision").and_then(Value::as_i64).ok_or_else(||anyhow!("invalid_request"))?; let op=operation("operationId")?; if let Some(value)=idempotent(tx,op)?{return Ok(value)} let table=if method=="draft.delete"{"drafts"}else{"workspaces"}; let revision:i64=tx.query_row(&format!("SELECT revision FROM {table} WHERE id=?"),[id],|r|r.get(0))?; if revision!=expected{return Err(anyhow!("revision_conflict"))} tx.execute(&format!("DELETE FROM {table} WHERE id=?"),[id])?; complete(tx,op,method,&Value::Null) }
            "workspace.save" => { let op=operation("operationId")?; if let Some(value)=idempotent(tx,op)?{return Ok(value)} let id=object.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string()); let expected=object.get("expectedRevision").and_then(Value::as_i64).ok_or_else(||anyhow!("invalid_request"))?; let existing:Option<i64>=tx.query_row("SELECT revision FROM workspaces WHERE id=?",[&id],|r|r.get(0)).optional()?; if existing.unwrap_or(0)!=expected{return Err(anyhow!("revision_conflict"))} let name=object.get("name").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_request"))?; let layout=object.get("layout").ok_or_else(||anyhow!("invalid_request"))?; validate_layout(layout)?; let project=object.get("projectId").and_then(Value::as_str); let worktree=object.get("worktreePath").and_then(Value::as_str); if let Some(project)=project{root_for(tx,project,worktree)?;}else if worktree.is_some(){return Err(anyhow!("invalid_request"))} let next=expected+1; let now=Utc::now().to_rfc3339(); tx.execute("INSERT INTO workspaces(id,name,project_id,worktree_path,revision,layout,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,project_id=excluded.project_id,worktree_path=excluded.worktree_path,revision=excluded.revision,layout=excluded.layout,updated_at=excluded.updated_at",params![id,name,project,worktree,next,serde_json::to_string(layout)?,now])?; let mut value=serde_json::Map::new(); value.insert("id".into(),json!(id)); value.insert("name".into(),json!(name)); value.insert("revision".into(),json!(next)); value.insert("layout".into(),layout.clone()); if let Some(project)=project{value.insert("projectId".into(),json!(project));} if let Some(worktree)=worktree{value.insert("worktreePath".into(),json!(worktree));} complete(tx,op,method,&Value::Object(value)) }
            "git.status" => { let root=root(project_id.ok_or_else(||anyhow!("invalid_request"))?)?; git_status(&root) }
            "git.diff" => { let root=root(project_id.ok_or_else(||anyhow!("invalid_request"))?)?; let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let staged=object.get("staged").and_then(Value::as_bool).ok_or_else(||anyhow!("invalid_request"))?; git_diff(&root,path,staged) }
            "worktree.list" => { let project=project_id.ok_or_else(||anyhow!("invalid_request"))?; let root=root(project)?; reconcile_worktrees(tx,project,&root) }
            "worktree.branches" => { let project=project_id.ok_or_else(||anyhow!("invalid_request"))?; let root=root(project)?; branches(&root) }
            "worktree.relocate" => relocate_worktree(tx, object, method),
            "worktree.create" => { let project=project_id.ok_or_else(||anyhow!("invalid_request"))?; let root=root(project)?; let op=operation("operationId")?; if let Some(value)=idempotent(tx,op)?{return Ok(value)} let path=object.get("path").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_path"))?; let branch=object.get("branch").and_then(Value::as_str).ok_or_else(||anyhow!("invalid_request"))?; let target=PathBuf::from(path); if !target.is_absolute()||target.exists()||target.parent().and_then(|parent|parent.canonicalize().ok()).is_none(){return Err(anyhow!("invalid_path"))} let create=object.get("createBranch").and_then(Value::as_bool).unwrap_or(false); if create { git(&root,&["worktree","add","-b",branch,path])?; } else { git(&root,&["worktree","add",path,branch])?; } let target=target.canonicalize().context("canonicalizing worktree")?.to_string_lossy().to_string(); let head=git(Path::new(&target),&["rev-parse","HEAD"]).unwrap_or_default(); let id=upsert_worktree(tx,project,&target,Some(branch),head.trim(),false,false)?; complete(tx,op,method,&worktree_json(&id,project,&target,Some(branch),head.trim(),false,false)) }
            "worktree.remove" => remove_worktree(tx, object, method),
            _ => unreachable!()
        }
    })?;
    Ok(Some(result))
}

/// Resolves an existing cwd to its closest registered project/worktree root.
/// The closest root wins so nested registered projects cannot be attributed to
/// an outer project selected by a stale client.
pub fn workspace_root_for_cwd(db: &Database, project_id: &str, cwd: &str) -> Result<PathBuf> {
    let cwd = Path::new(cwd)
        .canonicalize()
        .map_err(|_| anyhow!("invalid_cwd"))?;
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT id,path,'project' FROM projects UNION ALL SELECT project_id,path,'worktree' FROM worktrees",
        )?;
        let roots = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut closest_depth = 0usize;
        let mut closest: Vec<(String, PathBuf, String)> = Vec::new();
        for (candidate_project, candidate_path, kind) in roots {
            let Ok(candidate) = Path::new(&candidate_path).canonicalize() else {
                continue;
            };
            if !path_is_within(&cwd, &candidate)? {
                continue;
            }
            let depth = lexical_components(&candidate)?.len();
            if depth > closest_depth {
                closest_depth = depth;
                closest.clear();
                closest.push((candidate_project, candidate, kind));
            } else if depth == closest_depth {
                closest.push((candidate_project, candidate, kind));
            }
        }
        if closest.is_empty() {
            return Err(anyhow!("cwd_not_in_registered_project"));
        }
        // A nested registered project wins over another project's worktree at
        // the same path. Duplicate string forms of one directory are the same
        // project choice, not an ambiguity.
        let project_matches: Vec<(String, PathBuf)> = closest
            .iter()
            .filter(|(_, _, kind)| kind == "project")
            .map(|(id, path, _)| (id.clone(), path.clone()))
            .collect();
        let allowed = if project_matches.is_empty() {
            closest
                .iter()
                .map(|(id, path, _)| (id.clone(), path.clone()))
                .collect::<Vec<_>>()
        } else {
            project_matches
        };
        let Some((_, root)) = allowed.iter().find(|(id, _)| id == project_id) else {
            return Err(anyhow!("selected_project_mismatch"));
        };
        Ok(root.clone())
    })
}

fn relocate_worktree(
    tx: &Transaction<'_>,
    object: &serde_json::Map<String, Value>,
    method: &str,
) -> Result<Value> {
    let id = required_string(object, "id")?;
    let path = required_string(object, "path")?;
    let operation_id = required_string(object, "operationId")?;
    if let Some(value) = idempotent(tx, operation_id)? {
        return Ok(value);
    }
    let (project, old_path, branch, old_head, is_main, locked): (
        String,
        String,
        Option<String>,
        String,
        i64,
        i64,
    ) = tx
        .query_row(
            "SELECT project_id,path,branch,head,is_main,locked FROM worktrees WHERE id=?",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|_| anyhow!("worktree_not_registered"))?;
    if Path::new(&old_path).exists() {
        return Err(anyhow!("worktree_not_missing"));
    }
    let sessions = scoped_sessions(tx, &project, &old_path)?;
    if sessions
        .iter()
        .any(|(_, status, read_only)| !read_only && is_live_status(status))
    {
        return Err(anyhow!("worktree_running_session"));
    }
    let target = Path::new(path)
        .canonicalize()
        .map_err(|_| anyhow!("invalid_path"))?;
    let target_text = target.to_string_lossy().to_string();
    let conflict: Option<String> = tx
        .query_row(
            "SELECT id FROM worktrees WHERE path=?",
            [&target_text],
            |row| row.get(0),
        )
        .optional()?;
    if conflict.as_deref().is_some_and(|other| other != id) {
        return Err(anyhow!("worktree_already_registered"));
    }
    let root = root_for(tx, &project, None)?;
    let known = git(&root, &["worktree", "list", "--porcelain"])?;
    if !known.lines().any(|line| {
        line.strip_prefix("worktree ").is_some_and(|candidate| {
            Path::new(candidate)
                .canonicalize()
                .ok()
                .as_ref()
                .is_some_and(|candidate| same_lexical_path(candidate, &target).unwrap_or(false))
        })
    }) {
        return Err(anyhow!("worktree_not_project_member"));
    }
    let new_head = git(&target, &["rev-parse", "HEAD"])
        .unwrap_or(old_head)
        .trim()
        .to_owned();
    tx.execute(
        "UPDATE worktrees SET path=?,branch=?,head=? WHERE id=?",
        params![&target_text, branch, &new_head, id],
    )?;
    rebind_scoped_rows(tx, "drafts", &project, &old_path, &target_text)?;
    rebind_scoped_rows(tx, "workspaces", &project, &old_path, &target_text)?;
    for (session_id, _, _) in sessions {
        let session_path: String = tx.query_row(
            "SELECT worktree_path FROM sessions WHERE id=?",
            [&session_id],
            |row| row.get(0),
        )?;
        if let Some(rebased) =
            rebase_descendant(Path::new(&session_path), Path::new(&old_path), &target)?
        {
            tx.execute(
                "UPDATE sessions SET worktree_path=? WHERE id=?",
                params![rebased.to_string_lossy(), session_id],
            )?;
        }
    }
    let launch_configs = {
        let mut statement = tx.prepare(
            "SELECT c.session_id,c.cwd FROM session_launch_configs c JOIN sessions s ON s.id=c.session_id WHERE s.project_id=?",
        )?;
        let rows = statement
            .query_map([&project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (session_id, cwd) in launch_configs {
        if let Some(rebased) = rebase_descendant(Path::new(&cwd), Path::new(&old_path), &target)? {
            tx.execute(
                "UPDATE session_launch_configs SET cwd=? WHERE session_id=?",
                params![rebased.to_string_lossy(), session_id],
            )?;
        }
    }
    complete(
        tx,
        operation_id,
        method,
        &worktree_json(
            id,
            &project,
            &target_text,
            branch.as_deref(),
            &new_head,
            is_main != 0,
            locked != 0,
        ),
    )
}

fn remove_worktree(
    tx: &Transaction<'_>,
    object: &serde_json::Map<String, Value>,
    method: &str,
) -> Result<Value> {
    let id = required_string(object, "id")?;
    let operation_id = required_string(object, "operationId")?;
    if let Some(value) = idempotent(tx, operation_id)? {
        return Ok(value);
    }
    let (project, path, is_main, locked): (String, String, i64, i64) = tx
        .query_row(
            "SELECT project_id,path,is_main,locked FROM worktrees WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| anyhow!("worktree_not_registered"))?;
    if is_main != 0 {
        return Err(anyhow!("worktree_main"));
    }
    if locked != 0 {
        return Err(anyhow!("worktree_locked"));
    }
    let dirty = git(Path::new(&path), &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        return Err(anyhow!("worktree_dirty"));
    }
    if scoped_sessions(tx, &project, &path)?
        .iter()
        .any(|(_, status, read_only)| !read_only && is_live_status(status))
    {
        return Err(anyhow!("worktree_running_session"));
    }
    if has_scoped_rows(tx, "drafts", &project, &path)? {
        return Err(anyhow!("worktree_unsaved_drafts"));
    }
    if has_scoped_rows(tx, "workspaces", &project, &path)? {
        return Err(anyhow!("worktree_saved_workspace"));
    }
    let project_root = root_for(tx, &project, None)?;
    git(&project_root, &["worktree", "remove", "--", &path])?;
    tx.execute("DELETE FROM worktrees WHERE id=?", [id])?;
    complete(tx, operation_id, method, &Value::Null)
}

fn required_string<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn is_live_status(status: &str) -> bool {
    matches!(status, "starting" | "running" | "idle" | "waiting")
}

fn scoped_sessions(
    tx: &Transaction<'_>,
    project_id: &str,
    root: &str,
) -> Result<Vec<(String, String, bool)>> {
    let mut statement = tx.prepare(
        "SELECT id,worktree_path,status,read_only FROM sessions WHERE project_id=? AND worktree_path IS NOT NULL",
    )?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .filter_map(|(id, path, status, read_only)| {
            match path_is_within(Path::new(&path), Path::new(root)) {
                Ok(true) => Some(Ok((id, status, read_only))),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}

fn scoped_row_ids(
    tx: &Transaction<'_>,
    table: &str,
    project_id: &str,
    root: &str,
) -> Result<Vec<String>> {
    debug_assert!(matches!(table, "drafts" | "workspaces"));
    let mut statement = tx.prepare(&format!(
        "SELECT id,worktree_path FROM {table} WHERE project_id=? AND worktree_path IS NOT NULL"
    ))?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .filter_map(
            |(id, path)| match path_is_within(Path::new(&path), Path::new(root)) {
                Ok(true) => Some(Ok(id)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            },
        )
        .collect()
}

fn has_scoped_rows(
    tx: &Transaction<'_>,
    table: &str,
    project_id: &str,
    root: &str,
) -> Result<bool> {
    Ok(!scoped_row_ids(tx, table, project_id, root)?.is_empty())
}

fn rebind_scoped_rows(
    tx: &Transaction<'_>,
    table: &str,
    project_id: &str,
    old_root: &str,
    new_root: &str,
) -> Result<()> {
    for id in scoped_row_ids(tx, table, project_id, old_root)? {
        tx.execute(
            &format!("UPDATE {table} SET worktree_path=? WHERE id=?"),
            params![new_root, id],
        )?;
    }
    Ok(())
}

fn rebase_descendant(path: &Path, old_root: &Path, new_root: &Path) -> Result<Option<PathBuf>> {
    let path = lexical_components(path)?;
    let root = lexical_components(old_root)?;
    if path.len() < root.len()
        || !path
            .iter()
            .zip(&root)
            .all(|((path_key, _), (root_key, _))| path_key == root_key)
    {
        return Ok(None);
    }
    let mut rebased = new_root.to_path_buf();
    for (_, component) in path.into_iter().skip(root.len()) {
        rebased.push(component);
    }
    Ok(Some(rebased))
}

fn path_is_within(path: &Path, root: &Path) -> Result<bool> {
    let path = lexical_components(path)?;
    let root = lexical_components(root)?;
    Ok(path.len() >= root.len()
        && path
            .iter()
            .zip(&root)
            .all(|((path_key, _), (root_key, _))| path_key == root_key))
}

fn same_lexical_path(left: &Path, right: &Path) -> Result<bool> {
    let left = lexical_components(left)?;
    let right = lexical_components(right)?;
    Ok(left.len() == right.len()
        && left
            .iter()
            .zip(&right)
            .all(|((left_key, _), (right_key, _))| left_key == right_key))
}

fn lexical_components(path: &Path) -> Result<Vec<(String, OsString)>> {
    #[cfg(windows)]
    let path = {
        let text = path.to_string_lossy().replace('/', "\\");
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            PathBuf::from(rest)
        } else {
            PathBuf::from(text)
        }
    };
    #[cfg(not(windows))]
    let path = path.to_path_buf();
    if !path.is_absolute() {
        return Err(anyhow!("invalid_path"));
    }
    let mut output = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => return Err(anyhow!("invalid_path")),
            _ => {
                let original = component.as_os_str().to_os_string();
                #[cfg(windows)]
                let key = original.to_string_lossy().to_lowercase();
                #[cfg(not(windows))]
                let key = original.to_string_lossy().to_string();
                output.push((key, original));
            }
        }
    }
    Ok(output)
}

pub(crate) fn root_for(
    tx: &Transaction<'_>,
    id: &str,
    worktree_path: Option<&str>,
) -> Result<PathBuf> {
    if let Some(path) = worktree_path {
        let canonical = Path::new(path)
            .canonicalize()
            .map_err(|_| anyhow!("worktree_not_registered"))?;
        let canonical = canonical.to_string_lossy().to_string();
        let project_root: String =
            tx.query_row("SELECT path FROM projects WHERE id=?", [id], |row| {
                row.get(0)
            })?;
        let project_canonical = Path::new(&project_root)
            .canonicalize()
            .map_err(|_| anyhow!("invalid_project_root"))?;
        if canonical == project_canonical.to_string_lossy() {
            return Ok(project_canonical);
        }
        let registered: Option<String> = tx
            .query_row(
                "SELECT path FROM worktrees WHERE project_id=? AND path=?",
                params![id, canonical],
                |r| r.get(0),
            )
            .optional()?;
        return registered
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("worktree_not_registered"));
    }
    let path: String = tx.query_row("SELECT path FROM projects WHERE id=?", [id], |r| r.get(0))?;
    Ok(PathBuf::from(path))
}
/// Validates the persisted workspace-pane tree used by both saved workspaces
/// and preset layouts.
pub fn validate_layout(layout: &Value) -> Result<()> {
    fn visit(
        node: &Value,
        depth: usize,
        panes: &mut usize,
        ids: &mut HashSet<String>,
    ) -> Result<()> {
        if depth > 4 {
            return Err(anyhow!("invalid_workspace_layout"));
        }
        let node = node
            .as_object()
            .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
        let id = node
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
        if !ids.insert(id.to_owned()) {
            return Err(anyhow!("invalid_workspace_layout"));
        }
        match node.get("kind").and_then(Value::as_str) {
            Some("split") => {
                let ratio = node
                    .get("ratio")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
                if !matches!(
                    node.get("direction").and_then(Value::as_str),
                    Some("horizontal" | "vertical")
                ) || !(0.1..=0.9).contains(&ratio)
                {
                    return Err(anyhow!("invalid_workspace_layout"));
                }
                visit(
                    node.get("first")
                        .ok_or_else(|| anyhow!("invalid_workspace_layout"))?,
                    depth + 1,
                    panes,
                    ids,
                )?;
                visit(
                    node.get("second")
                        .ok_or_else(|| anyhow!("invalid_workspace_layout"))?,
                    depth + 1,
                    panes,
                    ids,
                )
            }
            Some("pane") => {
                *panes += 1;
                let tabs = node
                    .get("tabs")
                    .and_then(Value::as_array)
                    .filter(|tabs| tabs.len() <= 100)
                    .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
                if *panes > 4 {
                    return Err(anyhow!("invalid_workspace_layout"));
                }
                let mut tab_ids = HashSet::new();
                for tab in tabs {
                    let tab = tab
                        .as_object()
                        .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
                    let tab_id = tab
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| anyhow!("invalid_workspace_layout"))?;
                    if !tab_ids.insert(tab_id) {
                        return Err(anyhow!("invalid_workspace_layout"));
                    }
                    match tab.get("kind").and_then(Value::as_str) {
                        Some("session")
                            if tab
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty()) => {}
                        Some("file" | "diff" | "preview")
                            if tab
                                .get("projectId")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty())
                                && tab
                                    .get("path")
                                    .and_then(Value::as_str)
                                    .is_some_and(|path| !path.is_empty()) => {}
                        _ => return Err(anyhow!("invalid_workspace_layout")),
                    }
                }
                match node.get("activeTabId") {
                    Some(Value::Null) => Ok(()),
                    Some(Value::String(id)) if tab_ids.contains(id.as_str()) => Ok(()),
                    _ => Err(anyhow!("invalid_workspace_layout")),
                }
            }
            _ => Err(anyhow!("invalid_workspace_layout")),
        }
    }
    visit(layout, 0, &mut 0, &mut HashSet::new())
}
fn branches(root: &Path) -> Result<Value> {
    let current = git(root, &["branch", "--show-current"]).unwrap_or_default();
    let raw=git(root,&["for-each-ref","--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)","refs/heads"])?;
    let rows=raw.lines().filter_map(|line|{let mut p=line.split('\0');let name=p.next()?.to_owned();let upstream=p.next().filter(|v|!v.is_empty()).map(str::to_owned);let id=p.next()?.to_owned();let subject=p.next()?.to_owned();let committed_at=p.next()?.to_owned();let mut value=json!({"name":name,"current":name==current,"lastCommit":{"id":id,"subject":subject,"committedAt":committed_at}});if let Some(upstream)=upstream {value["upstream"]=json!(upstream);}Some(value)}).collect::<Vec<_>>();
    Ok(json!(rows))
}
fn worktree_json(
    id: &str,
    project_id: &str,
    path: &str,
    branch: Option<&str>,
    head: &str,
    is_main: bool,
    locked: bool,
) -> Value {
    json!({"id":id,"projectId":project_id,"path":path,"branch":branch,"head":head,"isMain":is_main,"locked":locked,"missing":!Path::new(path).exists()})
}
fn upsert_worktree(
    tx: &Transaction<'_>,
    project_id: &str,
    path: &str,
    branch: Option<&str>,
    head: &str,
    is_main: bool,
    locked: bool,
) -> Result<String> {
    let id = tx
        .query_row(
            "SELECT id FROM worktrees WHERE project_id=? AND path=?",
            params![project_id, path],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET project_id=excluded.project_id,branch=excluded.branch,head=excluded.head,is_main=excluded.is_main,locked=excluded.locked",params![&id,project_id,path,branch,head,i64::from(is_main),i64::from(locked)])?;
    Ok(id)
}
fn reconcile_worktrees(tx: &Transaction<'_>, project_id: &str, root: &Path) -> Result<Value> {
    let raw = git(root, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let canonical_root = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    for block in raw.split("\n\n").filter(|block| !block.trim().is_empty()) {
        let Some(path) = block
            .lines()
            .find_map(|line| line.strip_prefix("worktree "))
        else {
            continue;
        };
        let path = Path::new(path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .to_string();
        let branch = block
            .lines()
            .find_map(|line| line.strip_prefix("branch refs/heads/"));
        let head = block
            .lines()
            .find_map(|line| line.strip_prefix("HEAD "))
            .unwrap_or("");
        let is_main = path == canonical_root;
        upsert_worktree(
            tx,
            project_id,
            &path,
            branch,
            head,
            is_main,
            block
                .lines()
                .any(|line| line == "locked" || line.starts_with("locked ")),
        )?;
    }
    let mut statement=tx.prepare("SELECT id,path,branch,head,is_main,locked FROM worktrees WHERE project_id=? ORDER BY is_main DESC,path")?;
    let rows = statement.query_map([project_id], |row| {
        let id: String = row.get(0)?;
        let path: String = row.get(1)?;
        let branch: Option<String> = row.get(2)?;
        let head: String = row.get(3)?;
        let is_main = row.get::<_, i64>(4)? != 0;
        let locked = row.get::<_, i64>(5)? != 0;
        Ok(worktree_json(
            &id,
            project_id,
            &path,
            branch.as_deref(),
            &head,
            is_main,
            locked,
        ))
    })?;
    Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?))
}

fn idempotent(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row("SELECT result FROM operations WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|x| serde_json::from_str(&x).map_err(Into::into))
        .transpose()
}
fn complete(tx: &Transaction<'_>, id: &str, method: &str, value: &Value) -> Result<Value> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            id,
            method,
            serde_json::to_string(value)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}',?)",
        [Utc::now().to_rfc3339()],
    )?;
    Ok(value.clone())
}

pub fn scoped_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf> {
    if relative.contains('\0') || Path::new(relative).is_absolute() {
        return Err(anyhow!("invalid_path"));
    }
    let path = Path::new(relative);
    if path.components().any(|part| {
        matches!(
            part,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(anyhow!("invalid_path"));
    }
    let root = root
        .canonicalize()
        .context("canonicalizing registered root")?;
    let candidate = root.join(path);
    if must_exist {
        let canonical = candidate
            .canonicalize()
            .context("canonicalizing requested path")?;
        if !canonical.starts_with(&root) {
            return Err(anyhow!("path_escape"));
        }
        return Ok(canonical);
    }
    // Canonicalize the parent to reject junction/symlink escapes before creating a file.
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow!("invalid_path"))?
        .canonicalize()?;
    if !parent.starts_with(&root) {
        return Err(anyhow!("path_escape"));
    }
    Ok(parent.join(
        candidate
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?,
    ))
}

pub fn read_image(root: &Path, relative: &str) -> Result<(&'static str, Vec<u8>)> {
    let path = scoped_path(root, relative, true)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > 4 * 1024 * 1024 {
        return Err(anyhow!("image_too_large"));
    }
    let bytes = fs::read(path)?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(anyhow!("unsupported_image"));
    };
    Ok((mime, bytes))
}

pub fn read_document(root: &Path, relative: &str) -> Result<(String, String)> {
    let path = scoped_path(root, relative, true)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    let bytes = fs::read(&path)?;
    if bytes.contains(&0) {
        return Err(anyhow!("binary_file"));
    }
    let content = String::from_utf8(bytes).map_err(|_| anyhow!("binary_file"))?;
    Ok((fingerprint(content.as_bytes()), content))
}

pub fn write_document(
    root: &Path,
    relative: &str,
    content: &str,
    expected: &str,
) -> Result<(String, String)> {
    if content.len() > MAX_DOCUMENT_BYTES || content.as_bytes().contains(&0) {
        return Err(anyhow!("invalid_content"));
    }
    let path = scoped_path(root, relative, true)?;
    if fs::metadata(&path)?.permissions().readonly() {
        return Err(anyhow!("readonly_file"));
    }
    let existing = fs::read(&path)?;
    if fingerprint(&existing) != expected {
        return Err(anyhow!("file_conflict"));
    }
    let temporary = path.with_extension(format!("threadterm-{}", std::process::id()));
    fs::write(&temporary, content.as_bytes())?;
    // Rename is atomic when both files share the same parent directory.
    fs::rename(&temporary, &path).inspect_err(|_error| {
        let _ = fs::remove_file(&temporary);
    })?;
    Ok((fingerprint(content.as_bytes()), content.to_owned()))
}

pub fn git(root: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().context("launching git")?;
    if !output.status.success() {
        return Err(anyhow!(
            "git_failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(Into::into)
}

/// Git state is meaningful only for a verified worktree. A non-repository must
/// remain unavailable rather than impersonating a clean branch with zero counts.
pub fn git_status(root: &Path) -> Result<Value> {
    let inside = git(root, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| anyhow!("git_unavailable"))?;
    if inside.trim() != "true" {
        return Err(anyhow!("git_unavailable"));
    }
    // symbolic-ref works for an unborn branch; detached HEAD has no branch name.
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let upstream = git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok();
    let (ahead, behind) = if upstream.is_some() {
        let counts = git(
            root,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        )?;
        let values = counts
            .split_whitespace()
            .map(str::parse::<i64>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| anyhow!("git_failed"))?;
        if values.len() != 2 {
            return Err(anyhow!("git_failed"));
        }
        (values[1], values[0])
    } else {
        (0, 0)
    };
    let porcelain = git(root, &["status", "--porcelain=v1", "-z"])?;
    let mut fields = porcelain.split('\0');
    let mut changes = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 3 {
            continue;
        }
        let index = &record[..1];
        let worktree = &record[1..2];
        let mut path = record[3..].to_owned();
        if matches!(&record[..2], "R " | " R" | "C " | " C") {
            if let Some(old) = fields.next() {
                path = format!("{old} -> {path}");
            }
        }
        changes.push(json!({"path":path,"indexStatus":index,"worktreeStatus":worktree,"untracked":record.starts_with("??")}));
    }
    Ok(
        json!({"branch":branch.as_deref().map(str::trim),"upstream":upstream.as_deref().map(str::trim),"ahead":ahead,"behind":behind,"changes":changes}),
    )
}

pub fn git_diff(root: &Path, path: &str, staged: bool) -> Result<Value> {
    let target = scoped_path(root, path, true)?;
    let bytes = fs::read(&target)?;
    if bytes.contains(&0) {
        return Ok(
            json!({"path":path,"staged":staged,"oldText":"","newText":"","binary":true,"fingerprint":fingerprint(&bytes)}),
        );
    }
    let old = if staged {
        git(root, &["show", &format!(":{path}")]).unwrap_or_default()
    } else {
        git(root, &["show", &format!("HEAD:{path}")]).unwrap_or_default()
    };
    let new = String::from_utf8(bytes.clone()).map_err(|_| anyhow!("binary_file"))?;
    Ok(
        json!({"path":path,"staged":staged,"oldText":old,"newText":new,"binary":false,"fingerprint":fingerprint(&bytes)}),
    )
}

pub fn fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    #[test]
    fn reports_non_repository_git_status_as_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        assert!(git_status(temp.path())
            .unwrap_err()
            .to_string()
            .contains("git_unavailable"));
    }
    #[test]
    fn rejects_parent_and_junction_escape() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("safe.txt"), "one").unwrap();
        assert!(scoped_path(temp.path(), "../safe.txt", true).is_err());
        assert!(scoped_path(temp.path(), "safe.txt", true).is_ok());
    }
    #[test]
    fn fences_write_by_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.txt"), "one").unwrap();
        let (fingerprint, _) = read_document(temp.path(), "a.txt").unwrap();
        fs::write(temp.path().join("a.txt"), "changed").unwrap();
        assert!(write_document(temp.path(), "a.txt", "two", &fingerprint).is_err());
    }
    #[test]
    fn real_git_temp_repository() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]).unwrap();
        assert!(git(temp.path(), &["status", "--porcelain"])
            .unwrap()
            .is_empty());
    }
    #[test]
    fn worktree_and_branch_payloads_preserve_nullable_and_optional_fields() {
        let detached = worktree_json(
            "worktree",
            "project",
            "C:\\missing",
            None,
            "head",
            false,
            false,
        );
        assert!(detached["branch"].is_null());
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]).unwrap();
        git(
            temp.path(),
            &["config", "user.email", "tests@threadterm.invalid"],
        )
        .unwrap();
        git(temp.path(), &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(temp.path().join("README.md"), "initial").unwrap();
        git(temp.path(), &["add", "README.md"]).unwrap();
        git(temp.path(), &["commit", "-m", "initial"]).unwrap();
        let rows = branches(temp.path()).unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("upstream").is_none()));
    }
    #[test]
    fn cwd_root_resolution_selects_the_closest_registered_project() {
        let temp = tempfile::tempdir().unwrap();
        let outer = temp.path().join("outer");
        let nested = outer.join("nested");
        let cwd = nested.join("src");
        fs::create_dir_all(&cwd).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let outer_project = db
            .add_project(outer.to_str().unwrap(), Some("outer"), "outer-project")
            .unwrap();
        let nested_project = db
            .add_project(nested.to_str().unwrap(), Some("nested"), "nested-project")
            .unwrap();
        assert_eq!(
            workspace_root_for_cwd(&db, &nested_project.id, cwd.to_str().unwrap()).unwrap(),
            nested.canonicalize().unwrap()
        );
        assert!(
            workspace_root_for_cwd(&db, &outer_project.id, cwd.to_str().unwrap())
                .unwrap_err()
                .to_string()
                .contains("selected_project_mismatch")
        );
    }
    #[test]
    fn cwd_root_resolution_accepts_duplicate_path_spellings_of_the_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let first = db
            .add_project(root.to_str().unwrap(), Some("first"), "dup-a")
            .unwrap();
        let spelled = format!("{}{}", root.to_str().unwrap(), std::path::MAIN_SEPARATOR);
        let second = db.add_project(&spelled, Some("second"), "dup-b").unwrap();
        let canonical = root.canonicalize().unwrap();
        assert_eq!(
            workspace_root_for_cwd(&db, &first.id, root.to_str().unwrap()).unwrap(),
            canonical
        );
        assert_eq!(
            workspace_root_for_cwd(&db, &second.id, root.to_str().unwrap()).unwrap(),
            canonical
        );
    }
    #[test]
    fn cwd_root_resolution_lets_a_worktree_own_a_path_without_a_nested_project() {
        let temp = tempfile::tempdir().unwrap();
        let outer = temp.path().join("outer");
        let nested = outer.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let outer_project = db
            .add_project(outer.to_str().unwrap(), Some("outer"), "outer-wt")
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('wt',?,?, 'main','head',0,0)",
                params![outer_project.id, nested.to_str().unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            workspace_root_for_cwd(&db, &outer_project.id, nested.to_str().unwrap()).unwrap(),
            nested.canonicalize().unwrap()
        );
    }
    #[test]
    fn dispatch_fences_files_and_revisions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.txt"), "one").unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(temp.path().to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let read = dispatch(
            &db,
            "filesystem.read",
            &json!({"projectId":project.id,"path":"a.txt"}),
        )
        .unwrap()
        .unwrap();
        let fp = read["fingerprint"].as_str().unwrap();
        let write=dispatch(&db,"filesystem.write",&json!({"projectId":project.id,"path":"a.txt","content":"two","expectedFingerprint":fp,"operationId":"write-op"})).unwrap().unwrap();
        assert_eq!(write["content"], "two");
        assert!(dispatch(&db,"filesystem.write",&json!({"projectId":project.id,"path":"a.txt","content":"three","expectedFingerprint":fp,"operationId":"stale-write"})).is_err());
        let draft=dispatch(&db,"draft.put",&json!({"projectId":project.id,"path":"a.txt","content":"draft","baseFingerprint":"x","expectedRevision":0,"operationId":"draft-op"})).unwrap().unwrap();
        assert_eq!(draft["revision"], 1);
        assert!(dispatch(&db,"draft.put",&json!({"projectId":project.id,"path":"a.txt","content":"bad","baseFingerprint":"x","expectedRevision":0,"operationId":"draft-stale"})).is_err());
        assert!(dispatch(
            &db,
            "draft.list",
            &json!({"projectId":project.id,"worktreePath":temp.path().join("a.txt").to_string_lossy()})
        )
        .is_err());
        let entries = dispatch(
            &db,
            "filesystem.list",
            &json!({"projectId":project.id,"path":""}),
        )
        .unwrap()
        .unwrap();
        assert!(entries
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| !entry.get("size").is_some_and(Value::is_null)));
        fs::write(temp.path().join("pixel.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let image = dispatch(
            &db,
            "filesystem.image",
            &json!({"projectId":project.id,"path":"pixel.png"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(image["mime"], "image/png");
        assert!(dispatch(
            &db,
            "filesystem.image",
            &json!({"projectId":project.id,"path":"a.txt"})
        )
        .is_err());
        assert!(dispatch(
            &db,
            "filesystem.image",
            &json!({"projectId":project.id,"path":"../pixel.png"})
        )
        .is_err());
        let layout = json!({"kind":"pane","id":"p","tabs":[],"activeTabId":null});
        let workspace=dispatch(&db,"workspace.save",&json!({"name":"main","projectId":project.id,"worktreePath":temp.path().to_string_lossy(),"layout":layout,"expectedRevision":0,"operationId":"workspace-op"})).unwrap().unwrap();
        assert_eq!(workspace["revision"], 1);
        assert_eq!(workspace["projectId"], project.id);
        assert_eq!(
            workspace["worktreePath"].as_str(),
            Some(temp.path().to_string_lossy().as_ref())
        );
        assert!(dispatch(&db,"workspace.save",&json!({"id":workspace["id"],"name":"main","layout":workspace["layout"],"expectedRevision":0,"operationId":"workspace-stale"})).is_err());
    }
    #[test]
    fn validates_the_same_workspace_bounds_as_the_protocol() {
        let valid = json!({"kind":"split","id":"root","direction":"horizontal","ratio":0.5,"first":{"kind":"pane","id":"left","tabs":[{"id":"session","kind":"session","sessionId":"s"}],"activeTabId":"session"},"second":{"kind":"pane","id":"right","tabs":[{"id":"file","kind":"file","projectId":"p","path":"src/lib.rs"}],"activeTabId":"file"}});
        assert!(validate_layout(&valid).is_ok());
        let duplicate_ids = json!({"kind":"split","id":"same","direction":"horizontal","ratio":0.5,"first":{"kind":"pane","id":"same","tabs":[],"activeTabId":null},"second":{"kind":"pane","id":"right","tabs":[],"activeTabId":null}});
        assert!(validate_layout(&duplicate_ids).is_err());
        let invalid_tab = json!({"kind":"pane","id":"p","tabs":[{"id":"file","kind":"file","projectId":"p","path":""}],"activeTabId":"file"});
        assert!(validate_layout(&invalid_tab).is_err());
    }
    #[test]
    fn creates_lists_and_removes_a_registered_worktree_idempotently() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]).unwrap();
        git(&repo, &["config", "user.email", "tests@threadterm.invalid"]).unwrap();
        git(&repo, &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(repo.join("README.md"), "initial").unwrap();
        git(&repo, &["add", "README.md"]).unwrap();
        git(&repo, &["commit", "-m", "initial"]).unwrap();
        let db = Database::open(&parent.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let target = parent.path().join("feature");
        let params = json!({"projectId":project.id,"path":target.to_string_lossy(),"branch":"feature","createBranch":true,"operationId":"worktree-create"});
        let created = dispatch(&db, "worktree.create", &params).unwrap().unwrap();
        let replay = dispatch(&db, "worktree.create", &params).unwrap().unwrap();
        assert_eq!(created["id"], replay["id"]);
        let branches = dispatch(&db, "worktree.branches", &json!({"projectId":project.id}))
            .unwrap()
            .unwrap();
        assert!(!branches.as_array().unwrap().is_empty());
        let listed = dispatch(&db, "worktree.list", &json!({"projectId":project.id}))
            .unwrap()
            .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);
        let layout = json!({"kind":"pane","id":"main","tabs":[],"activeTabId":null});
        let workspace = dispatch(
            &db,
            "workspace.save",
            &json!({"name":"Feature","projectId":project.id,"worktreePath":created["path"],"layout":layout,"expectedRevision":0,"operationId":"workspace-save"}),
        )
        .unwrap()
        .unwrap();
        assert!(dispatch(
            &db,
            "worktree.remove",
            &json!({"id":created["id"],"operationId":"worktree-remove-blocked"}),
        )
        .unwrap_err()
        .to_string()
        .contains("worktree_saved_workspace"));
        dispatch(
            &db,
            "workspace.delete",
            &json!({"id":workspace["id"],"expectedRevision":workspace["revision"],"operationId":"workspace-delete"}),
        )
        .unwrap();
        dispatch(
            &db,
            "worktree.remove",
            &json!({"id":created["id"],"operationId":"worktree-remove"}),
        )
        .unwrap();
        assert!(!target.exists());
    }
    #[test]
    fn relocates_registered_references_without_changing_draft_or_layout_data() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]).unwrap();
        git(&repo, &["config", "user.email", "tests@threadterm.invalid"]).unwrap();
        git(&repo, &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(repo.join("README.md"), "initial").unwrap();
        git(&repo, &["add", "README.md"]).unwrap();
        git(&repo, &["commit", "-m", "initial"]).unwrap();
        let db = Database::open(&parent.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let old_path = parent.path().join("feature-old");
        let created = dispatch(
            &db,
            "worktree.create",
            &json!({"projectId":project.id,"path":old_path.to_string_lossy(),"branch":"feature","createBranch":true,"operationId":"worktree-create"}),
        )
        .unwrap()
        .unwrap();
        let old_text = created["path"].as_str().unwrap().to_owned();
        let draft = dispatch(
            &db,
            "draft.put",
            &json!({"projectId":project.id,"worktreePath":old_text,"path":"README.md","content":"draft body","baseFingerprint":"base-before-relocation","expectedRevision":0,"operationId":"draft-save"}),
        )
        .unwrap()
        .unwrap();
        let layout = json!({"kind":"pane","id":"main","tabs":[{"id":"file","kind":"file","projectId":project.id,"path":"README.md"}],"activeTabId":"file"});
        let workspace = dispatch(
            &db,
            "workspace.save",
            &json!({"name":"Feature","projectId":project.id,"worktreePath":old_text,"layout":layout,"expectedRevision":0,"operationId":"workspace-save"}),
        )
        .unwrap()
        .unwrap();
        let child_cwd = old_path.join("nested");
        fs::create_dir(&child_cwd).unwrap();
        let session = db
            .create_session(crate::db::CreateSession {
                project_id: Some(&project.id),
                title: Some("relocated terminal"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "relocation-session",
            })
            .unwrap();
        db.bind_session(&session.id, Some(child_cwd.to_str().unwrap()), None)
            .unwrap();
        crate::session_configs::save_new(
            &db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "shell".into(),
                mode: "terminal".into(),
                cwd: child_cwd.to_string_lossy().to_string(),
                project_id: Some(project.id.clone()),
                title: Some("relocated terminal".into()),
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();

        let new_path = parent.path().join("feature-new");
        git(
            &repo,
            &["worktree", "move", &old_text, new_path.to_str().unwrap()],
        )
        .unwrap();
        let relocated = dispatch(
            &db,
            "worktree.relocate",
            &json!({"id":created["id"],"path":new_path.to_string_lossy(),"operationId":"worktree-relocate"}),
        )
        .unwrap()
        .unwrap();
        let new_text = relocated["path"].as_str().unwrap();
        assert_ne!(new_text, old_text);
        let drafts = dispatch(
            &db,
            "draft.list",
            &json!({"projectId":project.id,"worktreePath":new_text}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(drafts[0]["id"], draft["id"]);
        assert_eq!(drafts[0]["content"], "draft body");
        assert_eq!(drafts[0]["baseFingerprint"], "base-before-relocation");
        assert_eq!(drafts[0]["revision"], draft["revision"]);
        let saved = db
            .snapshot()
            .unwrap()
            .workspaces
            .into_iter()
            .find(|item| item["id"] == workspace["id"])
            .unwrap();
        assert_eq!(saved["worktreePath"], new_text);
        assert_eq!(saved["layout"], layout);
        assert_eq!(saved["revision"], workspace["revision"]);
        let expected_child = new_path.join("nested");
        let expected_child = expected_child.canonicalize().unwrap();
        assert_eq!(
            db.session_by_id(&session.id)
                .unwrap()
                .unwrap()
                .worktree_path
                .as_deref(),
            expected_child.to_str()
        );
        assert_eq!(
            crate::session_configs::read(&db, &session.id)
                .unwrap()
                .unwrap()
                .launch
                .cwd,
            expected_child.to_string_lossy()
        );
    }
    #[test]
    fn removal_rejects_a_live_session_in_a_worktree_descendant() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]).unwrap();
        git(&repo, &["config", "user.email", "tests@threadterm.invalid"]).unwrap();
        git(&repo, &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(repo.join("README.md"), "initial").unwrap();
        git(&repo, &["add", "README.md"]).unwrap();
        git(&repo, &["commit", "-m", "initial"]).unwrap();
        let db = Database::open(&parent.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let worktree = parent.path().join("feature");
        let created = dispatch(
            &db,
            "worktree.create",
            &json!({"projectId":project.id,"path":worktree.to_string_lossy(),"branch":"feature","createBranch":true,"operationId":"worktree-create"}),
        )
        .unwrap()
        .unwrap();
        let child_cwd = worktree.join("nested");
        fs::create_dir(&child_cwd).unwrap();
        let session = db
            .create_session(crate::db::CreateSession {
                project_id: Some(&project.id),
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "child-session",
            })
            .unwrap();
        db.bind_session(&session.id, Some(child_cwd.to_str().unwrap()), None)
            .unwrap();
        assert!(dispatch(
            &db,
            "worktree.remove",
            &json!({"id":created["id"],"operationId":"worktree-remove"}),
        )
        .unwrap_err()
        .to_string()
        .contains("worktree_running_session"));
        assert!(worktree.exists());
    }
    #[test]
    fn reconciles_worktrees_into_the_registered_root_set() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(temp.path().to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let listed = dispatch(&db, "worktree.list", &json!({"projectId":project.id}))
            .unwrap()
            .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["isMain"], true);
        let path = listed[0]["path"].as_str().unwrap();
        let resolved = db
            .transaction(|tx| root_for(tx, &project.id, Some(path)))
            .unwrap();
        assert_eq!(resolved, temp.path().canonicalize().unwrap());
    }
}
