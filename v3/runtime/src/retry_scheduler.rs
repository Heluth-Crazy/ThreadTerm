//! Persisted, opt-in terminal retry policy. Scheduling never launches a process;
//! RuntimeService owns the explicit rerun action after an attempt is atomically claimed.
use crate::{db::Database, session_configs};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const DEFAULT_MAX_RETRIES: i64 = 1;
const DEFAULT_DELAY_SECONDS: i64 = 30;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetryAttempt {
    pub id: String,
    pub source_session_id: String,
    pub attempt: i64,
    pub due_at: String,
    pub status: String,
    pub operation_id: String,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetryState {
    pub session_id: String,
    pub revision: i64,
    pub enabled: bool,
    pub max_retries: i64,
    pub delay_seconds: i64,
    pub attempts: Vec<RetryAttempt>,
}

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| { tx.execute_batch("CREATE TABLE IF NOT EXISTS session_retry_policies (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, max_retries INTEGER NOT NULL, delay_seconds INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_retry_attempts (id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, attempt INTEGER NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_retry_suppressions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at TEXT NOT NULL);")?; tx.execute("UPDATE session_retry_attempts SET status='cancelled' WHERE status IN ('pending','claimed')",[])?; Ok(()) })
}

pub fn dispatch(db: &Database, method: &str, value: &Value) -> Result<Option<Value>> {
    if !matches!(method, "session.retry.read" | "session.retry.update") {
        return Ok(None);
    }
    let params = value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let session_id = policy_root(db, required(params, "sessionId")?)?;
    match method {
        "session.retry.read" => Ok(Some(serde_json::to_value(read(db, &session_id)?)?)),
        "session.retry.update" => {
            let op = required(params, "operationId")?;
            if let Some(result) = db.operation(op)? {
                return Ok(Some(result));
            }
            let expected = params
                .get("expectedRevision")
                .and_then(Value::as_i64)
                .filter(|v| *v >= 0)
                .ok_or_else(|| anyhow!("invalid_revision"))?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("invalid_request"))?;
            let max = params
                .get("maxRetries")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_MAX_RETRIES);
            let delay = params
                .get("delaySeconds")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_DELAY_SECONDS);
            validate(enabled, max, delay)?;
            let state=db.transaction(|tx| { let prior=read_tx(tx,&session_id)?; if prior.revision!=expected{return Err(anyhow!("revision_conflict"))} let next=RetryState{session_id:session_id.clone(),revision:expected+1,enabled,max_retries:max,delay_seconds:delay,attempts:prior.attempts}; tx.execute("INSERT INTO session_retry_policies(session_id,revision,enabled,max_retries,delay_seconds) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,max_retries=excluded.max_retries,delay_seconds=excluded.delay_seconds",params![session_id,next.revision,i64::from(enabled),max,delay])?; if !enabled {tx.execute("UPDATE session_retry_attempts SET status='cancelled' WHERE source_session_id=? AND status IN ('pending','claimed')",[&session_id])?;} let result=serde_json::to_value(read_tx(tx,&session_id)?)?; complete(tx,op,method,&result)?; Ok(result) })?;
            Ok(Some(state))
        }
        _ => unreachable!(),
    }
}
pub fn read(db: &Database, session_id: &str) -> Result<RetryState> {
    let root = policy_root(db, session_id)?;
    db.transaction(|tx| read_tx(tx, &root))
}
/// Called only for a terminal failure observed in this daemon lifetime.
pub fn schedule_failed_exit(db: &Database, session_id: &str) -> Result<Option<RetryAttempt>> {
    schedule_failed_exit_at(db, session_id, Utc::now())
}
pub fn schedule_failed_exit_at(
    db: &Database,
    session_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<RetryAttempt>> {
    let root = policy_root(db, session_id)?;
    db.transaction(|tx| {
        if tx.execute(
            "DELETE FROM session_retry_suppressions WHERE session_id=?",
            [session_id],
        )? > 0
        {
            return Ok(None);
        }
        let policy = read_tx(tx, &root)?;
        if !policy.enabled { return Ok(None); }
        let used:i64 = tx.query_row("SELECT COUNT(*) FROM session_retry_attempts WHERE source_session_id=? AND status IN ('pending','claimed','completed')", [&root], |row| row.get(0))?;
        if used >= policy.max_retries {
            let exists:Option<String> = tx.query_row("SELECT id FROM session_retry_attempts WHERE source_session_id=? AND status='exhausted'", [&root], |row| row.get(0)).optional()?;
            if exists.is_none() {
                tx.execute("INSERT INTO session_retry_attempts(id,source_session_id,attempt,due_at,status,operation_id,created_at) VALUES(?,?,?,?,?,?,?)", params![uuid::Uuid::new_v4().to_string(),root,used,now.to_rfc3339(),"exhausted",format!("retry-exhausted:{}",uuid::Uuid::new_v4()),now.to_rfc3339()])?;
                tx.execute("INSERT INTO inbox(id,session_id,turn_id,kind,data,resolved,created_at,read) VALUES(?,?,?,?,?,0,?,0)",params![uuid::Uuid::new_v4().to_string(),root,Option::<String>::None,"retry_exhausted",serde_json::to_string(&json!({"sessionId":root,"maxRetries":policy.max_retries}))?,now.to_rfc3339()])?;
                emit_state(tx,"retry.exhausted")?;
            }
            return Ok(None);
        }
        let attempt = used + 1;
        let item = RetryAttempt { id:uuid::Uuid::new_v4().to_string(), source_session_id:root.clone(), attempt, due_at:(now+Duration::seconds(policy.delay_seconds)).to_rfc3339(), status:"pending".into(), operation_id:format!("retry-rerun:{}",uuid::Uuid::new_v4()), created_at:now.to_rfc3339() };
        tx.execute("INSERT INTO session_retry_attempts(id,source_session_id,attempt,due_at,status,operation_id,created_at) VALUES(?,?,?,?,?,?,?)", params![item.id,item.source_session_id,item.attempt,item.due_at,item.status,item.operation_id,item.created_at])?;
        emit_state(tx,"retry.scheduled")?;
        Ok(Some(item))
    })
}
pub fn due_attempts(db: &Database, now: DateTime<Utc>) -> Result<Vec<RetryAttempt>> {
    db.transaction(|tx| {let mut stmt=tx.prepare("SELECT id,source_session_id,attempt,due_at,status,operation_id,created_at FROM session_retry_attempts WHERE status='pending' AND due_at<=? ORDER BY due_at")?;let rows=stmt.query_map([now.to_rfc3339()],row_to_attempt)?;Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)})
}
pub fn claim_enabled(db: &Database, id: &str) -> Result<Option<RetryAttempt>> {
    db.transaction(|tx| {let attempt=tx.query_row("SELECT id,source_session_id,attempt,due_at,status,operation_id,created_at FROM session_retry_attempts WHERE id=?",[id],row_to_attempt).optional()?;let Some(mut attempt)=attempt else{return Ok(None)}; if attempt.status!="pending"||tx.query_row("SELECT enabled FROM session_retry_policies WHERE session_id=?",[&attempt.source_session_id],|r|r.get::<_,i64>(0)).optional()?!=Some(1)||tx.execute("UPDATE session_retry_attempts SET status='claimed' WHERE id=? AND status='pending'",[id])?!=1{return Ok(None)};attempt.status="claimed".into();Ok(Some(attempt))})
}
pub fn claimed_still_enabled(db: &Database, id: &str) -> Result<bool> {
    db.transaction(|tx| Ok(tx.query_row("SELECT p.enabled FROM session_retry_attempts a JOIN session_retry_policies p ON p.session_id=a.source_session_id WHERE a.id=? AND a.status='claimed'",[id],|row|row.get::<_,i64>(0)).optional()?==Some(1)))
}
pub fn finish(db: &Database, id: &str, success: bool) -> Result<()> {
    db.transaction(|tx| {
        tx.execute(
            "UPDATE session_retry_attempts SET status=? WHERE id=? AND status='claimed'",
            params![if success { "completed" } else { "cancelled" }, id],
        )?;
        Ok(())
    })
}
pub fn cancel_session(db: &Database, session_id: &str) -> Result<()> {
    let root = policy_root(db, session_id)?;
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO session_retry_suppressions(session_id,created_at) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
            params![session_id, Utc::now().to_rfc3339()],
        )?;
        tx.execute("UPDATE session_retry_attempts SET status='cancelled' WHERE source_session_id=? AND status IN ('pending','claimed')", [&root])?;
        emit_state(tx, "retry.cancelled")
    })
}
/// Clears the one-shot Stop fence before intentionally resuming the same
/// durable session identity. Call this only at the serialized resume boundary.
pub fn clear_suppression(db: &Database, session_id: &str) -> Result<()> {
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM session_retry_suppressions WHERE session_id=?",
            [session_id],
        )?;
        Ok(())
    })
}
pub fn cancel_all(db: &Database) -> Result<()> {
    db.transaction(|tx|{tx.execute("UPDATE session_retry_attempts SET status='cancelled' WHERE status IN ('pending','claimed')",[])?;Ok(())})
}

fn emit_state(tx: &Transaction<'_>, kind: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![
            serde_json::to_string(&json!({"kind":kind}))?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}
fn policy_root(db: &Database, session_id: &str) -> Result<String> {
    let mut current = session_id.to_owned();
    let mut seen = HashSet::new();
    while seen.insert(current.clone()) {
        match session_configs::read(db, &current)?.and_then(|config| config.source_session_id) {
            Some(source) => current = source,
            None => return Ok(current),
        }
    }
    Err(anyhow!("retry_lineage_cycle"))
}
fn read_tx(tx: &Transaction<'_>, session_id: &str) -> Result<RetryState> {
    let policy:Option<(i64,i64,i64,i64)>=tx.query_row("SELECT revision,enabled,max_retries,delay_seconds FROM session_retry_policies WHERE session_id=?",[session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (revision, enabled, max_retries, delay_seconds) =
        policy.unwrap_or((0, 0, DEFAULT_MAX_RETRIES, DEFAULT_DELAY_SECONDS));
    let mut stmt=tx.prepare("SELECT id,source_session_id,attempt,due_at,status,operation_id,created_at FROM session_retry_attempts WHERE source_session_id=? ORDER BY attempt")?;
    let rows = stmt.query_map([session_id], row_to_attempt)?;
    Ok(RetryState {
        session_id: session_id.to_owned(),
        revision,
        enabled: enabled != 0,
        max_retries,
        delay_seconds,
        attempts: rows.collect::<rusqlite::Result<Vec<_>>>()?,
    })
}
fn row_to_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<RetryAttempt> {
    Ok(RetryAttempt {
        id: row.get(0)?,
        source_session_id: row.get(1)?,
        attempt: row.get(2)?,
        due_at: row.get(3)?,
        status: row.get(4)?,
        operation_id: row.get(5)?,
        created_at: row.get(6)?,
    })
}
fn validate(enabled: bool, max: i64, delay: i64) -> Result<()> {
    if enabled && !(1..=10).contains(&max) || !(1..=3600).contains(&delay) {
        Err(anyhow!("invalid_retry_policy"))
    } else {
        Ok(())
    }
}
fn required<'a>(p: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn complete(tx: &Transaction<'_>, op: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            op,
            method,
            serde_json::to_string(result)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}',?)",
        [Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use serde_json::json;
    fn setup() -> (tempfile::TempDir, Database, String) {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "create",
            })
            .unwrap();
        (temp, db, session.id)
    }
    #[test]
    fn bounds_delay_and_disable_cancel() {
        let (_t, db, id) = setup();
        let updated=dispatch(&db,"session.retry.update",&json!({"sessionId":id,"enabled":true,"maxRetries":2,"delaySeconds":3,"expectedRevision":0,"operationId":"enable"})).unwrap().unwrap();
        assert_eq!(updated["revision"], 1);
        let now = Utc::now();
        let first = schedule_failed_exit_at(&db, &id, now).unwrap().unwrap();
        assert!(due_attempts(&db, now).unwrap().is_empty());
        assert_eq!(
            due_attempts(&db, now + Duration::seconds(3)).unwrap()[0].id,
            first.id
        );
        dispatch(&db,"session.retry.update",&json!({"sessionId":id,"enabled":false,"maxRetries":2,"delaySeconds":3,"expectedRevision":1,"operationId":"disable"})).unwrap();
        assert!(due_attempts(&db, now + Duration::seconds(9))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn exhaustion_and_restart_cancellation_are_bounded() {
        let (_t, db, id) = setup();
        dispatch(&db,"session.retry.update",&json!({"sessionId":id,"enabled":true,"maxRetries":1,"delaySeconds":1,"expectedRevision":0,"operationId":"enable"})).unwrap();
        let now = Utc::now();
        let first = schedule_failed_exit_at(&db, &id, now).unwrap().unwrap();
        assert!(schedule_failed_exit_at(&db, &id, now).unwrap().is_none());
        assert_eq!(
            read(&db, &id)
                .unwrap()
                .attempts
                .iter()
                .filter(|a| a.status == "exhausted")
                .count(),
            1
        );
        crate::session_configs::initialize(&db).unwrap();
        initialize(&db).unwrap();
        assert!(claim_enabled(&db, &first.id).unwrap().is_none());
    }
    #[test]
    fn explicit_stop_suppresses_the_exit_event_without_disabling_future_policy() {
        let (_t, db, id) = setup();
        dispatch(&db,"session.retry.update",&json!({"sessionId":id,"enabled":true,"maxRetries":2,"delaySeconds":1,"expectedRevision":0,"operationId":"enable"})).unwrap();
        cancel_session(&db, &id).unwrap();
        initialize(&db).unwrap();
        assert!(read(&db, &id).unwrap().enabled);
        assert!(schedule_failed_exit_at(&db, &id, Utc::now())
            .unwrap()
            .is_none());
        assert!(read(&db, &id).unwrap().attempts.is_empty());
        assert!(schedule_failed_exit_at(&db, &id, Utc::now())
            .unwrap()
            .is_some());
        cancel_session(&db, &id).unwrap();
        clear_suppression(&db, &id).unwrap();
        assert!(schedule_failed_exit_at(&db, &id, Utc::now())
            .unwrap()
            .is_some());
    }
}
