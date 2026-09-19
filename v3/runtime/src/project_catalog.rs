//! Durable project presentation metadata and read-only Git catalog discovery.
use crate::{db::Database, domain::SessionOrganization};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| { tx.execute_batch("CREATE TABLE IF NOT EXISTS project_catalog_metadata (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS catalog_visibility (kind TEXT NOT NULL, item_id TEXT NOT NULL, visibility TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(kind,item_id));")?; Ok(()) })
}
pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "project.catalog.list"
            | "project.update"
            | "catalog.visibility.list"
            | "catalog.visibility.update"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let value = db.transaction(|tx| match method {
        "project.catalog.list" => catalog(tx),
        "project.update" => update(tx, object, method),
        "catalog.visibility.list" => visibility_list(tx),
        "catalog.visibility.update" => visibility_update(tx, object, method),
        _ => unreachable!(),
    })?;
    Ok(Some(value))
}
fn visibility_list(tx: &Transaction<'_>) -> Result<Value> {
    let mut statement = tx.prepare(
        "SELECT targets.kind,targets.item_id,
            CASE
                WHEN targets.kind='session' AND visibility.visibility='removed' THEN 'removed'
                WHEN targets.kind='session' AND COALESCE(json_extract(organization.data,'$.archived'),0)=1 THEN 'archived'
                WHEN targets.kind='session' THEN 'active'
                ELSE COALESCE(visibility.visibility,'active')
            END,
            CASE
                WHEN targets.kind='session' THEN COALESCE(json_extract(organization.data,'$.organizationRevision'),0)
                ELSE COALESCE(visibility.revision,0)
            END,
            targets.project_id,targets.worktree_path FROM (
            SELECT 'project' AS kind,id AS item_id,NULL AS project_id,NULL AS worktree_path FROM projects
            UNION ALL SELECT 'worktree',id,project_id,path FROM worktrees
            UNION ALL SELECT 'session',id,project_id,worktree_path FROM sessions
        ) targets LEFT JOIN catalog_visibility visibility ON visibility.kind=targets.kind AND visibility.item_id=targets.item_id
        LEFT JOIN session_organization organization ON targets.kind='session' AND organization.session_id=targets.item_id
        ORDER BY CASE targets.kind WHEN 'project' THEN 0 WHEN 'worktree' THEN 1 ELSE 2 END,targets.item_id",
    )?;
    let rows = statement.query_map([], |row| {
        let mut entry = json!({
            "kind":row.get::<_, String>(0)?,"id":row.get::<_, String>(1)?,
            "visibility":row.get::<_, String>(2)?,
            "revision":row.get::<_, i64>(3)?,
        });
        if let Some(project_id) = row.get::<_, Option<String>>(4)? {
            entry["projectId"] = json!(project_id);
        }
        if let Some(worktree_path) = row.get::<_, Option<String>>(5)? {
            entry["worktreePath"] = json!(worktree_path);
        }
        Ok(entry)
    })?;
    Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?))
}
fn visibility_update(
    tx: &Transaction<'_>,
    p: &serde_json::Map<String, Value>,
    method: &str,
) -> Result<Value> {
    let kind = req(p, "kind")?;
    let id = req(p, "id")?;
    let visibility = req(p, "visibility")?;
    let operation_id = req(p, "operationId")?;
    if !matches!(kind, "project" | "worktree" | "session")
        || !matches!(visibility, "active" | "archived" | "removed")
    {
        return Err(anyhow!("invalid_catalog_visibility"));
    }
    if let Some(value) = operation(tx, operation_id)? {
        return Ok(value);
    }
    let expected = p
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| anyhow!("invalid_revision"))?;
    let (project_id, worktree_path) = visibility_target_details(tx, kind, id)?
        .ok_or_else(|| anyhow!("catalog_visibility_target_not_found"))?;
    let mut organization = (kind == "session")
        .then(|| session_organization(tx, id))
        .transpose()?;
    let current = if let Some(organization) = &organization {
        organization.organization_revision
    } else {
        tx.query_row(
            "SELECT revision FROM catalog_visibility WHERE kind=? AND item_id=?",
            params![kind, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0)
    };
    if current != expected {
        return Err(anyhow!("revision_conflict"));
    }
    if visibility != "active" && visibility_has_active_sessions(tx, kind, id)? {
        return Err(anyhow!(
            "end_active_sessions_before_changing_catalog_visibility"
        ));
    }
    let next = current + 1;
    let mut value = json!({"kind":kind,"id":id,"visibility":visibility,"revision":next});
    if let Some(project_id) = project_id {
        value["projectId"] = json!(project_id);
    }
    if let Some(worktree_path) = worktree_path {
        value["worktreePath"] = json!(worktree_path);
    }
    if let Some(organization) = &mut organization {
        organization.archived = visibility != "active";
        organization.organization_revision = next;
        tx.execute(
            "INSERT INTO session_organization(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
            params![id, serde_json::to_string(organization)?],
        )?;
        if visibility == "removed" {
            tx.execute(
                "INSERT INTO catalog_visibility(kind,item_id,visibility,revision) VALUES('session',?,'removed',?) ON CONFLICT(kind,item_id) DO UPDATE SET visibility='removed',revision=excluded.revision",
                params![id, next],
            )?;
        } else {
            tx.execute(
                "DELETE FROM catalog_visibility WHERE kind='session' AND item_id=?",
                [id],
            )?;
        }
    } else {
        tx.execute("INSERT INTO catalog_visibility(kind,item_id,visibility,revision) VALUES(?,?,?,?) ON CONFLICT(kind,item_id) DO UPDATE SET visibility=excluded.visibility,revision=excluded.revision",params![kind,id,visibility,next])?;
    }
    complete_visibility(tx, operation_id, method, &value)?;
    Ok(value)
}

fn session_organization(tx: &Transaction<'_>, id: &str) -> Result<SessionOrganization> {
    let data: Option<String> = tx
        .query_row(
            "SELECT data FROM session_organization WHERE session_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    data.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .unwrap_or_else(|| Ok(SessionOrganization::default()))
}
fn visibility_target_details(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
) -> Result<Option<(Option<String>, Option<String>)>> {
    match kind {
        "project" => tx
            .query_row("SELECT id FROM projects WHERE id=?", [id], |_| {
                Ok((None, None))
            })
            .optional()
            .map_err(Into::into),
        "worktree" => tx
            .query_row(
                "SELECT project_id,path FROM worktrees WHERE id=?",
                [id],
                |row| Ok((Some(row.get(0)?), Some(row.get(1)?))),
            )
            .optional()
            .map_err(Into::into),
        "session" => tx
            .query_row(
                "SELECT project_id,worktree_path FROM sessions WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into),
        _ => Ok(None),
    }
}
fn visibility_has_active_sessions(tx: &Transaction<'_>, kind: &str, id: &str) -> Result<bool> {
    if kind == "worktree" {
        let (project_id, root): (String, String) = tx.query_row(
            "SELECT project_id,path FROM worktrees WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut statement = tx.prepare(
            "SELECT worktree_path FROM sessions WHERE project_id=? AND read_only=0 AND status IN ('starting','running','idle','waiting')",
        )?;
        let paths = statement.query_map([project_id], |row| row.get::<_, Option<String>>(0))?;
        for path in paths {
            // Session creation persists the identity before binding its canonical
            // workspace root. Conservatively keep every tree in that project
            // visible during this short NULL-binding window.
            let Some(path) = path? else {
                return Ok(true);
            };
            if scope_path_is_within(&path, &root) {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    let query = match kind {
        "project" => "SELECT EXISTS(SELECT 1 FROM sessions WHERE project_id=? AND read_only=0 AND status IN ('starting','running','idle','waiting'))",
        "session" => "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND read_only=0 AND status IN ('starting','running','idle','waiting'))",
        _ => return Ok(false),
    };
    Ok(tx.query_row(query, [id], |row| row.get::<_, i64>(0))? != 0)
}

fn scope_path_is_within(path: &str, root: &str) -> bool {
    let Some(path) = scope_components(path) else {
        return false;
    };
    let Some(root) = scope_components(root) else {
        return false;
    };
    path.len() >= root.len()
        && path
            .iter()
            .zip(root.iter())
            .all(|(path_component, root_component)| path_component == root_component)
}

fn scope_components(value: &str) -> Option<Vec<String>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    #[cfg(windows)]
    let path = {
        let mut normalized = value.replace('/', "\\");
        let lower = normalized.to_ascii_lowercase();
        if lower.starts_with(r"\\?\unc\") {
            normalized = format!(r"\\{}", &normalized[8..]);
        } else if lower.starts_with(r"\\?\") {
            normalized = normalized[4..].to_owned();
        }
        PathBuf::from(normalized)
    };
    #[cfg(not(windows))]
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return None;
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => return None,
            _ => {
                #[cfg(windows)]
                let key = component.as_os_str().to_string_lossy().to_lowercase();
                #[cfg(not(windows))]
                let key = component.as_os_str().to_string_lossy().to_string();
                components.push(key);
            }
        }
    }
    Some(components)
}
fn catalog(tx: &Transaction<'_>) -> Result<Value> {
    let mut stmt=tx.prepare("SELECT p.id,p.name,p.path,p.created_at,COALESCE(m.revision,0),COALESCE(m.pinned,0),COALESCE(m.sort_order,0) FROM projects p LEFT JOIN project_catalog_metadata m ON m.project_id=p.id ORDER BY COALESCE(m.pinned,0) DESC,COALESCE(m.sort_order,0),p.name,p.id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, path, created, revision, pinned, order) = row?;
        out.push(json!({"id":id,"name":name,"path":path,"createdAt":created,"revision":revision,"pinned":pinned!=0,"sortOrder":order,"git":git_catalog(Path::new(&path))}));
    }
    Ok(json!(out))
}
fn update(tx: &Transaction<'_>, p: &serde_json::Map<String, Value>, method: &str) -> Result<Value> {
    let id = req(p, "id")?;
    let op = req(p, "operationId")?;
    if let Some(value) = operation(tx, op)? {
        return Ok(value);
    }
    let expected = p
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or_else(|| anyhow!("invalid_revision"))?;
    let current:(String,String,i64,i64,i64)=tx.query_row("SELECT p.name,p.path,COALESCE(m.revision,0),COALESCE(m.pinned,0),COALESCE(m.sort_order,0) FROM projects p LEFT JOIN project_catalog_metadata m ON m.project_id=p.id WHERE p.id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if current.2 != expected {
        return Err(anyhow!("revision_conflict"));
    }
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&current.0);
    let pinned = p
        .get("pinned")
        .and_then(Value::as_bool)
        .map(i64::from)
        .unwrap_or(current.3);
    let order = p
        .get("sortOrder")
        .and_then(Value::as_i64)
        .unwrap_or(current.4);
    if order < 0
        || (!p.contains_key("name") && !p.contains_key("pinned") && !p.contains_key("sortOrder"))
    {
        return Err(anyhow!("invalid_request"));
    }
    tx.execute("UPDATE projects SET name=? WHERE id=?", params![name, id])?;
    tx.execute("INSERT INTO project_catalog_metadata(project_id,revision,pinned,sort_order) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,pinned=excluded.pinned,sort_order=excluded.sort_order",params![id,expected+1,pinned,order])?;
    let created_at: String =
        tx.query_row("SELECT created_at FROM projects WHERE id=?", [id], |row| {
            row.get(0)
        })?;
    let value = json!({"id":id,"name":name,"path":current.1,"createdAt":created_at,"revision":expected+1,"pinned":pinned!=0,"sortOrder":order,"git":git_catalog(Path::new(&current.1))});
    complete(tx, op, method, &value)?;
    Ok(value)
}
fn git_catalog(root: &Path) -> Value {
    let branch = git(root, &["branch", "--show-current"])
        .ok()
        .filter(|s| !s.is_empty());
    let upstream = git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .ok()
        .filter(|s| !s.is_empty());
    let commit = git(root, &["log", "-1", "--format=%H%x1f%s%x1f%cI"])
        .ok()
        .and_then(|line| {
            let mut p = line.split('\u{1f}');
            Some(json!({"id":p.next()?,"subject":p.next()?,"committedAt":p.next()?}))
        });
    let mut result = json!({"available":git(root, &["rev-parse", "--git-dir"]).is_ok()});
    if let Some(branch) = branch {
        result["branch"] = json!(branch);
    }
    if let Some(upstream) = upstream {
        result["upstream"] = json!(upstream);
    }
    if let Some(commit) = commit {
        result["lastCommit"] = commit;
    }
    result
}
fn git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).current_dir(root).output()?;
    if !out.status.success() {
        return Err(anyhow!("git_failed"));
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}
fn req<'a>(p: &'a serde_json::Map<String, Value>, k: &str) -> Result<&'a str> {
    p.get(k)
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn operation(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row("SELECT result FROM operations WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn complete(tx: &Transaction<'_>, op: &str, method: &str, value: &Value) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![op, method, serde_json::to_string(value)?, now],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            json!({"kind":"project.catalog"}).to_string(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}
fn complete_visibility(tx: &Transaction<'_>, op: &str, method: &str, value: &Value) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![op, method, serde_json::to_string(value)?, now],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            json!({"kind":"catalog.visibility"}).to_string(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use crate::domain::SessionOrganize;

    fn visibility_fixture() -> (tempfile::TempDir, Database, crate::domain::Project, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("catalog.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(dir.path().to_str().unwrap(), Some("Project"), "project")
            .unwrap();
        let worktree_id = "worktree".to_owned();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,?,?,?,?)",
                params![&worktree_id, &project.id, dir.path().join("tree").to_string_lossy(), "topic", "head", 0, 0],
            )?;
            Ok(())
        })
        .unwrap();
        (dir, db, project, worktree_id)
    }

    fn listed_session_visibility(db: &Database, session_id: &str) -> Value {
        dispatch(db, "catalog.visibility.list", &json!({}))
            .unwrap()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["kind"] == "session" && entry["id"] == session_id)
            .unwrap()
            .clone()
    }

    #[test]
    fn metadata_is_revision_fenced_and_sorted() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("catalog.sqlite")).unwrap();
        initialize(&db).unwrap();
        let a = db
            .add_project(dir.path().to_str().unwrap(), Some("A"), "a")
            .unwrap();
        let b = db
            .add_project(dir.path().join("b").to_str().unwrap(), Some("B"), "b")
            .unwrap();
        let updated=dispatch(&db,"project.update",&json!({"id":b.id,"pinned":true,"sortOrder":2,"expectedRevision":0,"operationId":"pin"})).unwrap().unwrap();
        assert_eq!(updated["revision"], 1);
        assert_eq!(updated["pinned"], true);
        assert_eq!(updated["createdAt"], b.created_at);
        assert_eq!(updated["git"], json!({"available":false}));
        let catalog = dispatch(&db, "project.catalog.list", &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(catalog[0]["id"], b.id);
        assert!(dispatch(
            &db,
            "project.update",
            &json!({"id":a.id,"name":"Renamed","expectedRevision":1,"operationId":"stale"})
        )
        .is_err());
    }

    #[test]
    fn catalog_visibility_is_durable_revision_fenced_and_idempotent() {
        let (dir, db, project, worktree_id) = visibility_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Saved"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "session",
            })
            .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let initial = dispatch(&db, "catalog.visibility.list", &json!({}))
            .unwrap()
            .unwrap();
        assert!(initial.as_array().unwrap().iter().any(|entry| entry
            == &json!({"kind":"project","id":project.id,"visibility":"active","revision":0})));
        assert!(initial.as_array().unwrap().iter().any(|entry| entry
            == &json!({"kind":"worktree","id":worktree_id,"visibility":"active","revision":0,"projectId":project.id,"worktreePath":dir.path().join("tree").to_string_lossy()})));
        let request = json!({"kind":"session","id":session.id,"visibility":"archived","expectedRevision":0,"operationId":"archive"});
        let archived = dispatch(&db, "catalog.visibility.update", &request)
            .unwrap()
            .unwrap();
        assert_eq!(archived["visibility"], "archived");
        assert_eq!(archived["revision"], 1);
        assert_eq!(archived["projectId"], project.id);
        let event = db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT data FROM outbox ORDER BY seq DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap(),
            json!({"kind":"catalog.visibility"})
        );
        assert_eq!(
            dispatch(&db, "catalog.visibility.update", &request)
                .unwrap()
                .unwrap(),
            archived
        );
        assert!(dispatch(&db, "catalog.visibility.update", &json!({"kind":"session","id":session.id,"visibility":"removed","expectedRevision":0,"operationId":"stale"})).is_err());
        let path = dir.path().join("catalog.sqlite");
        drop(db);
        let reopened = Database::open(&path).unwrap();
        crate::workspace_services::initialize(&reopened).unwrap();
        initialize(&reopened).unwrap();
        assert!(dispatch(&reopened, "catalog.visibility.list", &json!({}))
            .unwrap()
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&archived));
    }

    #[test]
    fn catalog_visibility_requires_active_sessions_to_end_but_allows_restore() {
        let (_dir, db, project, worktree_id) = visibility_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Active"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "active-session",
            })
            .unwrap();
        db.transaction(|tx| {
            tx.execute("UPDATE sessions SET worktree_path=(SELECT path FROM worktrees WHERE id=?) WHERE id=?", params![&worktree_id, &session.id])?;
            Ok(())
        })
        .unwrap();
        for request in [
            json!({"kind":"session","id":session.id,"visibility":"archived","expectedRevision":0,"operationId":"active-session-visibility"}),
            json!({"kind":"project","id":project.id,"visibility":"removed","expectedRevision":0,"operationId":"active-project-visibility"}),
            json!({"kind":"worktree","id":worktree_id,"visibility":"archived","expectedRevision":0,"operationId":"active-worktree-visibility"}),
        ] {
            assert!(dispatch(&db, "catalog.visibility.update", &request)
                .unwrap_err()
                .to_string()
                .contains("end_active_sessions"));
        }
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let archived = dispatch(&db, "catalog.visibility.update", &json!({"kind":"session","id":session.id,"visibility":"archived","expectedRevision":0,"operationId":"archive-ended"})).unwrap().unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        let restored = dispatch(&db, "catalog.visibility.update", &json!({"kind":"session","id":session.id,"visibility":"active","expectedRevision":archived["revision"],"operationId":"restore-active"})).unwrap().unwrap();
        assert_eq!(restored["visibility"], "active");
        assert!(dispatch(&db, "catalog.visibility.update", &json!({"kind":"unknown","id":"missing","visibility":"active","expectedRevision":0,"operationId":"invalid"})).is_err());
        assert!(dispatch(&db, "catalog.visibility.update", &json!({"kind":"project","id":"missing","visibility":"active","expectedRevision":0,"operationId":"missing"})).unwrap_err().to_string().contains("target_not_found"));
    }

    #[test]
    fn session_archive_state_interoperates_with_organization_in_both_directions() {
        let (_dir, db, project, _worktree_id) = visibility_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Interoperable"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "interop-session",
            })
            .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();

        let archived = db
            .organize_session(&SessionOrganize {
                session_id: session.id.clone(),
                archived: Some(true),
                pinned: None,
                bookmarked: None,
                intent: None,
                sort_order: None,
                expected_revision: 0,
                operation_id: "organize-archive".into(),
            })
            .unwrap();
        assert_eq!(archived.organization.organization_revision, 1);
        let listed = listed_session_visibility(&db, &session.id);
        assert_eq!(listed["visibility"], "archived");
        assert_eq!(listed["revision"], 1);

        let active = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"session","id":session.id,"visibility":"active","expectedRevision":1,"operationId":"catalog-restore"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(active["visibility"], "active");
        assert_eq!(active["revision"], 2);
        let restored = db.session_by_id(&session.id).unwrap().unwrap();
        assert!(!restored.organization.archived);
        assert_eq!(restored.organization.organization_revision, 2);

        let archived = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"session","id":session.id,"visibility":"archived","expectedRevision":2,"operationId":"catalog-archive"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(archived["revision"], 3);
        let restored = db
            .organize_session(&SessionOrganize {
                session_id: session.id.clone(),
                archived: Some(false),
                pinned: None,
                bookmarked: None,
                intent: None,
                sort_order: None,
                expected_revision: 3,
                operation_id: "organize-restore".into(),
            })
            .unwrap();
        assert_eq!(restored.organization.organization_revision, 4);
        let listed = listed_session_visibility(&db, &session.id);
        assert_eq!(listed["visibility"], "active");
        assert_eq!(listed["revision"], 4);
    }

    #[test]
    fn session_removal_preserves_organization_and_shares_one_revision_fence() {
        let (_dir, db, project, _worktree_id) = visibility_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Removable"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "removal-session",
            })
            .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let organized = db
            .organize_session(&SessionOrganize {
                session_id: session.id.clone(),
                archived: None,
                pinned: Some(true),
                bookmarked: Some(true),
                intent: Some("review".into()),
                sort_order: Some(42),
                expected_revision: 0,
                operation_id: "seed-organization".into(),
            })
            .unwrap();
        assert_eq!(organized.organization.organization_revision, 1);
        let outbox_before: i64 = db
            .transaction(|tx| {
                tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();

        let removed = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"session","id":session.id,"visibility":"removed","expectedRevision":1,"operationId":"catalog-remove"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(removed["revision"], 2);
        let (outbox_after, removal_state): (i64, (String, i64)) = db
            .transaction(|tx| {
                Ok((
                    tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?,
                    tx.query_row(
                        "SELECT visibility,revision FROM catalog_visibility WHERE kind='session' AND item_id=?",
                        [&session.id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(outbox_after, outbox_before + 1);
        assert_eq!(removal_state, ("removed".into(), 2));
        let saved = db.session_by_id(&session.id).unwrap().unwrap();
        assert!(saved.organization.archived);
        assert!(saved.organization.pinned);
        assert!(saved.organization.bookmarked);
        assert_eq!(saved.organization.intent.as_deref(), Some("review"));
        assert_eq!(saved.organization.sort_order, 42);
        assert_eq!(saved.organization.organization_revision, 2);

        assert!(db
            .organize_session(&SessionOrganize {
                session_id: session.id.clone(),
                archived: Some(false),
                pinned: None,
                bookmarked: None,
                intent: None,
                sort_order: None,
                expected_revision: 1,
                operation_id: "stale-organize-restore".into(),
            })
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        let organized = db
            .organize_session(&SessionOrganize {
                session_id: session.id.clone(),
                archived: Some(false),
                pinned: None,
                bookmarked: None,
                intent: None,
                sort_order: None,
                expected_revision: 2,
                operation_id: "organize-restore-removed".into(),
            })
            .unwrap();
        assert_eq!(organized.organization.organization_revision, 3);
        let listed = listed_session_visibility(&db, &session.id);
        assert_eq!(listed["visibility"], "removed");
        assert_eq!(listed["revision"], 3);

        assert!(dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"session","id":session.id,"visibility":"active","expectedRevision":2,"operationId":"stale-catalog-restore"}),
        )
        .unwrap_err()
        .to_string()
        .contains("revision_conflict"));
        let restored = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"session","id":session.id,"visibility":"active","expectedRevision":3,"operationId":"catalog-restore-removed"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(restored["revision"], 4);
        assert_eq!(listed_session_visibility(&db, &session.id), restored);
        let catalog_row_count: i64 = db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT COUNT(*) FROM catalog_visibility WHERE kind='session' AND item_id=?",
                    [&session.id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(catalog_row_count, 0);
        let saved = db.session_by_id(&session.id).unwrap().unwrap();
        assert!(!saved.organization.archived);
        assert!(saved.organization.pinned && saved.organization.bookmarked);
        assert_eq!(saved.organization.intent.as_deref(), Some("review"));
        assert_eq!(saved.organization.sort_order, 42);
        assert_eq!(saved.organization.organization_revision, 4);
    }

    #[test]
    fn worktree_visibility_blocks_canonical_nested_and_unbound_live_sessions() {
        let (dir, db, project, worktree_id) = visibility_fixture();
        let tree_path: String = db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT path FROM worktrees WHERE id=?",
                    [&worktree_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Binding"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "binding-session",
            })
            .unwrap();
        let blocked = |operation_id: &str| {
            assert!(dispatch(
                &db,
                "catalog.visibility.update",
                &json!({"kind":"worktree","id":worktree_id,"visibility":"archived","expectedRevision":0,"operationId":operation_id}),
            )
            .unwrap_err()
            .to_string()
            .contains("end_active_sessions"));
        };

        // create_session and bind_session are separate transactions. A live,
        // same-project session with no path must fence every worktree until its
        // canonical root is bound.
        blocked("archive-unbound");

        for (index, path) in [
            tree_path.clone(),
            Path::new(&tree_path)
                .join("nested")
                .to_string_lossy()
                .into_owned(),
        ]
        .into_iter()
        .enumerate()
        {
            db.transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET worktree_path=? WHERE id=?",
                    params![path, &session.id],
                )?;
                Ok(())
            })
            .unwrap();
            blocked(&format!("archive-scoped-{index}"));
        }

        #[cfg(windows)]
        {
            let alias = if tree_path.to_ascii_lowercase().starts_with(r"\\?\") {
                tree_path[4..].replace('\\', "/").to_ascii_uppercase()
            } else {
                format!(r"\\?\{}", tree_path.replace('\\', "/").to_ascii_uppercase())
            };
            db.transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET worktree_path=? WHERE id=?",
                    params![alias, &session.id],
                )?;
                Ok(())
            })
            .unwrap();
            blocked("archive-windows-alias");
        }

        // Read-only history is not a live job and must not fence presentation.
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET worktree_path=?,read_only=1 WHERE id=?",
                params![&tree_path, &session.id],
            )?;
            Ok(())
        })
        .unwrap();
        let archived = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"worktree","id":worktree_id,"visibility":"archived","expectedRevision":0,"operationId":"archive-read-only"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(archived["revision"], 1);
        dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"worktree","id":worktree_id,"visibility":"active","expectedRevision":1,"operationId":"restore-before-project-scope"}),
        )
        .unwrap();

        // A malformed association in another project must not block this one.
        let other = db
            .add_project(
                dir.path().join("other").to_str().unwrap(),
                Some("Other"),
                "other-project",
            )
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET project_id=?,worktree_path=NULL,read_only=0 WHERE id=?",
                params![other.id, &session.id],
            )?;
            Ok(())
        })
        .unwrap();
        let archived = dispatch(
            &db,
            "catalog.visibility.update",
            &json!({"kind":"worktree","id":worktree_id,"visibility":"archived","expectedRevision":2,"operationId":"archive-other-project-live"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(archived["revision"], 3);
    }

    #[cfg(windows)]
    #[test]
    fn scope_comparison_accepts_windows_drive_and_unc_aliases() {
        assert!(scope_path_is_within(
            r"\\?\C:\Work\Repo\tree\nested\",
            r"c:/work/repo/tree",
        ));
        assert!(scope_path_is_within(
            r"\\?\UNC\Server\Share\Repo\tree",
            r"\\server\share\repo",
        ));
        assert!(!scope_path_is_within(
            r"C:\Work\Repository",
            r"C:\Work\Repo",
        ));
    }
}
