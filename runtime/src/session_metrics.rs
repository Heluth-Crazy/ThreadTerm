//! Read-only session lifetime projection from durable sessions and outbox history.
use crate::db::Database;
use anyhow::Result;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

const ACTIVE_STATUSES: &[&str] = &["starting", "running", "idle", "waiting"];
const TERMINAL_STATUSES: &[&str] = &["exited", "interrupted", "error"];

pub fn lifecycle(db: &Database, filters: &Map<String, Value>) -> Result<Vec<Value>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT s.id,s.project_id,s.provider,s.mode,s.status,s.created_at,c.source_session_id,s.read_only
             FROM sessions s LEFT JOIN session_launch_configs c ON c.session_id=s.id
             ORDER BY s.created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, bool>(7)?))
        })?;
        let mut output = Vec::new();
        for row in rows {
            let (id, project_id, provider, mode, status, started_at, source_session_id, read_only) = row?;
            let source = source_for(tx, &id, source_session_id.as_deref())?;
            if !matches_filter(filters, &id, project_id.as_deref(), &provider, &status, source_session_id.as_deref(), source) { continue; }
            let events = status_events(tx, &id)?;
            // A terminal outbox event only describes the current session state
            // while the durable row is terminal. A later active state must not
            // inherit an old chat error as its completion time.
            let ended_at = if is_terminal(&status) {
                events.iter().rev().find(|event| event["status"].as_str().is_some_and(is_terminal)).and_then(|event| event["recordedAt"].as_str()).map(str::to_owned)
            } else { None };
            let lifetime = duration(&started_at, ended_at.as_deref(), !read_only && is_active(&status));
            let mut value = json!({"sessionId":id,"provider":provider,"mode":mode,"status":status,"startedAt":started_at,"durationKind":"session_lifetime","history":events,"source":source});
            if let Some(project_id) = project_id { value["projectId"] = json!(project_id); }
            if let Some(source_session_id) = source_session_id { value["sourceSessionId"] = json!(source_session_id); }
            if let Some(ended_at) = ended_at { value["endedAt"] = json!(ended_at); }
            if let Some(lifetime) = lifetime { value["sessionLifetimeSeconds"] = json!(lifetime); }
            output.push(value);
        }
        Ok(output)
    })
}

fn source_for<'a>(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    source_session_id: Option<&'a str>,
) -> Result<&'a str> {
    if source_session_id.is_some() {
        return Ok("rerun");
    }
    let native: Option<()> = tx.query_row(
        "SELECT 1 FROM operation_requests WHERE method IN ('session.create','history.import') AND json_extract(params,'$.nativeId') IS NOT NULL AND json_extract(params,'$.operationId') IN (SELECT id FROM operations WHERE json_extract(result,'$.id')=?) LIMIT 1",
        [session_id], |_| Ok(())
    ).optional()?;
    Ok(if native.is_some() {
        "native-history"
    } else {
        "created"
    })
}

fn status_events(tx: &rusqlite::Transaction<'_>, session_id: &str) -> Result<Vec<Value>> {
    let mut statement = tx.prepare("SELECT created_at,json_extract(data,'$.status') FROM outbox WHERE event='session.status' AND json_extract(data,'$.sessionId')=? ORDER BY seq")?;
    let events = statement
        .query_map([session_id], |row| {
            Ok(json!({"recordedAt":row.get::<_, String>(0)?,"status":row.get::<_, String>(1)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(events)
}

fn matches_filter(
    filters: &Map<String, Value>,
    id: &str,
    project_id: Option<&str>,
    provider: &str,
    status: &str,
    lineage: Option<&str>,
    source: &str,
) -> bool {
    let equals = |key: &str, value: Option<&str>| {
        filters
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(|wanted| value == Some(wanted))
    };
    equals("sessionId", Some(id))
        && equals("projectId", project_id)
        && equals("provider", Some(provider))
        && equals("status", Some(status))
        && equals("sourceSessionId", lineage)
        && equals("source", Some(source))
}

fn is_active(status: &str) -> bool {
    ACTIVE_STATUSES.contains(&status)
}
fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

fn duration(started_at: &str, ended_at: Option<&str>, still_active: bool) -> Option<i64> {
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at)
        .ok()?
        .with_timezone(&chrono::Utc);
    let end = match (ended_at, still_active) {
        (Some(ended_at), _) => chrono::DateTime::parse_from_rfc3339(ended_at)
            .ok()?
            .with_timezone(&chrono::Utc),
        (None, true) => chrono::Utc::now(),
        // A durable terminal status without an observed terminal transition has
        // no authoritative endpoint. Do not turn that unknown into "now".
        (None, false) => return None,
    };
    Some((end - started_at).num_seconds().max(0))
}

pub fn summary(rows: &[Value]) -> Value {
    json!({"sessionCount":rows.len(),"runningCount":rows.iter().filter(|row| row["status"].as_str().is_some_and(is_active) && row["sessionLifetimeSeconds"].is_number()).count(),"endedCount":rows.iter().filter(|row| row.get("endedAt").is_some()).count(),"sessionLifetimeSeconds":rows.iter().filter_map(|row| row["sessionLifetimeSeconds"].as_i64()).sum::<i64>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use serde_json::json;
    #[test]
    fn duration_uses_end_only_for_observed_terminal_or_active_sessions() {
        assert_eq!(
            duration("2026-01-01T00:00:00Z", Some("2026-01-01T00:01:30Z"), false),
            Some(90)
        );
        assert_eq!(duration("2026-01-01T00:00:00Z", None, false), None);
    }

    #[test]
    fn emits_created_source_and_keeps_unknown_terminal_duration_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("metrics.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "created-session",
            })
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET status='exited' WHERE id=?",
                [&session.id],
            )?;
            Ok(())
        })
        .unwrap();

        let rows = lifecycle(&db, &Map::new()).unwrap();
        assert_eq!(rows[0]["source"], "created");
        assert!(rows[0].get("endedAt").is_none());
        assert!(rows[0].get("sessionLifetimeSeconds").is_none());
    }

    #[test]
    fn current_active_state_does_not_reuse_old_error_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("metrics.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "chat",
                native_id: None,
                operation_id: "active-session",
            })
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET status='running' WHERE id=?",
                [&session.id],
            )?;
            tx.execute(
                "INSERT INTO outbox(event,data,created_at) VALUES('session.status',?,?)",
                [
                    json!({"sessionId":session.id,"status":"error"}).to_string(),
                    "2026-01-01T00:00:30Z".into(),
                ],
            )?;
            Ok(())
        })
        .unwrap();

        let rows = lifecycle(&db, &Map::new()).unwrap();
        assert!(rows[0].get("endedAt").is_none());
        assert!(rows[0]["sessionLifetimeSeconds"].as_i64().is_some());
    }

    #[test]
    fn imported_read_only_history_is_native_source_but_not_a_running_lifetime() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("metrics.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let request = json!({
            "provider":"codex",
            "nativeId":"native-history",
            "cwd":temp.path(),
            "mode":"chat",
            "operationId":"history-import"
        });
        db.bind_operation("history-import", "history.import", &request)
            .unwrap();
        db.import_history_session(crate::db::ImportHistorySession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            cwd: temp.path().to_str().unwrap(),
            native_id: "native-history",
            operation_id: "history-import",
            transcript: &[],
        })
        .unwrap();

        let rows = lifecycle(&db, &Map::new()).unwrap();
        assert_eq!(rows[0]["source"], "native-history");
        assert!(rows[0].get("sessionLifetimeSeconds").is_none());
        assert_eq!(summary(&rows)["runningCount"], 0);
    }
}
