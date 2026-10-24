//! Converts native provider updates into stable, persisted renderer chat items.
use crate::{db::Database, domain::ChatItem, file_references, providers::normalize_chat_ui};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn emit_attention_notice(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    session_id: &str,
    kind: &str,
    created_at: &str,
) -> Result<()> {
    let (session_title, provider): (String, String) = tx
        .query_row(
            "SELECT title, provider FROM sessions WHERE id=?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_else(|| (session_id.to_string(), String::new()));
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES ('inbox.created',?,?)",
        params![
            serde_json::to_string(&json!({
                "id":id,
                "sessionId":session_id,
                "kind":kind,
                "title":session_title,
                "provider":provider
            }))?,
            created_at
        ],
    )?;
    Ok(())
}

fn insert_attention(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: &Value,
    created_at: &str,
) -> Result<()> {
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO inbox(id,session_id,turn_id,kind,data,resolved,created_at,read) VALUES (?,?,?,?,?,0,?,0)",
        params![id, session_id, turn_id, kind, serde_json::to_string(data)?, created_at],
    )?;
    if inserted == 1 {
        emit_attention_notice(tx, id, session_id, kind, created_at)?;
    }
    Ok(())
}

fn notify_reply(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    data: &Value,
    created_at: &str,
) -> Result<()> {
    let turn_key = turn_id.unwrap_or("current");
    let id = format!("{session_id}:reply:{turn_key}");
    // Persist as already-read so toast/desktop still fire once, but the inbox
    // queue never treats an ordinary completed turn as something to decide.
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO inbox(id,session_id,turn_id,kind,data,resolved,created_at,read) VALUES (?,?,?,?,?,0,?,1)",
        params![id, session_id, turn_id, "reply", serde_json::to_string(data)?, created_at],
    )?;
    if inserted == 1 {
        emit_attention_notice(tx, &id, session_id, "reply", created_at)?;
    }
    Ok(())
}

fn upsert_chat_part(parts: &mut Vec<Value>, mut part: Value) {
    let tool_id = part.get("toolId").and_then(Value::as_str);
    if let Some(tool_id) = tool_id {
        if let Some(existing) = parts
            .iter_mut()
            .find(|item| item.get("toolId").and_then(Value::as_str) == Some(tool_id))
        {
            file_references::enrich_tool_part(&mut part, Some(existing));
            if let (Some(target), Some(source)) = (existing.as_object_mut(), part.as_object()) {
                for (key, value) in source {
                    target.insert(key.clone(), value.clone());
                }
            }
            return;
        }
    }
    file_references::enrich_tool_part(&mut part, None);
    parts.push(part);
}

fn item_text(raw: &Value) -> String {
    if let Some(text) = raw.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return text.to_owned();
        }
    }
    if let Some(text) = raw.get("content").and_then(Value::as_str) {
        return text.to_owned();
    }
    raw.get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn complete_streaming_items(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    now: &str,
) -> Result<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT id, data FROM chat_items WHERE session_id=?")?;
        let rows = stmt
            .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (id, data) in rows {
        let mut item: Value = serde_json::from_str(&data)?;
        let Some(parts) = item.get_mut("parts").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut changed = false;
        for part in parts.iter_mut() {
            if part.get("status").and_then(Value::as_str) == Some("streaming") {
                part["status"] = json!("complete");
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        let payload = serde_json::to_string(&item)?;
        tx.execute(
            "UPDATE chat_items SET data=? WHERE id=?",
            params![payload, id],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
            params![
                serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,
                now
            ],
        )?;
    }
    Ok(())
}

/// A leftover steer that becomes its own `carry:` turn re-homes its persisted
/// row onto that turn. The original turn never ran the text, so the transcript
/// must show the "Inserted" row under the carry turn that actually ran it.
fn rehome_steered_message(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    operation_id: &str,
    carry_turn: &str,
    now: &str,
) -> Result<()> {
    let id = format!("{session_id}:user:steer:{operation_id}");
    let previous: Option<String> = tx
        .query_row("SELECT data FROM chat_items WHERE id=?", [&id], |row| row.get(0))
        .optional()?;
    let Some(raw) = previous else {
        return Ok(());
    };
    let mut item: Value = serde_json::from_str(&raw)?;
    if item.get("turnId").and_then(Value::as_str) == Some(carry_turn) {
        return Ok(());
    }
    if let Some(object) = item.as_object_mut() {
        object.insert("turnId".into(), json!(carry_turn));
    }
    if let Some(parts) = item.get_mut("parts").and_then(Value::as_array_mut) {
        for part in parts {
            if part.pointer("/data/steered").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            if let Some(data) = part.pointer_mut("/data").and_then(Value::as_object_mut) {
                data.insert("turnId".into(), json!(carry_turn));
            }
        }
    }
    tx.execute(
        "UPDATE chat_items SET data=?,turn_id=? WHERE id=?",
        params![serde_json::to_string(&item)?, carry_turn, &id],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
        params![
            serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,
            now
        ],
    )?;
    Ok(())
}

/// Removes a steered row that the provider explicitly rejected. An empty
/// user item is the removal signal: history no longer contains the row, and
/// the renderer drops that id instead of leaving an empty bubble.
pub fn retract_steered_message(db: &Database, session_id: &str, operation_id: &str) -> Result<()> {
    let id = format!("{session_id}:user:steer:{operation_id}");
    db.transaction(|tx| {
        let previous: Option<String> = tx
            .query_row("SELECT data FROM chat_items WHERE id=?", [&id], |row| row.get(0))
            .optional()?;
        let Some(raw) = previous else {
            return Ok(());
        };
        let mut item: Value = serde_json::from_str(&raw)?;
        tx.execute("DELETE FROM chat_items WHERE id=?", [&id])?;
        if let Some(object) = item.as_object_mut() {
            object.insert("parts".into(), json!([]));
        }
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
            params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?, now],
        )?;
        Ok(())
    })
}

pub fn record(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: &Value,
) -> Result<()> {
    let speeds = crate::turn_speed::shared(db.path());
    if kind == "chat.speed.usage" { speeds.observe(session_id, turn_id, kind, data); return Ok(()); }
    db.transaction(|tx| {
        let data = speeds.observe(session_id, turn_id, kind, data);
        if matches!(kind,"session.closed"|"chat.connection") {
            if let (Some(turn),Some(usage)) = (data.get("speedTurnId").and_then(Value::as_str),data.get("turnUsage").and_then(turn_usage)) {
                attach_turn_speed(tx,session_id,turn,&usage)?;
            }
        }
        let turn_id = if matches!(kind,"session.closed"|"chat.connection") {turn_id} else {turn_id.or_else(|| data.get("speedTurnId").and_then(Value::as_str))};
        record_tx(tx, session_id, turn_id, kind, &data)
    })
}

/// A successful answer and its non-actionable transcript receipt share one
/// crash boundary. No completed operation can leave a pending approval behind.
pub(crate) fn record_answer_receipt(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    kind: &str,
    data: &Value,
    operation_id: &str,
) -> Result<()> {
    db.transaction(|tx| {
        let speeds = crate::turn_speed::shared(db.path());
        let data = speeds.observe(session_id, Some(turn_id), kind, data);
        record_tx(tx, session_id, Some(turn_id), kind, &data)?;
        crate::db::complete(tx, operation_id, "chat.answer", &Value::Null)
    })
}

/// Project an app-hosted approval only while its originating turn is still
/// running. The activity check and projection share the database transaction,
/// so a turn completion cannot slip between admission and publication.
pub(crate) fn record_if_active(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    kind: &str,
    data: &Value,
) -> Result<bool> {
    db.transaction(|tx| {
        let active: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM sessions s
                JOIN session_activity a ON a.session_id=s.id
                WHERE s.id=? AND s.mode='chat' AND s.read_only=0
                  AND s.status NOT IN ('exited','interrupted','error')
                  AND a.turn_id=? AND a.state='running'
            )",
            params![session_id, turn_id],
            |row| row.get(0),
        )?;
        if !active {
            return Ok(false);
        }
        let speeds = crate::turn_speed::shared(db.path());
        let data = speeds.observe(session_id, Some(turn_id), kind, data);
        record_tx(tx, session_id, Some(turn_id), kind, &data)?;
        Ok(true)
    })
}

fn record_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: &Value,
) -> Result<()> {
  let wall_now=Utc::now();
  let latest:Option<String>=tx.query_row("SELECT MAX(created_at) FROM chat_items WHERE session_id=?",[session_id],|row|row.get(0))?;
  let timestamp=latest.as_deref().and_then(|value|chrono::DateTime::parse_from_rfc3339(value).ok()).map(|value|value.with_timezone(&Utc)+chrono::Duration::nanoseconds(1)).filter(|value|value>&wall_now).unwrap_or(wall_now);
  let now=timestamp.to_rfc3339();
  let turn=turn_id.or_else(||data.pointer("/raw/params/turn/id").and_then(Value::as_str)).or_else(||data.pointer("/raw/params/turnId").and_then(Value::as_str));
  let turn_key=turn.unwrap_or("current");
  let usage_projection=crate::usage_ledger::live::project_event(tx,session_id,turn,kind,data,&now)?;
  let data=usage_projection.as_ref().unwrap_or(data);
  if kind=="chat.usage.fact" { return Ok(()); }
  let raw_item=data.get("item").or_else(||data.pointer("/raw/params/item"));
  let native_item=raw_item.and_then(|i|i.get("id")).and_then(Value::as_str).or_else(||data.pointer("/raw/params/itemId").and_then(Value::as_str));
  let native_created_at=raw_item.and_then(|item|item.get("createdAt")).and_then(Value::as_str)
   .filter(|value|chrono::DateTime::parse_from_rfc3339(value).is_ok()).map(str::to_owned)
   .filter(|value|latest.as_deref().and_then(|latest|chrono::DateTime::parse_from_rfc3339(latest).ok()).is_none_or(|latest|chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|candidate|candidate>latest)));
  let approval_id=data.get("approvalId").and_then(Value::as_str).or_else(||data.pointer("/part/approvalId").and_then(Value::as_str));
  let category=if kind=="message.user"{"user"}else if kind.starts_with("chat.approval"){"approval"}else{"assistant"};
  let key=if category=="approval"{approval_id.unwrap_or(turn_key)}else{native_item.unwrap_or(turn_key)};
  let id=format!("{session_id}:{category}:{key}");
  let previous:Option<String>=tx.query_row("SELECT data FROM chat_items WHERE id=?",[&id],|r|r.get(0)).optional()?;
  let mut item=previous.and_then(|s|serde_json::from_str::<ChatItem>(&s).ok()).unwrap_or(ChatItem{id:id.clone(),role:if category=="user"{"user"}else{"assistant"}.into(),parts:Vec::new(),created_at:native_created_at.unwrap_or_else(||now.clone()),turn_id:turn.map(str::to_owned),elapsed_ms:None,turn_status:None,turn_origin:None,fork_anchor:None,turn_model:None,turn_usage:None,turn_review:None});
  let mut changed=false;
  let mut resolved_pending_approval=false;
  // Agent delegation: while the parent agent is inside a turn, a delegated
  // session's requests go to it instead of the user, and its replies and
  // errors raise no notices. Otherwise everything behaves as usual.
  let delegation=crate::delegation::active_link(tx,session_id)?;
  let quiet=match &delegation {Some(link)=>crate::delegation::parent_turn_active(tx,&link.parent_session_id)?,None=>false};
  let mut routed_to_parent=false;
  match kind {
   "chat.subagent" => {
    record_subagent(tx, session_id, turn, data, false, &now)?;
    return Ok(());
   }
   "chat.subagent.item" => {
    record_subagent(tx, session_id, turn, data, true, &now)?;
    return Ok(());
   }
   "message.user"=>{
    // A steered insert joins the running turn. Completing streaming parts or
    // starting a new activity generation would freeze the live reply and make
    // Stop/queue target the insert instead of the turn already in progress.
    let steered=data.get("steered").and_then(Value::as_bool)==Some(true);
    if !steered { complete_streaming_items(tx,session_id,&now)?; }
    let mut part=json!({"type":"text","text":data.get("text").and_then(Value::as_str).unwrap_or("")});
    if steered {
     let mut extra=json!({"steered":true});
     if let Some(turn)=data.get("turnId") { extra["turnId"]=turn.clone(); }
     if let Some(images)=data.get("images").filter(|images| images.as_array().is_some_and(|items| !items.is_empty())) { extra["images"]=images.clone(); }
     part["data"]=extra;
    } else if let Some(images)=data.get("images").filter(|images| images.as_array().is_some_and(|items| !items.is_empty())) { part["data"]=json!({"images":images}); }
    item.parts=vec![part];changed=true;
   }
   "chat.delta"=>{
    let part_type=match data.pointer("/part/type").and_then(Value::as_str) { Some("thinking")=>"thinking", _=>"text" };
    let delta=data.pointer("/part/text").and_then(Value::as_str).or_else(||data.get("text").and_then(Value::as_str)).unwrap_or("");
    if !delta.is_empty(){
     if let Some(part)=item.parts.iter_mut().find(|p|p.get("type").and_then(Value::as_str)==Some(part_type)) {
      let prior=part.get("text").and_then(Value::as_str).unwrap_or("");
      part["text"]=json!(format!("{prior}{delta}"));
      part["status"]=json!("streaming");
     } else {item.parts.push(json!({"type":part_type,"text":delta,"status":"streaming"}));}
     changed=true;
    }
   }
   "chat.item"=>{
    if let Some(parts)=data.get("parts").and_then(Value::as_array){item.parts=parts.clone();file_references::enrich_parts(&mut item.parts);changed=true;}
    else if let Some(part)=data.get("part"){
     if data.get("merge").and_then(Value::as_bool)==Some(true){upsert_chat_part(&mut item.parts,part.clone());changed=true;}
     else {item.parts=vec![part.clone()];file_references::enrich_parts(&mut item.parts);changed=true;}
    }
    else if let Some(raw)=raw_item {
     let kind=raw.get("type").and_then(Value::as_str).unwrap_or("tool");
     let text=item_text(raw);
     if matches!(kind,"userMessage") {
      // User turns are already persisted from chat.send as message.user.
     } else if matches!(kind,"agentMessage"|"assistant"|"message"|"plan") {
      if !text.is_empty(){item.parts=vec![json!({"type":"text","text":text})];
       if let Some(phase)=raw.get("phase").and_then(Value::as_str).filter(|phase|matches!(*phase,"commentary"|"final_answer")){item.parts[0]["phase"]=json!(phase);}
       changed=true;}
     } else if matches!(kind,"agentThought"|"reasoning"|"thinking") {
      if !text.is_empty(){item.parts=vec![json!({"type":"thinking","text":text,"status":"complete"})];changed=true;}
     } else {item.parts=vec![json!({"type":"tool","toolName":raw.get("name").and_then(Value::as_str).unwrap_or(kind),"toolId":native_item.unwrap_or(&id),"status":raw.get("status").and_then(Value::as_str).unwrap_or("running"),"data":raw})];file_references::enrich_parts(&mut item.parts);changed=true;}
    }
   }
   "chat.approval"=>{
    if let Some(approval)=approval_id {
     let mut payload=data.get("part").and_then(|part|part.get("data")).cloned().unwrap_or_else(||data.clone());
     if let Some(link)=&delegation {
      // Requests ThreadTerm cannot answer by choice always stay with the user.
      routed_to_parent=quiet&&payload.get("submittable").and_then(Value::as_bool)!=Some(false)&&!matches!(payload.get("interaction").and_then(Value::as_str),Some("question"|"plan"))&&payload.get("choices").and_then(Value::as_array).is_some_and(|choices|choices.iter().any(|choice|choice.get("scope").and_then(Value::as_str)!=Some("persistent")));
      if let Some(object)=payload.as_object_mut() {object.insert("delegation".into(),json!({"parentSessionId":link.parent_session_id,"route":if routed_to_parent{"parent"}else{"user"}}));}
     }
     item.parts=vec![json!({"type":"approval","approvalId":approval,"status":"pending","data":payload})];changed=true;
     if !routed_to_parent {
      insert_attention(tx,&id,session_id,turn,"approval",data,&now)?;
      tx.execute("UPDATE inbox SET data=?,resolved=0 WHERE id=?",params![serde_json::to_string(data)?,id])?;
     }
    }
   }
   "chat.approval.resolved"=>{
    // `expired` retires one card (cancelled/superseded) without implying any
    // approval and without reopening the turn; other statuses resolve it.
    let expired=data.get("status").and_then(Value::as_str)==Some("expired");
    let status=if expired{"expired"}else{match data.get("status").and_then(Value::as_str) { Some("outcomeUnknown")=>"outcomeUnknown", Some("answered")=>"answered", Some("dismissed")=>"dismissed", _=>"resolved" }};
    for part in &mut item.parts {if part.get("type").and_then(Value::as_str)==Some("approval"){
     let previous_status=part.get("status").and_then(Value::as_str);
     // A successful local response can race a native turn-end expiry in the
     // ingress queue. Retain its read-only receipt without reviving activity.
     let submitted_answer=matches!(status,"answered"|"dismissed")&&matches!(data.get("outcome").and_then(Value::as_str),Some("submitted"|"partial"));
     if previous_status==Some("expired") && !expired && !submitted_answer {continue;}
     resolved_pending_approval |= matches!(previous_status,Some("pending"|"submitting"));
     part["status"]=json!(status);
     for key in ["planOutcome","feedback","outcome","message","recovery"] {if let Some(value)=data.get(key){part["data"][key]=value.clone();}}
     if let Some(summary)=data.get("answerSummary") { let summary=crate::chat_questions::mask_answer_summary(&part["data"],summary); part["data"]["answerSummary"]=summary; }
     if expired {
      if let (Some(target),Some(outcome))=(part.pointer_mut("/data").and_then(Value::as_object_mut),data.get("outcome")) {target.insert("outcome".into(),outcome.clone());}
      if let (Some(target),Some(message))=(part.pointer_mut("/data").and_then(Value::as_object_mut),data.get("message")) {target.insert("message".into(),message.clone());}
     }
     changed=true;
    }}
    tx.execute("UPDATE inbox SET resolved=1,read=1 WHERE id=?",[&id])?;
   }
   "chat.connection"=>{
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.connection',?,?)",params![serde_json::to_string(&{
     let mut payload=data.clone();
     payload["sessionId"]=json!(session_id);
     payload
    })?,now])?;
    let phase=data.get("phase").and_then(Value::as_str).unwrap_or("");
    // A replacement worker cannot inherit actionable permissions from the
    // prior connection. Its connecting event precedes its native events.
    if matches!(phase,"connecting"|"failed"|"disconnected"|"unavailable") {
     expire_pending_parts(tx,session_id,&now)?;
    }
   }
   "chat.turn.started"=>{
    // A carry turn re-homes the steered row that started it: the turn the
    // text was inserted into never ran it, so the "Inserted" row must move
    // with the carry instead of staying behind in a settled turn.
    if let Some(carry)=turn.filter(|value|value.starts_with("carry:")) {
     rehome_steered_message(tx,session_id,carry.trim_start_matches("carry:"),carry,&now)?;
    }
    // A delayed duplicate start must not replace the model that was active
    // when this turn first began.
    if item.turn_model.is_none() {
     if let Some(model)=turn_model(data).or_else(|| model_from_latest_ui(tx,session_id)) { item.turn_model=Some(model);changed=true; }
    }
   }
   "chat.turn.completed"=>{
    let completion=completed_turn_status(data);
    item.turn_status=Some(completion);changed=true;
    if let Some(turn)=turn {stamp_turn_status(tx,session_id,turn,&id,completion,&now)?;}
    expire_pending_parts_for_turn(tx,session_id,turn,&now)?;
    complete_streaming_items(tx,session_id,&now)?;
    // Adapters that time their turns carry elapsedMs; other providers omit it.
    if let Some(elapsed)=data.get("elapsedMs").and_then(Value::as_u64){item.elapsed_ms=Some(elapsed);changed=true;}
    for part in &mut item.parts {
     if part.get("status").and_then(Value::as_str)==Some("streaming") {part["status"]=json!("complete");changed=true;}
    }
    // Reply notices are already-read and excluded from snapshot Inbox rows.
    if !quiet {notify_reply(tx,session_id,turn,data,&now)?;}
   }
   "chat.error"=>{item.turn_status=Some(crate::domain::NativeTurnStatus::Failed);item.parts.push(json!({"type":"error","text":data.get("message").and_then(Value::as_str).unwrap_or("Provider request failed"),"data":data}));changed=true;if !quiet {insert_attention(tx,&format!("{session_id}:error:{turn_key}"),session_id,turn,"error",data,&now)?;}}
   "chat.ui"=>{
    let mut payload=normalize_chat_ui(data.clone());
    payload["sessionId"]=json!(session_id);
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.ui',?,?)",params![serde_json::to_string(&payload)?,now])?;
   }
   "chat.title"=>{
    project_native_title(tx,session_id,data,&now)?;
   }
   "chat.context"=>{
    if let Some(usage)=data.get("usage").filter(|usage|usage.is_object()){
     let mut usage=usage.clone();
     let updated_at=usage.get("updatedAt").and_then(Value::as_str)
      .filter(|timestamp|chrono::DateTime::parse_from_rfc3339(timestamp).is_ok())
      .unwrap_or(&now).to_owned();
     usage["updatedAt"]=json!(updated_at);
     // Context pressure is a latest-value snapshot: one row per session, so a
     // reopened chat can paint it before the next turn produces usage.
     tx.execute("INSERT INTO chat_context(session_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",params![session_id,serde_json::to_string(&usage)?,updated_at])?;
     tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.context',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"usage":usage}))?,now])?;
     // Native per-turn context usage can enrich the saved footer. The speed
     // tracker freezes per-call output aggregates on the terminal event.
     if turn.is_some() { if let Some(usage)=data.get("turnUsage").and_then(turn_usage) { item.turn_usage=Some(crate::turn_speed::merge_usage(item.turn_usage.as_ref(),&usage));changed=true; } }
     // Agents that name the answering model only on its message (OpenCode)
     // send it here; a model known when the turn started is kept.
     if turn.is_some() && item.turn_model.is_none() {
      if let Some(model)=turn_model(data) { item.turn_model=Some(model);changed=true; }
     }
    }
   }
   _=>{}
  }
  if matches!(kind,"chat.turn.completed"|"chat.error") {
   if let Some(usage)=data.get("turnUsage").and_then(turn_usage) {
    item.turn_usage=Some(crate::turn_speed::merge_usage(item.turn_usage.as_ref(),&usage));changed=true;
   }
  }
  // A context snapshot is not billing usage or a session-status change. When it
  // carries per-turn footer usage, that assistant item still has to be saved.
  if kind=="chat.context" {
   if changed {
    let payload=serde_json::to_string(&item)?;
    tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,turn_id=excluded.turn_id",params![id,session_id,turn,"message",payload,item.created_at])?;
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,now])?;
   }
   return Ok(());
  }
  // Adapters may attach a provider-native fork coordinate to the item they
  // are currently projecting. Never persist an anchor for another native
  // conversation, even if a malformed or stale provider event supplies one.
  let anchor=data.get("forkAnchor")
   .or_else(||data.pointer("/part/forkAnchor"))
   .or_else(||raw_item.and_then(|raw|raw.get("forkAnchor")));
  if item.role=="assistant" {
   if let Some(anchor)=anchor.and_then(|value|serde_json::from_value::<crate::domain::NativeForkAnchor>(value.clone()).ok()) {
    let bound:Option<String>=tx.query_row("SELECT native_id FROM sessions WHERE id=?",[session_id],|row|row.get(0)).optional()?.flatten();
    if bound.as_deref()==Some(anchor.native_id.as_str()) {item.fork_anchor=Some(anchor);changed=true;}
   }
  }
  if kind=="chat.turn.completed" && item.role=="assistant" && item.turn_status==Some(crate::domain::NativeTurnStatus::Completed) && item.fork_anchor.is_none() {
   let native_id:Option<String>=tx.query_row("SELECT native_id FROM sessions WHERE id=?",[session_id],|row|row.get(0))?;
   if let Some(native_id)=native_id.filter(|value|!value.is_empty()) {
    item.fork_anchor=Some(crate::domain::NativeForkAnchor {native_id,turn_id:None,message_id:None,entry_id:None});changed=true;
   }
  }
  if changed {
   let payload=serde_json::to_string(&item)?;
   tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,turn_id=excluded.turn_id",params![id,session_id,turn,"message",payload,item.created_at])?;
   tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,now])?;
  }
  let status=match kind {"chat.turn.started"=>Some("running"),"chat.turn.completed"=>Some(if has_pending_approval(tx,session_id)? {"waiting"}else{"idle"}),"chat.approval" if data.pointer("/part/data/runtimeOwned").and_then(Value::as_bool)==Some(true) && data.pointer("/part/data/waitingForPrompt").and_then(Value::as_bool)==Some(true)=>Some("idle"),"chat.approval"=>Some("waiting"),"chat.approval.resolved" if data.get("preserveSessionState").and_then(Value::as_bool)==Some(true)=>None,"chat.approval.resolved" if data.get("returnToIdle").and_then(Value::as_bool)==Some(true) && !has_pending_approval(tx,session_id)?=>Some("idle"),"chat.approval.resolved" if !resolved_pending_approval || data.get("status").and_then(Value::as_str)==Some("expired")=>None,"chat.approval.resolved"=>Some(if has_pending_approval(tx,session_id)? {"waiting"}else{"running"}),"chat.error"=>Some("error"),_=>None};
  if let Some(status)=status {
   // Provider readers can deliver a final completion/error after an explicit
   // stop or runtime recovery has already made the session terminal. Keep
   // projecting transcript and usage data, but never resurrect that session.
   tx.execute("UPDATE sessions SET status=?,updated_at=? WHERE id=? AND status NOT IN ('exited','interrupted')",params![status,now,session_id])?;
  }
  if let Some(activity) = project_activity(tx, session_id, turn, kind, data, resolved_pending_approval, routed_to_parent)? {
   tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('session.activity',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"activity":activity}))?,now])?;
  }
  if let Some(link)=&delegation {crate::delegation::project_child_event(tx,link,turn,kind,data)?;}
  crate::group_chat::project_event(tx,session_id,turn,kind,data)?;
  // A parent whose turn ends can no longer answer: its delegates' requests go to the user.
  if matches!(kind,"chat.turn.completed"|"chat.error") {escalate_parent_requests(tx,session_id,&now)?;}
  let usage=data.get("usage").or_else(||data.pointer("/raw/params/usage")).or_else(||data.pointer("/raw/params/tokenUsage/last"));
  if let Some(usage)=usage {
   let input=usage.get("inputTokens").or_else(||usage.get("input_tokens")).or_else(||usage.get("prompt_tokens")).and_then(Value::as_u64);
   let output=usage.get("outputTokens").or_else(||usage.get("output_tokens")).or_else(||usage.get("completion_tokens")).and_then(Value::as_u64);
   // Model identity is persisted only when the provider event actually supplies it.
   let model=usage.get("model").or_else(||data.get("model")).or_else(||data.pointer("/raw/params/model")).and_then(Value::as_str);
   if input.is_some()||output.is_some(){
    tx.execute("INSERT INTO usage_records(id,session_id,provider,recorded_at,input_tokens,output_tokens,model) SELECT ?,id,provider,?,?,?,? FROM sessions WHERE id=? ON CONFLICT(id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,model=excluded.model",params![format!("{session_id}:{turn_key}:usage"),now,input,output,model,session_id])?;
   }
  }
  if status.is_some()||usage.is_some() {tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"kind":kind}))?,now])?;}
  Ok(())
}

/// Native providers may name a conversation after it starts.  An explicit
/// session title request is durable provenance even if the user picked the
/// provider's default spelling again, so never infer ownership from equality.
fn project_native_title(tx: &rusqlite::Transaction<'_>, session_id: &str, data: &Value, now: &str) -> Result<bool> {
 let Some(title)=data.get("title").and_then(Value::as_str).map(str::trim).filter(|title|!title.is_empty()) else {return Ok(false)};
 let current:Option<(String,String)>=tx.query_row("SELECT title,provider FROM sessions WHERE id=?",[session_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
 if current.as_ref().is_none_or(|(current,provider)|current!=provider) {return Ok(false)}
 let user_owned:bool=tx.query_row(
  "SELECT EXISTS(SELECT 1 FROM operation_requests WHERE (method='session.update' AND json_extract(params,'$.sessionId')=? AND json_type(params,'$.title')='text') OR (method IN ('session.create','history.import') AND json_type(params,'$.title')='text' AND id IN (SELECT id FROM operations WHERE json_extract(result,'$.id')=?)))",
 params![session_id,session_id],|row|row.get(0))?;
 if user_owned {return Ok(false)}
 if tx.execute("UPDATE sessions SET title=?,updated_at=? WHERE id=?",params![title,now,session_id])?==1 {
  tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"kind":"session.title"}))?,now])?;
  return Ok(true)
 }
 Ok(false)
}

fn completed_turn_status(data: &Value) -> crate::domain::NativeTurnStatus {
 use crate::domain::NativeTurnStatus;
 if data.get("cancelled").and_then(Value::as_bool)==Some(true)
  || data.get("canceled").and_then(Value::as_bool)==Some(true) {
  return NativeTurnStatus::Interrupted;
 }
 let status=data.get("status")
  .or_else(||data.get("turnStatus"))
  .or_else(||data.pointer("/result/stopReason"))
  .or_else(||data.pointer("/raw/params/turn/status"))
  .or_else(||data.pointer("/raw/params/status"))
  .and_then(Value::as_str)
  .unwrap_or("")
  .to_ascii_lowercase();
 match status.as_str() {
  "cancelled"|"canceled"|"interrupted"|"stopped"|"killed"|"aborted"=>NativeTurnStatus::Interrupted,
  "failed"|"error"=>NativeTurnStatus::Failed,
  "unknown"=>NativeTurnStatus::Unknown,
  "inprogress"|"in_progress"|"running"=>NativeTurnStatus::InProgress,
  _=>NativeTurnStatus::Completed,
 }
}

fn stamp_turn_status(
 tx:&rusqlite::Transaction<'_>,session_id:&str,turn_id:&str,exclude_id:&str,
 status:crate::domain::NativeTurnStatus,now:&str,
)->Result<()> {
 let native_id:Option<String>=tx.query_row("SELECT native_id FROM sessions WHERE id=?",[session_id],|row|row.get(0))?;
 let rows=tx.prepare("SELECT id,data FROM chat_items WHERE session_id=? AND turn_id=? AND id<>?")?
  .query_map(params![session_id,turn_id,exclude_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?
  .collect::<rusqlite::Result<Vec<_>>>()?;
 for (id,data) in rows {
  let Ok(mut item)=serde_json::from_str::<ChatItem>(&data) else {continue};
  if item.role!="assistant" {continue;}
  item.turn_status=Some(status);
  if status==crate::domain::NativeTurnStatus::Completed && item.fork_anchor.is_none() {
   if let Some(native_id)=native_id.as_ref().filter(|value|!value.is_empty()) {
    item.fork_anchor=Some(crate::domain::NativeForkAnchor {native_id:native_id.clone(),turn_id:None,message_id:None,entry_id:None});
   }
  }
  tx.execute("UPDATE chat_items SET data=? WHERE id=?",params![serde_json::to_string(&item)?,id])?;
  tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,now])?;
 }
 Ok(())
}

fn turn_model(data: &Value) -> Option<String> {
    [data.get("model"), data.pointer("/turn/model"), data.pointer("/raw/params/turn/model"), data.pointer("/raw/params/model")]
        .into_iter().flatten().find_map(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn model_from_latest_ui(tx: &rusqlite::Transaction<'_>, session_id: &str) -> Option<String> {
    let raw: Option<String> = tx.query_row("SELECT data FROM outbox WHERE event='chat.ui' AND json_extract(data,'$.sessionId')=? ORDER BY seq DESC LIMIT 1", [session_id], |row| row.get(0)).optional().ok().flatten();
    serde_json::from_str::<Value>(raw?.as_str()).ok()?.get("options")?.as_array()?.iter()
        .find(|option| option.get("id").and_then(Value::as_str)==Some("model"))?.get("value")?.as_str()
        .filter(|value| !value.is_empty()).map(str::to_owned)
}

// A worker close/replacement has its own lifecycle. Save its last measurement
// without manufacturing a completion that could change the new worker's state.
fn attach_turn_speed(tx:&rusqlite::Transaction<'_>,session_id:&str,turn_id:&str,usage:&Value)->Result<()> {
    let rows=tx.prepare("SELECT id,data FROM chat_items WHERE session_id=? AND turn_id=? ORDER BY created_at DESC,id DESC")?
        .query_map(params![session_id,turn_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id,raw) in rows {
        let Ok(mut item)=serde_json::from_str::<ChatItem>(&raw) else {continue};
        if item.role!="assistant" {continue;}
        item.turn_usage=Some(crate::turn_speed::merge_usage(item.turn_usage.as_ref(),usage));
        tx.execute("UPDATE chat_items SET data=? WHERE id=?",params![serde_json::to_string(&item)?,id])?;
        tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,Utc::now().to_rfc3339()])?;
        break;
    }
    Ok(())
}

fn turn_usage(usage: &Value) -> Option<Value> {
    let mut out=serde_json::Map::new();
    for key in ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens","generationMs","firstTokenMs"] {
        if let Some(value)=usage.get(key).filter(|value| value.is_number()) { out.insert(key.into(),value.clone()); }
    }
    if let Some(value)=usage.get("outputTokensEstimated").filter(|value|value.is_boolean()) { out.insert("outputTokensEstimated".into(),value.clone()); }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Attaches review metadata after an event-triggered checkpoint pair is captured.
/// Called only after projection and provider fencing have released their locks.
pub(crate) fn attach_turn_review(db: &Database, session_id: &str, turn_id: &str, review: crate::domain::ChatTurnReview) -> Result<()> {
    db.transaction(|tx| {
        let mut statement=tx.prepare("SELECT id,data FROM chat_items WHERE session_id=? AND turn_id=? AND kind='message' ORDER BY created_at DESC,id DESC")?;
        let rows=statement.query_map(params![session_id,turn_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?;
        let mut selected=None;
        for row in rows {
            let (id,raw)=row?;
            let item:ChatItem=serde_json::from_str(&raw)?;
            if item.role=="assistant" { selected=Some((id,item)); break; }
        }
        drop(statement);
        let Some((id,mut item))=selected else { return Ok(()); };
        if item.turn_review.as_ref()==Some(&review) { return Ok(()); }
        item.turn_review=Some(review);
        tx.execute("UPDATE chat_items SET data=? WHERE id=?",params![serde_json::to_string(&item)?,id])?;
        tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,Utc::now().to_rfc3339()])?;
        Ok(())
    })
}

fn terminal_subagent_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn truncate_subagent_string(value: &mut Value, limit: usize) {
    if let Some(text) = value.as_str() {
        if text.chars().count() > limit {
            const SUFFIX: &str = "…[truncated]";
            *value = json!(format!(
                "{}{}",
                text.chars()
                    .take(limit - SUFFIX.chars().count())
                    .collect::<String>(),
                SUFFIX
            ));
        }
    }
}

pub(crate) fn subagent_activity_label(item: &ChatItem) -> String {
    for part in &item.parts {
        if part.get("type").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        for path in [
            "/data/command",
            "/data/input/command",
            "/data/rawInput/command",
            "/data/file_path",
            "/data/path",
            "/data/filePath",
            "/data/input/file_path",
            "/data/input/path",
            "/data/input/filePath",
            "/data/rawInput/file_path",
            "/data/rawInput/path",
            "/data/rawInput/filePath",
            "/toolName",
            "/data/title",
        ] {
            if let Some(label) = part
                .pointer(path)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                return label.trim().to_owned();
            }
        }
    }
    for part in &item.parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(line) = part
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(|s| s.lines().find(|line| !line.trim().is_empty()))
                {
                    return line.trim().to_owned();
                }
            }
            Some("thinking") => return "Thinking".into(),
            _ => {}
        }
    }
    String::new()
}

fn record_subagent(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    turn: Option<&str>,
    data: &Value,
    transcript_item: bool,
    now: &str,
) -> Result<()> {
    let Some(key) = data
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
    else {
        return Ok(());
    };
    let id = format!("{session}:assistant:subagent:{key}");
    let previous = crate::db::subagent_card_tx(tx, session, key)?;
    let provider: String =
        tx.query_row("SELECT provider FROM sessions WHERE id=?", [session], |r| {
            r.get(0)
        })?;
    let mut card = previous.clone().unwrap_or_else(|| ChatItem {
        id: id.clone(),
        role: "assistant".into(),
        parts: Vec::new(),
        created_at: now.into(),
        turn_id: turn.map(str::to_owned),
        elapsed_ms: None,
        turn_status: None,
        turn_origin: None,
            fork_anchor: None,
        turn_model: None,
        turn_usage: None,
        turn_review: None,
    });
    let mut info = card.parts.first().and_then(|part| part.get("data")).filter(|v| v.is_object()).cloned()
        .unwrap_or_else(|| json!({"key":key,"provider":provider,"status":"running","transcript":"live","startedAt":now}));
    if transcript_item {
        let Some(raw) = data.get("item") else {
            return Ok(());
        };
        let Some(item_id) = raw.get("id").and_then(Value::as_str) else {
            return Ok(());
        };
        let item = ChatItem {
            id: item_id.into(),
            role: raw
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("assistant")
                .into(),
            parts: raw
                .get("parts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            created_at: raw
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or(now)
                .into(),
            turn_id: turn.map(str::to_owned),
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        };
        let rev = crate::db::upsert_subagent_item(
            tx,
            session,
            key,
            &item,
            data.get("merge").and_then(Value::as_bool) == Some(true),
        )?;
        let (item_count, tool_count, newest, truncated) =
            crate::db::subagent_item_projection_tx(tx, session, key)?;
        info["itemCount"] = json!(item_count);
        info["toolCount"] = json!(tool_count);
        info["lastActivity"] = json!(newest
            .as_ref()
            .map(subagent_activity_label)
            .unwrap_or_default());
        info["rev"] = json!(rev);
        if truncated {
            info["truncated"] = json!(true);
        }
    } else if let Some(patch) = data.get("info").and_then(Value::as_object) {
        let terminal = info
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(terminal_subagent_status);
        let reopen = data.get("reopen").and_then(Value::as_bool) == Some(true);
        for (field, value) in patch {
            if field == "status" && value.as_str() == Some("running") && terminal && !reopen {
                continue;
            }
            info[field] = value.clone();
        }
    }
    info["key"] = json!(key);
    if info.get("startedAt").is_none_or(Value::is_null) {
        info["startedAt"] = json!(now);
    }
    if info
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(terminal_subagent_status)
        && info.get("endedAt").is_none_or(Value::is_null)
    {
        info["endedAt"] = json!(now);
    }
    for (field, limit) in [
        ("description", 300),
        ("prompt", 4000),
        ("summary", 8000),
        ("lastActivity", 200),
    ] {
        if let Some(value) = info.get_mut(field) {
            truncate_subagent_string(value, limit);
        }
    }
    crate::db::bound_json(&mut info);
    card.parts = vec![json!({"type":"subagent","toolId":key,"status":info["status"],"data":info})];
    if previous.as_ref() == Some(&card) {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![id, session, card.turn_id, "message", serde_json::to_string(&card)?, card.created_at],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
        params![
            serde_json::to_string(&json!({"sessionId":session,"item":card}))?,
            now
        ],
    )?;
    Ok(())
}

fn project_activity(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: &Value,
    resolved_pending_approval: bool,
    routed_to_parent: bool,
) -> Result<Option<crate::session_activity::SessionActivity>> {
    let current = crate::db::session_activity_tx(tx, session_id)?;
    let same_turn = current
        .as_ref()
        .is_none_or(|activity| activity.turn_id.as_deref() == turn_id);
    let live_turn = current.as_ref().is_some_and(|activity| {
        matches!(
            activity.state.as_str(),
            "running" | "awaiting_approval" | "awaiting_parent"
        ) && same_turn
    });
    let transition = match kind {
        // This record is accepted under the provider worker lock, so it is
        // the only event allowed to begin a new attention generation.
        "message.user" if data.get("steered").and_then(Value::as_bool) != Some(true) => {
            Some(("running", turn_id, None))
        }
        // Native start can replace the client operation id with the canonical
        // native turn id, but never revives an already completed turn.
        "chat.turn.started"
            if current.as_ref().is_some_and(|activity| {
                activity.state == "running" && activity.turn_id.as_deref() == turn_id
            }) =>
        {
            Some(("running", turn_id, None))
        }
        // A carry turn is the provider running a leftover steer as its own
        // turn. It has no message.user of its own, so it may claim running
        // from a settled previous turn; the `carry:` prefix keeps a delayed
        // replay of an ordinary turn from reviving a completed one.
        "chat.turn.started"
            if turn_id.is_some_and(|id| id.starts_with("carry:"))
                && current.as_ref().is_none_or(|activity| {
                    matches!(activity.state.as_str(), "idle" | "awaiting_input")
                }) =>
        {
            Some(("running", turn_id, None))
        }
        // A resumed provider can deliver its authoritative pending permission
        // before replaying a local user/start record. Only an explicit idle
        // activity has that admission path; a completed awaiting-input turn
        // remains fenced against late approvals.
        "chat.approval" if same_turn
            && data.pointer("/part/data/runtimeOwned").and_then(Value::as_bool) == Some(true)
            && data.pointer("/part/data/waitingForPrompt").and_then(Value::as_bool) == Some(true) =>
        {
            Some(("awaiting_input", turn_id, None))
        }
        "chat.approval"
            if live_turn
                || (same_turn && data.pointer("/part/data/runtimeOwned").and_then(Value::as_bool) == Some(true))
                || current
                    .as_ref()
                    .is_none_or(|activity| activity.state == "idle") =>
        {
            // The user's attention state, unless this request (and every
            // other pending one) waits for the delegating parent agent.
            match pending_approval_route(tx, session_id)? {
                Some("parent") if routed_to_parent => Some(("awaiting_parent", turn_id, None)),
                _ => Some(("awaiting_approval", turn_id, None)),
            }
        }
        "chat.approval.resolved" if data.get("preserveSessionState").and_then(Value::as_bool) == Some(true) => None,
        "chat.approval.resolved" if same_turn
            && data.get("returnToIdle").and_then(Value::as_bool) == Some(true)
            && !has_pending_approval(tx, session_id)? => Some(("awaiting_input", turn_id, None)),
        "chat.approval.resolved"
            if resolved_pending_approval
                && data.get("status").and_then(Value::as_str) != Some("expired")
                && same_turn
                && current.as_ref().is_some_and(|activity| {
                    matches!(activity.state.as_str(), "awaiting_approval" | "awaiting_parent")
                }) =>
        {
            match pending_approval_route(tx, session_id)? {
                Some("parent") => Some(("awaiting_parent", turn_id, None)),
                Some(_) => Some(("awaiting_approval", turn_id, None)),
                None => Some((if data.get("returnToIdle").and_then(Value::as_bool) == Some(true) { "awaiting_input" } else { "running" }, turn_id, None)),
            }
        }
        "chat.turn.completed" if live_turn && has_pending_approval(tx, session_id)? => None,
        "chat.turn.completed" if live_turn && completion_is_actionable(data) => {
            Some(("awaiting_input", turn_id, None))
        }
        "chat.turn.completed" if live_turn => Some(("idle", turn_id, Some("terminal"))),
        "chat.error" if live_turn => Some(("idle", turn_id, Some("error"))),
        _ => None,
    };
    let Some((state, turn_id, reason)) = transition else {
        return Ok(None);
    };
    crate::db::set_session_activity_tx(tx, session_id, state, turn_id, reason)
}

fn completion_is_actionable(data: &Value) -> bool {
    !matches!(
        data.get("status").and_then(Value::as_str),
        Some("failed" | "error" | "cancelled" | "canceled" | "interrupted")
    )
}

fn has_pending_approval(tx: &rusqlite::Transaction<'_>, session_id: &str) -> Result<bool> {
    let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=?")?;
    let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let item: ChatItem = serde_json::from_str(&row?)?;
        if item.parts.iter().any(|part| {
            part.get("type").and_then(Value::as_str) == Some("approval")
                && matches!(
                    part.get("status").and_then(Value::as_str),
                    Some("pending" | "submitting")
                )
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Who the session's pending approvals wait for: `Some("parent")` when every
/// pending request was routed to the delegating parent agent, `Some("user")`
/// when at least one waits for the user, `None` when nothing is pending.
pub(crate) fn pending_approval_route(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<Option<&'static str>> {
    let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=?")?;
    let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
    let mut route = None;
    for row in rows {
        let item: ChatItem = serde_json::from_str(&row?)?;
        for part in &item.parts {
            if part.get("type").and_then(Value::as_str) != Some("approval")
                || !matches!(
                    part.get("status").and_then(Value::as_str),
                    Some("pending" | "submitting")
                )
            {
                continue;
            }
            if part.pointer("/data/delegation/route").and_then(Value::as_str) == Some("parent") {
                route.get_or_insert("parent");
            } else {
                return Ok(Some("user"));
            }
        }
    }
    Ok(route)
}

/// Hands every request a parent agent was asked to answer back to the user,
/// as a normal approval with an Inbox notice. Called when the parent's turn
/// ends or the parent stops; escalation is one-way.
pub(crate) fn escalate_parent_requests(
    tx: &rusqlite::Transaction<'_>,
    parent_session_id: &str,
    now: &str,
) -> Result<()> {
    for child in crate::delegation::active_children(tx, parent_session_id)? {
        let mut statement =
            tx.prepare("SELECT id, turn_id, data FROM chat_items WHERE session_id=?")?;
        let rows = statement
            .query_map([&child], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut escalated_turn = None;
        for (id, item_turn, data) in rows {
            let Ok(mut item) = serde_json::from_str::<ChatItem>(&data) else {
                continue;
            };
            let mut notices = Vec::new();
            for part in &mut item.parts {
                if part.get("type").and_then(Value::as_str) == Some("approval")
                    && matches!(
                        part.get("status").and_then(Value::as_str),
                        Some("pending" | "submitting")
                    )
                    && part.pointer("/data/delegation/route").and_then(Value::as_str)
                        == Some("parent")
                {
                    if let Some(delegation) = part
                        .pointer_mut("/data/delegation")
                        .and_then(Value::as_object_mut)
                    {
                        delegation.insert("route".into(), json!("user"));
                        delegation.insert("escalated".into(), json!(true));
                    }
                    notices.push(part.get("data").cloned().unwrap_or(Value::Null));
                }
            }
            if notices.is_empty() {
                continue;
            }
            tx.execute(
                "UPDATE chat_items SET data=? WHERE id=?",
                params![serde_json::to_string(&item)?, id],
            )?;
            tx.execute(
                "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
                params![
                    serde_json::to_string(&json!({"sessionId":child,"item":item}))?,
                    now
                ],
            )?;
            for notice in notices {
                insert_attention(tx, &id, &child, item_turn.as_deref(), "approval", &notice, now)?;
            }
            escalated_turn = Some(item_turn);
        }
        let Some(item_turn) = escalated_turn else {
            continue;
        };
        let turn = crate::db::session_activity_tx(tx, &child)?
            .and_then(|activity| activity.turn_id)
            .or(item_turn);
        if let Some(activity) = crate::db::set_session_activity_tx(
            tx,
            &child,
            "awaiting_approval",
            turn.as_deref(),
            None,
        )? {
            tx.execute(
                "INSERT INTO outbox(event,data,created_at) VALUES ('session.activity',?,?)",
                params![
                    serde_json::to_string(&json!({"sessionId":child,"activity":activity}))?,
                    now
                ],
            )?;
        }
        if let Some(link) = crate::delegation::active_link(tx, &child)? {
            // A pending stop keeps its state: the delegate may still be working,
            // and a cancel must not be overwritten by an escalation.
            if !crate::delegation::stop_requested(&link.state) {
                crate::delegation::set_state(tx, &link.id, "awaiting_user", None, None)?;
            }
        }
    }
    Ok(())
}

/// Parent-stop hook (`session.stop`): escalate outside a provider event.
pub fn escalate_parent_requests_now(db: &Database, parent_session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    db.transaction(|tx| escalate_parent_requests(tx, parent_session_id, &now))
}

pub fn expire_pending_approvals(db: &Database, session_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    db.transaction(|tx| expire_pending_parts(tx, session_id, &now))
}

fn expire_pending_parts(tx: &rusqlite::Transaction<'_>, session_id: &str, now: &str) -> Result<()> {
    expire_pending_parts_matching(tx, session_id, None, now)
}

fn expire_pending_parts_for_turn(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    now: &str,
) -> Result<()> {
    expire_pending_parts_matching(tx, session_id, turn_id, now)
}

fn expire_pending_parts_matching(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: Option<&str>,
    now: &str,
) -> Result<()> {
    let mut stmt = tx.prepare("SELECT id, turn_id, data FROM chat_items WHERE session_id=?")?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut retired_runtime_turns = Vec::new();
    for (id, item_turn, data) in rows {
        if let Some(expected) = turn_id {
            if item_turn.as_deref() != Some(expected) {
                continue;
            }
        }
        let Ok(mut item) = serde_json::from_str::<ChatItem>(&data) else {
            continue;
        };
        let mut changed = false;
        for part in &mut item.parts {
            // A synthetic plan belongs to the completed turn's review, not to
            // a native permission request that expires at that turn boundary.
            if turn_id.is_some() && part.pointer("/data/runtimeOwned").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if part.get("type").and_then(Value::as_str) == Some("approval")
                && part.get("status").and_then(Value::as_str) == Some("pending")
            {
                part["status"] = json!("expired");
                if part.pointer("/data/runtimeOwned").and_then(Value::as_bool) == Some(true) {
                    retired_runtime_turns.push(item_turn.clone());
                }
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        tx.execute(
            "UPDATE chat_items SET data=? WHERE id=?",
            params![serde_json::to_string(&item)?, id],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
            params![
                serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,
                now
            ],
        )?;
        tx.execute("UPDATE inbox SET resolved=1,read=1 WHERE id=?", [&id])?;
    }
    if !retired_runtime_turns.is_empty() && !has_pending_approval(tx, session_id)? {
        if let Some(activity) = crate::db::session_activity_tx(tx, session_id)? {
            if retired_runtime_turns.contains(&activity.turn_id)
                && matches!(activity.state.as_str(), "awaiting_approval" | "awaiting_parent") {
                crate::db::set_session_activity_tx(tx, session_id, "idle", activity.turn_id.as_deref(), Some("plan_expired"))?;
                tx.execute("UPDATE sessions SET status='idle' WHERE id=? AND status='waiting'", [session_id])?;
            }
        }
    }
    Ok(())
}

/// Publish only bounded eval approval metadata through the existing projection.
/// The broker owns exact code bytes; they never enter this transaction payload.
pub(crate) fn publish_browser_eval_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: &str,
    summary: &Value,
) -> Result<bool> {
    let invalid = || anyhow::anyhow!("browser_invalid_arguments");
    let exact = |value: &Value, keys: &[&str]| {
        value.as_object().is_some_and(|map| {
            map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))
        })
    };
    let bounded = |value: &Value, max: usize| {
        value.as_str().is_some_and(|text| {
            !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
        })
    };
    let part = &summary["part"];
    let data = &part["data"];
    if !exact(summary, &["approvalId", "part"])
        || !exact(part, &["type", "approvalId", "status", "data"])
        || part["type"] != "approval"
        || part["status"] != "pending"
        || !exact(
            data,
            &[
                "runtimeOwned",
                "requestType",
                "approvalId",
                "operationId",
                "callerSessionId",
                "tabId",
                "origin",
                "codeHash",
                "codeByteLength",
                "expiresAtUnixMs",
                "settingsGeneration",
                "choices",
            ],
        )
        || data["runtimeOwned"] != true
        || data["requestType"] != "threadterm.browser_eval"
        || !bounded(&data["approvalId"], 256)
        || summary["approvalId"] != data["approvalId"]
        || part["approvalId"] != data["approvalId"]
        || data["callerSessionId"] != session_id
        || !bounded(&data["callerSessionId"], 256)
        || !bounded(&data["operationId"], 512)
        || !bounded(&data["tabId"], 256)
        || !bounded(&data["origin"], 4096)
        || !bounded(&data["settingsGeneration"], 256)
        || !data["codeHash"].as_str().is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        || !data["codeByteLength"]
            .as_u64()
            .is_some_and(|bytes| (1..=16384).contains(&bytes))
        || data["expiresAtUnixMs"]
            .as_u64()
            .is_none_or(|time| time > 9_007_199_254_740_991)
        || data["choices"]
            != json!([{"id":"approve_once","label":"Approve once"},{"id":"deny","label":"Deny"}])
    {
        return Err(invalid());
    }
    let origin =
        reqwest::Url::parse(data["origin"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.origin().ascii_serialization() != data["origin"].as_str().unwrap_or("")
    {
        return Err(invalid());
    }
    match crate::db::browser_eval_context_tx(tx, session_id, turn_id, None) {
        Ok(context) if !context.enabled => return Err(anyhow::anyhow!("browser_eval_disabled")),
        Ok(_) => {}
        Err(error) if error.to_string() == "browser_turn_inactive" => return Ok(false),
        Err(error) => return Err(error),
    }
    let safe = json!({"approvalId":data["approvalId"],"part":{
        "type":"approval","approvalId":data["approvalId"],"status":"pending","data":{
            "runtimeOwned":true,"requestType":"threadterm.browser_eval","approvalId":data["approvalId"],
            "operationId":data["operationId"],"callerSessionId":session_id,"tabId":data["tabId"],
            "origin":data["origin"],"codeHash":data["codeHash"],"codeByteLength":data["codeByteLength"],
            "expiresAtUnixMs":data["expiresAtUnixMs"],"settingsGeneration":data["settingsGeneration"],
            "choices":[{"id":"approve_once","label":"Approve once"},{"id":"deny","label":"Deny"}]
        }
    }});
    record_tx(tx, session_id, Some(turn_id), "chat.approval", &safe)?;
    Ok(true)
}

/// A late cleanup cannot rewrite a settled decision or another approval kind.
pub(crate) fn resolve_browser_eval_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    turn_id: &str,
    approval_id: &str,
    status: &str,
) -> Result<()> {
    if !matches!(status, "approved" | "denied" | "expired" | "cancelled") {
        return Err(anyhow::anyhow!("browser_invalid_arguments"));
    }
    let row: Option<(Option<String>, String)> = tx
        .query_row(
            "SELECT turn_id,data FROM chat_items WHERE id=? AND session_id=?",
            params![format!("{session_id}:approval:{approval_id}"), session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((saved_turn, raw)) = row else {
        return Ok(());
    };
    if saved_turn.as_deref() != Some(turn_id) {
        return Ok(());
    }
    let item: ChatItem = serde_json::from_str(&raw)?;
    if !item.parts.iter().any(|part| {
        part["type"] == "approval"
            && part["approvalId"] == approval_id
            && part.pointer("/data/runtimeOwned").and_then(Value::as_bool) == Some(true)
            && part.pointer("/data/requestType").and_then(Value::as_str)
                == Some("threadterm.browser_eval")
            && matches!(part["status"].as_str(), Some("pending" | "submitting"))
    }) {
        return Ok(());
    }
    let current_turn: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_activity a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=? AND a.turn_id=? AND a.state IN ('running','awaiting_approval') AND s.status NOT IN ('exited','interrupted','error'))",
        params![session_id, turn_id],
        |row| row.get(0),
    )?;
    // Expiry and cleanup must never resume an ended or replacement turn.
    let projection_status = if matches!(status, "expired" | "cancelled") || !current_turn {
        "expired"
    } else {
        "resolved"
    };
    record_tx(
        tx,
        session_id,
        Some(turn_id),
        "chat.approval.resolved",
        &json!({
            "approvalId":approval_id,"status":projection_status,"outcome":status
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_status_rejects_cancelled_failed_and_unknown_turns() {
        use crate::domain::NativeTurnStatus;
        assert_eq!(completed_turn_status(&json!({})), NativeTurnStatus::Completed);
        assert_eq!(completed_turn_status(&json!({"cancelled":true})), NativeTurnStatus::Interrupted);
        assert_eq!(completed_turn_status(&json!({"result":{"stopReason":"cancelled"}})), NativeTurnStatus::Interrupted);
        assert_eq!(completed_turn_status(&json!({"raw":{"params":{"turn":{"status":"failed"}}}})), NativeTurnStatus::Failed);
        assert_eq!(completed_turn_status(&json!({"status":"unknown"})), NativeTurnStatus::Unknown);
    }

    #[test]
    fn completion_stamps_every_assistant_row_in_the_turn() {
        use crate::domain::NativeTurnStatus;
        let db=db();
        let item=ChatItem {id:"reply".into(),role:"assistant".into(),parts:vec![json!({"type":"text","text":"reply"})],created_at:"now".into(),turn_id:Some("turn".into()),elapsed_ms:None,turn_status:None,turn_origin:None,fork_anchor:None,turn_model:None,turn_usage:None,turn_review:None};
        db.transaction(|tx| {
            tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES ('reply','s','turn','message',?,'now')",[serde_json::to_string(&item)?])?;
            stamp_turn_status(tx,"s","turn","boundary",NativeTurnStatus::Completed,"later")
        }).unwrap();
        let stored=db.chat_items("s").unwrap().into_iter().find(|item|item.id=="reply").unwrap();
        assert_eq!(stored.turn_status,Some(NativeTurnStatus::Completed));
    }

    fn subagent_info(db: &Database) -> Value {
        db.subagent_card("s", "child").unwrap().unwrap().parts[0]["data"].clone()
    }

    #[test]
    fn subagent_card_merges_preserves_terminal_status_and_reopens() {
        for status in ["completed", "failed", "cancelled"] {
            let db = db();
            record(&db, "s", Some("first"), "chat.subagent", &json!({"key":"child","info":{"agentType":"explore","description":"task","transcript":"live"}})).unwrap();
            let original = db.subagent_card("s", "child").unwrap().unwrap();
            assert_eq!(original.id, "s:assistant:subagent:child");
            assert_eq!(original.parts.len(), 1);
            assert_eq!(original.parts[0]["type"], "subagent");
            assert_eq!(original.parts[0]["toolId"], "child");
            assert_eq!(subagent_info(&db)["provider"], "codex");
            assert_eq!(subagent_info(&db)["status"], "running");
            assert!(subagent_info(&db)["startedAt"].as_str().is_some());
            record(
                &db,
                "s",
                Some("second"),
                "chat.subagent",
                &json!({"key":"child","info":{"status":status,"summary":"result"}}),
            )
            .unwrap();
            let ended = subagent_info(&db)["endedAt"].clone();
            assert!(ended.as_str().is_some());
            record(
                &db,
                "s",
                Some("second"),
                "chat.subagent",
                &json!({"key":"child","info":{"status":"running","name":"child name"}}),
            )
            .unwrap();
            let card = db.subagent_card("s", "child").unwrap().unwrap();
            assert_eq!(card.parts[0]["status"], status);
            assert_eq!(card.turn_id, original.turn_id);
            assert_eq!(card.created_at, original.created_at);
            assert_eq!(subagent_info(&db)["description"], "task");
            record(&db, "s", Some("second"), "chat.subagent", &json!({"key":"child","info":{"provider":"adapter-provider"}})).unwrap();
            assert_eq!(subagent_info(&db)["provider"], "adapter-provider");
            assert_eq!(subagent_info(&db)["endedAt"], ended);
            assert_eq!(
                db.transaction(|tx| Ok(tx.query_row(
                    "SELECT turn_id FROM chat_items WHERE id=?",
                    [&card.id],
                    |r| r.get::<_, String>(0)
                )?))
                .unwrap(),
                "first"
            );
            let revision = db.snapshot().unwrap().revision;
            record(
                &db,
                "s",
                Some("second"),
                "chat.subagent",
                &json!({"key":"child","info":{"status":"running","name":"child name"}}),
            )
            .unwrap();
            assert!(
                db.events_after(revision).unwrap().is_empty(),
                "unchanged card is silent"
            );
            record(
                &db,
                "s",
                Some("second"),
                "chat.subagent",
                &json!({"key":"child","reopen":true,"info":{"status":"running"}}),
            )
            .unwrap();
            assert_eq!(subagent_info(&db)["status"], "running");
        }
    }

    #[test]
    fn subagent_unknown_item_creates_placeholder_without_parent_side_effects() {
        let db = db();
        record(&db, "s", Some("parent"), "chat.turn.started", &json!({})).unwrap();
        let before = db.session_by_id("s").unwrap().unwrap();
        let revision = db.snapshot().unwrap().revision;
        record(&db, "s", Some("parent"), "chat.subagent.item", &json!({"key":"child","usage":{"inputTokens":12,"outputTokens":34},"item":{"id":"message","role":"assistant","parts":[{"type":"text","text":"\nWorking\nMore"}]}})).unwrap();
        let info = subagent_info(&db);
        assert_eq!(info["status"], "running");
        assert_eq!(info["transcript"], "live");
        assert_eq!(info["itemCount"], 1);
        assert_eq!(info["toolCount"], 0);
        assert_eq!(info["lastActivity"], "Working");
        assert_eq!(info["rev"], 1);
        let after = db.session_by_id("s").unwrap().unwrap();
        assert_eq!(before.status, after.status);
        assert_eq!(before.updated_at, after.updated_at);
        assert_eq!(before.activity, after.activity);
        let events = db.events_after(revision).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "chat.item");
        assert!(db.snapshot().unwrap().inbox.is_empty());
        assert_eq!(
            db.transaction(|tx| Ok(tx.query_row(
                "SELECT COUNT(*) FROM usage_records",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
            0
        );
        let revision = db.snapshot().unwrap().revision;
        record(
            &db,
            "s",
            Some("other"),
            "chat.subagent",
            &json!({"key":"child","usage":{"inputTokens":99},"info":{"status":"failed"}}),
        )
        .unwrap();
        assert_eq!(db.events_after(revision).unwrap().len(), 1);
        assert_eq!(
            db.session_by_id("s").unwrap().unwrap().activity,
            before.activity
        );
    }

    #[test]
    fn subagent_tool_results_merge_and_counts_follow_newest_inserted_item() {
        let db = db();
        for item in [
            json!({"id":"tool-row","role":"tool","parts":[{"type":"tool","toolId":"tool-1","toolName":"Bash","status":"running","data":{"input":{"command":"rg needle"}}}]}),
            json!({"id":"newest","role":"assistant","parts":[{"type":"text","text":"Newest activity"}]}),
        ] {
            record(
                &db,
                "s",
                Some("first"),
                "chat.subagent.item",
                &json!({"key":"child","item":item}),
            )
            .unwrap();
        }
        record(&db, "s", Some("later"), "chat.subagent.item", &json!({"key":"child","merge":true,"item":{"id":"tool-row","role":"tool","parts":[{"type":"tool","toolId":"tool-1","status":"complete","data":{"output":"done"}}]}})).unwrap();
        let info = subagent_info(&db);
        assert_eq!(info["itemCount"], 2);
        assert_eq!(info["toolCount"], 1);
        assert_eq!(info["rev"], 3);
        assert_eq!(info["lastActivity"], "Newest activity");
        let (items, rev, truncated) = db.subagent_items_after("s", "child", 2).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "tool-row");
        assert_eq!(items[0].parts.len(), 1);
        assert_eq!(items[0].parts[0]["toolName"], "Bash");
        assert_eq!(items[0].parts[0]["status"], "complete");
        assert_eq!(rev, 3);
        assert!(!truncated);
        assert_eq!(
            db.subagent_card("s", "child")
                .unwrap()
                .unwrap()
                .turn_id
                .as_deref(),
            Some("first")
        );
        record(&db, "s", None, "chat.subagent.item", &json!({"key":"child","item":{"id":"tool-row","role":"assistant","parts":[{"type":"thinking"}]}})).unwrap();
        assert_eq!(subagent_info(&db)["toolCount"], 0);
        assert_eq!(
            db.subagent_items_after("s", "child", 0).unwrap().0[0].parts,
            vec![json!({"type":"thinking"})]
        );
    }

    #[test]
    fn subagent_transcript_cap_drops_lowest_seq_and_retains_truncation() {
        let db = db();
        for index in 0..501 {
            record(&db, "s", Some("turn"), "chat.subagent.item", &json!({"key":"child","item":{"id":format!("item-{index}"),"role":"assistant","parts":[{"type":"text","text":format!("step-{index}")} ]}})).unwrap();
        }
        let (items, rev, truncated) = db.subagent_items_after("s", "child", 0).unwrap();
        assert_eq!(items.len(), 500);
        assert_eq!(items[0].id, "item-1");
        assert_eq!(items[499].id, "item-500");
        assert_eq!(rev, 501);
        assert!(truncated);
        let info = subagent_info(&db);
        assert_eq!(info["itemCount"], 500);
        assert_eq!(info["lastActivity"], "step-500");
        assert_eq!(info["truncated"], true);
        record(
            &db,
            "s",
            None,
            "chat.subagent",
            &json!({"key":"child","info":{"status":"completed"}}),
        )
        .unwrap();
        assert!(db.subagent_items_after("s", "child", 501).unwrap().2);
        assert!(db
            .subagent_items_after("s", "child", 501)
            .unwrap()
            .0
            .is_empty());
    }

    #[test]
    fn subagent_strings_and_part_count_are_bounded() {
        let db = db();
        let mut ascii = json!({"output":"x".repeat(20 * 1024)});
        crate::db::bound_json(&mut ascii);
        assert_eq!(ascii["output"].as_str().unwrap().len(), 16 * 1024);
        assert!(ascii["output"].as_str().unwrap().ends_with("…[truncated]"));
        let long = "界".repeat(20 * 1024);
        record(&db, "s", None, "chat.subagent", &json!({"key":"child","info":{"description":long,"prompt":long,"summary":long,"lastActivity":long}})).unwrap();
        for (field, limit) in [
            ("description", 300),
            ("prompt", 4000),
            ("summary", 8000),
            ("lastActivity", 200),
        ] {
            let info = subagent_info(&db);
            let text = info[field].as_str().unwrap();
            assert!(text.chars().count() <= limit);
            assert!(text.len() <= 16 * 1024);
            assert!(text.ends_with("…[truncated]"));
        }
        let parts = vec![json!({"type":"tool","data":{"nested":[{"output":long}]}}); 65];
        record(
            &db,
            "s",
            None,
            "chat.subagent.item",
            &json!({"key":"child","item":{"id":"bounded","role":"tool","parts":parts}}),
        )
        .unwrap();
        let items = db.subagent_items_after("s", "child", 0).unwrap().0;
        assert_eq!(items[0].parts.len(), 64);
        let text = items[0].parts[0]["data"]["nested"][0]["output"]
            .as_str()
            .unwrap();
        assert!(text.len() <= 16 * 1024);
        assert!(text.ends_with("…[truncated]"));
    }

    #[test]
    fn subagent_activity_labels_cover_command_path_text_and_thinking() {
        for (part, expected) in [
            (
                json!({"type":"tool","toolName":"Bash","data":{"command":"cargo check"}}),
                "cargo check",
            ),
            (
                json!({"type":"tool","data":{"rawInput":{"command":"ls"}}}),
                "ls",
            ),
            (
                json!({"type":"tool","data":{"input":{"file_path":"src/lib.rs"}}}),
                "src/lib.rs",
            ),
            (
                json!({"type":"tool","toolName":"Read","data":{"title":"fallback"}}),
                "Read",
            ),
            (
                json!({"type":"tool","data":{"title":"fallback"}}),
                "fallback",
            ),
            (
                json!({"type":"text","text":"\n \nFirst line\nSecond line"}),
                "First line",
            ),
            (
                json!({"type":"thinking","text":"private reasoning"}),
                "Thinking",
            ),
        ] {
            let item = ChatItem {
                id: "i".into(),
                role: "assistant".into(),
                parts: vec![part],
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
            assert_eq!(subagent_activity_label(&item), expected);
        }
    }

    #[test]
    fn approval_resolution_keeps_sibling_waiting_and_ignores_late_unknown_replies() {
        for provider in crate::providers::Providers::new().registered_ids() {
            let root = tempfile::tempdir().unwrap();
            let db = Database::open(&root.path().join("approvals.sqlite")).unwrap();
            db.transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('s','test',?,'chat','running','now','now')", [provider.as_str()])?;
                Ok(())
            }).unwrap();
            for id in ["one", "two"] {
                record(
                    &db,
                    "s",
                    Some("turn"),
                    "chat.approval",
                    &json!({"approvalId":id}),
                )
                .unwrap();
            }
            record(
                &db,
                "s",
                Some("turn"),
                "chat.approval.resolved",
                &json!({"approvalId":"one"}),
            )
            .unwrap();
            assert_eq!(
                db.session_by_id("s").unwrap().unwrap().status,
                "waiting",
                "{provider}: sibling still pending"
            );
            record(
                &db,
                "s",
                Some("turn"),
                "chat.approval.resolved",
                &json!({"approvalId":"two"}),
            )
            .unwrap();
            assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "running");
            record(&db, "s", Some("turn"), "chat.turn.completed", &json!({})).unwrap();
            for id in ["one", "missing"] {
                record(
                    &db,
                    "s",
                    Some("turn"),
                    "chat.approval.resolved",
                    &json!({"approvalId":id}),
                )
                .unwrap();
                assert_eq!(
                    db.session_by_id("s").unwrap().unwrap().status,
                    "idle",
                    "{provider}: late/unknown resolution"
                );
            }
        }
    }
    use tempfile::tempdir;
    fn db() -> Database {
        let dir = tempdir().unwrap();
        let path = dir.keep().join("usage.sqlite");
        let db = Database::open(&path).unwrap();
        db.transaction(|tx| { tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('s','test','codex','chat','idle','now','now')",[])?; Ok(()) }).unwrap();
        db
    }
    #[test]
    fn native_title_updates_only_sessions_without_explicit_title_provenance() {
        let db = db();
        record(&db, "s", None, "chat.title", &json!({"title":"Ignored native title"})).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().title, "test", "legacy named chats remain user-owned without an operation request");
        db.transaction(|tx| { tx.execute("UPDATE sessions SET title='codex' WHERE id='s'", [])?; Ok(()) }).unwrap();
        record(&db, "s", None, "chat.title", &json!({"title":"Native title"})).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().title, "Native title");
        record(&db, "s", None, "chat.title", &json!({"title":"Later native title"})).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().title, "Native title", "a native title only replaces the untouched default once");
        db.transaction(|tx| { tx.execute("UPDATE sessions SET title='codex' WHERE id='s'", [])?; Ok(()) }).unwrap();
        db.bind_operation("rename-default", "session.update", &json!({"sessionId":"s","title":"codex","operationId":"rename-default"})).unwrap();
        record(&db, "s", None, "chat.title", &json!({"title":"New native title"})).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().title, "codex", "a manual rename back to the default spelling remains user-owned");
    }
    #[test]
    fn speed_projection_persists_final_usage_and_keeps_native_exact_counts() {
        let db=db();
        let _speeds=crate::turn_speed::shared(db.path());
        record(&db,"s",Some("turn"),"chat.turn.started",&json!({})).unwrap();
        record(&db,"s",Some("turn"),"chat.delta",&json!({"text":"中文 reasoning"})).unwrap();
        record(&db,"s",Some("turn"),"chat.turn.completed",&json!({"turnUsage":{"outputTokens":50,"inputTokens":80},"status":"interrupted"})).unwrap();
        let items=db.chat_items("s").unwrap();
        let usage=items.iter().find_map(|item|item.turn_usage.as_ref()).unwrap();
        assert_eq!(usage["outputTokens"],50);
        assert_eq!(usage["outputTokensEstimated"],false);
        assert_eq!(usage["inputTokens"],80);
        assert!(usage["generationMs"].is_number() && usage["firstTokenMs"].is_number());
        assert_eq!(items.iter().find(|item|item.turn_usage.is_some()).unwrap().turn_status,Some(crate::domain::NativeTurnStatus::Interrupted));
        record(&db,"s",Some("turn"),"chat.context",&json!({"usage":{},"turnUsage":{"outputTokens":5,"outputTokensEstimated":true}})).unwrap();
        assert_eq!(db.chat_items("s").unwrap().iter().find_map(|item|item.turn_usage.as_ref()).unwrap()["outputTokens"],50);
    }
    #[test]
    fn speed_projection_estimates_without_context_and_creates_nothing_before_output() {
        let db=db();let _speeds=crate::turn_speed::shared(db.path());
        record(&db,"s",Some("empty"),"chat.turn.started",&json!({})).unwrap();
        record(&db,"s",Some("empty"),"chat.turn.completed",&json!({"status":"cancelled"})).unwrap();
        assert!(db.chat_items("s").unwrap().iter().all(|item|item.turn_usage.is_none()));
        record(&db,"s",Some("acp"),"chat.turn.started",&json!({})).unwrap();
        record(&db,"s",Some("acp"),"chat.delta",&json!({"part":{"type":"thinking","text":"中文abcd"}})).unwrap();
        record(&db,"s",Some("acp"),"chat.error",&json!({"message":"interrupted"})).unwrap();
        let items=db.chat_items("s").unwrap();
        let usage=items.iter().find_map(|item|item.turn_usage.as_ref()).unwrap();
        assert_eq!(usage["outputTokens"],3);assert_eq!(usage["outputTokensEstimated"],true);
        assert!(usage["generationMs"].is_number());
    }
    #[test]
    fn speed_projection_accumulates_calls_and_does_not_write_live_updates() {
        let db=db();let speeds=crate::turn_speed::shared(db.path());let mut live=speeds.subscribe();
        record(&db,"s",Some("turn"),"chat.turn.started",&json!({})).unwrap();
        record(&db,"s",Some("turn"),"chat.delta",&json!({"text":"a"})).unwrap();
        let before=db.events_after(0).unwrap().len();
        for id in ["a","b"] {record(&db,"s",Some("turn"),"chat.speed.usage",&json!({"callId":id,"outputTokens":20})).unwrap();}
        assert_eq!(db.events_after(0).unwrap().len(),before);
        record(&db,"s",Some("turn"),"chat.context",&json!({"usage":{},"turnUsage":{"outputTokens":20}})).unwrap();
        assert!(db.chat_items("s").unwrap().iter().all(|item|item.turn_usage.is_none()));
        record(&db,"s",Some("turn"),"chat.turn.completed",&json!({})).unwrap();
        assert_eq!(db.chat_items("s").unwrap().iter().find_map(|item|item.turn_usage.as_ref()).unwrap()["outputTokens"],40);
        let events=std::iter::from_fn(||live.try_recv().ok()).collect::<Vec<_>>();assert_eq!(events.last().unwrap()["active"],false);
    }
    #[test]
    fn speed_projection_disconnect_saves_usage_without_manufacturing_a_completion() {
        let db=db();let _speeds=crate::turn_speed::shared(db.path());
        record(&db,"s",Some("turn"),"chat.turn.started",&json!({})).unwrap();
        record(&db,"s",Some("turn"),"chat.delta",&json!({"text":"abcd"})).unwrap();
        let before=db.session_by_id("s").unwrap().unwrap().status;
        record(&db,"s",None,"chat.connection",&json!({"phase":"disconnected"})).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status,before);
        let items=db.chat_items("s").unwrap();let item=items.iter().find(|item|item.turn_usage.is_some()).unwrap();
        assert_eq!(item.turn_usage.as_ref().unwrap()["outputTokens"],1);
        assert!(item.turn_usage.as_ref().unwrap()["generationMs"].is_number());
        assert!(item.turn_status.is_none());
    }
    fn usage(_turn: &str, input: Option<u64>, output: Option<u64>, model: Option<&str>) -> Value {
        let mut u = json!({});
        if let Some(v) = input {
            u["inputTokens"] = json!(v)
        }
        if let Some(v) = output {
            u["outputTokens"] = json!(v)
        }
        if let Some(v) = model {
            u["model"] = json!(v)
        }
        json!({"usage":u})
    }
    #[test]
    fn usage_projection_preserves_model_and_replaces_same_turn() {
        let db = db();
        record(
            &db,
            "s",
            Some("one"),
            "chat.turn.completed",
            &usage("one", Some(2), Some(3), Some("gpt-x")),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("one"),
            "chat.turn.completed",
            &usage("one", Some(7), Some(11), Some("gpt-x")),
        )
        .unwrap();
        let row = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT input_tokens,output_tokens,model FROM usage_records",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, Option<i64>>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )?)
            })
            .unwrap();
        assert_eq!(row, (Some(7), Some(11), Some("gpt-x".into())));
        let counts = db
            .transaction(|tx| {
                Ok((
                    tx.query_row("SELECT COUNT(*) FROM inbox WHERE kind='reply'", [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                    tx.query_row("SELECT COUNT(*) FROM usage_records", [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                    tx.query_row(
                        "SELECT COUNT(*) FROM outbox WHERE event='inbox.created'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(counts, (1, 1, 1));
        let unread: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM inbox WHERE kind='reply' AND read=0",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(unread, 0);
    }
    #[test]
    fn completed_turns_do_not_fill_the_actionable_inbox() {
        let db = db();
        record(&db, "s", Some("turn-a"), "chat.turn.completed", &json!({})).unwrap();
        record(&db, "s", Some("turn-b"), "chat.turn.completed", &json!({})).unwrap();
        let snapshot = db.snapshot().unwrap();
        assert!(snapshot
            .inbox
            .iter()
            .all(|item| item.get("kind").and_then(Value::as_str) != Some("reply")));
    }
    #[test]
    fn activity_tracks_pending_completion_and_rejects_late_turns() {
        let db = db();
        record(
            &db,
            "s",
            Some("one"),
            "message.user",
            &json!({"text":"one"}),
        )
        .unwrap();
        record(&db, "s", Some("one"), "chat.turn.started", &json!({})).unwrap();
        record(&db, "s", Some("one"), "chat.turn.completed", &json!({})).unwrap();
        let pending = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        assert_eq!(pending.state, "awaiting_input");
        assert_eq!(pending.turn_id.as_deref(), Some("one"));

        // A delayed old worker event cannot replace a completion that the
        // renderer still needs to acknowledge.
        record(&db, "s", Some("old"), "chat.turn.started", &json!({})).unwrap();
        assert_eq!(
            db.session_by_id("s").unwrap().unwrap().activity.unwrap(),
            pending
        );
        record(
            &db,
            "s",
            Some("two"),
            "message.user",
            &json!({"text":"two"}),
        )
        .unwrap();
        assert_eq!(
            db.session_by_id("s")
                .unwrap()
                .unwrap()
                .activity
                .unwrap()
                .state,
            "running"
        );
    }
    #[test]
    fn resumed_pending_approval_is_admitted_from_idle_but_not_after_completion() {
        let db = db();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO session_activity(session_id,state,revision) VALUES ('s','idle',1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        record(
            &db,
            "s",
            Some("resume"),
            "chat.approval",
            &json!({"approvalId":"resume-card"}),
        )
        .unwrap();
        assert_eq!(
            db.session_by_id("s")
                .unwrap()
                .unwrap()
                .activity
                .unwrap()
                .state,
            "awaiting_approval"
        );
        record(
            &db,
            "s",
            Some("resume"),
            "chat.approval.resolved",
            &json!({"approvalId":"resume-card"}),
        )
        .unwrap();
        record(&db, "s", Some("resume"), "chat.turn.completed", &json!({})).unwrap();
        let completed = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        record(
            &db,
            "s",
            Some("late"),
            "chat.approval",
            &json!({"approvalId":"late-card"}),
        )
        .unwrap();
        assert_eq!(
            db.session_by_id("s").unwrap().unwrap().activity.unwrap(),
            completed
        );
    }
    #[test]
    fn late_provider_status_cannot_resurrect_terminal_sessions() {
        for terminal in ["exited", "interrupted"] {
            let db = db();
            db.set_session_status("s", terminal, None).unwrap();
            record(
                &db,
                "s",
                Some("late-turn"),
                "chat.turn.completed",
                &json!({"elapsedMs":12}),
            )
            .unwrap();
            record(
                &db,
                "s",
                Some("late-turn"),
                "chat.error",
                &json!({"message":"worker closed after stop"}),
            )
            .unwrap();
            assert_eq!(db.session_by_id("s").unwrap().unwrap().status, terminal);
            assert!(db.chat_items("s").unwrap().iter().any(|item| item
                .parts
                .iter()
                .any(|part| part.get("type").and_then(Value::as_str) == Some("error"))));
        }
    }
    #[test]
    fn reply_attention_event_includes_session_identity() {
        let db = db();
        record(&db, "s", Some("turn-1"), "chat.turn.completed", &json!({})).unwrap();
        let payload = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT data FROM outbox WHERE event='inbox.created'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["kind"], "reply");
        assert_eq!(value["title"], "test");
        assert_eq!(value["provider"], "codex");
    }
    #[test]
    fn thinking_deltas_stay_separate_from_answer_text() {
        let db = db();
        record(
            &db,
            "s",
            Some("turn-2"),
            "chat.delta",
            &json!({"part":{"type":"thinking","text":"plan "}}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("turn-2"),
            "chat.delta",
            &json!({"part":{"type":"thinking","text":"step"}}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("turn-2"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"hello"}}),
        )
        .unwrap();
        record(&db, "s", Some("turn-2"), "chat.turn.completed", &json!({})).unwrap();
        let item = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT data FROM chat_items WHERE id='s:assistant:turn-2'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        let value: Value = serde_json::from_str(&item).unwrap();
        assert_eq!(value["parts"][0]["type"], "thinking");
        assert_eq!(value["parts"][0]["text"], "plan step");
        assert_eq!(value["parts"][0]["status"], "complete");
        assert_eq!(value["parts"][1]["type"], "text");
        assert_eq!(value["parts"][1]["text"], "hello");
        assert_eq!(value["parts"][1]["status"], "complete");
    }
    #[test]
    fn a_new_user_message_completes_prior_streaming_parts() {
        let db = db();
        record(
            &db,
            "s",
            Some("turn-a"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"old"}}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("turn-b"),
            "message.user",
            &json!({"text":"next"}),
        )
        .unwrap();
        let assistant = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT data FROM chat_items WHERE id='s:assistant:turn-a'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        let value: Value = serde_json::from_str(&assistant).unwrap();
        assert_eq!(value["parts"][0]["status"], "complete");
    }
    #[test]
    fn a_steered_user_message_keeps_the_running_turn_and_retracts_when_rejected() {
        let db = db();
        record(&db, "s", Some("turn-a"), "message.user", &json!({"text":"start"})).unwrap();
        record(
            &db,
            "s",
            Some("turn-a"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"old"}}),
        )
        .unwrap();
        let before: Value = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT state,revision,turn_id FROM session_activity WHERE session_id='s'",
                    [],
                    |row| Ok(json!({"state":row.get::<_,String>(0)?,"revision":row.get::<_,i64>(1)?,"turnId":row.get::<_,Option<String>>(2)?})),
                )?)
            })
            .unwrap();
        record(
            &db,
            "s",
            Some("turn-a"),
            "message.user",
            &json!({"text":"while you work","steered":true,"turnId":"turn-a","item":{"id":"steer:op-1"}}),
        )
        .unwrap();
        let assistant: Value = db
            .transaction(|tx| {
                Ok(serde_json::from_str(&tx.query_row(
                    "SELECT data FROM chat_items WHERE id='s:assistant:turn-a'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)?)
            })
            .unwrap();
        assert_eq!(assistant["parts"][0]["status"], "streaming");
        let steered: Value = db
            .transaction(|tx| {
                Ok(serde_json::from_str(&tx.query_row(
                    "SELECT data FROM chat_items WHERE id='s:user:steer:op-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)?)
            })
            .unwrap();
        assert_eq!(steered["turnId"], "turn-a");
        assert_eq!(steered["role"], "user");
        assert_eq!(steered["parts"][0]["data"]["steered"], true);
        let original: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM chat_items WHERE id='s:user:turn-a'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(original, 1);
        let after: Value = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT state,revision,turn_id FROM session_activity WHERE session_id='s'",
                    [],
                    |row| Ok(json!({"state":row.get::<_,String>(0)?,"revision":row.get::<_,i64>(1)?,"turnId":row.get::<_,Option<String>>(2)?})),
                )?)
            })
            .unwrap();
        assert_eq!(after, before);
        retract_steered_message(&db, "s", "op-1").unwrap();
        let gone: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM chat_items WHERE id='s:user:steer:op-1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(gone, 0);
    }
    #[test]
    fn a_carry_turn_claims_running_from_a_settled_previous_turn() {
        let db = db();
        record(&db, "s", Some("one"), "message.user", &json!({"text":"one"})).unwrap();
        record(&db, "s", Some("one"), "chat.turn.started", &json!({})).unwrap();
        record(&db, "s", Some("one"), "chat.turn.completed", &json!({})).unwrap();
        let settled = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        assert_eq!(settled.state, "awaiting_input");
        // The carry turn has no message.user of its own, so its start claims
        // running from the settled previous turn.
        record(&db, "s", Some("carry:op-1"), "chat.turn.started", &json!({})).unwrap();
        let carrying = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        assert_eq!(carrying.state, "running");
        assert_eq!(carrying.turn_id.as_deref(), Some("carry:op-1"));
        // An ordinary delayed start still cannot revive a completed turn.
        record(&db, "s", Some("carry:op-1"), "chat.turn.completed", &json!({})).unwrap();
        record(&db, "s", Some("old"), "chat.turn.started", &json!({})).unwrap();
        let done = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        assert_eq!(done.state, "awaiting_input");
        assert_eq!(done.turn_id.as_deref(), Some("carry:op-1"));
    }
    #[test]
    fn a_carry_turn_rehomes_its_steered_row() {
        let db = db();
        record(&db, "s", Some("turn-a"), "message.user", &json!({"text":"start"})).unwrap();
        record(
            &db,
            "s",
            Some("turn-a"),
            "message.user",
            &json!({"text":"while you work","steered":true,"turnId":"turn-a","item":{"id":"steer:op-1"}}),
        )
        .unwrap();
        let revision = db.snapshot().unwrap().revision;
        record(&db, "s", Some("carry:op-1"), "chat.turn.started", &json!({})).unwrap();
        let steered: Value = db
            .transaction(|tx| {
                Ok(serde_json::from_str(&tx.query_row(
                    "SELECT data FROM chat_items WHERE id='s:user:steer:op-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)?)
            })
            .unwrap();
        assert_eq!(steered["turnId"], "carry:op-1");
        assert_eq!(steered["parts"][0]["data"]["turnId"], "carry:op-1");
        assert_eq!(steered["parts"][0]["data"]["steered"], true);
        // The renderer learns about the move through an ordinary chat.item event.
        let events = db.events_after(revision).unwrap();
        assert!(events.iter().any(|event| {
            event.1 == "chat.item"
                && event.2["item"]["id"] == "s:user:steer:op-1"
                && event.2["item"]["turnId"] == "carry:op-1"
        }));
    }
    #[test]
    fn usage_projection_keeps_distinct_turns_and_unknowns_null() {
        let db = db();
        record(
            &db,
            "s",
            Some("one"),
            "chat.turn.completed",
            &usage("one", Some(1), None, None),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("two"),
            "chat.turn.completed",
            &usage("two", None, Some(4), None),
        )
        .unwrap();
        let rows = db
            .transaction(|tx| {
                let mut q = tx.prepare(
                    "SELECT input_tokens,output_tokens,model FROM usage_records ORDER BY id",
                )?;
                let rows = q
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, Option<i64>>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(rows, vec![(Some(1), None, None), (None, Some(4), None)]);
    }
    #[test]
    fn chat_ui_reaches_the_outbox_without_creating_transcript_rows() {
        let db = db();
        record(
            &db,
            "s",
            None,
            "chat.ui",
            &json!({"options":[{"id":"model","name":"Model","value":"gpt-5.5-luna","choices":[]}],"commands":[{"name":"compact"}],"inputCapabilities":{"images":true},"loadState":"loading","error":{"code":"options_loading","message":"Loading options"}}),
        )
        .unwrap();
        let payload = db
            .transaction(|tx| {
                Ok(
                    tx.query_row("SELECT data FROM outbox WHERE event='chat.ui'", [], |row| {
                        row.get::<_, String>(0)
                    })?,
                )
            })
            .unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["options"][0]["value"], "gpt-5.5-luna");
        assert_eq!(value["commands"][0]["name"], "compact");
        assert_eq!(value["inputCapabilities"]["images"], true);
        assert_eq!(value["loadState"], "loading");
        assert_eq!(value["error"]["code"], "options_loading");
        let items: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT COUNT(*) FROM chat_items", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(items, 0);
    }
    #[test]
    fn chat_context_persists_the_latest_value_and_emits_no_transcript_row() {
        let db = db();
        record(
            &db,
            "s",
            Some("turn-1"),
            "chat.context",
            &json!({"usage":{"usedTokens":94700,"windowTokens":258000,"percent":36.7,"inputTokens":90000}}),
        )
        .unwrap();
        assert_eq!(db.chat_context("s").unwrap().unwrap()["usedTokens"], 94700);
        let payload = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT data FROM outbox WHERE event='chat.context' ORDER BY seq DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["usage"]["windowTokens"], 258000);
        assert_eq!(value["usage"]["inputTokens"], 90000);
        let stored = db.chat_context("s").unwrap().unwrap();
        let timestamp = stored["updatedAt"].as_str().expect("snapshot has a timestamp");
        chrono::DateTime::parse_from_rfc3339(timestamp).unwrap();
        assert_eq!(value["usage"]["updatedAt"], stored["updatedAt"]);
        let (billing, recorded_at): (i64, String) = db.transaction(|tx| {
            Ok((tx.query_row("SELECT COUNT(*) FROM usage_records", [], |r| r.get(0))?,
                tx.query_row("SELECT updated_at FROM chat_context WHERE session_id='s'", [], |r| r.get(0))?))
        }).unwrap();
        assert_eq!(billing, 0, "cumulative context counters are not billing usage");
        assert_eq!(recorded_at, timestamp);
        let items: i64 = db
            .transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM chat_items", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(items, 0, "a context snapshot never creates a transcript row");

        // A later snapshot replaces the stored value in place.
        record(&db, "s", Some("turn-2"), "chat.context", &json!({"usage":{"usedTokens":5}})).unwrap();
        assert_eq!(db.chat_context("s").unwrap().unwrap()["usedTokens"], 5);
        let rows: i64 = db
            .transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM chat_context", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(rows, 1, "one row per session keeps the latest value");
    }
    #[test]
    fn context_snapshots_leave_existing_billing_records_unchanged() {
        let db = db();
        record(&db, "s", None, "chat.turn.completed", &json!({"usage":{"inputTokens":11,"outputTokens":7}})).unwrap();
        let billing = || db.transaction(|tx| {
            Ok(tx.query_row("SELECT id,recorded_at,input_tokens,output_tokens FROM usage_records", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
            })?)
        }).unwrap();
        let before = billing();
        for total in [100, 200] {
            record(&db, "s", None, "chat.context", &json!({"usage":{"inputTokens":total,"outputTokens":total}})).unwrap();
        }
        assert_eq!(billing(), before);
    }
    #[test]
    fn chat_context_ignores_a_missing_or_malformed_usage_object() {
        let db = db();
        record(&db, "s", None, "chat.context", &json!({})).unwrap();
        record(&db, "s", None, "chat.context", &json!({"usage":"bad"})).unwrap();
        assert!(db.chat_context("s").unwrap().is_none());
        let events: i64 = db
            .transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox WHERE event='chat.context'", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(events, 0);
    }
    #[test]
    fn turn_footer_metadata_is_frozen_from_start_and_context_events() {
        let db = db();
        record(&db, "s", None, "chat.ui", &json!({"options":[{"id":"model","value":"gpt-test","choices":[]}]})).unwrap();
        record(&db, "s", Some("turn"), "chat.turn.started", &json!({})).unwrap();
        record(&db, "s", None, "chat.ui", &json!({"options":[{"id":"model","value":"gpt-later","choices":[]}]})).unwrap();
        record(&db, "s", Some("turn"), "chat.turn.started", &json!({"model":"gpt-later"})).unwrap();
        record(&db, "s", Some("turn"), "chat.context", &json!({"usage":{"usedTokens":99},"turnUsage":{"inputTokens":12,"outputTokens":3,"totalTokens":15,"sessionTotal":999}})).unwrap();
        let item = db.chat_items("s").unwrap().into_iter().find(|item| item.id == "s:assistant:turn").unwrap();
        assert_eq!(item.turn_model.as_deref(), Some("gpt-test"));
        assert_eq!(item.turn_usage.as_ref().unwrap()["totalTokens"], 15);
        assert!(item.turn_usage.as_ref().unwrap().get("sessionTotal").is_none());
        let legacy: ChatItem = serde_json::from_value(json!({"id":"old","role":"assistant","parts":[],"createdAt":"now"})).unwrap();
        assert!(legacy.turn_model.is_none() && legacy.turn_usage.is_none() && legacy.turn_review.is_none());
    }
    #[test]
    fn a_context_event_names_the_turn_model_only_when_none_is_frozen() {
        let late = db();
        record(&late, "s", Some("turn"), "chat.turn.started", &json!({})).unwrap();
        record(&late, "s", Some("turn"), "chat.context", &json!({"usage":{"usedTokens":9},"model":"anthropic/claude-x"})).unwrap();
        record(&late, "s", Some("turn"), "chat.context", &json!({"usage":{"usedTokens":9},"model":"other"})).unwrap();
        let item = late.chat_items("s").unwrap().into_iter().find(|item| item.id == "s:assistant:turn").unwrap();
        assert_eq!(item.turn_model.as_deref(), Some("anthropic/claude-x"));
    }
    #[test]
    fn turn_review_attaches_to_assistant_when_a_later_user_item_exists() {
        let db = db();
        record(&db, "s", Some("turn"), "chat.item", &json!({"item":{"id":"assistant"},"parts":[{"type":"text","text":"answer"}]})).unwrap();
        record(&db, "s", Some("turn"), "message.user", &json!({"text":"follow-up"})).unwrap();
        let review = crate::domain::ChatTurnReview { from: "before".into(), to: "after".into(), file_count: 3 };
        attach_turn_review(&db, "s", "turn", review.clone()).unwrap();
        let items = db.chat_items("s").unwrap();
        assert_eq!(items.iter().find(|item| item.role == "assistant").unwrap().turn_review.as_ref(), Some(&review));
        assert!(items.iter().find(|item| item.role == "user").unwrap().turn_review.is_none());
    }
    #[test]
    fn chat_ui_defaults_missing_input_capabilities_to_an_empty_object() {
        let db = db();
        record(&db, "s", None, "chat.ui", &json!({})).unwrap();
        let payload = db.transaction(|tx| {
            Ok(tx.query_row("SELECT data FROM outbox WHERE event='chat.ui'", [], |row| row.get::<_, String>(0))?)
        }).unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["inputCapabilities"], json!({}));
        assert_eq!(value["options"], json!([]));
        assert_eq!(value["commands"], json!([]));
        assert_eq!(value["loadState"], "empty");
    }
    #[test]
    fn provider_user_messages_do_not_duplicate_the_local_user_turn() {
        let db = db();
        record(
            &db,
            "s",
            Some("op-1"),
            "message.user",
            &json!({"text":"hello"}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("op-1"),
            "chat.item",
            &json!({"raw":{"params":{"item":{"id":"u1","type":"userMessage","text":"hello"}}}}),
        )
        .unwrap();
        let items = db.chat_items("s").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].role, "user");
    }
    #[test]
    fn turn_completion_stamps_elapsed_ms_only_when_supplied() {
        let db = db();
        record(
            &db,
            "s",
            Some("timed"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"reply"}}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("timed"),
            "chat.turn.completed",
            &json!({"elapsedMs":4200u64}),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("untimed"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"reply"}}),
        )
        .unwrap();
        record(&db, "s", Some("untimed"), "chat.turn.completed", &json!({})).unwrap();
        let items = db.chat_items("s").unwrap();
        let timed = items
            .iter()
            .find(|item| item.id == "s:assistant:timed")
            .unwrap();
        assert_eq!(timed.elapsed_ms, Some(4200));
        let untimed = items
            .iter()
            .find(|item| item.id == "s:assistant:untimed")
            .unwrap();
        assert_eq!(untimed.elapsed_ms, None);
    }

    #[test]
    fn native_plan_markdown_is_transcript_text_instead_of_a_tool() {
        let db = db();
        record(&db, "s", Some("plan-turn"), "chat.item", &json!({"item":{"id":"native-plan","type":"plan","text":"# Plan\n1. Build"}})).unwrap();
        let items = db.chat_items("s").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts[0]["type"], "text");
        assert_eq!(items[0].parts[0]["text"], "# Plan\n1. Build");
    }

    #[test]
    fn native_codex_text_phase_is_preserved_without_classifying_unphased_text() {
        let db = db();
        for (id, phase) in [("progress",Some("commentary")),("answer",Some("final_answer")),("plain",None)] {
            let mut raw = json!({"id":id,"type":"agentMessage","text":id});
            if let Some(phase) = phase { raw["phase"] = json!(phase); }
            record(&db,"s",Some("turn"),"chat.item",&json!({"raw":{"params":{"item":raw}}})).unwrap();
        }
        let items = db.chat_items("s").unwrap();
        for (id, phase) in [("progress",Some("commentary")),("answer",Some("final_answer")),("plain",None)] {
            let item = items.iter().find(|item| item.id == format!("s:assistant:{id}")).unwrap();
            assert_eq!(item.parts[0]["phase"].as_str(), phase);
            assert_eq!(item.parts[0]["text"], id);
        }
    }

    #[test]
    fn timed_native_item_is_enriched_without_creating_a_blank_turn_item() {
        let db = db();
        record(
            &db,
            "s",
            Some("turn-native"),
            "chat.item",
            &json!({
                "raw": {
                    "params": {
                        "item": {"id":"agent-native","type":"agentMessage","text":"reply"}
                    }
                }
            }),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("turn-native"),
            "chat.turn.completed",
            &json!({"elapsedMs":4200u64,"item":{"id":"agent-native"}}),
        )
        .unwrap();
        let items = db.chat_items("s").unwrap();
        let native = items
            .iter()
            .find(|item| item.id == "s:assistant:agent-native")
            .unwrap();
        assert_eq!(native.elapsed_ms, Some(4200));
        assert!(!items
            .iter()
            .any(|item| item.id == "s:assistant:turn-native"));
    }
    #[test]
    fn merged_tool_parts_update_in_place() {
        let db = db();
        record(
            &db,
            "s",
            Some("t"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"hi"}}),
        )
        .unwrap();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"tool","toolId":"call-1","toolName":"list_dir","status":"running"}})).unwrap();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"tool","toolId":"call-1","toolName":"List Files","status":"complete","text":"a.txt"}})).unwrap();
        let item = db
            .chat_items("s")
            .unwrap()
            .into_iter()
            .find(|item| item.role == "assistant")
            .unwrap();
        assert_eq!(item.parts.len(), 2);
        assert_eq!(item.parts[0]["type"], "text");
        assert_eq!(item.parts[1]["toolName"], "List Files");
        assert_eq!(item.parts[1]["status"], "complete");
        assert_eq!(item.parts[1]["text"], "a.txt");
    }
    #[test]
    fn runtime_plan_feedback_is_idle_and_receipts_survive_late_resolution() {
        let db = db();
        record(&db, "s", Some("plan-turn"), "message.user", &json!({"text":"Plan"})).unwrap();
        record(&db, "s", Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
        let pending = json!({"approvalId":"plan:plan-turn","part":{"data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan","submittable":true,"choices":[]}}});
        record(&db, "s", Some("plan-turn"), "chat.approval", &pending).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().activity.unwrap().state, "awaiting_approval");
        let mut waiting = pending.clone();
        waiting["part"]["data"]["waitingForPrompt"] = json!(true);
        record(&db, "s", Some("plan-turn"), "chat.approval", &waiting).unwrap();
        let session = db.session_by_id("s").unwrap().unwrap();
        assert_eq!(session.status, "idle");
        assert_eq!(session.activity.unwrap().state, "awaiting_input");
        record(&db, "s", Some("next-turn"), "message.user", &json!({"text":"Add tests"})).unwrap();
        record(&db, "s", Some("next-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
        let before = db.session_by_id("s").unwrap().unwrap();
        record(&db, "s", Some("plan-turn"), "chat.approval.resolved", &json!({"approvalId":"plan:plan-turn","status":"answered","outcome":"submitted","planOutcome":"changes_requested","feedback":"Add tests","preserveSessionState":true})).unwrap();
        let after = db.session_by_id("s").unwrap().unwrap();
        assert_eq!(after.status, before.status);
        assert_eq!(after.activity, before.activity);
        let part = db.chat_items("s").unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == "plan:plan-turn").unwrap();
        assert_eq!(part["status"], "answered");
        assert_eq!(part["data"]["planOutcome"], "changes_requested");
        assert_eq!(part["data"]["feedback"], "Add tests");
    }

    #[test]
    fn runtime_plan_cancel_and_reconnect_retire_attention_without_a_new_card() {
        for reconnect in [false, true] {
            let db = db();
            record(&db, "s", Some("plan-turn"), "message.user", &json!({"text":"Plan"})).unwrap();
            record(&db, "s", Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
            record(&db, "s", Some("plan-turn"), "chat.approval", &json!({"approvalId":"plan:plan-turn","part":{"data":{"interaction":"plan","runtimeOwned":true,"plan":"Plan"}}})).unwrap();
            if reconnect {
                record(&db, "s", None, "chat.connection", &json!({"phase":"connecting"})).unwrap();
            } else {
                record(&db, "s", Some("plan-turn"), "chat.approval.resolved", &json!({"approvalId":"plan:plan-turn","status":"expired","returnToIdle":true})).unwrap();
            }
            let session = db.session_by_id("s").unwrap().unwrap();
            assert_ne!(session.status, "waiting");
            assert!(!matches!(session.activity.unwrap().state.as_str(), "awaiting_approval" | "awaiting_parent"));
            let part = db.chat_items("s").unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == "plan:plan-turn").unwrap();
            assert_eq!(part["status"], "expired");
        }
    }

    #[test]
    fn native_plan_receipt_wins_over_completion_expiry() {
        let db = db();
        record(&db, "s", Some("native-plan"), "message.user", &json!({"text":"Plan"})).unwrap();
        record(&db, "s", Some("native-plan"), "chat.approval", &json!({"approvalId":"exit-plan","part":{"data":{"interaction":"plan","plan":"# Plan"}}})).unwrap();
        record(&db, "s", Some("native-plan"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
        record(&db, "s", Some("native-plan"), "chat.approval.resolved", &json!({"approvalId":"exit-plan","status":"answered","outcome":"submitted","planOutcome":"approved"})).unwrap();
        let part = db.chat_items("s").unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == "exit-plan").unwrap();
        assert_eq!(part["status"], "answered");
        assert_eq!(part["data"]["planOutcome"], "approved");
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "idle");
    }

    #[test]
    fn plan_parts_upsert_in_place() {
        let db = db();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"plan","toolId":"plan:t","status":"complete","data":{"entries":[{"content":"One","status":"pending"}]}}})).unwrap();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"plan","toolId":"plan:t","status":"complete","data":{"entries":[{"content":"One","status":"completed"},{"content":"Two","status":"in_progress"}]}}})).unwrap();
        let item = db
            .chat_items("s")
            .unwrap()
            .into_iter()
            .find(|item| item.role == "assistant")
            .unwrap();
        let plans: Vec<_> = item
            .parts
            .iter()
            .filter(|part| part["type"] == "plan")
            .collect();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0]["data"]["entries"].as_array().unwrap().len(), 2);
        assert_eq!(plans[0]["data"]["entries"][0]["status"], "completed");
    }
    #[test]
    fn empty_plan_snapshot_replaces_the_persisted_plan() {
        let db = db();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"plan","toolId":"plan:t","status":"complete","data":{"entries":[{"content":"One","status":"pending"}]}}})).unwrap();
        record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{"type":"plan","toolId":"plan:t","status":"complete","data":{"entries":[]}}})).unwrap();
        let item = db.chat_items("s").unwrap().into_iter().find(|item| item.role == "assistant").unwrap();
        assert_eq!(item.parts.iter().find(|part| part["type"] == "plan").unwrap()["data"]["entries"], json!([]));
    }
    #[test]
    fn six_provider_tool_shapes_keep_bounded_candidates_across_partial_updates() {
        for (provider, data, expected) in [
            (
                "codex",
                json!({"type":"fileChange","changes":[{"path":"src/codex.rs"}]}),
                "src/codex.rs",
            ),
            (
                "claude",
                json!({"type":"tool_use","input":{"file_path":"src/claude.rs"}}),
                "src/claude.rs",
            ),
            (
                "kimi",
                json!({"sessionUpdate":"tool_call","locations":[{"path":"src/kimi.rs"}]}),
                "src/kimi.rs",
            ),
            (
                "gemini",
                json!({"sessionUpdate":"tool_call","rawInput":{"path":"src/gemini.rs"}}),
                "src/gemini.rs",
            ),
            (
                "grok",
                json!({"sessionUpdate":"tool_call","rawOutput":{"filePath":"src/grok.rs"}}),
                "src/grok.rs",
            ),
            (
                "opencode",
                json!({"type":"tool","state":{"input":{"filepath":"src/opencode.rs"}}}),
                "src/opencode.rs",
            ),
        ] {
            let db = db();
            let tool_id = format!("{provider}-tool");
            let part = json!({"type":"tool","toolId":tool_id,"status":"running","data":data});
            record(
                &db,
                "s",
                Some("t"),
                "chat.item",
                &json!({"merge":true,"part":part}),
            )
            .unwrap();
            record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{
                "type":"tool","toolId":tool_id,"status":"failed","data":{"output":{"path":"src/later.rs"}}
            }})).unwrap();
            // A repeated partial update must not duplicate either candidate.
            record(&db, "s", Some("t"), "chat.item", &json!({"merge":true,"part":{
                "type":"tool","toolId":tool_id,"status":"failed","data":{"output":{"path":"src/later.rs"}}
            }})).unwrap();
            let item = db
                .chat_items("s")
                .unwrap()
                .into_iter()
                .find(|item| item.role == "assistant")
                .unwrap();
            assert_eq!(item.parts.len(), 1, "{provider}");
            assert_eq!(item.parts[0]["status"], "failed", "{provider}");
            assert_eq!(
                item.parts[0]["data"],
                json!({"output":{"path":"src/later.rs"}})
            );
            assert_eq!(
                item.parts[0]["fileReferences"],
                json!([{"path":expected},{"path":"src/later.rs"}])
            );
        }
    }
    #[test]
    fn approval_projection_keeps_native_choices_and_expires_stale_pending() {
        let db = db();
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval",
            &json!({
                "approvalId":"a1",
                "choices":[{"choiceId":"always","label":"Always","kind":"allow","scope":"persistent"}],
                "part":{"type":"approval","approvalId":"a1","status":"pending","data":{
                    "approvalId":"a1",
                    "choices":[{"choiceId":"always","label":"Always","kind":"allow","scope":"persistent"}],
                    "submittable":true
                }}
            }),
        )
        .unwrap();
        let pending = db.chat_items("s").unwrap().pop().unwrap();
        assert_eq!(pending.parts[0]["status"], "pending");
        assert_eq!(pending.parts[0]["data"]["choices"][0]["choiceId"], "always");
        expire_pending_approvals(&db, "s").unwrap();
        let expired = db.chat_items("s").unwrap().pop().unwrap();
        assert_eq!(expired.parts[0]["status"], "expired");
    }
    #[test]
    fn delegate_permissions_without_a_temporary_choice_route_to_the_user() {
        for (choices, expected_route, expected_state) in [
            (json!([{"choiceId":"always","scope":"persistent","kind":"allow"}]), "user", "awaiting_user"),
            (json!([]), "user", "awaiting_user"),
            (json!([{"choiceId":"always","scope":"persistent","kind":"allow"},{"choiceId":"once","scope":"once","kind":"allow"}]), "parent", "awaiting_parent"),
        ] {
            let db = db();
            let child = db.create_session(crate::db::CreateSession { project_id:None,title:None,provider:"kimi",mode:"chat",native_id:None,operation_id:"delegate-permission" }).unwrap();
            db.set_session_status("s", "idle", None).unwrap();
            record(&db, "s", Some("parent-turn"), "message.user", &json!({"text":"fixture"})).unwrap();
            record(&db, "s", Some("parent-turn"), "chat.turn.started", &json!({})).unwrap();
            crate::delegation::insert(&db, &crate::delegation::NewDelegation {
                id:"delegation",parent_session_id:"s",child_session_id:&child.id,agent:"kimi",workspace:"shared",workspace_path:"fixture",branch:None,prompt:"fixture",user_messages:0,authority:None,operation_id:"delegate-permission",
            }).unwrap();
            record(&db, &child.id, Some("child-turn"), "message.user", &json!({"text":"fixture"})).unwrap();
            record(&db, &child.id, Some("child-turn"), "chat.approval", &json!({"approvalId":"permission","part":{"type":"approval","approvalId":"permission","status":"pending","data":{"choices":choices,"submittable":true}}})).unwrap();
            let part = db.chat_items(&child.id).unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["type"] == "approval").unwrap();
            assert_eq!(part["data"]["delegation"]["route"], expected_route);
            assert_eq!(part["data"]["choices"], choices, "persistent choices stay available to the user");
            let state = db.transaction(|tx| Ok(tx.query_row("SELECT state FROM delegations WHERE id='delegation'", [], |row| row.get::<_,String>(0))?)).unwrap();
            assert_eq!(state, expected_state);
            let inbox = db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM inbox WHERE session_id=? AND resolved=0", [&child.id], |row| row.get::<_,i64>(0))?)).unwrap();
            assert_eq!(inbox > 0, expected_route == "user");
        }
    }
    #[test]
    fn submitted_approval_is_resolved_not_tool_executed() {
        let db = db();
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval",
            &json!({
                "approvalId":"a1",
                "part":{"type":"approval","approvalId":"a1","status":"pending","data":{"approvalId":"a1","choices":[],"submittable":true}}
            }),
        )
        .unwrap();
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval.resolved",
            &json!({"approvalId":"a1","outcome":"submitted"}),
        )
        .unwrap();
        let item = db.chat_items("s").unwrap().pop().unwrap();
        assert_eq!(item.parts[0]["status"], "resolved");
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval.resolved",
            &json!({"approvalId":"a1","status":"outcomeUnknown","outcome":"unknown"}),
        )
        .unwrap();
        let unknown = db.chat_items("s").unwrap().pop().unwrap();
        assert_eq!(unknown.parts[0]["status"], "outcomeUnknown");
    }
    #[test]
    fn expired_resolution_targets_one_card_and_never_reopens_the_turn() {
        let db = db();
        for approval in ["a1", "a2"] {
            record(
                &db,
                "s",
                Some("t1"),
                "chat.approval",
                &json!({
                    "approvalId":approval,
                    "part":{"type":"approval","approvalId":approval,"status":"pending","data":{"approvalId":approval,"choices":[],"submittable":true}}
                }),
            )
            .unwrap();
        }
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "waiting");
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval.resolved",
            &json!({"approvalId":"a1","status":"expired","outcome":"cancelled","message":"Request cancelled"}),
        )
        .unwrap();
        let items = db.chat_items("s").unwrap();
        let first = items
            .iter()
            .find(|item| item.id == "s:approval:a1")
            .unwrap();
        assert_eq!(first.parts[0]["status"], "expired");
        assert_eq!(first.parts[0]["data"]["outcome"], "cancelled");
        let second = items
            .iter()
            .find(|item| item.id == "s:approval:a2")
            .unwrap();
        assert_eq!(
            second.parts[0]["status"], "pending",
            "the other card must stay pending"
        );
        // A cancellation must not flip a waiting/idle session back to running.
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "waiting");
        let inbox_resolved: bool = db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT resolved FROM inbox WHERE id='s:approval:a1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(inbox_resolved, "cancelled card inbox entry must resolve");
        // Repeating the cancellation is idempotent.
        record(
            &db,
            "s",
            Some("t1"),
            "chat.approval.resolved",
            &json!({"approvalId":"a1","status":"expired","outcome":"cancelled"}),
        )
        .unwrap();
        let again = db.chat_items("s").unwrap();
        assert_eq!(
            again
                .iter()
                .find(|item| item.id == "s:approval:a1")
                .unwrap()
                .parts[0]["status"],
            "expired"
        );
    }
}
