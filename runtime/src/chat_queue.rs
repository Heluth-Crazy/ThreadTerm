//! Durable, runtime-owned prompt queues. Provider I/O never holds a SQLite transaction.
use crate::{
    db::Database,
    domain::ChatItem,
    leases::LeaseManager,
    providers::{ProviderError, ProviderEvent, Providers},
};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

// Queue responses include every attachment. Leave headroom within the 8 MiB wire frame
// for the response envelope and later state/error fields without stranding a saved queue.
const MAX_QUEUE_WIRE_BYTES: usize = 8 * 1024 * 1024 - 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    text: String,
    images: Vec<String>,
    revision: i64,
    created_at: String,
    updated_at: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    item_id: Option<String>,
    text: Option<String>,
    images: Option<Vec<String>>,
    expected_revision: Option<i64>,
    to_index: Option<usize>,
    operation_id: Option<String>,
    lease_epoch: Option<i64>,
}

fn failure(code: &str) -> anyhow::Error {
    ProviderError::new(code, code).into()
}

/// A known rejection never delivered the text, so the queue item goes back.
/// Timeouts and outcome-unknown stay failed so dispatch cannot send them again.
fn steer_failure_restores_queue(error: &anyhow::Error) -> bool {
    if let Some(provider) = error.downcast_ref::<ProviderError>() {
        return matches!(
            provider.code.as_str(),
            "turn_changed"
                | "steer_unsupported"
                | "images_unsupported"
                | "invalid_image"
                | "invalid_message"
                | "empty_message"
                | "chat_not_open"
                | "images_not_supported_for_command"
        );
    }
    matches!(error.to_string().as_str(), "invalid_message" | "chat_not_open")
}

pub(crate) fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS chat_queue_items (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            position INTEGER NOT NULL, text TEXT NOT NULL, images_json TEXT NOT NULL,
            revision INTEGER NOT NULL, state TEXT NOT NULL, error TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS chat_queue_order ON chat_queue_items(session_id,position);
            CREATE TABLE IF NOT EXISTS chat_queue_state (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT);")?;
        let ids = tx.prepare("SELECT DISTINCT session_id FROM chat_queue_items")?
            .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            // A crash between native dispatch and removal is explicitly uncertain.
            tx.execute("UPDATE chat_queue_items SET state='failed', error='May have been sent — check the transcript',revision=revision+1,updated_at=? WHERE session_id=? AND state='sending'", params![Utc::now().to_rfc3339(),id])?;
            pause_tx(tx, &id, "restarted")?;
        }
        Ok(())
    })
}

fn require_chat(tx: &Transaction<'_>, id: &str, write: bool) -> Result<()> {
    let session: Option<(String, bool, String)> = tx
        .query_row(
            "SELECT mode,read_only,status FROM sessions WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((mode, read_only, status)) = session else {
        return Err(failure("session_not_found"));
    };
    if mode != "chat" {
        return Err(failure("chat_unavailable"));
    }
    if write && (read_only || status == "exited") {
        return Err(failure("session_read_only_resume_required"));
    }
    Ok(())
}

fn read_tx(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let state: Option<(bool, Option<String>)> = tx
        .query_row(
            "SELECT paused,pause_reason FROM chat_queue_state WHERE session_id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (paused, reason) = state.unwrap_or((false, None));
    let items = tx.prepare("SELECT id,text,images_json,revision,created_at,updated_at,state,error FROM chat_queue_items WHERE session_id=? ORDER BY position,id")?
        .query_map([id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?.into_iter()
        .map(|(id,text,images,revision,created_at,updated_at,state,error)| Ok(Item {id,text,images:serde_json::from_str(&images)?,revision,created_at,updated_at,state,error}))
        .collect::<Result<Vec<_>>>()?;
    let mut result = json!({"sessionId":id,"paused":paused,"items":items});
    if let Some(reason) = reason {
        result["pauseReason"] = json!(reason);
    }
    Ok(result)
}

pub(crate) fn read(db: &Database, id: &str) -> Result<Value> {
    db.transaction(|tx| {
        require_chat(tx, id, false)?;
        read_tx(tx, id)
    })
}

fn changed(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
        params![
            json!({"kind":"chat.queue","sessionId":id}).to_string(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

fn pause_tx(tx: &Transaction<'_>, id: &str, reason: &str) -> Result<()> {
    tx.execute("INSERT INTO chat_queue_state(session_id,paused,pause_reason) VALUES (?,1,?) ON CONFLICT(session_id) DO UPDATE SET paused=1,pause_reason=excluded.pause_reason",params![id,reason])?;
    changed(tx, id)
}

pub(crate) fn pause(db: &Database, id: &str, reason: &str) -> Result<()> {
    db.transaction(|tx| {
        require_chat(tx, id, false)?;
        pause_tx(tx, id, reason)
    })
}

pub(crate) fn pause_all(db: &Database, reason: &str) -> Result<()> {
    db.transaction(|tx| {
        let ids = tx
            .prepare("SELECT DISTINCT session_id FROM chat_queue_items")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            pause_tx(tx, &id, reason)?;
        }
        Ok(())
    })
}

fn validate_message(text: &str, images: &[String]) -> Result<()> {
    crate::service::validate_chat_images(images)?;
    if text.trim() == "/fork" && images.is_empty() {
        return Err(failure("control_command_not_queueable"));
    }
    if (text.trim().is_empty() && images.is_empty()) || text.len() > 1024 * 1024 {
        return Err(failure("invalid_message"));
    }
    Ok(())
}

fn reorder(tx: &Transaction<'_>, id: &str, item: &str, index: usize) -> Result<()> {
    let mut ids = tx
        .prepare("SELECT id FROM chat_queue_items WHERE session_id=? ORDER BY position,id")?
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if index >= ids.len() {
        return Err(failure("invalid_queue_position"));
    }
    let old = ids
        .iter()
        .position(|id| id == item)
        .ok_or_else(|| failure("queue_item_not_found"))?;
    let moved = ids.remove(old);
    ids.insert(index, moved);
    for (index, item) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE chat_queue_items SET position=? WHERE id=?",
            params![index as i64, item],
        )?;
    }
    Ok(())
}

/// Mutation and its operation receipt commit together. Replays return current canonical state.
pub(crate) fn mutate(db: &Database, method: &str, value: &Value) -> Result<Value> {
    let p: Request =
        serde_json::from_value(value.clone()).map_err(|_| failure("invalid_request"))?;
    let op = p
        .operation_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("invalid_operation_id"))?;
    db.transaction(|tx| {
        require_chat(tx,&p.session_id,true)?;
        let replay: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id=?)",[op],|r|r.get(0))?;
        if replay { return read_tx(tx,&p.session_id); }
        let now = Utc::now().to_rfc3339();
        if method == "chat.queue.add" {
            let text = p.text.as_deref().ok_or_else(|| failure("invalid_message"))?;
            let images = p.images.as_deref().unwrap_or_default();
            validate_message(text,images)?;
            let (count,position): (i64,i64) = tx.query_row("SELECT COUNT(*),COALESCE(MAX(position),-1)+1 FROM chat_queue_items WHERE session_id=?",[&p.session_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if count >= 20 { return Err(failure("queue_full")); }
            let id = uuid::Uuid::new_v4().to_string();
            // Reserve the internal operation before returning its item id. Public RPCs
            // bind_operation must never be able to impersonate this native send.
            tx.execute("INSERT INTO operation_requests(id,method,params) VALUES (?,'chat.queue.dispatch',?)",params![format!("queue:{id}"),json!({"sessionId":p.session_id,"itemId":id}).to_string()])?;
            tx.execute("INSERT INTO chat_queue_items(id,session_id,position,text,images_json,revision,state,created_at,updated_at) VALUES (?,?,?,?,?,1,'queued',?,?)",params![id,p.session_id,position,text,serde_json::to_string(images)?,now,now])?;
        } else if matches!(method,"chat.queue.pause"|"chat.queue.resume") {
            tx.execute("INSERT INTO chat_queue_state(session_id,paused,pause_reason) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET paused=excluded.paused,pause_reason=excluded.pause_reason",params![p.session_id,method=="chat.queue.pause",if method=="chat.queue.pause" {Some("user")} else {None}])?;
        } else {
            let item = p.item_id.as_deref().ok_or_else(|| failure("queue_item_not_found"))?;
            let prior: Option<(String,i64,String)> = tx.query_row("SELECT state,revision,images_json FROM chat_queue_items WHERE session_id=? AND id=?",params![p.session_id,item],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let Some((state,revision,images)) = prior else { return Err(failure("queue_item_not_found")); };
            if state == "sending" { return Err(failure("queue_item_sending")); }
            match method {
                "chat.queue.update" => {
                    if p.expected_revision != Some(revision) { return Err(failure("revision_conflict")); }
                    let text = p.text.as_deref().ok_or_else(|| failure("invalid_message"))?;
                    // The frozen update contract requires text even for an image-only item.
                    if text.trim().is_empty() { return Err(failure("invalid_message")); }
                    validate_message(text,&serde_json::from_str::<Vec<String>>(&images)?)?;
                    tx.execute("UPDATE chat_queue_items SET text=?,revision=revision+1,updated_at=? WHERE id=?",params![text,now,item])?;
                }
                "chat.queue.remove" => { tx.execute("DELETE FROM chat_queue_items WHERE id=?",[item])?; }
                "chat.queue.move" => { reorder(tx,&p.session_id,item,p.to_index.filter(|n| *n<20).ok_or_else(||failure("invalid_queue_position"))?)?; }
                "chat.queue.send" => {
                    if !idle_tx(tx,&p.session_id)? { return Err(failure("chat_busy")); }
                    reorder(tx,&p.session_id,item,0)?;
                    // An explicit retry retains queue:<id>; the shared send path fences uncertain outcomes.
                    tx.execute("UPDATE chat_queue_items SET state='queued',error=NULL,revision=revision+1,updated_at=? WHERE id=?",params![now,item])?;
                    tx.execute("INSERT INTO chat_queue_state(session_id,paused,pause_reason) VALUES (?,0,NULL) ON CONFLICT(session_id) DO UPDATE SET paused=0,pause_reason=NULL",[&p.session_id])?;
                }
                _ => return Err(failure("unknown_method")),
            }
        }
        changed(tx,&p.session_id)?;
        let result = read_tx(tx,&p.session_id)?;
        if matches!(method,"chat.queue.add"|"chat.queue.update") && serde_json::to_vec(&result)?.len() > MAX_QUEUE_WIRE_BYTES { return Err(failure("queue_full")); }
        tx.execute("INSERT INTO operations(id,method,result,created_at) VALUES (?,?,?,?)",params![op,method,result.to_string(),now])?;
        Ok(result)
    })
}

/// Activity fencing also protects against an old completion arriving after the next send.
fn idle_tx(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    let status: String =
        tx.query_row("SELECT status FROM sessions WHERE id=?", [id], |r| r.get(0))?;
    if status != "idle" {
        return Ok(false);
    }
    let activity: Option<String> = tx
        .query_row(
            "SELECT state FROM session_activity WHERE session_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if activity.is_some_and(|s| {
        matches!(
            s.as_str(),
            "running" | "awaiting_approval" | "awaiting_parent" | "unknown"
        )
    }) {
        return Ok(false);
    }
    let rows = tx
        .prepare("SELECT data FROM chat_items WHERE session_id=?")?
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for row in rows {
        let item: ChatItem = serde_json::from_str(&row)?;
        if item.parts.iter().any(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("approval" | "question")
            ) && matches!(
                part.get("status").and_then(Value::as_str),
                Some("pending" | "submitting")
            )
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) struct ChatQueues {
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    healthy: AtomicBool,
}

impl Default for ChatQueues {
    fn default() -> Self {
        Self {
            gates: Mutex::new(HashMap::new()),
            healthy: AtomicBool::new(true),
        }
    }
}

impl ChatQueues {
    /// Observation only: repair must preserve this restart-only dispatch fence.
    pub(crate) fn ingress_failed(&self) -> bool {
        !self.healthy.load(Ordering::Acquire)
    }

    fn gate(&self, id: &str) -> Result<Arc<Mutex<()>>> {
        Ok(self
            .gates
            .lock()
            .map_err(|_| failure("queue_lock_poisoned"))?
            .entry(id.to_owned())
            .or_default()
            .clone())
    }

    pub(crate) fn pause_dispatch(&self, db: &Database, id: &str, reason: &str) -> Result<()> {
        let gate = self.gate(id)?;
        let _guard = gate.lock().map_err(|_| failure("queue_lock_poisoned"))?;
        pause(db, id, reason)
    }

    pub(crate) fn projection_failed(&self, db: &Database) {
        self.healthy.store(false, Ordering::Release);
        if let Err(error) = pause_all(db, "failed") {
            eprintln!("prompt queues could not be paused: {error}");
        }
    }
    /// Called only after a current worker's event has been committed, outside its registry guard.
    pub(crate) fn provider_event(
        self: &Arc<Self>,
        db: &Arc<Database>,
        providers: &Arc<Providers>,
        event: &ProviderEvent,
    ) {
        let reason = match event.kind.as_str() {
            "session.closed" => Some("disconnected"),
            "chat.connection"
                if matches!(
                    event.data.get("phase").and_then(Value::as_str),
                    Some("disconnected" | "failed" | "unavailable" | "connecting")
                ) =>
            {
                Some("disconnected")
            }
            "chat.error" => Some("failed"),
            "chat.turn.completed"
                if matches!(
                    event.data.get("status").and_then(Value::as_str),
                    Some("failed" | "error" | "interrupted")
                ) =>
            {
                Some("failed")
            }
            "chat.turn.completed"
                if matches!(
                    event.data.get("status").and_then(Value::as_str),
                    Some("cancelled" | "canceled")
                ) =>
            {
                Some("stopped")
            }
            _ => None,
        };
        if let Some(reason) = reason {
            // A first connection is not loss of queued work. Preserve an existing
            // deliberate/recovery pause, and do not seed a paused empty queue.
            let paused = db.transaction(|tx| {
                require_chat(tx, &event.session_id, false)?;
                let queue = read_tx(tx, &event.session_id)?;
                if queue["paused"] != true
                    && queue["items"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty())
                {
                    pause_tx(tx, &event.session_id, reason)?;
                }
                Ok(())
            });
            if let Err(error) = paused {
                eprintln!("prompt queue pause failed: {error}");
            }
        } else if event.kind == "chat.turn.completed" {
            self.schedule(db, providers, &event.session_id);
        }
    }

    pub(crate) fn try_dispatch(
        &self,
        db: &Database,
        providers: &Providers,
        id: &str,
    ) -> Result<()> {
        if !self.healthy.load(Ordering::Acquire) {
            return Ok(());
        }
        let gate = self.gate(id)?;
        let _guard = gate.lock().map_err(|_| failure("queue_lock_poisoned"))?;
        if !self.healthy.load(Ordering::Acquire) {
            return Ok(());
        }
        let snapshot = read(db, id)?;
        if snapshot["paused"] == true
            || snapshot["items"]
                .as_array()
                .is_none_or(|items| items.is_empty())
        {
            return Ok(());
        }
        if !providers.chat_is_open(id) {
            // Never turn a reconnect into automatic queue resumption.
            pause(db, id, "disconnected")?;
            return Ok(());
        }
        let item = db.transaction(|tx| {
            require_chat(tx,id,true)?;
            let queue = read_tx(tx,id)?;
            if queue["paused"] == true || !idle_tx(tx,id)? { return Ok(None); }
            let Some(value) = queue["items"].as_array().and_then(|items|items.first()) else { return Ok(None); };
            let item: Item = serde_json::from_value(value.clone())?;
            if item.state != "queued" { return Ok(None); }
            tx.execute("UPDATE chat_queue_items SET state='sending',revision=revision+1,updated_at=? WHERE id=?",params![Utc::now().to_rfc3339(),item.id])?;
            changed(tx,id)?;
            Ok(Some(item))
        })?;
        let Some(item) = item else {
            return Ok(());
        };
        // steer_queued holds this same gate and reserves `sending` first, so
        // an insert-now of this item cannot also dispatch here.
        let operation = format!("queue:{}", item.id);
        // The reservation is committed above; no transaction/DB lock survives this call.
        let sent = crate::service::send_chat_message(
            db,
            providers,
            id,
            &item.text,
            &item.images,
            &operation,
        );
        db.transaction(|tx| {
            match sent {
                Ok(_) => { tx.execute("DELETE FROM chat_queue_items WHERE id=?",[&item.id])?; }
                Err(error) => {
                    let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM external_operations WHERE id=?)",[&operation],|r|r.get(0))?;
                    let error = if claimed || error.to_string().contains("operation_outcome_unknown") { format!("May have been sent — check the transcript: {error}") } else { error.to_string() };
                    let error: String = error.chars().take(500).collect();
                    tx.execute("UPDATE chat_queue_items SET state='failed',error=?,revision=revision+1,updated_at=? WHERE id=?",params![error,Utc::now().to_rfc3339(),item.id])?;
                    pause_tx(tx,id,"failed")?;
                }
            }
            changed(tx,id)
        })
    }

    /// Holds the queue gate, then the chat worker, and deletes the item only
    /// after the provider accepts the steer. A known rejection puts the item
    /// back. A timeout or any other uncertain outcome marks it failed so the
    /// dispatcher cannot send a second copy.
    pub(crate) fn steer_queued(
        &self,
        db: &Database,
        providers: &Providers,
        session_id: &str,
        turn_id: &str,
        item_id: &str,
        operation_id: &str,
    ) -> Result<Value> {
        let gate = self.gate(session_id)?;
        let _guard = gate.lock().map_err(|_| failure("queue_lock_poisoned"))?;
        let (text, images) = db.transaction(|tx| {
            require_chat(tx, session_id, true)?;
            let prior: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT state,text,images_json FROM chat_queue_items WHERE session_id=? AND id=?",
                    params![session_id, item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((state, text, images)) = prior else {
                return Err(failure("queue_item_not_found"));
            };
            if state == "sending" {
                return Err(failure("queue_item_sending"));
            }
            if state != "queued" && state != "failed" {
                return Err(failure("queue_item_not_found"));
            }
            tx.execute(
                "UPDATE chat_queue_items SET state='sending',error=NULL,revision=revision+1,updated_at=? WHERE id=?",
                params![Utc::now().to_rfc3339(), item_id],
            )?;
            changed(tx, session_id)?;
            Ok((text, serde_json::from_str::<Vec<String>>(&images)?))
        })?;
        let steered = crate::service::steer_chat_message(
            db,
            providers,
            session_id,
            turn_id,
            &text,
            &images,
            operation_id,
        );
        db.transaction(|tx| {
            match &steered {
                Ok(_) => {
                    tx.execute("DELETE FROM chat_queue_items WHERE id=?", [item_id])?;
                }
                Err(error) if steer_failure_restores_queue(error) => {
                    tx.execute(
                        "UPDATE chat_queue_items SET state='queued',error=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='sending'",
                        params![Utc::now().to_rfc3339(), item_id],
                    )?;
                }
                Err(error) => {
                    let message = format!("May have been sent — check the transcript: {error}");
                    let message: String = message.chars().take(500).collect();
                    tx.execute(
                        "UPDATE chat_queue_items SET state='failed',error=?,revision=revision+1,updated_at=? WHERE id=?",
                        params![message, Utc::now().to_rfc3339(), item_id],
                    )?;
                    pause_tx(tx, session_id, "failed")?;
                }
            }
            changed(tx, session_id)
        })?;
        steered
    }

    pub(crate) fn schedule(
        self: &Arc<Self>,
        db: &Arc<Database>,
        providers: &Arc<Providers>,
        id: &str,
    ) {
        let (queues, db, providers, id) = (
            Arc::clone(self),
            Arc::clone(db),
            Arc::clone(providers),
            id.to_owned(),
        );
        std::thread::spawn(move || {
            if let Err(error) = queues.try_dispatch(&db, &providers, &id) {
                eprintln!("prompt queue dispatch failed for {id}: {error}");
                let _ = pause(&db, &id, "failed");
            }
        });
    }

    pub(crate) fn dispatch(
        self: &Arc<Self>,
        db: &Arc<Database>,
        providers: &Arc<Providers>,
        leases: &LeaseManager,
        principal: &str,
        method: &str,
        value: &Value,
    ) -> Result<Value> {
        let p: Request =
            serde_json::from_value(value.clone()).map_err(|_| failure("invalid_request"))?;
        if method == "chat.queue.read" {
            return read(db, &p.session_id);
        }
        leases.require(
            db,
            &p.session_id,
            principal,
            p.lease_epoch.ok_or_else(|| failure("lease_missing"))?,
        )?;
        if !self.healthy.load(Ordering::Acquire)
            && matches!(method, "chat.queue.resume" | "chat.queue.send")
        {
            return Err(failure("chat_queue_unavailable"));
        }
        let gate = self.gate(&p.session_id)?;
        let _control_guard = if matches!(
            method,
            "chat.queue.pause" | "chat.queue.resume" | "chat.queue.send"
        ) {
            Some(gate.lock().map_err(|_| failure("queue_lock_poisoned"))?)
        } else {
            None
        };
        let result = mutate(db, method, value)?;
        if !self.healthy.load(Ordering::Acquire) {
            pause(db, &p.session_id, "failed")?;
            return read(db, &p.session_id);
        }
        if matches!(
            method,
            "chat.queue.add" | "chat.queue.resume" | "chat.queue.send"
        ) {
            self.schedule(db, providers, &p.session_id);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::steer_failure_restores_queue;
    use crate::providers::ProviderError;

    #[test]
    fn a_rejected_steer_returns_the_queue_item_and_a_timeout_does_not() {
        let rejected = ProviderError::new("turn_changed", "ended").into();
        let unsupported = ProviderError::new("steer_unsupported", "no").into();
        let timeout = ProviderError::new("provider_timeout", "timed out").into();
        let unknown = ProviderError::new("operation_outcome_unknown", "unknown").into();
        assert!(steer_failure_restores_queue(&rejected));
        assert!(steer_failure_restores_queue(&unsupported));
        assert!(!steer_failure_restores_queue(&timeout));
        assert!(!steer_failure_restores_queue(&unknown));
        assert!(steer_failure_restores_queue(&anyhow::anyhow!("invalid_message")));
    }
}
