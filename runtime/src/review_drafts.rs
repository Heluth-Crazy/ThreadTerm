//! Revisioned review-comment drafts and their desktop-owned asset references.
use crate::db::Database;
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MAX_DRAFT_BYTES: usize = 1024 * 1024;
const MAX_ASSET_PATHS: usize = 64;
const MAX_ASSET_PATH_BYTES: usize = 16 * 1024;
const MAX_PAGE_ROWS: usize = 200;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const LEGACY_IMPORT_MARKER: &str = "review-comments-local-storage-v1";

pub fn read(db: &Database, method: &str, params_value: &Value) -> Result<Value> {
    db.transaction(|tx| match method {
        "reviewDrafts.list" => Ok(list(tx, params_value)?),
        "reviewDrafts.assetReferences" => {
            let mut statement = tx.prepare(
                "SELECT DISTINCT asset.path FROM review_draft_assets asset
                 JOIN review_drafts draft ON draft.draft_id=asset.draft_id
                 WHERE draft.deleted=0 AND (? IS NULL OR asset.path>?) ORDER BY asset.path LIMIT ?",
            )?;
            let after = optional_string(params_value, "after")?;
            let limit = page_limit(params_value)?;
            let mut paths = Vec::new();
            let mut bytes = 0;
            let mut more = false;
            for path in statement.query_map(
                params![after.as_deref(), after.as_deref(), limit + 1],
                |row| row.get::<_, String>(0),
            )? {
                let path = path?;
                if paths.len() >= limit
                    || (!paths.is_empty() && bytes + path.len() > MAX_PAGE_BYTES)
                {
                    more = true;
                    break;
                }
                bytes += path.len();
                paths.push(path);
            }
            let legacy_import_complete = tx
                .query_row(
                    "SELECT 1 FROM review_draft_imports WHERE marker=?",
                    [LEGACY_IMPORT_MARKER],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let mut result = json!({"paths":paths,"legacyImportComplete":legacy_import_complete});
            if more {
                result["nextAfter"] = json!(paths.last().cloned().expect("paged paths"));
            }
            Ok(result)
        }
        _ => Err(anyhow!("invalid_request")),
    })
}

pub fn mutate(db: &Database, method: &str, params_value: &Value) -> Result<Value> {
    db.transaction(|tx| {
        let operation_id = required_string(params_value, "operationId")?;
        if let Some(result) = prior_operation(tx, operation_id)? {
            return Ok(result);
        }
        let result = match method {
            "reviewDrafts.upsert" => upsert(tx, params_value)?,
            "reviewDrafts.delete" => delete(tx, params_value)?,
            "reviewDrafts.importLegacy" => import_legacy(tx, params_value)?,
            _ => return Err(anyhow!("invalid_request")),
        };
        complete(tx, operation_id, method, &result)?;
        Ok(result)
    })
}

fn upsert(tx: &Transaction<'_>, params_value: &Value) -> Result<Value> {
    let draft_id = required_string(params_value, "draftId")?;
    let expected = required_i64(params_value, "expectedRevision")?;
    if expected < 0 {
        return Err(anyhow!("invalid_request"));
    }
    let draft = params_value
        .get("draft")
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let content_json = serde_json::to_string(draft)?;
    if content_json.len() > MAX_DRAFT_BYTES {
        return Err(anyhow!("draft_too_large"));
    }
    let assets = asset_paths(params_value)?;
    let current = row(tx, draft_id)?;
    if current.as_ref().map(|value| value.revision).unwrap_or(0) != expected {
        return Ok(conflict(current));
    }
    let revision = expected + 1;
    let scope_project_id = optional_string(params_value, "scopeProjectId")?;
    let scope_root = optional_string(params_value, "scopeRoot")?;
    let updated_at = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO review_drafts(draft_id,scope_project_id,scope_root,content_json,revision,deleted,updated_at)
         VALUES(?,?,?,?,?,0,?)
         ON CONFLICT(draft_id) DO UPDATE SET scope_project_id=excluded.scope_project_id,
             scope_root=excluded.scope_root,content_json=excluded.content_json,revision=excluded.revision,
             deleted=0,updated_at=excluded.updated_at",
        params![draft_id, scope_project_id, scope_root, content_json, revision, updated_at],
    )?;
    replace_assets(tx, draft_id, &assets)?;
    let draft = row(tx, draft_id)?.expect("inserted review draft");
    changed(tx, draft_id, revision)?;
    Ok(json!({"status":"ok","draft":draft.value()}))
}

fn delete(tx: &Transaction<'_>, params_value: &Value) -> Result<Value> {
    let draft_id = required_string(params_value, "draftId")?;
    let expected = required_i64(params_value, "expectedRevision")?;
    if expected < 0 {
        return Err(anyhow!("invalid_request"));
    }
    let current = row(tx, draft_id)?;
    if current.as_ref().map(|value| value.revision).unwrap_or(0) != expected {
        return Ok(conflict(current));
    }
    let revision = expected + 1;
    let updated_at = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO review_drafts(draft_id,content_json,revision,deleted,updated_at) VALUES(?, '{}', ?, 1, ?)
         ON CONFLICT(draft_id) DO UPDATE SET revision=excluded.revision,deleted=1,updated_at=excluded.updated_at",
        params![draft_id, revision, updated_at],
    )?;
    tx.execute(
        "DELETE FROM review_draft_assets WHERE draft_id=?",
        [draft_id],
    )?;
    changed(tx, draft_id, revision)?;
    Ok(json!({"status":"deleted","draftId":draft_id,"revision":revision}))
}

fn import_legacy(tx: &Transaction<'_>, params_value: &Value) -> Result<Value> {
    let marker = required_string(params_value, "marker")?;
    if tx
        .query_row(
            "SELECT 1 FROM review_draft_imports WHERE marker=?",
            [marker],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(json!({"imported":false,"complete":true}));
    }
    let drafts = params_value
        .get("drafts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let complete = match params_value.get("complete") {
        None => true,
        Some(Value::Bool(complete)) => *complete,
        Some(_) => return Err(anyhow!("invalid_request")),
    };
    for candidate in drafts {
        let draft_id = required_string(candidate, "draftId")?;
        let draft = candidate
            .get("draft")
            .ok_or_else(|| anyhow!("invalid_request"))?;
        let content_json = serde_json::to_string(draft)?;
        if content_json.len() > MAX_DRAFT_BYTES {
            return Err(anyhow!("draft_too_large"));
        }
        if row(tx, draft_id)?.is_some() {
            continue;
        }
        let updated_at = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO review_drafts(draft_id,scope_project_id,scope_root,content_json,revision,deleted,updated_at)
             VALUES(?,?,?,?,1,0,?)",
            params![draft_id, optional_string(candidate, "scopeProjectId")?, optional_string(candidate, "scopeRoot")?, content_json, updated_at],
        )?;
        replace_assets(tx, draft_id, &asset_paths(candidate)?)?;
    }
    if complete {
        tx.execute(
            "INSERT INTO review_draft_imports(marker,imported_at) VALUES(?,?)",
            params![marker, Utc::now().to_rfc3339()],
        )?;
    }
    changed(tx, "", 0)?;
    Ok(json!({"imported":true,"complete":complete}))
}

#[derive(Debug)]
struct DraftRow {
    draft_id: String,
    scope_project_id: Option<String>,
    scope_root: Option<String>,
    content_json: String,
    revision: i64,
    deleted: bool,
    updated_at: String,
}
impl DraftRow {
    fn value(&self) -> Value {
        let mut value = json!({"draftId":self.draft_id,"draft":serde_json::from_str::<Value>(&self.content_json).unwrap_or(Value::Null),"revision":self.revision,"deleted":self.deleted,"updatedAt":self.updated_at});
        let object = value.as_object_mut().expect("review draft object");
        if let Some(project_id) = self.scope_project_id.as_ref() {
            object.insert("scopeProjectId".into(), json!(project_id));
        }
        if let Some(root) = self.scope_root.as_ref() {
            object.insert("scopeRoot".into(), json!(root));
        }
        value
    }
}

fn row(tx: &Transaction<'_>, draft_id: &str) -> Result<Option<DraftRow>> {
    tx.query_row("SELECT draft_id,scope_project_id,scope_root,content_json,revision,deleted,updated_at FROM review_drafts WHERE draft_id=?", [draft_id], |row| Ok(DraftRow { draft_id: row.get(0)?, scope_project_id: row.get(1)?, scope_root: row.get(2)?, content_json: row.get(3)?, revision: row.get(4)?, deleted: row.get::<_, i64>(5)? != 0, updated_at: row.get(6)? })).optional().map_err(Into::into)
}

fn list(tx: &Transaction<'_>, filter: &Value) -> Result<Value> {
    let project_id = optional_string(filter, "scopeProjectId")?;
    let root = optional_string(filter, "scopeRoot")?;
    let after = optional_string(filter, "after")?;
    let limit = page_limit(filter)?;
    let mut statement = tx.prepare("SELECT draft_id,scope_project_id,scope_root,content_json,revision,deleted,updated_at FROM review_drafts WHERE deleted=0 AND (? IS NULL OR scope_project_id=?) AND (? IS NULL OR scope_root=?) AND (? IS NULL OR draft_id>?) ORDER BY draft_id LIMIT ?")?;
    let rows = statement.query_map(
        params![
            project_id.as_deref(),
            project_id.as_deref(),
            root.as_deref(),
            root.as_deref(),
            after.as_deref(),
            after.as_deref(),
            limit + 1,
        ],
        |row| {
            Ok(DraftRow {
                draft_id: row.get(0)?,
                scope_project_id: row.get(1)?,
                scope_root: row.get(2)?,
                content_json: row.get(3)?,
                revision: row.get(4)?,
                deleted: row.get::<_, i64>(5)? != 0,
                updated_at: row.get(6)?,
            })
        },
    )?;
    let mut drafts = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    for row in rows {
        let draft = row?.value();
        let size = serde_json::to_vec(&draft)?.len();
        if drafts.len() >= limit || (!drafts.is_empty() && bytes + size > MAX_PAGE_BYTES) {
            more = true;
            break;
        }
        bytes += size;
        drafts.push(draft);
    }
    let mut result = json!({"drafts":drafts});
    if more {
        result["nextAfter"] = json!(drafts
            .last()
            .and_then(|draft| draft.get("draftId"))
            .and_then(Value::as_str)
            .expect("paged drafts"));
    }
    Ok(result)
}

fn conflict(current: Option<DraftRow>) -> Value {
    json!({"status":"conflict","draft":current.map(|draft| draft.value())})
}

fn replace_assets(tx: &Transaction<'_>, draft_id: &str, paths: &[String]) -> Result<()> {
    tx.execute(
        "DELETE FROM review_draft_assets WHERE draft_id=?",
        [draft_id],
    )?;
    for path in paths {
        tx.execute(
            "INSERT INTO review_draft_assets(draft_id,path) VALUES(?,?)",
            params![draft_id, path],
        )?;
    }
    Ok(())
}

fn asset_paths(value: &Value) -> Result<Vec<String>> {
    let values = value
        .get("assetPaths")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if values.len() > MAX_ASSET_PATHS {
        return Err(anyhow!("invalid_request"));
    }
    let mut paths = BTreeSet::new();
    for value in values {
        let path = value.as_str().ok_or_else(|| anyhow!("invalid_request"))?;
        if path.is_empty() || path.len() > MAX_ASSET_PATH_BYTES {
            return Err(anyhow!("invalid_request"));
        }
        paths.insert(path.to_owned());
    }
    Ok(paths.into_iter().collect())
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    let value = value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if value.len() > 1024 {
        return Err(anyhow!("invalid_request"));
    }
    Ok(value)
}
fn optional_string(value: &Value, field: &str) -> Result<Option<String>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= MAX_ASSET_PATH_BYTES => {
            Ok(Some(value.clone()))
        }
        _ => Err(anyhow!("invalid_request")),
    }
}
fn required_i64(value: &Value, field: &str) -> Result<i64> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn page_limit(value: &Value) -> Result<usize> {
    match value.get("limit") {
        None => Ok(100),
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=MAX_PAGE_ROWS as u64).contains(value))
            .map(|value| value as usize)
            .ok_or_else(|| anyhow!("invalid_request")),
    }
}
fn prior_operation(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    tx.query_row("SELECT result FROM operations WHERE id=?", [id], |row| {
        row.get::<_, String>(0)
    })
    .optional()?
    .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
    .transpose()
}
fn complete(tx: &Transaction<'_>, id: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            id,
            method,
            serde_json::to_string(result)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}
fn changed(tx: &Transaction<'_>, draft_id: &str, revision: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            serde_json::to_string(
                &json!({"kind":"reviewDrafts","draftId":draft_id,"revision":revision})
            )?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    fn draft(id: &str, body: &str) -> Value {
        json!({"draftId":id,"draft":{"id":id,"body":body},"assetPaths":[format!("shots/{id}.png")]})
    }
    fn upsert(db: &Database, id: &str, body: &str, expected: i64, operation: &str) -> Value {
        let mut value = draft(id, body);
        value["expectedRevision"] = json!(expected);
        value["operationId"] = json!(operation);
        mutate(db, "reviewDrafts.upsert", &value).unwrap()
    }
    #[test]
    fn revisions_conflict_without_losing_the_confirmed_draft() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        assert_eq!(upsert(&db, "a", "first", 0, "one")["status"], "ok");
        let stale = upsert(&db, "a", "stale", 0, "two");
        assert_eq!(stale["status"], "conflict");
        assert_eq!(stale["draft"]["draft"]["body"], "first");
        assert_eq!(
            read(&db, "reviewDrafts.list", &json!({})).unwrap()["drafts"][0]["draft"]["body"],
            "first"
        );
    }
    #[test]
    fn legacy_import_is_marker_scoped_and_does_not_overwrite_rows() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let mut request = json!({"marker":"legacy-key","drafts":[draft("a","legacy")],"operationId":"import-one"});
        assert_eq!(
            mutate(&db, "reviewDrafts.importLegacy", &request).unwrap()["imported"],
            true
        );
        request["operationId"] = json!("import-two");
        request["drafts"][0]["draft"]["body"] = json!("replacement");
        assert_eq!(
            mutate(&db, "reviewDrafts.importLegacy", &request).unwrap()["imported"],
            false
        );
        assert_eq!(
            read(&db, "reviewDrafts.list", &json!({})).unwrap()["drafts"][0]["draft"]["body"],
            "legacy"
        );
    }

    #[test]
    fn partial_legacy_import_stays_unready_until_its_final_batch() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let partial = json!({"marker":LEGACY_IMPORT_MARKER,"drafts":[draft("a","first")],"complete":false,"operationId":"partial"});
        assert_eq!(
            mutate(&db, "reviewDrafts.importLegacy", &partial).unwrap()["complete"],
            false
        );
        assert_eq!(
            read(&db, "reviewDrafts.assetReferences", &json!({})).unwrap()["legacyImportComplete"],
            false
        );
        let retried = json!({"marker":LEGACY_IMPORT_MARKER,"drafts":[draft("a","replacement")],"complete":false,"operationId":"partial-retry"});
        mutate(&db, "reviewDrafts.importLegacy", &retried).unwrap();
        let final_batch = json!({"marker":LEGACY_IMPORT_MARKER,"drafts":[draft("b","second")],"complete":true,"operationId":"final"});
        assert_eq!(
            mutate(&db, "reviewDrafts.importLegacy", &final_batch).unwrap()["complete"],
            true
        );
        assert_eq!(
            read(&db, "reviewDrafts.assetReferences", &json!({})).unwrap()["legacyImportComplete"],
            true
        );
        let rows = read(&db, "reviewDrafts.list", &json!({"limit":200})).unwrap();
        assert_eq!(rows["drafts"].as_array().unwrap().len(), 2);
        assert_eq!(rows["drafts"][0]["draft"]["body"], "first");
    }
    #[test]
    fn tombstones_prevent_stale_resurrection_and_release_assets() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        upsert(&db, "a", "first", 0, "one");
        assert_eq!(
            read(&db, "reviewDrafts.assetReferences", &json!({})).unwrap()["paths"],
            json!(["shots/a.png"])
        );
        let deleted = mutate(
            &db,
            "reviewDrafts.delete",
            &json!({"draftId":"a","expectedRevision":1,"operationId":"delete"}),
        )
        .unwrap();
        assert_eq!(deleted["status"], "deleted");
        assert_eq!(
            read(&db, "reviewDrafts.assetReferences", &json!({})).unwrap()["paths"],
            json!([])
        );
        assert_eq!(upsert(&db, "a", "stale", 1, "stale")["status"], "conflict");
    }

    #[test]
    fn concurrent_windows_keep_distinct_comments_and_fence_stale_writes() {
        let temp = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&temp.path().join("runtime.sqlite")).unwrap());
        let barrier = Arc::new(Barrier::new(3));
        let writer = |id: &'static str, body: &'static str, operation: &'static str| {
            let db = Arc::clone(&db);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                upsert(&db, id, body, 0, operation)
            })
        };
        let first = writer("first", "one", "one");
        let second = writer("second", "two", "two");
        barrier.wait();
        assert_eq!(first.join().unwrap()["status"], "ok");
        assert_eq!(second.join().unwrap()["status"], "ok");
        assert_eq!(
            read(&db, "reviewDrafts.list", &json!({"limit":200})).unwrap()["drafts"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let barrier = Arc::new(Barrier::new(3));
        let stale = |body: &'static str, operation: &'static str| {
            let db = Arc::clone(&db);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                upsert(&db, "same", body, 0, operation)
            })
        };
        let left = stale("left", "left");
        let right = stale("right", "right");
        barrier.wait();
        let outcomes = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome["status"] == "ok")
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome["status"] == "conflict")
                .count(),
            1
        );
    }
}
