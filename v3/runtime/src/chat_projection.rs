//! Converts native provider updates into stable, persisted renderer chat items.
use crate::{db::Database, domain::ChatItem, file_references};
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

pub fn record(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    data: &Value,
) -> Result<()> {
    db.transaction(|tx| {
  let now=Utc::now().to_rfc3339();
  let turn=turn_id.or_else(||data.pointer("/raw/params/turn/id").and_then(Value::as_str)).or_else(||data.pointer("/raw/params/turnId").and_then(Value::as_str));
  let turn_key=turn.unwrap_or("current");
  let raw_item=data.get("item").or_else(||data.pointer("/raw/params/item"));
  let native_item=raw_item.and_then(|i|i.get("id")).and_then(Value::as_str).or_else(||data.pointer("/raw/params/itemId").and_then(Value::as_str));
  let approval_id=data.get("approvalId").and_then(Value::as_str).or_else(||data.pointer("/part/approvalId").and_then(Value::as_str));
  let category=if kind=="message.user"{"user"}else if kind.starts_with("chat.approval"){"approval"}else{"assistant"};
  let key=if category=="approval"{approval_id.unwrap_or(turn_key)}else{native_item.unwrap_or(turn_key)};
  let id=format!("{session_id}:{category}:{key}");
  let previous:Option<String>=tx.query_row("SELECT data FROM chat_items WHERE id=?",[&id],|r|r.get(0)).optional()?;
  let mut item=previous.and_then(|s|serde_json::from_str::<ChatItem>(&s).ok()).unwrap_or(ChatItem{id:id.clone(),role:if category=="user"{"user"}else{"assistant"}.into(),parts:Vec::new(),created_at:now.clone(),turn_id:turn.map(str::to_owned),elapsed_ms:None});
  let mut changed=false;
  let mut resolved_pending_approval=false;
  match kind {
   "message.user"=>{
    complete_streaming_items(tx,session_id,&now)?;
    item.parts=vec![json!({"type":"text","text":data.get("text").and_then(Value::as_str).unwrap_or("")})];changed=true;
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
     } else if matches!(kind,"agentMessage"|"assistant"|"message") {
      if !text.is_empty(){item.parts=vec![json!({"type":"text","text":text})];changed=true;}
     } else if matches!(kind,"agentThought"|"reasoning"|"thinking") {
      if !text.is_empty(){item.parts=vec![json!({"type":"thinking","text":text,"status":"complete"})];changed=true;}
     } else {item.parts=vec![json!({"type":"tool","toolName":raw.get("name").and_then(Value::as_str).unwrap_or(kind),"toolId":native_item.unwrap_or(&id),"status":raw.get("status").and_then(Value::as_str).unwrap_or("running"),"data":raw})];file_references::enrich_parts(&mut item.parts);changed=true;}
    }
   }
   "chat.approval"=>{
    if let Some(approval)=approval_id {
     let payload=data.get("part").and_then(|part|part.get("data")).cloned().unwrap_or_else(||data.clone());
     item.parts=vec![json!({"type":"approval","approvalId":approval,"status":"pending","data":payload})];changed=true;
     insert_attention(tx,&id,session_id,turn,"approval",data,&now)?;
     tx.execute("UPDATE inbox SET data=?,resolved=0 WHERE id=?",params![serde_json::to_string(data)?,id])?;
    }
   }
   "chat.approval.resolved"=>{
    // `expired` retires one card (cancelled/superseded) without implying any
    // approval and without reopening the turn; other statuses resolve it.
    let expired=data.get("status").and_then(Value::as_str)==Some("expired");
    let status=if expired{"expired"}else{match data.get("status").and_then(Value::as_str) { Some("outcomeUnknown")=>"outcomeUnknown", _=>"resolved" }};
    for part in &mut item.parts {if part.get("type").and_then(Value::as_str)==Some("approval"){
     let previous_status=part.get("status").and_then(Value::as_str);
     if previous_status==Some("expired") && !expired {continue;}
     resolved_pending_approval |= matches!(previous_status,Some("pending"|"submitting"));
     part["status"]=json!(status);
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
   "chat.turn.completed"=>{
    expire_pending_parts_for_turn(tx,session_id,turn,&now)?;
    complete_streaming_items(tx,session_id,&now)?;
    // Adapters that time their turns carry elapsedMs; other providers omit it.
    if let Some(elapsed)=data.get("elapsedMs").and_then(Value::as_u64){item.elapsed_ms=Some(elapsed);changed=true;}
    for part in &mut item.parts {
     if part.get("status").and_then(Value::as_str)==Some("streaming") {part["status"]=json!("complete");changed=true;}
    }
    notify_reply(tx,session_id,turn,data,&now)?;
   }
   "chat.error"=>{item.parts.push(json!({"type":"error","text":data.get("message").and_then(Value::as_str).unwrap_or("Provider request failed"),"data":data}));changed=true;insert_attention(tx,&format!("{session_id}:error:{turn_key}"),session_id,turn,"error",data,&now)?;}
   "chat.ui"=>{
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.ui',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"options":data.get("options").cloned().unwrap_or_else(||json!([])),"commands":data.get("commands").cloned().unwrap_or_else(||json!([]))}))?,now])?;
   }
   _=>{}
  }
  if changed {
   let payload=serde_json::to_string(&item)?;
   tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,turn_id=excluded.turn_id",params![id,session_id,turn,"message",payload,item.created_at])?;
   tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",params![serde_json::to_string(&json!({"sessionId":session_id,"item":item}))?,now])?;
  }
  let status=match kind {"chat.turn.started"=>Some("running"),"chat.turn.completed"=>Some("idle"),"chat.approval"=>Some("waiting"),"chat.approval.resolved" if !resolved_pending_approval || data.get("status").and_then(Value::as_str)==Some("expired")=>None,"chat.approval.resolved"=>Some(if has_pending_approval(tx,session_id)? {"waiting"}else{"running"}),"chat.error"=>Some("error"),_=>None};
  if let Some(status)=status {
   // Provider readers can deliver a final completion/error after an explicit
   // stop or runtime recovery has already made the session terminal. Keep
   // projecting transcript and usage data, but never resurrect that session.
   tx.execute("UPDATE sessions SET status=?,updated_at=? WHERE id=? AND status NOT IN ('exited','interrupted')",params![status,now,session_id])?;
  }
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
 })
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
            if part.get("type").and_then(Value::as_str) == Some("approval")
                && part.get("status").and_then(Value::as_str) == Some("pending")
            {
                part["status"] = json!("expired");
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_resolution_keeps_sibling_waiting_and_ignores_late_unknown_replies() {
        for provider in crate::providers::SUPPORTED_PROVIDERS {
            let root = tempfile::tempdir().unwrap();
            let db = Database::open(&root.path().join("approvals.sqlite")).unwrap();
            db.transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('s','test',?,'chat','running','now','now')", [provider])?;
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
            &json!({"options":[{"id":"model","name":"Model","value":"gpt-5.5-luna","choices":[]}],"commands":[{"name":"compact"}]}),
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
        let items: i64 = db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT COUNT(*) FROM chat_items", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(items, 0);
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
