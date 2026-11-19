//! Push wake (R3–R8 of the operator push plan).
//!
//! A parent agent must not poll: ThreadTerm wakes it with an automatic message
//! when a delegate finishes, needs its decision or goes quiet. The state machine
//! (`delegation::set_state`, `project_child_event`), the quiet sweep and the
//! projection are database-only — they cannot reach `Providers` or
//! `ChatQueues` — so all waking happens in one post-commit function,
//! [`pass`], called after a delegated child's event is committed, after a quiet
//! sweep that changed episodes, and at a parent's turn end. The projection and
//! the sweep only ask [`can_wake_tx`] whether a wake is possible at all.
//!
//! Nothing here holds a SQLite transaction while calling a provider or
//! `ChatQueues::schedule`.
use crate::{
    chat_queue::{self, ChatQueues},
    db::Database,
    providers::Providers,
};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::sync::Arc;

/// R8: the fixed first line of every automatic delegate update. The text is
/// English because models read it, short, and one line per update.
pub const AUTOMATIC_FIRST_LINE: &str =
    "[ThreadTerm] Automatic delegate update, not a message from the user:";
/// R4: what the wake tells the parent to do after the update lines.
const AUTOMATIC_CLOSING: &str = "Handle these, then end your turn. ThreadTerm wakes you again on the next update. Use ask_user only for decisions that belong to the user.";
/// R6: at most this many automatic messages per parent since the last
/// non-automatic user message. A send back (R13) is user-authored, so it opens
/// a new window.
pub const AUTO_WAKE_BUDGET: i64 = 12;
/// R4: the runtime-owned queue item a wake is delivered in.
const AUTOWAKE_PREFIX: &str = "autowake-";
/// R13: the item a send back is delivered in.
const SENDBACK_PREFIX: &str = "sendback-";
/// R6: the Inbox notice a parent gets when wakes stop.
pub const AUTOWAKE_EXHAUSTED_KIND: &str = "autowake_exhausted";
/// R3/R4: how much of a delegate's own text one line carries.
const MAX_LINE_CHARS: usize = 200;

/// R8: an automatic message is recognised by its fixed first line. The
/// operation id alone is not enough: repair and history import rebuild user
/// items from native history and lose fields.
pub(crate) fn is_automatic_text(text: &str) -> bool {
    text.trim_start().starts_with(AUTOMATIC_FIRST_LINE)
}

/// R8: the projection sets `automatic` on the text part; the history paths use
/// [`mark_automatic_parts`]. Both are read through this one predicate.
pub(crate) fn is_automatic_item(item: &crate::domain::ChatItem) -> bool {
    item.parts.iter().any(|part| {
        part.get("type").and_then(Value::as_str) == Some("text")
            && part.get("automatic").and_then(Value::as_bool) == Some(true)
    })
}

/// R8: repair, history refresh and history import rebuild user items from
/// native history, which still contains the text the runtime sent.
pub(crate) fn mark_automatic_parts(item: &mut crate::domain::ChatItem) {
    if item.role != "user" {
        return;
    }
    for part in &mut item.parts {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if part.get("text").and_then(Value::as_str).is_some_and(is_automatic_text) {
            part["automatic"] = json!(true);
        }
    }
}

fn new_wake_id() -> String {
    format!("{AUTOWAKE_PREFIX}{}", uuid::Uuid::new_v4())
}

/// R13: the id of the user-authored item a send back is delivered in.
pub(crate) fn new_sendback_id() -> String {
    format!("{SENDBACK_PREFIX}{}", uuid::Uuid::new_v4())
}

/// R13: a send back is the user's own message to the parent, so it is not
/// automatic (it does not start with the fixed first line).
pub(crate) fn sendback_text(child_title: &str, delegation_id: &str, note: &str) -> String {
    format!("The user sent back \"{child_title}\" (delegation {delegation_id}):\n{note}")
}

/// One thing the parent has not been told about yet (R3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Update {
    /// R3(a): a terminal state. `cancelled` never appears here: the parent asked.
    Terminal { delegation_id: String, title: String, agent: String, state: String, error: Option<String> },
    /// R3(b): a pending approval routed to the parent.
    Request { delegation_id: String, title: String, agent: String, request_id: String, request_title: String },
    /// R3(c): an open quiet episode.
    Quiet { delegation_id: String, title: String, agent: String, quiet_since: String, minutes: i64, tool: Option<String> },
}

impl Update {
    /// R4: one line per update, English, short.
    fn line(&self) -> String {
        match self {
            Update::Terminal { delegation_id, title, agent, state, error } => match state.as_str() {
                "failed" => format!(
                    "- \"{title}\" ({agent}, {delegation_id}) failed: {}",
                    shorten(error.as_deref().unwrap_or("the delegated turn failed"), MAX_LINE_CHARS)
                ),
                "interrupted" => format!(
                    "- \"{title}\" ({agent}, {delegation_id}) was interrupted before it finished. Read what it did with delegate_result."
                ),
                "cancel_failed" => format!(
                    "- \"{title}\" ({agent}, {delegation_id}) could not be stopped: {}. Check it with delegate_status; it may still be working.",
                    shorten(error.as_deref().unwrap_or("the stop was refused"), MAX_LINE_CHARS)
                ),
                _ => format!(
                    "- \"{title}\" ({agent}, {delegation_id}) completed. Read it with delegate_result."
                ),
            },
            Update::Request { delegation_id, title, agent, request_id, request_title } => format!(
                "- \"{title}\" ({agent}, {delegation_id}) asks: \"{}\". Answer with delegate_respond (requestId {request_id}; choices in delegate_status).",
                shorten(request_title, MAX_LINE_CHARS)
            ),
            Update::Quiet { delegation_id, title, agent, minutes, tool, .. } => {
                let running = tool.as_deref().map(|tool| format!(", while running {tool}")).unwrap_or_default();
                format!(
                    "- \"{title}\" ({agent}, {delegation_id}) has had no activity for {minutes} min{running}. Check it with delegate_status; stop it with delegate_cancel if it is stuck."
                )
            }
        }
    }

    /// R2: after the wake carried this update, the parent knows it.
    fn mark_reported(&self, tx: &Transaction<'_>) -> Result<()> {
        match self {
            Update::Terminal { delegation_id, state, .. } => {
                crate::delegation::mark_reported(tx, delegation_id, Some(state), None, None)
            }
            Update::Request { delegation_id, request_id, .. } => {
                crate::delegation::mark_reported(tx, delegation_id, None, Some(request_id), None)
            }
            Update::Quiet { delegation_id, quiet_since, .. } => {
                crate::delegation::mark_reported(tx, delegation_id, None, None, Some(quiet_since))
            }
        }
    }
}

/// One line, at most `limit` characters: coalescing re-reads a queued wake line
/// by line, so an update must never span two.
fn shorten(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    flat.chars().take(limit).collect::<String>() + "…"
}

/// The full automatic message for these update lines (R4).
fn wake_text(lines: &[String]) -> String {
    let mut text = String::from(AUTOMATIC_FIRST_LINE);
    for line in lines {
        text.push('\n');
        text.push_str(line);
    }
    text.push('\n');
    text.push_str(AUTOMATIC_CLOSING);
    text
}

/// The update lines a queued wake already carries, so coalescing adds to them
/// instead of starting over.
fn update_lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| line.starts_with("- "))
        .map(str::to_owned)
        .collect()
}

struct Row {
    id: String,
    child: String,
    agent: String,
    title: String,
    state: String,
    error: Option<String>,
    reported_state: Option<String>,
    reported_request: Option<String>,
    reported_quiet: Option<String>,
    quiet_since: Option<String>,
    quiet_tool: Option<String>,
}

fn rows(db: &Database, parent_id: &str) -> Result<Vec<Row>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT d.id,d.child_session_id,d.agent,s.title,d.state,d.error,d.reported_state,\
             d.reported_request,d.reported_quiet,d.quiet_since,d.quiet_tool \
             FROM delegations d JOIN sessions s ON s.id=d.child_session_id \
             WHERE d.parent_session_id=? ORDER BY d.created_at",
        )?;
        let rows = statement.query_map([parent_id], |row| {
            Ok(Row {
                id: row.get(0)?,
                child: row.get(1)?,
                agent: row.get(2)?,
                title: row.get(3)?,
                state: row.get(4)?,
                error: row.get(5)?,
                reported_state: row.get(6)?,
                reported_request: row.get(7)?,
                reported_quiet: row.get(8)?,
                quiet_since: row.get(9)?,
                quiet_tool: row.get(10)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    })
}

fn title_of(row: &Row) -> String {
    if row.title.trim().is_empty() {
        format!("delegation {}", row.id)
    } else {
        shorten(&row.title, 120)
    }
}

/// R3: every update of one parent that it has not been told about yet.
pub(crate) fn collect_updates(db: &Database, parent_id: &str) -> Result<Vec<Update>> {
    let now = crate::delegation::now_seconds();
    let mut updates = Vec::new();
    for row in rows(db, parent_id)? {
        if crate::delegation::REPORTABLE_STATES.contains(&row.state.as_str())
            && row.reported_state.as_deref() != Some(row.state.as_str())
        {
            updates.push(Update::Terminal {
                delegation_id: row.id.clone(),
                title: title_of(&row),
                agent: row.agent.clone(),
                state: row.state.clone(),
                error: row.error.clone(),
            });
        }
        // A request is reportable only while it still waits for this parent.
        if row.state == "awaiting_parent" {
            let request = crate::delegation::pending_requests(db, &row.child)?
                .into_iter()
                .find(|request| {
                    request
                        .get("requestId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| row.reported_request.as_deref() != Some(id))
                });
            if let Some(request) = request {
                let request_id = request.get("requestId").and_then(Value::as_str).unwrap_or_default().to_owned();
                if !request_id.is_empty() {
                    updates.push(Update::Request {
                        delegation_id: row.id.clone(),
                        title: title_of(&row),
                        agent: row.agent.clone(),
                        request_id,
                        request_title: request
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("needs your decision")
                            .to_owned(),
                    });
                }
            }
        }
        // R3(c): an open episode the parent has not been told about.
        if let Some(since) = row.quiet_since.clone() {
            if row.reported_quiet.as_deref() != Some(since.as_str()) {
                let minutes = chrono::DateTime::parse_from_rfc3339(&since)
                    .map(|since| (now - since.timestamp()).max(0) / 60)
                    .unwrap_or(0)
                    .max(1);
                let tool = row
                    .quiet_tool
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .and_then(|raw| raw.get("name").and_then(Value::as_str).map(str::to_owned));
                updates.push(Update::Quiet {
                    delegation_id: row.id.clone(),
                    title: title_of(&row),
                    agent: row.agent.clone(),
                    quiet_since: since,
                    minutes,
                    tool,
                });
            }
        }
    }
    Ok(updates)
}

// ---- upgrade: what the parent already knew before push wake -----------------

/// Metadata key of [`backfill_reported_once`].
const REPORTED_BACKFILL_KEY: &str = "delegation.wake.reportedBackfill";

/// R2 on upgrade (11-18): the reported columns arrived empty, so every delegation that had ended
/// before push wake existed counted as news, and a parent's first turn end after the upgrade woke
/// it with all of those old outcomes. The parent had already seen them the old way (it asked
/// `delegation status`, and a quiet episode already gave the user its Inbox notice). Once per
/// database, every ended delegation and every open quiet episode is marked as reported. A delegate
/// that is still running is left alone: its outcome is news and wakes the parent as designed.
pub(crate) fn backfill_reported_once(connection: &rusqlite::Connection) -> Result<()> {
    let done: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM metadata WHERE key=?)",
        [REPORTED_BACKFILL_KEY],
        |row| row.get(0),
    )?;
    if done {
        return Ok(());
    }
    let states = crate::delegation::REPORTABLE_STATES
        .iter()
        .map(|state| format!("'{state}'"))
        .collect::<Vec<_>>()
        .join(",");
    let tx = connection.unchecked_transaction()?;
    tx.execute(
        &format!("UPDATE delegations SET reported_state=state WHERE reported_state IS NULL AND state IN ({states})"),
        [],
    )?;
    tx.execute(
        "UPDATE delegations SET reported_quiet=quiet_since WHERE reported_quiet IS NULL AND quiet_since IS NOT NULL",
        [],
    )?;
    tx.execute("INSERT INTO metadata(key,value) VALUES (?,'1')", [REPORTED_BACKFILL_KEY])?;
    tx.commit()?;
    Ok(())
}

/// Metadata key of [`backfill_acceptance_once`].
const ACCEPTANCE_BACKFILL_KEY: &str = "delegation.acceptance.backfill";

/// R13 on upgrade (owner decision 11-19): the acceptance columns arrived empty, so every delegate
/// that had finished before acceptance existed waited in 待处理 as 待验收. Once per database, every
/// completed delegation without a decision is marked accepted, as of its last update; one that
/// finishes after the upgrade waits for the user's decision as designed.
pub(crate) fn backfill_acceptance_once(connection: &rusqlite::Connection) -> Result<()> {
    let done: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM metadata WHERE key=?)",
        [ACCEPTANCE_BACKFILL_KEY],
        |row| row.get(0),
    )?;
    if done {
        return Ok(());
    }
    let tx = connection.unchecked_transaction()?;
    tx.execute(
        "UPDATE delegations SET acceptance='accepted',acceptance_at=updated_at WHERE state='completed' AND acceptance IS NULL",
        [],
    )?;
    tx.execute("INSERT INTO metadata(key,value) VALUES (?,'1')", [ACCEPTANCE_BACKFILL_KEY])?;
    tx.commit()?;
    Ok(())
}

// ---- R4: can this parent be woken right now? --------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wake {
    Ready,
    /// The parent is inside its own turn and answers there instead.
    InTurn,
    Off,
    /// Not a live Chat: released, exited, read-only or gone.
    Closed,
    Paused,
    Budget,
}

/// R5: everything about waking that a transaction can answer. The projection
/// and the quiet sweep call this; the provider half (the chat is open) is
/// checked by [`pass`] before it takes the queue gate.
pub(crate) fn can_wake_tx(tx: &Transaction<'_>, parent_id: &str) -> Result<bool> {
    Ok(wake_tx(tx, parent_id)? == Wake::Ready)
}

fn wake_tx(tx: &Transaction<'_>, parent_id: &str) -> Result<Wake> {
    if crate::delegation::parent_turn_active(tx, parent_id)? {
        return Ok(Wake::InTurn);
    }
    // R1: off means today's behaviour, unchanged.
    if !crate::delegation::chat_tool_settings_tx(tx)?.auto_wake {
        return Ok(Wake::Off);
    }
    let session: Option<(String, bool, bool, String)> = tx
        .query_row(
            "SELECT mode,read_only,released,status FROM sessions WHERE id=?",
            [parent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match session {
        Some((mode, read_only, released, status))
            if mode == "chat"
                && !read_only
                && !released
                && !matches!(status.as_str(), "exited" | "interrupted" | "error") => {}
        _ => return Ok(Wake::Closed),
    }
    if queue_paused_tx(tx, parent_id)? {
        return Ok(Wake::Paused);
    }
    if budget_left_tx(tx, parent_id)? <= 0 {
        return Ok(Wake::Budget);
    }
    Ok(Wake::Ready)
}

fn queue_paused_tx(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT paused FROM chat_queue_state WHERE session_id=?",
            [session_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false))
}

/// A user item is automatic when its first text part carries the marker; the
/// projection writes exactly one text part for a user message, and the history
/// paths derive from that same native text.
const AUTOMATIC_ITEM: &str =
    "(json_extract(data,'$.role')='user' AND COALESCE(json_extract(data,'$.parts[0].automatic'),0)=1)";

/// The newest user item that is the user's own words: it opens the R6 window.
fn newest_user_item_tx(tx: &Transaction<'_>, parent_id: &str) -> Result<Option<String>> {
    tx.query_row(
        &format!(
            "SELECT id FROM chat_items WHERE session_id=? AND json_extract(data,'$.role')='user' \
             AND COALESCE(json_extract(data,'$.parts[0].automatic'),0)=0 \
             ORDER BY created_at DESC, id DESC LIMIT 1"
        ),
        [parent_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

/// R6: automatic messages that count against the budget: those after the newest
/// non-automatic user message.
fn budget_left_tx(tx: &Transaction<'_>, parent_id: &str) -> Result<i64> {
    let last: Option<(String, String)> = tx
        .query_row(
            &format!(
                "SELECT created_at,id FROM chat_items WHERE session_id=? AND json_extract(data,'$.role')='user' \
                 AND COALESCE(json_extract(data,'$.parts[0].automatic'),0)=0 \
                 ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            [parent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let used: i64 = match last {
        Some((at, id)) => tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM chat_items WHERE session_id=? AND {AUTOMATIC_ITEM} \
                 AND (created_at>? OR (created_at=? AND id>?))"
            ),
            params![parent_id, at, at, id],
            |row| row.get(0),
        )?,
        None => tx.query_row(
            &format!("SELECT COUNT(*) FROM chat_items WHERE session_id=? AND {AUTOMATIC_ITEM}"),
            [parent_id],
            |row| row.get(0),
        )?,
    };
    Ok(AUTO_WAKE_BUDGET - used)
}

/// R6: one notice per budget window that wakes have stopped.
fn exhausted_notice(db: &Database, parent_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    db.transaction(|tx| {
        let last = newest_user_item_tx(tx, parent_id)?;
        let id = format!("{parent_id}:{AUTOWAKE_EXHAUSTED_KIND}:{}", last.unwrap_or_else(|| "start".into()));
        crate::chat_projection::insert_attention(
            tx,
            &id,
            parent_id,
            None,
            AUTOWAKE_EXHAUSTED_KIND,
            &json!({"delegationId": Value::Null, "budget": AUTO_WAKE_BUDGET}),
            &now,
        )
    })
}

// ---- the pass ---------------------------------------------------------------

/// The one place a wake is decided and written. Never holds a transaction while
/// calling `schedule` or a provider method.
pub(crate) fn pass(db: &Arc<Database>, providers: &Arc<Providers>, queues: &Arc<ChatQueues>, parent_id: &str) {
    if let Err(error) = run(db, providers, queues, parent_id) {
        eprintln!("delegation wake for {parent_id} failed: {error}");
    }
}

/// R4: called after every committed event of a delegated child, after a quiet
/// sweep that changed episodes, and after every turn end of a parent.
pub(crate) fn after_event(
    db: &Arc<Database>,
    providers: &Arc<Providers>,
    queues: &Arc<ChatQueues>,
    event: &crate::providers::ProviderEvent,
) {
    // Only these kinds change a delegate's state (`project_child_event`) or end
    // a parent's turn; streamed deltas and tool updates skip the lookup. Quiet
    // episodes and stops are written elsewhere and run the pass themselves.
    if !matches!(
        event.kind.as_str(),
        "chat.approval" | "chat.approval.resolved" | "chat.turn.completed" | "chat.error"
    ) {
        return;
    }
    let mut parents: Vec<String> = Vec::new();
    if let Ok(Some(parent)) = crate::delegation::parent_of(db, &event.session_id) {
        parents.push(parent);
    } else if matches!(event.kind.as_str(), "chat.turn.completed" | "chat.error") {
        // The parent's own turn end: wake it for whatever it did not see.
        parents.push(event.session_id.clone());
    }
    parents.sort();
    parents.dedup();
    for parent in parents {
        pass(db, providers, queues, &parent);
    }
}

fn run(db: &Arc<Database>, providers: &Arc<Providers>, queues: &Arc<ChatQueues>, parent_id: &str) -> Result<()> {
    let updates = collect_updates(db, parent_id)?;
    if updates.is_empty() {
        return Ok(());
    }
    // The provider half of R4 is asked before any transaction or gate is taken.
    let wake = if providers.chat_is_open(parent_id) {
        db.transaction(|tx| wake_tx(tx, parent_id))?
    } else {
        Wake::Closed
    };
    match wake {
        // The parent answers inside its own turn; the pass after its turn end
        // wakes it for what is still unreported.
        Wake::InTurn => Ok(()),
        Wake::Ready => deliver(db, providers, queues, parent_id, &updates),
        Wake::Budget => {
            exhausted_notice(db, parent_id)?;
            fallback(db, parent_id, &updates)
        }
        Wake::Off | Wake::Closed | Wake::Paused => fallback(db, parent_id, &updates),
    }
}

/// R4: one queue item per parent, coalescing into a wake that is still queued,
/// and the reported marks in the same transaction. Returns what the gate saw:
/// `Ready` means the wake was written and the caller schedules after this
/// returns.
fn write_wake(
    db: &Arc<Database>,
    queues: &Arc<ChatQueues>,
    parent_id: &str,
    updates: &[Update],
) -> Result<Wake> {
    let mut seen = Wake::Ready;
    // The same queue gate dispatch takes, so a wake can never rewrite an item
    // that `try_dispatch` reserved as `sending`.
    queues.group_control(db, parent_id, |tx| {
        // Re-read under the gate: a turn or a pause may have started meanwhile.
        seen = wake_tx(tx, parent_id)?;
        if seen != Wake::Ready {
            return Ok(());
        }
        let queued: Option<(String, String)> = tx
            .query_row(
                "SELECT id,text FROM chat_queue_items WHERE session_id=? AND id LIKE 'autowake-%' \
                 AND state='queued' ORDER BY position,id LIMIT 1",
                [parent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let text = match &queued {
            Some((_, existing)) => {
                let mut lines = update_lines(existing);
                lines.extend(updates.iter().map(Update::line));
                wake_text(&lines)
            }
            None => wake_text(&updates.iter().map(Update::line).collect::<Vec<_>>()),
        };
        let replaced = match &queued {
            Some((id, _)) => chat_queue::rewrite_owned(tx, parent_id, id, &text)?,
            None => false,
        };
        if !replaced {
            chat_queue::add_owned(tx, parent_id, &new_wake_id(), &text)?;
        }
        for update in updates {
            update.mark_reported(tx)?;
        }
        Ok(())
    })?;
    Ok(seen)
}

fn deliver(
    db: &Arc<Database>,
    providers: &Arc<Providers>,
    queues: &Arc<ChatQueues>,
    parent_id: &str,
    updates: &[Update],
) -> Result<()> {
    match write_wake(db, queues, parent_id, updates)? {
        // After the commit only: `schedule` spawns the dispatch thread.
        Wake::Ready => {
            queues.schedule(db, providers, parent_id);
            Ok(())
        }
        Wake::InTurn => Ok(()),
        // The state changed between the first check and the gate: the same
        // fallback as when the first check had seen it.
        Wake::Budget => {
            exhausted_notice(db, parent_id)?;
            fallback(db, parent_id, updates)
        }
        Wake::Off | Wake::Closed | Wake::Paused => fallback(db, parent_id, updates),
    }
}

/// R5/R7: no wake is possible, so the parent's requests go back to the user and
/// a quiet episode keeps today's Inbox notice.
fn fallback(db: &Arc<Database>, parent_id: &str, updates: &[Update]) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    if updates.iter().any(|update| matches!(update, Update::Request { .. })) {
        db.transaction(|tx| crate::chat_projection::escalate_parent_requests(tx, parent_id, &now, false))?;
    }
    for update in updates {
        let Update::Quiet { delegation_id, quiet_since, minutes, tool, .. } = update else {
            continue;
        };
        let Some(child) = child_of(db, delegation_id)? else {
            continue;
        };
        let notice = format!("{delegation_id}:quiet:{quiet_since}");
        let data = json!({"delegationId": delegation_id, "quietSeconds": minutes * 60, "openTool": tool});
        db.transaction(|tx| {
            crate::chat_projection::insert_attention(tx, &notice, &child, None, "quiet", &data, &now)?;
            // R11: the notice is the user's, so only a new episode is news to the parent.
            crate::delegation::mark_reported(tx, delegation_id, None, None, Some(quiet_since))
        })?;
    }
    Ok(())
}

fn child_of(db: &Database, delegation_id: &str) -> Result<Option<String>> {
    db.transaction(|tx| {
        tx.query_row("SELECT child_session_id FROM delegations WHERE id=?", [delegation_id], |row| row.get(0))
            .optional()
            .map_err(Into::into)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderRuntime, Providers,
        TerminalCommand,
    };
    use tempfile::TempDir;

    struct FakeChat;

    impl ChatSession for FakeChat {
        fn native_id(&self) -> Option<String> {
            Some("fake-native".into())
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            Ok(json!({"turnId":"fake-turn"}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), ProviderError> {
            Ok(())
        }
        fn set_option(&mut self, _: &str, value: &str) -> Result<Value, ProviderError> {
            Ok(json!({"value": value}))
        }
        fn ui_state(&self) -> Value {
            json!({"options":[]})
        }
    }

    struct FakeProvider;

    impl ProviderAdapter for FakeProvider {
        fn id(&self) -> &str {
            "fake"
        }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source: "builtin", plugin_id: None, icon: None, sign_in: None, remote_sign_in: None,
                homepage: None, id: "fake".into(), name: "Fake".into(), installed: true, version: None,
                terminal: false, chat: true, history: false, resume: false,
                terminal_resume_capture: "none", reason: None, auth: "unknown".into(),
                setup: Default::default(),
            }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "wake fixture"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
            Ok(json!([]))
        }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(FakeChat))
        }
    }

    const PENDING: &str = r#"{"id":"c:approval:a1","role":"assistant","parts":[{"type":"approval","approvalId":"a1","status":"pending","data":{"title":"Run npm test?","interaction":"permission","choices":[{"choiceId":"allow","label":"Allow","scope":"once"}],"delegation":{"parentSessionId":"p","route":"parent"}}}],"createdAt":"now","turnId":"turn"}"#;

    struct Fixture {
        _root: TempDir,
        db: Arc<Database>,
        providers: Arc<Providers>,
        queues: Arc<ChatQueues>,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let db = Arc::new(Database::open(&root.path().join("wake.sqlite")).unwrap());
            crate::chat_queue::initialize(&db).unwrap();
            db.transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('p','Parent','fake','chat','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])?;
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('c','Fix the parser','fake','chat','running','2026-01-01T00:00:01Z','2026-01-01T00:00:01Z')", [])?;
                tx.execute("INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,turn_id,state,created_at,updated_at) VALUES ('d','p','c','fake','shared','C:/fixture',NULL,'work',0,'op','turn','running','2026-01-01T00:00:02Z','2026-01-01T00:00:02Z')", [])?;
                Ok(())
            })
            .unwrap();
            Self {
                _root: root,
                db,
                providers: Arc::new(Providers::for_test(vec![Arc::new(FakeProvider)])),
                queues: Arc::new(ChatQueues::default()),
            }
        }

        fn open_parent(&self) {
            self.providers.chat_open("p", "fake", "C:/fixture", None).unwrap();
        }

        fn set_wake(&self, on: bool) {
            self.db
                .transaction(|tx| {
                    tx.execute(
                        "UPDATE settings SET value=? WHERE singleton=1",
                        [serde_json::to_string(&json!({"chatTools.autoWake": on}))?],
                    )?;
                    Ok(())
                })
                .unwrap();
        }

        fn complete(&self) {
            self.db
                .transaction(|tx| crate::delegation::set_state(tx, "d", "completed", Some("done"), None))
                .unwrap();
        }

        fn awaiting_parent(&self) {
            self.db
                .transaction(|tx| {
                    crate::delegation::set_state(tx, "d", "awaiting_parent", None, None)?;
                    tx.execute(
                        "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES ('c:approval:a1','c','turn','message',?,'2026-01-01T00:00:03Z')",
                        [PENDING],
                    )?;
                    Ok(())
                })
                .unwrap();
        }

        fn set_quiet(&self, since: &str) {
            self.db
                .transaction(|tx| {
                    tx.execute(
                        "UPDATE delegations SET quiet_since=?,quiet_tool=? WHERE id='d'",
                        params![since, json!({"name":"bash","since":since}).to_string()],
                    )?;
                    Ok(())
                })
                .unwrap();
        }

        fn reported(&self) -> (Option<String>, Option<String>, Option<String>) {
            self.db
                .transaction(|tx| {
                    tx.query_row(
                        "SELECT reported_state,reported_request,reported_quiet FROM delegations WHERE id='d'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(Into::into)
                })
                .unwrap()
        }

        fn queue(&self) -> Vec<(String, String, String)> {
            self.db
                .transaction(|tx| {
                    Ok(tx
                        .prepare("SELECT id,state,text FROM chat_queue_items WHERE session_id='p' ORDER BY position")
                        .unwrap()
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()?)
                })
                .unwrap()
        }

        fn inbox(&self) -> Vec<(String, String)> {
            self.db
                .transaction(|tx| {
                    Ok(tx
                        .prepare("SELECT id,kind FROM inbox ORDER BY id")
                        .unwrap()
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()?)
                })
                .unwrap()
        }

        fn route(&self) -> Option<String> {
            self.db
                .transaction(|tx| {
                    Ok(tx
                        .query_row(
                            "SELECT json_extract(part.value,'$.data.delegation.route') FROM chat_items item, json_each(item.data,'$.parts') part WHERE item.session_id='c'",
                            [],
                            |row| row.get(0),
                        )
                        .optional()?)
                })
                .unwrap()
        }
    }

    fn updates(fixture: &Fixture) -> Vec<Update> {
        collect_updates(&fixture.db, "p").unwrap()
    }

    #[test]
    fn the_automatic_marker_is_the_fixed_first_line() {
        assert!(is_automatic_text(AUTOMATIC_FIRST_LINE));
        assert!(is_automatic_text(&format!("{AUTOMATIC_FIRST_LINE}\n- something")));
        assert!(!is_automatic_text("Please fix the parser"));
        assert!(!is_automatic_text(""));
        let mut item = crate::domain::ChatItem {
            id: "c:user:1".into(),
            role: "user".into(),
            parts: vec![json!({"type":"text","text":format!("{AUTOMATIC_FIRST_LINE}\n- done")})],
            created_at: "now".into(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        };
        mark_automatic_parts(&mut item);
        assert!(is_automatic_item(&item));
        // The build the repair path makes carries the flag too (`scoped_history_item`).
        let scoped = crate::db::scoped_history_item("c", &item);
        assert!(
            scoped.parts[0].get("automatic").and_then(Value::as_bool) == Some(true),
            "history rebuilds keep the marker"
        );
        // A send back is the user's own text: it never starts with that line.
        assert!(!is_automatic_text(&sendback_text("Fix the parser", "d", "please add tests")));
    }

    #[test]
    fn a_wake_carries_one_line_per_update_and_coalesces_into_the_queued_item() {
        let fixture = Fixture::new();
        fixture.open_parent();
        fixture.complete();
        let collected = updates(&fixture);
        assert_eq!(collected.len(), 1);
        assert_eq!(write_wake(&fixture.db, &fixture.queues, "p", &collected).unwrap(), Wake::Ready);
        // R2: the update the wake carried is reported.
        assert_eq!(fixture.reported().0.as_deref(), Some("completed"));
        let queue = fixture.queue();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].1, "queued");
        assert!(queue[0].2.starts_with(AUTOMATIC_FIRST_LINE));
        assert!(queue[0].2.contains("- \"Fix the parser\" (fake, d) completed. Read it with delegate_result."));
        assert!(queue[0].2.ends_with(AUTOMATIC_CLOSING));
        // Nothing is reportable twice.
        assert!(updates(&fixture).is_empty());
        // A new update while the wake is still queued rewrites it (coalescing).
        // A second update arrives (the delegate runs again and finishes).
        fixture
            .db
            .transaction(|tx| {
                tx.execute("UPDATE delegations SET reported_state=NULL, state='running' WHERE id='d'", [])?;
                crate::delegation::set_state(tx, "d", "completed", Some("again"), None)
            })
            .unwrap();
        let again = updates(&fixture);
        assert_eq!(again.len(), 1);
        assert_eq!(write_wake(&fixture.db, &fixture.queues, "p", &again).unwrap(), Wake::Ready);
        let queue = fixture.queue();
        assert_eq!(queue.len(), 1, "one wake item per parent");
        assert_eq!(queue[0].2.matches("Read it with delegate_result").count(), 2);
        let revision: i64 = fixture
            .db
            .transaction(|tx| {
                tx.query_row("SELECT revision FROM chat_queue_items WHERE session_id='p'", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert!(revision > 1, "coalescing bumps the revision");
    }

    #[test]
    fn the_budget_stops_wakes_and_notices_the_parent_once() {
        let fixture = Fixture::new();
        fixture.open_parent();
        // The user's own message opens the window; 12 automatic messages fill it.
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES ('p:user:own','p','t0','message','{\"id\":\"p:user:own\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"ship it\"}],\"createdAt\":\"2026-01-01T00:00:10Z\",\"turnId\":\"t0\"}','2026-01-01T00:00:10Z')",
                    [],
                )?;
                for index in 0..AUTO_WAKE_BUDGET {
                    tx.execute(
                        &format!("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES ('p:user:auto{index}','p','t{index}','message','{{\"id\":\"p:user:auto{index}\",\"role\":\"user\",\"parts\":[{{\"type\":\"text\",\"text\":\"auto\",\"automatic\":true}}],\"createdAt\":\"2026-01-01T00:01:{index:02}Z\",\"turnId\":\"t{index}\"}}','2026-01-01T00:01:{index:02}Z')"),
                        [],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        fixture.complete();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert!(fixture.queue().is_empty(), "no wake once the budget is spent");
        assert_eq!(fixture.reported().0, None, "nothing was reported");
        let inbox = fixture.inbox();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].1, AUTOWAKE_EXHAUSTED_KIND);
        assert_eq!(inbox[0].0, "p:autowake_exhausted:p:user:own");
        // One notice per budget window, however often the pass runs.
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert_eq!(fixture.inbox().len(), 1);
        // A new user message opens a new window.
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES ('p:user:again','p','t9','message','{\"id\":\"p:user:again\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"go on\"}],\"createdAt\":\"2026-01-01T00:02:00Z\",\"turnId\":\"t9\"}','2026-01-01T00:02:00Z')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert_eq!(fixture.queue().len(), 1, "a new window wakes again");
    }

    #[test]
    fn an_update_during_the_turn_is_woken_for_when_the_turn_ends() {
        let fixture = Fixture::new();
        fixture.open_parent();
        fixture
            .db
            .transaction(|tx| {
                tx.execute("INSERT INTO session_activity(session_id,state,revision,turn_id) VALUES ('p','running',1,'parent-turn')", [])?;
                Ok(())
            })
            .unwrap();
        fixture.complete();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert!(fixture.queue().is_empty(), "the parent answers inside its own turn");
        assert_eq!(fixture.reported().0, None);
        // The turn ends: the pass after it wakes the parent for the same update.
        fixture
            .db
            .transaction(|tx| {
                tx.execute("UPDATE session_activity SET state='idle' WHERE session_id='p'", [])?;
                Ok(())
            })
            .unwrap();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert_eq!(fixture.queue().len(), 1);
        assert_eq!(fixture.reported().0.as_deref(), Some("completed"));
    }

    #[test]
    fn only_a_reported_request_is_escalated_at_the_turn_end() {
        let fixture = Fixture::new();
        fixture.awaiting_parent();
        let now = Utc::now().to_rfc3339();
        // Unreported: it stays with the parent, which the wake pass handles.
        fixture
            .db
            .transaction(|tx| crate::chat_projection::escalate_parent_requests(tx, "p", &now, true))
            .unwrap();
        assert_eq!(fixture.route().as_deref(), Some("parent"));
        assert!(fixture.inbox().is_empty());
        // Reported (the parent saw it in delegate_status): the user gets it.
        fixture
            .db
            .transaction(|tx| crate::delegation::mark_reported(tx, "d", None, Some("a1"), None))
            .unwrap();
        fixture
            .db
            .transaction(|tx| crate::chat_projection::escalate_parent_requests(tx, "p", &now, true))
            .unwrap();
        assert_eq!(fixture.route().as_deref(), Some("user"));
        assert_eq!(fixture.inbox().len(), 1);
        assert_eq!(fixture.inbox()[0].1, "approval");
    }

    #[test]
    fn a_request_and_a_quiet_episode_fall_back_when_the_chat_is_not_open() {
        let fixture = Fixture::new();
        // No chat_open: `pass` cannot wake this parent.
        fixture.awaiting_parent();
        fixture.set_quiet("2026-01-01T00:00:05Z");
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert!(fixture.queue().is_empty(), "a closed chat gets no queue item");
        // R5/R7: the request goes back to the user at once, with a notice.
        assert_eq!(fixture.route().as_deref(), Some("user"));
        let inbox = fixture.inbox();
        assert!(inbox.iter().any(|(_, kind)| kind == "approval"));
        // R11: the quiet episode keeps today's notice, and is not news again.
        assert!(inbox.iter().any(|(_, kind)| kind == "quiet"));
        assert_eq!(fixture.reported().2.as_deref(), Some("2026-01-01T00:00:05Z"));
        let quiet_before = fixture.inbox().len();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert_eq!(fixture.inbox().len(), quiet_before, "one notice per episode");
    }

    #[test]
    fn with_the_setting_off_nothing_is_woken_and_nothing_is_reported() {
        let fixture = Fixture::new();
        fixture.open_parent();
        fixture.set_wake(false);
        fixture.complete();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert!(fixture.queue().is_empty(), "off means today's behaviour");
        assert_eq!(fixture.reported().0, None);
        assert_eq!(crate::delegation::chat_tool_settings(&fixture.db).unwrap().auto_wake, false);
    }

    #[test]
    fn a_quiet_episode_a_wake_carries_gets_no_inbox_notice() {
        let fixture = Fixture::new();
        fixture.open_parent();
        fixture.set_quiet("2026-01-01T00:00:05Z");
        let collected = updates(&fixture);
        assert_eq!(collected.len(), 1);
        assert_eq!(write_wake(&fixture.db, &fixture.queues, "p", &collected).unwrap(), Wake::Ready);
        let queue = fixture.queue();
        assert!(queue[0].2.contains("has had no activity for"));
        assert!(queue[0].2.contains("while running bash"));
        assert_eq!(fixture.reported().2.as_deref(), Some("2026-01-01T00:00:05Z"));
        assert!(fixture.inbox().is_empty(), "woken for, so the user is not told");
    }

    #[test]
    fn a_paused_queue_is_not_woken_into() {
        let fixture = Fixture::new();
        fixture.open_parent();
        crate::chat_queue::pause(&fixture.db, "p", "user").unwrap();
        fixture.complete();
        pass(&fixture.db, &fixture.providers, &fixture.queues, "p");
        assert!(fixture.queue().is_empty());
        assert_eq!(fixture.reported().0, None);
        // A pause the first check missed is seen under the queue gate.
        let collected = updates(&fixture);
        assert_eq!(write_wake(&fixture.db, &fixture.queues, "p", &collected).unwrap(), Wake::Paused);
        assert!(fixture.queue().is_empty());
    }

    #[test]
    fn an_upgrade_reports_nothing_that_ended_before_push_wake_and_backfills_once() {
        // A database the previous build already opened: the reported columns exist, are empty, and
        // no backfill ran. One delegation completed, one failed, one is still running with an open
        // quiet episode, one was cancelled.
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("upgrade.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.transaction(|tx| {
                for (id, status) in [("p", "idle"), ("c1", "idle"), ("c2", "idle"), ("c3", "running"), ("c4", "idle")] {
                    tx.execute(
                        "INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES (?,?,'fake','chat',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                        params![id, id, status],
                    )?;
                }
                for (id, child, state) in [("d1", "c1", "completed"), ("d2", "c2", "failed"), ("d3", "c3", "running"), ("d4", "c4", "cancelled")] {
                    tx.execute(
                        "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,turn_id,state,created_at,updated_at) VALUES (?,'p',?,'fake','shared','C:/fixture',NULL,'work',0,?,'turn',?,'2026-01-01T00:00:02Z','2026-01-01T00:00:02Z')",
                        params![id, child, format!("op-{id}"), state],
                    )?;
                }
                tx.execute("UPDATE delegations SET quiet_since='2026-01-01T00:00:05Z' WHERE id='d3'", [])?;
                tx.execute("DELETE FROM metadata WHERE key=?", [REPORTED_BACKFILL_KEY])?;
                Ok(())
            })
            .unwrap();
            assert_eq!(collect_updates(&db, "p").unwrap().len(), 3, "the old outcomes and the old episode read as news");
        }
        let marks = |db: &Database| -> Vec<(String, Option<String>, Option<String>)> {
            db.transaction(|tx| {
                let mut statement = tx.prepare("SELECT id,reported_state,reported_quiet FROM delegations ORDER BY id")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
            })
            .unwrap()
        };
        let db = Database::open(&path).unwrap();
        let some = |value: &str| Some(value.to_owned());
        assert_eq!(
            marks(&db),
            vec![
                ("d1".to_owned(), some("completed"), None),
                ("d2".to_owned(), some("failed"), None),
                ("d3".to_owned(), None, some("2026-01-01T00:00:05Z")),
                ("d4".to_owned(), None, None),
            ]
        );
        assert!(collect_updates(&db, "p").unwrap().is_empty(), "nothing that ended before the upgrade wakes the parent");
        // Once only: an outcome after the upgrade is news, and a restart does not mark it.
        db.transaction(|tx| crate::delegation::set_state(tx, "d3", "completed", Some("done"), None)).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        let fresh = collect_updates(&db, "p").unwrap();
        assert_eq!(fresh.len(), 1, "{fresh:?}");
        assert!(matches!(&fresh[0], Update::Terminal { delegation_id, state, .. } if delegation_id == "d3" && state == "completed"));
    }

    #[test]
    fn an_upgrade_accepts_what_finished_before_acceptance_existed_once() {
        // A database the previous build already opened: the acceptance columns exist and are empty
        // except for one decision the user made on that build.
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("acceptance.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.transaction(|tx| {
                for (id, status) in [("p", "idle"), ("c1", "idle"), ("c2", "idle"), ("c3", "running"), ("c4", "idle")] {
                    tx.execute(
                        "INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES (?,?,'fake','chat',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                        params![id, id, status],
                    )?;
                }
                for (id, child, state) in [("d1", "c1", "completed"), ("d2", "c2", "failed"), ("d3", "c3", "running"), ("d4", "c4", "completed")] {
                    tx.execute(
                        "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,turn_id,state,created_at,updated_at) VALUES (?,'p',?,'fake','shared','C:/fixture',NULL,'work',0,?,'turn',?,'2026-01-01T00:00:02Z','2026-01-01T00:00:09Z')",
                        params![id, child, format!("op-{id}"), state],
                    )?;
                }
                tx.execute("UPDATE delegations SET acceptance='sent_back',acceptance_at='2026-01-01T00:00:10Z' WHERE id='d4'", [])?;
                tx.execute("DELETE FROM metadata WHERE key=?", [ACCEPTANCE_BACKFILL_KEY])?;
                Ok(())
            })
            .unwrap();
        }
        let decisions = |db: &Database| -> Vec<(String, Option<String>, Option<String>)> {
            db.transaction(|tx| {
                let mut statement = tx.prepare("SELECT id,acceptance,acceptance_at FROM delegations ORDER BY id")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
            })
            .unwrap()
        };
        let some = |value: &str| Some(value.to_owned());
        let db = Database::open(&path).unwrap();
        assert_eq!(
            decisions(&db),
            vec![
                ("d1".to_owned(), some("accepted"), some("2026-01-01T00:00:09Z")),
                ("d2".to_owned(), None, None),
                ("d3".to_owned(), None, None),
                ("d4".to_owned(), some("sent_back"), some("2026-01-01T00:00:10Z")),
            ],
            "only a completed delegate without a decision is accepted, as of when it finished"
        );
        // Once only: a delegate that finishes after the upgrade waits for the user, across restarts.
        db.transaction(|tx| crate::delegation::set_state(tx, "d3", "completed", Some("done"), None)).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(decisions(&db)[2], ("d3".to_owned(), None, None));
    }

    #[test]
    fn a_multi_line_error_stays_one_update_line() {
        // Coalescing re-reads a queued wake line by line.
        let failed = Update::Terminal {
            delegation_id: "d".into(),
            title: "Fix the parser".into(),
            agent: "fake".into(),
            state: "failed".into(),
            error: Some("exit 1\n  at step two\n".into()),
        };
        let line = failed.line();
        assert!(!line.contains('\n'), "{line}");
        assert!(line.ends_with("failed: exit 1 at step two"), "{line}");
        assert_eq!(update_lines(&wake_text(&[line.clone()])), [line]);
        assert_eq!(shorten(&"x".repeat(250), 200).chars().count(), 201);
    }
}
