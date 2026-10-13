use crate::domain::ChatItem;
use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const METHOD: &str = "chat.repair";
pub(crate) const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const HISTORY_FRAME_HEADROOM_BYTES: usize = 64 * 1024;
const EXPIRED_EN: &str = "This request expired when history was repaired.";
const EXPIRED_ZH_CN: &str = "此请求已在历史修复时过期。";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RepairWorkerState {
    pub generation: u64,
    pub worker_token: Option<String>,
    pub registered: bool,
    pub connecting: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRepairAvailability {
    pub offered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingress_failed: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRepairResult {
    pub session_id: String,
    pub mode: String,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub expired: usize,
    pub total: usize,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionState {
    provider: String,
    native_id: Option<String>,
    mode: String,
    status: String,
    read_only: bool,
    activity: Option<ActivityState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivityState {
    state: String,
    revision: i64,
    turn_id: Option<String>,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeOwnerState {
    id: String,
    status: String,
    read_only: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct RawChatRow {
    id: String,
    session_id: String,
    turn_id: Option<String>,
    kind: String,
    data: String,
    created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct RepairCapture {
    pub session_id: String,
    pub provider: String,
    pub native_id: String,
    session: SessionState,
    transcript: Vec<RawChatRow>,
    integrity_marker: Option<String>,
    native_owners: Vec<NativeOwnerState>,
    worker: RepairWorkerState,
    reader_available: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RepairPlan {
    session_id: String,
    items: Vec<ChatItem>,
    history_expired: HashSet<String>,
}

pub(crate) struct RepairCommitContext<'a> {
    pub principal: &'a str,
    pub lease_epoch: i64,
    pub operation_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRepairSnapshot {
    pub items: Vec<ChatItem>,
    pub revision: i64,
    pub repair: ChatRepairAvailability,
}

pub(crate) fn availability(
    tx: &Transaction<'_>,
    session_id: &str,
    worker: &RepairWorkerState,
    reader_available: bool,
) -> Result<ChatRepairAvailability> {
    let Some(session) = session_state(tx, session_id)? else {
        return Ok(unavailable("session_unavailable", false, None));
    };
    let marker = integrity_marker(tx, session_id)?;
    let degraded = marker.is_some();
    let marker_data = marker
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let diagnostic = marker_data.as_ref().and_then(|value| {
            value
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });

    if session.mode != "chat" || session.status == "exited" {
        return Ok(unavailable("session_unavailable", degraded, diagnostic));
    }
    let stopped_without_worker =
        session.status == "interrupted" && !worker.registered && !worker.connecting;
    let activity = session
        .activity
        .as_ref()
        .map(|activity| activity.state.as_str());
    if worker.connecting
        || matches!(session.status.as_str(), "starting" | "running" | "waiting")
        || (!stopped_without_worker
            && matches!(
                activity,
                // awaiting_input is "reply ready" after a completed turn
                // (chat_projection), not a running turn: repair stays offered.
                Some("running" | "awaiting_approval" | "awaiting_parent")
            ))
    {
        return Ok(unavailable("busy", degraded, diagnostic));
    }
    if !stopped_without_worker
        && (activity == Some("unknown") || (activity.is_none() && worker.registered))
    {
        return Ok(unavailable("unknown_activity", degraded, diagnostic));
    }
    // Imports created before turn metadata existed keep their generated
    // `session:history:` row IDs even after explicit resume. Offer the fenced
    // rebuild only for that durable legacy provenance; a generic missing
    // duration/status or turn ID is not evidence of degradation. New imports
    // and rebuilds carry turn_origin, while resumed sessions may later contain
    // ordinary live projection rows alongside the legacy rows.
    let metadata_missing = history_metadata_missing(tx, session_id)?;
    if !degraded
        && !metadata_missing
        && !matches!(session.status.as_str(), "error" | "interrupted")
    {
        return Ok(unavailable("healthy", false, None));
    }
    if session.native_id.as_deref().is_none_or(str::is_empty) {
        return Ok(unavailable("missing_native_id", degraded, diagnostic));
    }
    if !reader_available {
        return Ok(unavailable("history_unavailable", degraded, diagnostic));
    }
    Ok(ChatRepairAvailability {
        offered: true,
        mode: Some("rebuild"),
        reason: metadata_missing.then_some("history_metadata_missing"),
        degraded,
        diagnostic: if metadata_missing {
            Some("history_metadata_missing".to_owned())
        } else {
            diagnostic
        },
        ingress_failed: None,
    })
}

pub(crate) fn capture(
    tx: &Transaction<'_>,
    session_id: &str,
    worker: &RepairWorkerState,
    reader_available: bool,
) -> Result<RepairCapture> {
    let gate = availability(tx, session_id, worker, reader_available)?;
    if !gate.offered {
        bail!(
            "chat_repair_unavailable:{}",
            gate.reason.unwrap_or("session_unavailable")
        );
    }
    let session = session_state(tx, session_id)?.ok_or_else(|| anyhow!("session_not_found"))?;
    let native_id = session
        .native_id
        .clone()
        .ok_or_else(|| anyhow!("chat_repair_unavailable:missing_native_id"))?;
    let native_owners = native_owners(tx, &session.provider, &native_id)?;
    Ok(RepairCapture {
        session_id: session_id.to_owned(),
        provider: session.provider.clone(),
        native_id,
        session,
        transcript: raw_transcript(tx, session_id)?,
        integrity_marker: integrity_marker(tx, session_id)?,
        native_owners,
        worker: worker.clone(),
        reader_available,
    })
}

pub(crate) fn snapshot(
    tx: &Transaction<'_>,
    session_id: &str,
    worker: &RepairWorkerState,
    reader_available: bool,
) -> Result<ChatRepairSnapshot> {
    let mut statement =
        tx.prepare("SELECT data FROM chat_items WHERE session_id=? ORDER BY created_at,id")?;
    let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(serde_json::from_str(&row?)?);
    }
    drop(statement);
    let revision = tx.query_row("SELECT COALESCE(MAX(seq),0) FROM outbox", [], |row| {
        row.get(0)
    })?;
    Ok(ChatRepairSnapshot {
        items,
        revision,
        repair: availability(tx, session_id, worker, reader_available)?,
    })
}

/// Pure validation and normalization. It runs after the sole native history
/// read and before the provider-registry/SQLite commit fence is reacquired.
pub(crate) fn prepare(capture: &RepairCapture, history: &[ChatItem]) -> Result<RepairPlan> {
    let serialized = serde_json::to_vec(history)?;
    if serialized.len() > MAX_HISTORY_BYTES {
        bail!("invalid_history_transcript: history exceeds 8 MiB");
    }
    // An empty native record must never wipe a non-empty local transcript: a
    // reader/shape mismatch or missing native session would otherwise "succeed".
    if history.is_empty() && !capture.transcript.is_empty() {
        bail!("invalid_history_transcript: native history is empty");
    }
    let mut ids = HashSet::new();
    let mut items = Vec::with_capacity(history.len());
    let mut history_expired = HashSet::new();
    for source in history {
        if source.id.is_empty() || source.id == "unknown" || !ids.insert(source.id.as_str()) {
            bail!("invalid_history_transcript: missing, fallback or duplicate item id");
        }
        if source.turn_id.as_deref().is_some_and(str::is_empty) {
            bail!("invalid_history_transcript: empty turn id");
        }
        if !matches!(
            source.role.as_str(),
            "user" | "assistant" | "tool" | "system"
        ) {
            bail!("invalid_history_transcript: unsupported item role");
        }
        let mut item = crate::db::scoped_history_item(&capture.session_id, source);
        for (part_index, part) in item.parts.iter_mut().enumerate() {
            validate_part(part)?;
            let approval_id = part
                .get("approvalId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if settle_approval_part(part) == 1 {
                history_expired.insert(format!(
                    "{}:{}",
                    item.id,
                    approval_id.unwrap_or_else(|| part_index.to_string())
                ));
            }
        }
        items.push(item);
    }
    let output_size = serde_json::to_vec(&json!({
        "items":items,
        "revision":i64::MAX,
        "repair":{
            "offered":true,
            "mode":"rebuild",
            "degraded":true,
            "diagnostic":"history repair"
        }
    }))?
    .len();
    if output_size > MAX_HISTORY_BYTES - HISTORY_FRAME_HEADROOM_BYTES {
        bail!("invalid_history_transcript: normalized snapshot exceeds frame limit");
    }
    Ok(RepairPlan {
        session_id: capture.session_id.clone(),
        items,
        history_expired,
    })
}

pub(crate) fn commit(
    tx: &Transaction<'_>,
    capture: &RepairCapture,
    plan: &RepairPlan,
    current_worker: &RepairWorkerState,
    reader_available: bool,
    context: RepairCommitContext<'_>,
) -> Result<ChatRepairResult> {
    let RepairCommitContext { principal, lease_epoch, operation_id } = context;
    require_lease(tx, &capture.session_id, principal, lease_epoch)?;
    if let Some((method, raw)) = tx
        .query_row(
            "SELECT method,result FROM operations WHERE id=?",
            [operation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if method != METHOD {
            bail!("operation_conflict");
        }
        return Ok(serde_json::from_str(&raw)?);
    }
    let binding: Option<(String, String)> = tx
        .query_row(
            "SELECT method,params FROM operation_requests WHERE id=?",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((bound_method, bound_params)) = binding else {
        bail!("operation_unbound");
    };
    let bound_params: Value = serde_json::from_str(&bound_params)?;
    if bound_method != METHOD || bound_params != json!({"sessionId":capture.session_id}) {
        bail!("operation_conflict");
    }
    if plan.session_id != capture.session_id
        || current_worker != &capture.worker
        || reader_available != capture.reader_available
    {
        bail!("chat_repair_superseded");
    }
    let current_session = session_state(tx, &capture.session_id)?;
    let current_transcript = raw_transcript(tx, &capture.session_id)?;
    let current_marker = integrity_marker(tx, &capture.session_id)?;
    let current_owners = native_owners(tx, &capture.provider, &capture.native_id)?;
    if current_session.as_ref() != Some(&capture.session)
        || current_transcript != capture.transcript
        || current_marker != capture.integrity_marker
        || current_owners != capture.native_owners
        || !availability(tx, &capture.session_id, current_worker, reader_available)?.offered
    {
        bail!("chat_repair_superseded");
    }

    let old_items = parsed_items(&capture.transcript);
    let old_positions: HashMap<&str, usize> = capture
        .transcript
        .iter()
        .enumerate()
        .map(|(index, row)| (row.id.as_str(), index))
        .collect();
    let final_ids: HashSet<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
    let old_ids: HashSet<&str> = capture
        .transcript
        .iter()
        .map(|row| row.id.as_str())
        .collect();
    let added = final_ids.difference(&old_ids).count();
    let removed = old_ids.difference(&final_ids).count();
    let updated = plan
        .items
        .iter()
        .enumerate()
        .filter(|(index, item)| {
            old_positions
                .get(item.id.as_str())
                .is_some_and(|old_index| {
                    *old_index != *index
                        || old_items
                            .get(item.id.as_str())
                            .is_none_or(|old| !same_meaning(old, item))
                })
        })
        .count();
    let mut expired_keys = active_approval_keys(&capture.transcript);
    expired_keys.extend(plan.history_expired.iter().cloned());
    let expired = expired_keys.len();

    let backup = serde_json::to_string(&capture.transcript)?;
    tx.execute(
        "INSERT INTO chat_repair_backups(session_id,created_at,items_json) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET created_at=excluded.created_at,items_json=excluded.items_json",
        params![capture.session_id, Utc::now().to_rfc3339(), backup],
    )?;
    tx.execute(
        "DELETE FROM chat_items WHERE session_id=?",
        [&capture.session_id],
    )?;

    let transcript_unchanged = added == 0 && updated == 0 && removed == 0;
    let base = Utc::now();
    let changed_ids: HashSet<&str> = plan
        .items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if !old_ids.contains(item.id.as_str())
                || old_positions.get(item.id.as_str()).copied() != Some(index)
                || old_items
                    .get(item.id.as_str())
                    .is_none_or(|old| !same_meaning(old, item))
            {
                Some(item.id.as_str())
            } else {
                None
            }
        })
        .collect();
    let mut stored = Vec::with_capacity(plan.items.len());
    for (index, planned) in plan.items.iter().enumerate() {
        let mut item = if transcript_unchanged {
            old_items
                .get(planned.id.as_str())
                .cloned()
                .unwrap_or_else(|| planned.clone())
        } else {
            planned.clone()
        };
        if !transcript_unchanged {
            item.created_at = (base + Duration::nanoseconds(index as i64)).to_rfc3339();
        }
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,'message',?,?)",
            params![
                item.id,
                capture.session_id,
                item.turn_id,
                serde_json::to_string(&item)?,
                item.created_at
            ],
        )?;
        stored.push(item);
    }

    tx.execute(
        "UPDATE inbox SET resolved=1,read=1 WHERE session_id=? AND kind='approval' AND (resolved=0 OR read=0)",
        [&capture.session_id],
    )?;
    tx.execute(
        "DELETE FROM metadata WHERE key=?",
        [format!("chat.integrity:{}", capture.session_id)],
    )?;
    for item in &stored {
        if changed_ids.contains(item.id.as_str()) {
            emit(
                tx,
                "chat.item",
                json!({"sessionId":capture.session_id,"item":item}),
            )?;
        }
    }
    emit(
        tx,
        "state.changed",
        json!({
            "kind":"chat.repair",
            "sessionId":capture.session_id,
            "operationId":operation_id,
            "mode":"rebuild",
            "added":added,
            "updated":updated,
            "removed":removed,
            "expired":expired,
            "total":stored.len()
        }),
    )?;
    let revision = tx.last_insert_rowid();
    let result = ChatRepairResult {
        session_id: capture.session_id.clone(),
        mode: "rebuild".to_owned(),
        added,
        updated,
        removed,
        expired,
        total: stored.len(),
        revision,
    };
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES (?,?,?,?)",
        params![
            operation_id,
            METHOD,
            serde_json::to_string(&result)?,
            Utc::now().to_rfc3339()
        ],
    )?;

    Ok(result)
}

fn unavailable(
    reason: &'static str,
    degraded: bool,
    diagnostic: Option<String>,
) -> ChatRepairAvailability {
    ChatRepairAvailability {
        offered: false,
        mode: None,
        reason: Some(reason),
        degraded,
        diagnostic,
        ingress_failed: None,
    }
}

fn session_state(tx: &Transaction<'_>, session_id: &str) -> Result<Option<SessionState>> {
    let session = tx
        .query_row(
            "SELECT provider,native_id,mode,status,read_only FROM sessions WHERE id=?",
            [session_id],
            |row| {
                Ok(SessionState {
                    provider: row.get(0)?,
                    native_id: row.get(1)?,
                    mode: row.get(2)?,
                    status: row.get(3)?,
                    read_only: row.get(4)?,
                    activity: None,
                })
            },
        )
        .optional()?;
    let Some(mut session) = session else {
        return Ok(None);
    };
    session.activity = tx
        .query_row(
            "SELECT state,revision,turn_id,reason FROM session_activity WHERE session_id=?",
            [session_id],
            |row| {
                Ok(ActivityState {
                    state: row.get(0)?,
                    revision: row.get(1)?,
                    turn_id: row.get(2)?,
                    reason: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(Some(session))
}

fn raw_transcript(tx: &Transaction<'_>, session_id: &str) -> Result<Vec<RawChatRow>> {
    let mut statement = tx.prepare(
        "SELECT id,session_id,turn_id,kind,data,created_at FROM chat_items WHERE session_id=? ORDER BY created_at,id",
    )?;
    let rows = statement.query_map([session_id], |row| {
        Ok(RawChatRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            turn_id: row.get(2)?,
            kind: row.get(3)?,
            data: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn history_metadata_missing(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    let mut statement = tx.prepare(
        "SELECT id,turn_id,data FROM chat_items WHERE session_id=? ORDER BY created_at,id",
    )?;
    let rows = statement.query_map([session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let prefix = format!("{session_id}:history:");
    for row in rows {
        let (id, column_turn_id, data) = row?;
        let Ok(parsed) = serde_json::from_str::<ChatItem>(&data) else {
            continue;
        };
        if id
            .strip_prefix(&prefix)
            .is_some_and(|suffix| !suffix.is_empty())
            && parsed.id == id
            && column_turn_id.is_none()
            && parsed.turn_id.is_none()
            && parsed.turn_origin.is_none()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn integrity_marker(tx: &Transaction<'_>, session_id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT value FROM metadata WHERE key=?",
            [format!("chat.integrity:{session_id}")],
            |row| row.get(0),
        )
        .optional()?)
}

fn native_owners(
    tx: &Transaction<'_>,
    provider: &str,
    native_id: &str,
) -> Result<Vec<NativeOwnerState>> {
    let mut statement = tx.prepare(
        "SELECT id,status,read_only FROM sessions WHERE provider=? AND native_id=? ORDER BY id",
    )?;
    let rows = statement.query_map(params![provider, native_id], |row| {
        Ok(NativeOwnerState {
            id: row.get(0)?,
            status: row.get(1)?,
            read_only: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(crate) fn validate_part(part: &Value) -> Result<()> {
    let Some(object) = part.as_object() else {
        bail!("invalid_history_transcript: chat part must be an object");
    };
    if !matches!(
        object.get("type").and_then(Value::as_str),
        Some("text" | "thinking" | "tool" | "approval" | "usage" | "error" | "status" | "subagent" | "plan")
    ) {
        bail!("invalid_history_transcript: unsupported chat part type");
    }
    for field in ["text", "toolName", "toolId", "approvalId", "status"] {
        if object.get(field).is_some_and(|value| !value.is_string()) {
            bail!("invalid_history_transcript: chat part string field has wrong type");
        }
    }
    if object.get("type").and_then(Value::as_str) == Some("plan") {
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "type"
                    | "text"
                    | "toolName"
                    | "toolId"
                    | "approvalId"
                    | "status"
                    | "data"
                    | "fileReferences"
                    | "phase"
            )
        }) {
            bail!("invalid_history_transcript: unsupported plan part field");
        }
        if object
            .get("phase")
            .is_some_and(|value| !matches!(value.as_str(), Some("commentary" | "final_answer")))
        {
            bail!("invalid_history_transcript: invalid plan phase");
        }
        let Some(data) = object.get("data").and_then(Value::as_object) else {
            bail!("invalid_history_transcript: plan data must be an object");
        };
        let Some(entries) = data.get("entries").and_then(Value::as_array) else {
            bail!("invalid_history_transcript: plan entries must be an array");
        };
        if data
            .keys()
            .any(|key| !matches!(key.as_str(), "entries" | "explanation"))
        {
            bail!("invalid_history_transcript: unsupported plan data field");
        }
        if data
            .get("explanation")
            .is_some_and(|value| !value.is_string())
        {
            bail!("invalid_history_transcript: plan explanation must be a string");
        }
        for entry in entries {
            let Some(entry) = entry.as_object() else {
                bail!("invalid_history_transcript: plan entry must be an object");
            };
            if entry
                .keys()
                .any(|key| !matches!(key.as_str(), "content" | "status" | "priority"))
                || entry.get("content").and_then(Value::as_str).is_none()
                || !matches!(
                    entry.get("status").and_then(Value::as_str),
                    Some("pending" | "in_progress" | "completed")
                )
                || entry.get("priority").is_some_and(|value| {
                    !matches!(value.as_str(), Some("high" | "medium" | "low"))
                })
            {
                bail!("invalid_history_transcript: malformed plan entry");
            }
        }
    }
    if let Some(references) = object.get("fileReferences") {
        let Some(references) = references.as_array() else {
            bail!("invalid_history_transcript: fileReferences must be an array");
        };
        for reference in references {
            let Some(reference) = reference.as_object() else {
                bail!("invalid_history_transcript: file reference must be an object");
            };
            if reference
                .get("path")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || reference
                    .get("line")
                    .is_some_and(|value| !value.is_u64())
                || reference
                    .get("column")
                    .is_some_and(|value| !value.is_u64())
            {
                bail!("invalid_history_transcript: malformed file reference");
            }
        }
    }
    Ok(())
}

fn require_lease(
    tx: &Transaction<'_>,
    session_id: &str,
    principal: &str,
    epoch: i64,
) -> Result<()> {
    let lease: Option<(String, i64, String)> = tx
        .query_row(
            "SELECT client_id,epoch,expires_at FROM leases WHERE session_id=?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let valid = lease.is_some_and(|(holder, current, expires)| {
        holder == principal
            && current == epoch
            && DateTime::parse_from_rfc3339(&expires)
                .is_ok_and(|expires| expires.with_timezone(&Utc) > Utc::now())
    });
    if !valid {
        bail!("chat_repair_superseded");
    }
    Ok(())
}

fn settle_approval_part(part: &mut Value) -> usize {
    if part.get("type").and_then(Value::as_str) != Some("approval") {
        return 0;
    }
    if let Some(summary) = part.pointer("/data/answerSummary").cloned() {
        let masked = crate::chat_questions::mask_answer_summary(&part["data"], &summary);
        part["data"]["answerSummary"] = masked;
    }
    if !matches!(
        part.get("status").and_then(Value::as_str),
        None | Some("pending" | "submitting")
    ) {
        return 0;
    }
    if !part.get("data").is_some_and(Value::is_object) {
        part["data"] = json!({});
    }
    part["status"] = json!("expired");
    part["data"]["submittable"] = json!(false);
    part["data"]["answerable"] = json!(false);
    part["data"]["outcome"] = json!("expired_by_repair");
    part["data"]["localizedText"] = json!({"en":EXPIRED_EN,"zh-CN":EXPIRED_ZH_CN});
    1
}

fn active_approval_keys(rows: &[RawChatRow]) -> HashSet<String> {
    rows.iter()
        .filter_map(|row| serde_json::from_str::<ChatItem>(&row.data).ok())
        .flat_map(|item| {
            item.parts
                .into_iter()
                .enumerate()
                .filter_map(move |(index, part)| {
                    if part.get("type").and_then(Value::as_str) == Some("approval")
                        && matches!(
                            part.get("status").and_then(Value::as_str),
                            None | Some("pending" | "submitting")
                        )
                    {
                        Some(format!(
                            "{}:{}",
                            item.id,
                            part.get("approvalId")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| index.to_string())
                        ))
                    } else {
                        None
                    }
                })
        })
        .collect()
}

fn parsed_items(rows: &[RawChatRow]) -> HashMap<&str, ChatItem> {
    rows.iter()
        .filter_map(|row| {
            serde_json::from_str::<ChatItem>(&row.data)
                .ok()
                .map(|item| (row.id.as_str(), item))
        })
        .collect()
}

fn same_meaning(left: &ChatItem, right: &ChatItem) -> bool {
    let mut left = serde_json::to_value(left).unwrap_or(Value::Null);
    let mut right = serde_json::to_value(right).unwrap_or(Value::Null);
    left.as_object_mut().map(|value| value.remove("createdAt"));
    right.as_object_mut().map(|value| value.remove("createdAt"));
    left == right
}

fn emit(tx: &Transaction<'_>, event: &str, data: Value) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES (?,?,?)",
        params![
            event,
            serde_json::to_string(&data)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CreateSession, Database};
    use crate::domain::ChatTurnOrigin;

    const PRINCIPAL: &str = "repair-test";
    const EPOCH: i64 = 7;

    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        session: String,
        worker: RepairWorkerState,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let db = Database::open(&root.path().join("repair.sqlite")).unwrap();
            let session = db
                .create_session(CreateSession {
                    project_id: None,
                    title: Some("repair"),
                    provider: "codex",
                    mode: "chat",
                    native_id: Some("native-thread"),
                    operation_id: "create-repair-session",
                })
                .unwrap()
                .id;
            db.transaction(|tx| {
                tx.execute("UPDATE sessions SET status='error' WHERE id=?", [&session])?;
                tx.execute(
                    "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?,?,?,?)",
                    params![
                        session,
                        PRINCIPAL,
                        EPOCH,
                        (Utc::now() + Duration::hours(1)).to_rfc3339()
                    ],
                )?;
                Ok(())
            })
            .unwrap();
            db.mark_chat_degraded(Some(&session), "projection failed")
                .unwrap();
            Self {
                _root: root,
                db,
                session,
                worker: RepairWorkerState::default(),
            }
        }

        fn bind(&self, operation: &str) {
            self.db
                .bind_operation(operation, METHOD, &json!({"sessionId":self.session}))
                .unwrap();
        }

        fn capture(&self) -> RepairCapture {
            self.db
                .transaction(|tx| capture(tx, &self.session, &self.worker, true))
                .unwrap()
        }

        fn commit(
            &self,
            capture: &RepairCapture,
            plan: &RepairPlan,
            operation: &str,
        ) -> Result<ChatRepairResult> {
            self.db.transaction(|tx| {
                commit(
                    tx,
                    capture,
                    plan,
                    &self.worker,
                    true,
                    RepairCommitContext { principal: PRINCIPAL, lease_epoch: EPOCH, operation_id: operation },
                )
            })
        }

        fn insert_item(&self, item: &ChatItem) {
            self.db
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,'message',?,?)",
                        params![
                            item.id,
                            self.session,
                            item.turn_id,
                            serde_json::to_string(item)?,
                            item.created_at
                        ],
                    )?;
                    Ok(())
                })
                .unwrap();
        }
    }

    fn text_item(id: &str, role: &str, text: &str) -> ChatItem {
        ChatItem {
            id: id.to_owned(),
            role: role.to_owned(),
            parts: vec![json!({"type":"text","text":text})],
            created_at: "2026-01-01T00:00:00+00:00".to_owned(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
        }
    }

    fn approval_item(id: &str, status: &str) -> ChatItem {
        ChatItem {
            id: id.to_owned(),
            role: "assistant".to_owned(),
            parts: vec![json!({
                "type":"approval",
                "approvalId":"secret-question",
                "status":status,
                "data":{
                    "approvalId":"secret-question",
                    "answerable":true,
                    "submittable":true,
                    "form":{"kind":"form","fields":[{"id":"password","type":"string","secret":true}]},
                    "answerSummary":{"password":"do-not-store"}
                }
            })],
            created_at: "2026-01-01T00:00:01+00:00".to_owned(),
            turn_id: Some("old-turn".to_owned()),
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
        }
    }

    fn gate_case(
        status: &str,
        mode: &str,
        read_only: bool,
        native_id: Option<&str>,
        activity: Option<&str>,
        marker: bool,
        worker: RepairWorkerState,
        reader_available: bool,
    ) -> ChatRepairAvailability {
        let fixture = Fixture::new();
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status=?,mode=?,read_only=?,native_id=? WHERE id=?",
                    params![status, mode, read_only, native_id, fixture.session],
                )?;
                if let Some(activity) = activity {
                    tx.execute(
                        "UPDATE session_activity SET state=?,revision=revision+1 WHERE session_id=?",
                        params![activity, fixture.session],
                    )?;
                } else {
                    tx.execute(
                        "DELETE FROM session_activity WHERE session_id=?",
                        [&fixture.session],
                    )?;
                }
                if !marker {
                    tx.execute(
                        "DELETE FROM metadata WHERE key=?",
                        [format!("chat.integrity:{}", fixture.session)],
                    )?;
                }
                availability(tx, &fixture.session, &worker, reader_available)
            })
            .unwrap()
    }

    #[test]
    fn availability_uses_durable_marker_and_quiescent_worker_state() {
        let fixture = Fixture::new();
        let available = fixture
            .db
            .transaction(|tx| availability(tx, &fixture.session, &fixture.worker, true))
            .unwrap();
        assert!(available.offered);
        assert!(available.degraded);
        assert_eq!(available.mode, Some("rebuild"));
        assert_eq!(available.diagnostic.as_deref(), Some("projection failed"));

        let running = RepairWorkerState {
            registered: true,
            ..fixture.worker.clone()
        };
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE session_activity SET state='running',revision=revision+1 WHERE session_id=?",
                    [&fixture.session],
                )?;
                let gate = availability(tx, &fixture.session, &running, true)?;
                assert!(!gate.offered);
                assert_eq!(gate.reason, Some("busy"));
                tx.execute(
                    "UPDATE sessions SET status='interrupted' WHERE id=?",
                    [&fixture.session],
                )?;
                let stopped = availability(tx, &fixture.session, &fixture.worker, true)?;
                assert!(stopped.offered, "an absent fenced worker makes Stop conclusive");
                Ok(())
            })
            .unwrap();

        let reopened = Database::open(fixture.db.path()).unwrap();
        let persisted = reopened
            .transaction(|tx| availability(tx, &fixture.session, &fixture.worker, true))
            .unwrap();
        assert!(persisted.degraded, "integrity marker survives restart");
    }

    #[test]
    fn availability_covers_every_lifecycle_prerequisite() {
        let absent = RepairWorkerState::default();
        let surviving = RepairWorkerState {
            generation: 4,
            worker_token: Some("worker".to_owned()),
            registered: true,
            connecting: false,
        };
        let connecting = RepairWorkerState {
            connecting: true,
            ..absent.clone()
        };
        let cases = [
            ("degraded idle", gate_case("idle", "chat", false, Some("native-thread"), Some("idle"), true, absent.clone(), true), true, None, true),
            ("error without marker", gate_case("error", "chat", false, Some("native-thread"), Some("idle"), false, absent.clone(), true), true, None, false),
            ("interrupted stopped stale activity", gate_case("interrupted", "chat", false, Some("native-thread"), Some("running"), false, absent.clone(), true), true, None, false),
            ("read only error", gate_case("error", "chat", true, Some("native-thread"), Some("idle"), false, absent.clone(), true), true, None, false),
            ("healthy idle", gate_case("idle", "chat", false, Some("native-thread"), Some("idle"), false, absent.clone(), true), false, Some("healthy"), false),
            ("missing native", gate_case("error", "chat", false, None, Some("idle"), false, absent.clone(), true), false, Some("missing_native_id"), false),
            ("reader unavailable", gate_case("error", "chat", false, Some("native-thread"), Some("idle"), false, absent.clone(), false), false, Some("history_unavailable"), false),
            ("starting", gate_case("starting", "chat", false, Some("native-thread"), Some("idle"), true, absent.clone(), true), false, Some("busy"), true),
            ("running", gate_case("running", "chat", false, Some("native-thread"), Some("idle"), true, absent.clone(), true), false, Some("busy"), true),
            ("waiting", gate_case("waiting", "chat", false, Some("native-thread"), Some("idle"), true, absent.clone(), true), false, Some("busy"), true),
            ("connecting", gate_case("error", "chat", false, Some("native-thread"), Some("idle"), true, connecting, true), false, Some("busy"), true),
            ("awaiting approval", gate_case("error", "chat", false, Some("native-thread"), Some("awaiting_approval"), true, absent.clone(), true), false, Some("busy"), true),
            ("degraded reply ready after a completed turn", gate_case("idle", "chat", false, Some("native-thread"), Some("awaiting_input"), true, absent.clone(), true), true, None, true),
            ("awaiting parent", gate_case("error", "chat", false, Some("native-thread"), Some("awaiting_parent"), true, absent.clone(), true), false, Some("busy"), true),
            ("unknown activity", gate_case("error", "chat", false, Some("native-thread"), Some("unknown"), true, absent.clone(), true), false, Some("unknown_activity"), true),
            ("missing activity surviving worker", gate_case("error", "chat", false, Some("native-thread"), None, true, surviving.clone(), true), false, Some("unknown_activity"), true),
            ("interrupted surviving stale turn", gate_case("interrupted", "chat", false, Some("native-thread"), Some("running"), true, surviving, true), false, Some("busy"), true),
            ("exited", gate_case("exited", "chat", false, Some("native-thread"), Some("idle"), true, absent.clone(), true), false, Some("session_unavailable"), true),
            ("terminal", gate_case("error", "terminal", false, Some("native-thread"), Some("idle"), true, absent, true), false, Some("session_unavailable"), true),
        ];
        for (name, gate, offered, reason, degraded) in cases {
            assert_eq!(gate.offered, offered, "{name}");
            assert_eq!(gate.reason, reason, "{name}");
            assert_eq!(gate.degraded, degraded, "{name}");
            assert_eq!(gate.mode, offered.then_some("rebuild"), "{name}");
        }
    }

    #[test]
    fn legacy_scoped_history_offers_explicit_rebuild_after_resume_with_live_rows() {
        let legacy = Fixture::new();
        let mut legacy_unsupported = text_item(
            &format!("{}:history:unsupported", legacy.session),
            "assistant",
            "preserved legacy shape",
        );
        legacy_unsupported.role = "unsupported-legacy-role".into();
        legacy_unsupported.parts = vec![json!("unsupported legacy part")];
        legacy.insert_item(&legacy_unsupported);
        legacy.insert_item(&text_item("later-live", "assistant", "new live response"));
        let offered = legacy
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status='idle',read_only=0 WHERE id=?",
                    [&legacy.session],
                )?;
                tx.execute(
                    "DELETE FROM metadata WHERE key=?",
                    [format!("chat.integrity:{}", legacy.session)],
                )?;
                availability(tx, &legacy.session, &legacy.worker, true)
            })
            .unwrap();
        assert!(offered.offered);
        assert!(!offered.degraded);
        assert_eq!(offered.reason, Some("history_metadata_missing"));
        assert_eq!(offered.diagnostic.as_deref(), Some("history_metadata_missing"));

        let current = Fixture::new();
        let mut item = text_item(
            &format!("{}:history:current", current.session),
            "assistant",
            "new import",
        );
        item.turn_origin = Some(ChatTurnOrigin::History);
        current.insert_item(&item);
        let unavailable = current
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status='idle',read_only=1 WHERE id=?",
                    [&current.session],
                )?;
                tx.execute(
                    "DELETE FROM metadata WHERE key=?",
                    [format!("chat.integrity:{}", current.session)],
                )?;
                availability(tx, &current.session, &current.worker, true)
            })
            .unwrap();
        assert!(!unavailable.offered);
        assert_eq!(unavailable.reason, Some("healthy"));

        let live_only = Fixture::new();
        live_only.insert_item(&text_item("live-without-metadata", "assistant", "ordinary live row"));
        let live_gate = live_only
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status='idle',read_only=0 WHERE id=?",
                    [&live_only.session],
                )?;
                tx.execute(
                    "DELETE FROM metadata WHERE key=?",
                    [format!("chat.integrity:{}", live_only.session)],
                )?;
                availability(tx, &live_only.session, &live_only.worker, true)
            })
            .unwrap();
        assert!(!live_gate.offered);
        assert_eq!(live_gate.reason, Some("healthy"));

        let empty = Fixture::new();
        let empty_gate = empty
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status='idle',read_only=1 WHERE id=?",
                    [&empty.session],
                )?;
                tx.execute(
                    "DELETE FROM metadata WHERE key=?",
                    [format!("chat.integrity:{}", empty.session)],
                )?;
                availability(tx, &empty.session, &empty.worker, true)
            })
            .unwrap();
        assert!(!empty_gate.offered);
        assert_eq!(empty_gate.reason, Some("healthy"));
    }

    #[test]
    fn prepare_scopes_repaired_native_turn_ids() {
        let fixture = Fixture::new();
        let mut source = text_item("native-item", "assistant", "repaired");
        source.turn_id = Some("provider-turn".to_owned());
        let capture = fixture.capture();
        let plan = prepare(&capture, &[source]).unwrap();
        let expected_turn = format!("{}:history:provider-turn", fixture.session);
        assert_eq!(
            plan.items[0].turn_id.as_deref(),
            Some(expected_turn.as_str())
        );
        assert_eq!(plan.items[0].turn_origin, Some(ChatTurnOrigin::History));
        fixture.bind("scope-repair");
        fixture.commit(&capture, &plan, "scope-repair").unwrap();
        let stored: (Option<String>, String) = fixture
            .db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT turn_id,data FROM chat_items WHERE session_id=?",
                    [&fixture.session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .unwrap();
        let stored_item: ChatItem = serde_json::from_str(&stored.1).unwrap();
        assert_eq!(stored.0.as_deref(), Some(expected_turn.as_str()));
        assert_eq!(stored_item.turn_id.as_deref(), Some(expected_turn.as_str()));
        fixture.insert_item(&ChatItem {
            id: "later-live-item".into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":"live"})],
            created_at: Utc::now().to_rfc3339(),
            turn_id: Some("provider-turn".into()),
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
        });
        let rows = fixture.db.chat_items(&fixture.session).unwrap();
        assert!(rows.iter().any(|item| item.turn_id.as_deref() == Some("provider-turn") && item.turn_origin.is_none()));
        assert!(rows.iter().any(|item| item.turn_id.as_deref() == Some(expected_turn.as_str()) && item.turn_origin == Some(ChatTurnOrigin::History)));
    }

    #[test]
    fn rebuild_is_atomic_ordered_idempotent_and_leaves_adjacent_state_untouched() {
        let fixture = Fixture::new();
        fixture.insert_item(&text_item("local-user", "user", "same"));
        fixture.insert_item(&approval_item("local-approval", "submitting"));
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO inbox(id,session_id,turn_id,kind,data,resolved,created_at,read) VALUES (?,?,?,'approval','{}',0,?,0)",
                    params!["local-approval", fixture.session, "old-turn", Utc::now().to_rfc3339()],
                )?;
                tx.execute(
                    "INSERT INTO subagent_items(session_id,subagent_key,item_id,seq,rev,data,created_at) VALUES (?, 'child','child-item',1,1,'{}','then')",
                    [&fixture.session],
                )?;
                tx.execute(
                    "INSERT INTO chat_drafts(session_id,revision,text) VALUES (?,3,'draft')",
                    [&fixture.session],
                )?;
                tx.execute_batch(
                    "CREATE TABLE chat_queue_items (id TEXT PRIMARY KEY, session_id TEXT, payload TEXT);
                     CREATE TABLE chat_queue_state (session_id TEXT PRIMARY KEY, paused INTEGER, pause_reason TEXT);
                     CREATE TABLE review_checkpoints (id TEXT PRIMARY KEY, session_id TEXT, payload TEXT);",
                )?;
                tx.execute("INSERT INTO chat_queue_items VALUES ('q',?,'queued')", [&fixture.session])?;
                tx.execute("INSERT INTO chat_queue_state VALUES (?,1,'projection')", [&fixture.session])?;
                tx.execute("INSERT INTO review_checkpoints VALUES ('r',?,'checkpoint')", [&fixture.session])?;
                tx.execute(
                    "INSERT INTO usage_records(id,session_id,provider,recorded_at) VALUES ('u',?,'codex','then')",
                    [&fixture.session],
                )?;
                Ok(())
            })
            .unwrap();
        let adjacent_before = fixture
            .db
            .transaction(|tx| adjacent_state(tx, &fixture.session))
            .unwrap();

        let native = vec![
            text_item("native-user", "user", "same"),
            approval_item("native-answer", "pending"),
        ];
        fixture.bind("repair-1");
        let capture = fixture.capture();
        let backup_expected = serde_json::to_string(&capture.transcript).unwrap();
        let plan = prepare(&capture, &native).unwrap();
        let result = fixture.commit(&capture, &plan, "repair-1").unwrap();
        assert_eq!(
            result,
            ChatRepairResult {
                session_id: fixture.session.clone(),
                mode: "rebuild".to_owned(),
                added: 2,
                updated: 0,
                removed: 2,
                expired: 2,
                total: 2,
                revision: result.revision,
            }
        );

        let (rows, backup, marker, inbox, adjacent_after) = fixture
            .db
            .transaction(|tx| {
                let rows = raw_transcript(tx, &fixture.session)?;
                let backup: (i64, String) = tx.query_row(
                    "SELECT COUNT(*),items_json FROM chat_repair_backups WHERE session_id=?",
                    [&fixture.session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let marker = integrity_marker(tx, &fixture.session)?;
                let inbox: (bool, bool) = tx.query_row(
                    "SELECT resolved,read FROM inbox WHERE id='local-approval'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok((rows, backup, marker, inbox, adjacent_state(tx, &fixture.session)?))
            })
            .unwrap();
        assert_eq!(backup, (1, backup_expected));
        assert!(marker.is_none());
        assert_eq!(inbox, (true, true));
        assert_eq!(adjacent_after, adjacent_before);
        assert_eq!(
            rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>(),
            vec![
                format!("{}:history:native-user", fixture.session),
                format!("{}:history:native-answer", fixture.session)
            ]
        );
        assert!(rows[0].created_at < rows[1].created_at);
        let repaired_approval: ChatItem = serde_json::from_str(&rows[1].data).unwrap();
        assert_eq!(repaired_approval.turn_origin, Some(ChatTurnOrigin::History));
        let part = &repaired_approval.parts[0];
        assert_eq!(part["status"], "expired");
        assert_eq!(part["data"]["submittable"], false);
        assert_eq!(part["data"]["answerable"], false);
        assert_eq!(part["data"]["outcome"], "expired_by_repair");
        assert_eq!(part["data"]["answerSummary"]["password"], "••••");
        assert_eq!(part["data"]["localizedText"]["en"], EXPIRED_EN);

        let outbox_before = fixture.db.events_after(0).unwrap().len();
        let backup_before = backup.1;
        let replay = fixture.commit(&capture, &plan, "repair-1").unwrap();
        assert_eq!(replay, result);
        assert_eq!(fixture.db.events_after(0).unwrap().len(), outbox_before);
        let replay_backup = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT items_json FROM chat_repair_backups WHERE session_id=?",
                    [&fixture.session],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        assert_eq!(replay_backup, backup_before);

        fixture.bind("repair-2");
        let second_capture = fixture.capture();
        let second_backup = serde_json::to_string(&second_capture.transcript).unwrap();
        let second_plan = prepare(&second_capture, &native).unwrap();
        let second = fixture
            .commit(&second_capture, &second_plan, "repair-2")
            .unwrap();
        assert_eq!((second.added, second.updated, second.removed), (0, 0, 0));
        let latest_backup = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT items_json FROM chat_repair_backups WHERE session_id=?",
                    [&fixture.session],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        assert_eq!(latest_backup, second_backup, "one row keeps the latest pre-repair state");

        let forced_tail = (Utc::now() + Duration::seconds(10)).to_rfc3339();
        fixture
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE chat_items SET created_at=? WHERE session_id=? AND id=(SELECT id FROM chat_items WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1)",
                    params![forced_tail, fixture.session, fixture.session],
                )?;
                Ok(())
            })
            .unwrap();

        fixture
            .db
            .record_provider_event(
                &fixture.session,
                Some("live-turn"),
                "chat.item",
                &json!({"item":{"id":"live","type":"agentMessage","text":"later"}}),
            )
            .unwrap();
        let live_created_at: String = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT created_at FROM chat_items WHERE id=?",
                    [format!("{}:assistant:live", fixture.session)],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(live_created_at > forced_tail, "live projection must advance beyond a future repaired tail");
        let snapshot = fixture.db.chat_items(&fixture.session).unwrap();
        assert_eq!(snapshot.last().unwrap().id, format!("{}:assistant:live", fixture.session));
    }

    #[test]
    fn fingerprint_worker_and_lease_changes_supersede_without_writes() {
        for change in ["row", "worker", "lease", "owner"] {
            let fixture = Fixture::new();
            fixture.insert_item(&text_item("old", "user", "old"));
            fixture.bind(&format!("repair-{change}"));
            let capture = fixture.capture();
            let plan = prepare(&capture, &[text_item("native", "assistant", "new")]).unwrap();
            let mut worker = fixture.worker.clone();
            match change {
                "row" => fixture.insert_item(&text_item("racing-user", "user", "race")),
                "worker" => worker.generation += 1,
                "lease" => fixture
                    .db
                    .transaction(|tx| {
                        tx.execute(
                            "UPDATE leases SET epoch=epoch+1 WHERE session_id=?",
                            [&fixture.session],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "owner" => fixture
                    .db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES ('other-owner','other','codex','chat','interrupted','now','now','native-thread',0,0)",
                            [],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                _ => unreachable!(),
            }
            let error = fixture
                .db
                .transaction(|tx| {
                    commit(
                        tx,
                        &capture,
                        &plan,
                        &worker,
                        true,
                        RepairCommitContext { principal: PRINCIPAL, lease_epoch: EPOCH, operation_id: &format!("repair-{change}") },
                    )
                })
                .unwrap_err();
            assert!(error.to_string().contains("chat_repair_superseded"));
            fixture
                .db
                .transaction(|tx| {
                    assert_eq!(
                        tx.query_row(
                            "SELECT COUNT(*) FROM chat_repair_backups WHERE session_id=?",
                            [&fixture.session],
                            |row| row.get::<_, i64>(0)
                        )?,
                        0
                    );
                    assert!(integrity_marker(tx, &fixture.session)?.is_some());
                    assert_eq!(
                        tx.query_row(
                            "SELECT COUNT(*) FROM operations WHERE id=?",
                            [format!("repair-{change}")],
                            |row| row.get::<_, i64>(0)
                        )?,
                        0
                    );
                    Ok(())
                })
                .unwrap();
        }
    }

    #[test]
    fn prepare_rejects_malformed_parts_and_post_scope_frame_overflow() {
        let fixture = Fixture::new();
        let capture = fixture.capture();
        let mut with_local = capture.clone();
        with_local.transcript.push(RawChatRow {
            id: "s:assistant:local".into(),
            session_id: capture.session_id.clone(),
            turn_id: None,
            kind: "message".into(),
            data: "{}".into(),
            created_at: "2026-10-08T00:00:00+00:00".into(),
        });
        assert!(
            prepare(&with_local, &[])
                .unwrap_err()
                .to_string()
                .contains("native history is empty"),
            "an empty native record never replaces a non-empty transcript"
        );
        for invalid in [
            vec![text_item("", "assistant", "missing")],
            vec![text_item("unknown", "assistant", "fallback")],
            vec![
                text_item("duplicate", "user", "same"),
                text_item("duplicate", "assistant", "same"),
            ],
        ] {
            assert!(
                prepare(&capture, &invalid)
                    .unwrap_err()
                    .to_string()
                    .contains("invalid_history_transcript")
            );
        }
        for part in [
            json!("text"),
            json!({"type":"unknown"}),
            json!({"type":"text","text":7}),
            json!({"type":"tool","toolId":false}),
            json!({"type":"text","fileReferences":"not-an-array"}),
            json!({"type":"text","fileReferences":[{"path":""}]}),
        ] {
            let mut item = text_item("native", "assistant", "valid");
            item.parts = vec![part];
            assert!(
                prepare(&capture, &[item])
                    .unwrap_err()
                    .to_string()
                    .contains("invalid_history_transcript")
            );
        }

        // Plan payloads are protocol-owned. A valid empty entries array remains
        // valid because it is the clearing marker for a previous snapshot.
        for part in [
            json!({"type":"plan"}),
            json!({"type":"plan","data":{}}),
            json!({"type":"plan","data":{"entries":{}}}),
            json!({"type":"plan","data":{"entries":[{}]}}),
            json!({"type":"plan","data":{"entries":[{"content":"missing status"}]}}),
            json!({"type":"plan","data":{"entries":[{"content":"bad status","status":"started"}]}}),
            json!({"type":"plan","data":{"entries":[{"content":"bad priority","status":"pending","priority":"urgent"}]}}),
            json!({"type":"plan","data":{"entries":[]},"unexpected":true}),
            json!({"type":"plan","data":{"entries":[]},"phase":"draft"}),
            json!({"type":"plan","data":{"entries":[],"unexpected":true}}),
            json!({"type":"plan","data":{"entries":[{"content":"unexpected field","status":"pending","extra":true}]}}),
            json!({"type":"plan","data":{"entries":[],"explanation":false}}),
        ] {
            let mut item = text_item("native-plan", "assistant", "valid");
            item.parts = vec![part];
            assert!(
                prepare(&capture, &[item])
                    .unwrap_err()
                    .to_string()
                    .contains("invalid_history_transcript")
            );
        }
        let mut empty_plan = text_item("empty-plan", "assistant", "valid");
        empty_plan.parts = vec![json!({"type":"plan","data":{"entries":[]}})];
        assert!(prepare(&capture, &[empty_plan]).is_ok());

        let mut nearly_full = text_item("native", "assistant", "");
        nearly_full.parts[0]["text"] =
            json!("x".repeat(MAX_HISTORY_BYTES - HISTORY_FRAME_HEADROOM_BYTES - 256));
        let raw_size = serde_json::to_vec(&[nearly_full.clone()]).unwrap().len();
        assert!(raw_size < MAX_HISTORY_BYTES, "fixture must pass the raw input bound");
        assert!(
            prepare(&capture, &[nearly_full])
                .unwrap_err()
                .to_string()
                .contains("normalized snapshot exceeds frame limit")
        );
    }

    #[test]
    fn terminal_approval_receipts_keep_status_and_mask_secret_summaries() {
        let fixture = Fixture::new();
        let capture = fixture.capture();
        for status in ["answered", "dismissed", "resolved", "expired", "outcomeUnknown"] {
            let mut receipt = approval_item(status, status);
            receipt.parts[0]["data"]["answerable"] = json!(false);
            receipt.parts[0]["data"]["submittable"] = json!(false);
            let plan = prepare(&capture, &[receipt]).unwrap();
            let part = &plan.items[0].parts[0];
            assert_eq!(part["status"], status);
            assert_eq!(part["data"]["answerable"], false);
            assert_eq!(part["data"]["submittable"], false);
            assert_eq!(part["data"]["answerSummary"]["password"], "••••");
        }
    }

    #[test]
    fn recorded_codex_shape_rebuild_removes_local_duplicates_and_keeps_native_order() {
        let fixture = Fixture::new();
        let recorded: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/repair-native-history.json"
        ))
        .unwrap();
        let raw = recorded["codex"]["turns"][0]["items"].as_array().unwrap();
        let native_user_id = raw[0]["id"].as_str().unwrap();
        let native_assistant_id = raw[1]["id"].as_str().unwrap();
        let native_tool_id = raw[2]["id"].as_str().unwrap();
        let mut tool = text_item(native_tool_id, "tool", "");
        tool.parts = vec![json!({
            "type":"tool",
            "toolId":native_tool_id,
            "toolName":raw[2]["type"],
            "status":raw[2]["status"],
            "data":raw[2]
        })];
        let native = vec![
            text_item(native_user_id, "user", raw[0]["text"].as_str().unwrap()),
            text_item("repair-codex-user-repeat", "user", raw[0]["text"].as_str().unwrap()),
            text_item(
                native_assistant_id,
                "assistant",
                raw[1]["text"].as_str().unwrap(),
            ),
            tool,
        ];
        for local in [
            text_item(
                &format!("{}:user:local-operation", fixture.session),
                "user",
                "repeat",
            ),
            ChatItem {
                id: format!("{}:assistant:local-slash-command", fixture.session),
                role: "assistant".to_owned(),
                parts: vec![json!({"type":"status","text":"/compact"})],
                created_at: "2026-01-01T00:00:01+00:00".to_owned(),
                turn_id: None,
                elapsed_ms: None,
                turn_status: None,
                turn_origin: None,
            fork_anchor: None,
            },
            text_item(
                &format!("{}:history:stale-prefix", fixture.session),
                "assistant",
                "old import",
            ),
            text_item(
                &format!("{}:assistant:{native_assistant_id}", fixture.session),
                "assistant",
                "partial answer",
            ),
        ] {
            fixture.insert_item(&local);
        }
        fixture.bind("fixture-roundtrip");
        let capture = fixture.capture();
        let plan = prepare(&capture, &native).unwrap();
        let result = fixture
            .commit(&capture, &plan, "fixture-roundtrip")
            .unwrap();
        assert_eq!((result.added, result.removed, result.total), (4, 4, 4));
        let rebuilt = fixture.db.chat_items(&fixture.session).unwrap();
        assert_eq!(
            rebuilt.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            native
                .iter()
                .map(|item| format!("{}:history:{}", fixture.session, item.id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            rebuilt
                .iter()
                .filter(|item| item.role == "user" && item.parts[0]["text"] == "repeat")
                .count(),
            2,
            "equal-content native messages remain distinct and in place"
        );
        assert!(rebuilt.iter().all(|item| {
            !item.id.contains("local-operation")
                && !item.id.contains("slash-command")
                && !item.id.contains("stale-history")
                && !item.id.contains("live-native")
        }));
    }

    #[test]
    fn failures_at_each_commit_stage_roll_back_every_repair_side_effect() {
        for stage in ["backup", "delete", "insert", "outbox", "receipt"] {
            let fixture = Fixture::new();
            fixture.insert_item(&text_item("old", "user", "old"));
            fixture.bind(&format!("repair-{stage}"));
            let capture = fixture.capture();
            let plan = prepare(&capture, &[text_item("native", "assistant", "new")]).unwrap();
            let before = fixture
                .db
                .transaction(|tx| repair_state(tx, &fixture.session))
                .unwrap();
            fixture
                .db
                .transaction(|tx| {
                    let trigger = match stage {
                        "backup" => "CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON chat_repair_backups BEGIN SELECT RAISE(ABORT,'fail backup'); END;",
                        "delete" => "CREATE TEMP TRIGGER fail_repair BEFORE DELETE ON chat_items BEGIN SELECT RAISE(ABORT,'fail delete'); END;",
                        "insert" => "CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON chat_items WHEN NEW.id LIKE '%:history:%' BEGIN SELECT RAISE(ABORT,'fail insert'); END;",
                        "outbox" => "CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON outbox WHEN NEW.event='state.changed' BEGIN SELECT RAISE(ABORT,'fail outbox'); END;",
                        "receipt" => "CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON operations WHEN NEW.method='chat.repair' BEGIN SELECT RAISE(ABORT,'fail receipt'); END;",
                        _ => unreachable!(),
                    };
                    tx.execute_batch(trigger)?;
                    Ok(())
                })
                .unwrap();
            assert!(fixture.commit(&capture, &plan, &format!("repair-{stage}")).is_err());
            let after = fixture
                .db
                .transaction(|tx| repair_state(tx, &fixture.session))
                .unwrap();
            assert_eq!(after, before, "stage {stage} must roll back atomically");
        }
    }

    #[test]
    fn global_degradation_marks_only_the_supplied_existing_chats_and_backup_cascades() {
        let fixture = Fixture::new();
        let other = fixture
            .db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "grok",
                mode: "chat",
                native_id: Some("other-native"),
                operation_id: "other-session",
            })
            .unwrap();
        fixture
            .db
            .transaction(|tx| {
                tx.execute("DELETE FROM metadata WHERE key LIKE 'chat.integrity:%'", [])?;
                Ok(())
            })
            .unwrap();
        fixture
            .db
            .mark_chat_degraded_for_sessions(
                &[fixture.session.clone(), fixture.session.clone(), "missing".to_owned()],
                "global ingress failed",
            )
            .unwrap();
        fixture
            .db
            .transaction(|tx| {
                assert!(integrity_marker(tx, &fixture.session)?.is_some());
                assert!(integrity_marker(tx, &other.id)?.is_none());
                tx.execute(
                    "INSERT INTO chat_repair_backups(session_id,created_at,items_json) VALUES (?,'now','[]')",
                    [&fixture.session],
                )?;
                tx.execute("DELETE FROM sessions WHERE id=?", [&fixture.session])?;
                assert_eq!(
                    tx.query_row(
                        "SELECT COUNT(*) FROM chat_repair_backups WHERE session_id=?",
                        [&fixture.session],
                        |row| row.get::<_, i64>(0)
                    )?,
                    0
                );
                assert!(integrity_marker(tx, &fixture.session)?.is_none());
                Ok(())
            })
            .unwrap();
    }

    fn adjacent_state(tx: &Transaction<'_>, session: &str) -> Result<Vec<String>> {
        let queries = [
            "SELECT data FROM subagent_items WHERE session_id=? ORDER BY subagent_key,item_id",
            "SELECT revision||':'||text FROM chat_drafts WHERE session_id=?",
            "SELECT id||':'||payload FROM chat_queue_items WHERE session_id=?",
            "SELECT paused||':'||pause_reason FROM chat_queue_state WHERE session_id=?",
            "SELECT id||':'||payload FROM review_checkpoints WHERE session_id=?",
            "SELECT id||':'||provider||':'||recorded_at FROM usage_records WHERE session_id=?",
        ];
        let mut result = Vec::new();
        for query in queries {
            let mut statement = tx.prepare(query)?;
            let rows = statement.query_map([session], |row| row.get::<_, String>(0))?;
            result.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(result)
    }

    fn repair_state(tx: &Transaction<'_>, session: &str) -> Result<Vec<String>> {
        let mut result = Vec::new();
        for query in [
            "SELECT id||'|'||data||'|'||created_at FROM chat_items WHERE session_id=? ORDER BY id",
            "SELECT session_id||'|'||created_at||'|'||items_json FROM chat_repair_backups WHERE session_id=?",
            "SELECT key||'|'||value FROM metadata WHERE key='chat.integrity:'||?",
            "SELECT id||'|'||resolved||'|'||read FROM inbox WHERE session_id=? ORDER BY id",
            "SELECT seq||'|'||event||'|'||data FROM outbox WHERE ? IS NOT NULL ORDER BY seq",
            "SELECT id||'|'||method||'|'||result FROM operations WHERE method='chat.repair' AND ? IS NOT NULL",
        ] {
            let mut statement = tx.prepare(query)?;
            let rows = statement.query_map([session], |row| row.get::<_, String>(0))?;
            result.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(result)
    }
}
