//! Recoverable project decisions. Pi owns its native trust files; these records
//! live only in ThreadTerm's database and require an explicit user operation.
use crate::db::Database;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn reconnect_key(operation: &str) -> String { format!("pi-trust-reconnect:{operation}") }
fn generation_key(project: &str) -> String { format!("pi-trust-operation:{project}") }

pub(super) fn pending(db: &Database, project: &str, operation: &str) -> Result<Option<Vec<String>>> {
    db.transaction(|tx| {
        let raw: Option<String> = tx.query_row("SELECT value FROM metadata WHERE key=?", [reconnect_key(operation)], |row| row.get(0)).optional()?;
        let Some(raw) = raw else { return Ok(None); };
        let current: Option<String> = tx.query_row("SELECT value FROM metadata WHERE key=?", [generation_key(project)], |row| row.get(0)).optional()?;
        if current.as_deref() != Some(operation) {
            return Err(anyhow!("project_trust_superseded: a newer project trust decision replaced this operation"));
        }
        let value: Value = serde_json::from_str(&raw)?;
        Ok(Some(serde_json::from_value(value["sessionIds"].clone())?))
    })
}

/// The saved decision and its recovery route have the same crash boundary.
pub(super) fn save(db: &Database, project: &str, decision: &str, operation: &str, sessions: &[String]) -> Result<()> {
    // Initialize the lazily-created project table outside the transaction.
    crate::pi_project_trust::read(db, project)?;
    db.transaction(|tx| {
        if tx.execute("INSERT OR IGNORE INTO external_operations(id,started_at) VALUES (?,?)", params![operation, chrono::Utc::now().to_rfc3339()])? != 1 {
            return Err(anyhow!("project_trust_outcome_unknown: no reconnect receipt exists for this decision"));
        }
        if decision == "none" {
            tx.execute("DELETE FROM pi_project_trust WHERE project_id=?", [project])?;
        } else {
            tx.execute("INSERT INTO pi_project_trust(project_id,decision) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET decision=excluded.decision", params![project, decision])?;
        }
        let receipt = json!({"projectId":project,"decision":decision,"sessionIds":sessions});
        for (key, value) in [(reconnect_key(operation), serde_json::to_string(&receipt)?), (generation_key(project), operation.to_owned())] {
            tx.execute("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
        }
        Ok(())
    })
}

pub(super) fn complete(db: &Database, operation: &str, state: &Value) -> Result<()> {
    db.transaction(|tx| {
        crate::db::complete(tx, operation, "chat.projectTrust.set", state)?;
        tx.execute("DELETE FROM metadata WHERE key=?", [reconnect_key(operation)])?;
        Ok(())
    })
}
