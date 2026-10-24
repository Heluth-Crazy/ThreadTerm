//! Lossless, retry-safe import of the retired scripted Roundtable records.
//!
//! Legacy rows are deliberately never changed.  A row in `group_migrations`
//! marks a completed import, so a later version can inspect the original rows
//! and repair an earlier migration without data loss.
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const VERSION: i64 = 1;

/// Imports every legacy Roundtable that has not already been imported.
///
/// `groups`, `group_members`, and `group_messages` must already exist.  The
/// caller owns the surrounding transaction, so a partially converted room is
/// rolled back with its ledger entry on any error.
pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS group_migrations(
            roundtable_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        );",
    )?;
    if !table_exists(tx, "roundtables") {
        return Ok(());
    }
    for required in ["groups", "group_members", "group_messages"] {
        if !table_exists(tx, required) {
            return Err(anyhow!("group migration requires {required}"));
        }
    }

    let rooms = tx
        .prepare(
            "SELECT id,data,revision FROM roundtables
             WHERE id NOT IN (SELECT roundtable_id FROM group_migrations)
             ORDER BY id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (id, data, revision) in rooms {
        migrate_room(tx, &id, &data, revision)?;
        tx.execute(
            "INSERT INTO group_migrations(roundtable_id,version) VALUES(?,?)",
            params![id, VERSION],
        )?;
    }
    Ok(())
}

fn migrate_room(tx: &Transaction<'_>, id: &str, raw: &str, revision: i64) -> Result<()> {
    let room: Value = serde_json::from_str(raw)
        .map_err(|error| anyhow!("cannot migrate Roundtable {id}: invalid room JSON: {error}"))?;
    let created_at = text(&room, "createdAt").unwrap_or_else(now);
    let updated_at = text(&room, "updatedAt").unwrap_or_else(|| created_at.clone());
    let title = text(&room, "title").unwrap_or_else(|| "Group chat".into());
    let cwd = text(&room, "cwd").unwrap_or_default();
    let mut members = Vec::new();
    let mut member_states = Vec::new();
    let mut used_handles = existing_handles(tx, id)?;
    let old_members = room["participants"].as_array().cloned().unwrap_or_default();
    let participant_rows = participant_rows(tx, id)?;
    let mut conflicts = Vec::new();

    for (index, old) in old_members.iter().enumerate() {
        let session_id =
            text(old, "sessionId").or_else(|| participant_rows.get(index).map(|row| row.0.clone()));
        let Some(session_id) = session_id else {
            continue;
        };
        let provider = text(old, "provider")
            .or_else(|| {
                participant_rows
                    .iter()
                    .find(|row| row.0 == session_id)
                    .and_then(|row| row.2.clone())
            })
            .unwrap_or_else(|| "agent".into());
        let handle = unique_handle(&provider, &mut used_handles);
        let legacy_run_state = participant_rows
            .iter()
            .find(|row| row.0 == session_id)
            .map(|row| row.3.as_str());
        let state = migrated_state(
            legacy_run_state
                .filter(|state| matches!(*state, "queued" | "working"))
                .or(text(old, "state").as_deref()),
        );
        let mut member = json!({
            "sessionId": session_id,
            "provider": provider,
            "handle": handle,
            "mode": if text(old, "readOnly").as_deref().is_some_and(|v| v != "none") { "read_only" } else { "default" },
            "state": state,
            "joinedAt": created_at,
        });
        if let Some(model) = text(old, "model") {
            member["model"] = json!(model);
        }
        if let Some(read_only) =
            text(old, "readOnly").filter(|value| matches!(value.as_str(), "enforced" | "prompt"))
        {
            member["readOnly"] = json!(read_only);
        }
        if let Some(note) = text(old, "readOnlyNote") {
            member["readOnlyNote"] = json!(note);
        }
        if let Some(error) = text(old, "error") {
            member["error"] = json!(error);
        }
        if state == "failed" && member.get("error").is_none() {
            member["error"] = json!("Interrupted by restart — Resend");
        }

        let inserted = tx.execute(
            "INSERT OR IGNORE INTO group_members(group_id,session_id,handle,header_sent) VALUES(?,?,?,0)",
            params![id, session_id, handle],
        )?;
        if inserted == 0 {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT group_id FROM group_members WHERE session_id=?",
                    [&session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if owner.as_deref() != Some(id) {
                conflicts.push(format!("@{handle} was not linked because this Chat already belongs to group {}. Its legacy Roundtable remains intact.", owner.unwrap_or_else(|| "another group".into())));
                continue;
            }
        }
        members.push(member);
        member_states.push((session_id, handle, state.to_owned()));
    }

    let group_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM groups WHERE id=?)",
        [id],
        |row| row.get(0),
    )?;
    if !group_exists {
        let mut group = json!({
            "id": id,
            "revision": revision,
            "title": title,
            "cwd": cwd,
            "members": members,
            "lastRecipients": [],
            "archived": false,
            "createdAt": created_at,
            "updatedAt": updated_at,
        });
        copy_optional(&room, &mut group, "projectId");
        copy_optional(&room, &mut group, "worktreePath");
        copy_optional(&room, &mut group, "filesCheck");
        tx.execute(
            "INSERT INTO groups(id,data,revision) VALUES(?,?,?)",
            params![id, serde_json::to_string(&group)?, revision],
        )?;
    }

    let handles = group_handles(tx, id)?;
    let mut last_recipients = Vec::new();
    let mut reply_to = None;
    if let Some(topic) = text(&room, "topic").filter(|topic| !topic.trim().is_empty()) {
        let topic_id = format!("{id}:topic");
        let recipients = handles
            .iter()
            .map(|(_, handle, _)| handle.clone())
            .collect::<Vec<_>>();
        let deliveries = legacy_deliveries(&member_states);
        let message = json!({
            "id": topic_id,
            "author": "user",
            "body": topic,
            "recipients": recipients,
            "deliveries": deliveries,
            "createdAt": created_at,
        });
        tx.execute(
            "INSERT OR IGNORE INTO group_messages(id,group_id,data) VALUES(?,?,?)",
            params![message["id"].as_str(), id, serde_json::to_string(&message)?],
        )?;
        insert_legacy_deliveries(tx, id, &message, &member_states)?;
        last_recipients = recipients;
        reply_to = message["id"].as_str().map(str::to_owned);
    }
    let posts = legacy_posts(tx, id, &room)?;
    for (fallback, post) in posts.iter().enumerate() {
        let Some(post_id) = text(post, "id") else {
            continue;
        };
        let message = post_to_message(post, &handles, fallback, &created_at, reply_to.as_deref());
        if message["author"] == "user" {
            last_recipients = message["recipients"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            reply_to = message["id"].as_str().map(str::to_owned);
        }
        tx.execute(
            "INSERT OR IGNORE INTO group_messages(id,group_id,data) VALUES(?,?,?)",
            params![post_id, id, serde_json::to_string(&message)?],
        )?;
    }
    for (index, conflict) in conflicts.iter().enumerate() {
        let message = json!({
            "id": format!("migration:{id}:member-conflict:{index}"),
            "author": "system",
            "body": conflict,
            "createdAt": updated_at,
        });
        tx.execute(
            "INSERT OR IGNORE INTO group_messages(id,group_id,data) VALUES(?,?,?)",
            params![message["id"].as_str(), id, serde_json::to_string(&message)?],
        )?;
    }
    if !group_exists {
        if !last_recipients.is_empty() {
            let raw: String =
                tx.query_row("SELECT data FROM groups WHERE id=?", [id], |row| row.get(0))?;
            let mut group: Value = serde_json::from_str(&raw)?;
            group["lastRecipients"] = json!(last_recipients);
            tx.execute(
                "UPDATE groups SET data=? WHERE id=?",
                params![group.to_string(), id],
            )?;
        }
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
            params![json!({"kind":"group","id":id}).to_string(), updated_at],
        )?;
    }
    Ok(())
}

fn legacy_posts(tx: &Transaction<'_>, id: &str, room: &Value) -> Result<Vec<Value>> {
    if table_exists(tx, "roundtable_posts") {
        let raw_posts = tx
            .prepare("SELECT data FROM roundtable_posts WHERE room_id=? ORDER BY json_extract(data,'$.createdAt'),rowid")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let posts = raw_posts
            .into_iter()
            .map(|raw| serde_json::from_str::<Value>(&raw).map_err(anyhow::Error::from))
            .collect::<Result<Vec<Value>>>()?;
        if !posts.is_empty() {
            return Ok(posts);
        }
    }
    Ok(room["posts"].as_array().cloned().unwrap_or_default())
}

fn post_to_message(
    post: &Value,
    handles: &[(String, String, String)],
    fallback: usize,
    created_at: &str,
    reply_to: Option<&str>,
) -> Value {
    let author = text(post, "author").unwrap_or_else(|| "system".into());
    let body = text(post, "body").unwrap_or_default();
    let id = text(post, "id").unwrap_or_else(|| format!("migration-message-{fallback}"));
    let mut message = json!({"id":id,"body":body,"createdAt":text(post,"createdAt").unwrap_or_else(||created_at.into())});
    if author == "user" {
        message["author"] = json!("user");
        let recipients = recipients_for(post, handles);
        if !recipients.is_empty() {
            message["recipients"] = json!(recipients);
        }
        return message;
    }
    if author == "system" {
        message["author"] = json!("system");
        return message;
    }
    message["author"] = json!("member");
    let seat = text(post, "seat");
    if let Some((session_id, handle, _)) = handles
        .iter()
        .find(|(session, _, old_seat)| author == *session || seat.as_deref() == Some(old_seat))
    {
        message["sessionId"] = json!(session_id);
        message["handle"] = json!(handle);
    } else if let Some(seat) = seat {
        message["handle"] = json!(seat.to_lowercase());
    }
    if let Some(reply_to) = reply_to {
        message["replyTo"] = json!(reply_to);
    }
    let mut outputs = Map::new();
    if let Some(changed) = post
        .get("changedFiles")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        outputs.insert("changed".into(), Value::Array(changed.clone()));
    }
    if !outputs.is_empty() {
        message["outputs"] = Value::Object(outputs);
    }
    message
}

fn recipients_for(post: &Value, handles: &[(String, String, String)]) -> Vec<String> {
    text(post, "to")
        .map(|seat| {
            handles
                .iter()
                .filter(|(_, _, old_seat)| old_seat == &seat)
                .map(|(_, handle, _)| handle.clone())
                .collect()
        })
        .unwrap_or_else(|| {
            handles
                .iter()
                .map(|(_, handle, _)| handle.clone())
                .collect()
        })
}

fn legacy_deliveries(members: &[(String, String, String)]) -> Vec<Value> {
    members
        .iter()
        .filter(|(_, _, state)| matches!(state.as_str(), "queued" | "working" | "failed"))
        .map(|(session, handle, _)| {
            json!({
                "sessionId": session,
                "handle": handle,
                "state": "failed",
                "error": "Interrupted by restart — Resend",
            })
        })
        .collect()
}

fn insert_legacy_deliveries(
    tx: &Transaction<'_>,
    group: &str,
    topic: &Value,
    members: &[(String, String, String)],
) -> Result<()> {
    let message = topic["id"]
        .as_str()
        .ok_or_else(|| anyhow!("missing migrated topic id"))?;
    let body = topic["body"].as_str().unwrap_or_default();
    for (session, handle, state) in members {
        if !matches!(state.as_str(), "queued" | "working" | "failed") {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO group_deliveries(id,group_id,message_id,session_id,handle,state,queue_id,turn_id,prompt,attempt,before_json,header) VALUES(?,?,?,?,?,'failed',NULL,NULL,?,0,NULL,0)",
            params![format!("{group}:{session}:legacy"), group, message, session, handle, body],
        )?;
    }
    Ok(())
}

type LegacyParticipant = (String, String, Option<String>, String);

fn participant_rows(tx: &Transaction<'_>, id: &str) -> Result<Vec<LegacyParticipant>> {
    if !table_exists(tx, "roundtable_participants") {
        return Ok(Vec::new());
    }
    let mut statement = tx.prepare(
        "SELECT p.session_id,p.seat,s.provider,p.run_state FROM roundtable_participants p
         LEFT JOIN sessions s ON s.id=p.session_id WHERE p.room_id=? ORDER BY p.seat",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn existing_handles(tx: &Transaction<'_>, id: &str) -> Result<HashSet<String>> {
    let mut statement = tx.prepare("SELECT handle FROM group_members WHERE group_id=?")?;
    let handles = statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(handles)
}

fn group_handles(tx: &Transaction<'_>, id: &str) -> Result<Vec<(String, String, String)>> {
    let seats = if table_exists(tx, "roundtable_participants") {
        participant_rows(tx, id)?
    } else {
        Vec::new()
    };
    let mut statement =
        tx.prepare("SELECT session_id,handle FROM group_members WHERE group_id=? ORDER BY rowid")?;
    let members = statement
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(session, handle)| {
            let seat = seats
                .iter()
                .find(|(member, _, _, _)| member == &session)
                .map(|(_, seat, _, _)| seat.clone())
                .unwrap_or_default();
            (session, handle, seat)
        })
        .collect();
    Ok(members)
}

fn table_exists(tx: &Transaction<'_>, table: &str) -> bool {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [table],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}
fn copy_optional(from: &Value, to: &mut Value, key: &str) {
    if !from[key].is_null() {
        to[key] = from[key].clone();
    }
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn migrated_state(old: Option<&str>) -> &'static str {
    match old {
        Some("working") => "failed",
        Some("queued") => "queued",
        Some("needs_user") => "needs_user",
        Some("failed") => "failed",
        _ => "idle",
    }
}

fn unique_handle(provider: &str, used: &mut HashSet<String>) -> String {
    let mut base = provider
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    base = base.trim_matches('-').to_owned();
    if base.is_empty() {
        base = "agent".into();
    }
    base.truncate(24);
    while base.ends_with('-') {
        base.pop();
    }
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used.contains(&candidate) {
        let tail = format!("-{suffix}");
        let limit = 24usize.saturating_sub(tail.len());
        let mut stem = base.clone();
        stem.truncate(limit);
        while stem.ends_with('-') {
            stem.pop();
        }
        candidate = format!("{stem}{tail}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn schema(conn: &Connection) {
        conn.execute_batch("CREATE TABLE roundtables(id TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL);
            CREATE TABLE roundtable_participants(room_id TEXT,session_id TEXT UNIQUE,seat TEXT,run_state TEXT NOT NULL DEFAULT 'idle');
            CREATE TABLE roundtable_posts(id TEXT PRIMARY KEY,room_id TEXT,data TEXT);
            CREATE TABLE sessions(id TEXT PRIMARY KEY,provider TEXT);
            CREATE TABLE groups(id TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL);
            CREATE TABLE group_members(group_id TEXT,session_id TEXT UNIQUE,handle TEXT,header_sent INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(group_id,session_id));
            CREATE TABLE group_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,group_id TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE group_deliveries(id TEXT PRIMARY KEY,group_id TEXT,message_id TEXT,session_id TEXT,handle TEXT,state TEXT,queue_id TEXT,turn_id TEXT,prompt TEXT,attempt INTEGER DEFAULT 0,before_json TEXT,header INTEGER DEFAULT 0);
            CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT,data TEXT,created_at TEXT);") .unwrap();
    }
    fn legacy(conn: &Connection, id: &str, session: &str, provider: &str, state: &str) {
        conn.execute(
            "INSERT INTO sessions VALUES(?,?)",
            params![session, provider],
        )
        .unwrap();
        conn.execute("INSERT INTO roundtables VALUES(?,?,7)", params![id,json!({"id":id,"title":"Old room","cwd":"workspace","projectId":"p","topic":"Original user task","participants":[{"sessionId":session,"provider":provider,"seat":"A","readOnly":"enforced","readOnlyNote":"review only","state":state}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}).to_string()]).unwrap();
        conn.execute(
            "INSERT INTO roundtable_participants(room_id,session_id,seat) VALUES(?,?,?)",
            params![id, session, "A"],
        )
        .unwrap();
    }
    #[test]
    fn imports_rows_idempotently_and_keeps_legacy_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        legacy(&conn, "old", "chat", "Codex", "working");
        conn.execute("INSERT INTO roundtable_posts VALUES('user','old',?)",[json!({"id":"user","author":"user","body":"make it","createdAt":"2026-01-01T00:00:01Z"}).to_string()]).unwrap();
        conn.execute("INSERT INTO roundtable_posts VALUES('reply','old',?)",[json!({"id":"reply","author":"chat","seat":"A","body":"https://example.test/a\n","changedFiles":["a.html"],"createdAt":"2026-01-01T00:00:02Z"}).to_string()]).unwrap();
        conn.execute("INSERT INTO roundtable_posts VALUES('notice','old',?)",[json!({"id":"notice","author":"system","body":"Round completed","createdAt":"2026-01-01T00:00:03Z"}).to_string()]).unwrap();
        let tx = conn.transaction().unwrap();
        migrate(&tx).unwrap();
        tx.commit().unwrap();
        let group: Value = serde_json::from_str(
            &conn
                .query_row("SELECT data FROM groups WHERE id='old'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(group["members"][0]["handle"], "codex");
        assert_eq!(group["members"][0]["state"], "failed");
        assert_eq!(group["members"][0]["mode"], "read_only");
        assert_eq!(group["lastRecipients"], json!(["codex"]));
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM group_messages WHERE group_id='old'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            4
        );
        let topic: Value = serde_json::from_str(
            &conn
                .query_row(
                    "SELECT data FROM group_messages WHERE id='old:topic'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let user: Value = serde_json::from_str(
            &conn
                .query_row("SELECT data FROM group_messages WHERE id='user'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
        )
        .unwrap();
        let reply: Value = serde_json::from_str(
            &conn
                .query_row(
                    "SELECT data FROM group_messages WHERE id='reply'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let notice: Value = serde_json::from_str(
            &conn
                .query_row(
                    "SELECT data FROM group_messages WHERE id='notice'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(user["author"], "user");
        assert_eq!(user["recipients"], json!(["codex"]));
        assert_eq!(topic["body"], "Original user task");
        assert_eq!(topic["recipients"], json!(["codex"]));
        assert_eq!(topic["deliveries"][0]["state"], "failed");
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT state FROM group_deliveries WHERE id='old:chat:legacy'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "failed"
        );
        assert_eq!(reply["author"], "member");
        assert_eq!(reply["handle"], "codex");
        assert_eq!(reply["replyTo"], "user");
        assert_eq!(reply["outputs"]["changed"], json!(["a.html"]));
        assert_eq!(notice["author"], "system");
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM roundtables", [], |r| r.get(0))
                .unwrap(),
            1
        );
        let tx = conn.transaction().unwrap();
        migrate(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM group_messages WHERE group_id='old'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            4
        );
    }
    #[test]
    fn repeats_receive_suffixes_and_conflicts_are_visible() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        legacy(&conn, "first", "a", "Codex", "idle");
        legacy(&conn, "second", "b", "Codex", "idle");
        conn.execute("INSERT INTO sessions VALUES('c','Codex')", [])
            .unwrap();
        conn.execute("UPDATE roundtables SET data=? WHERE id='second'",[json!({"id":"second","title":"Second","cwd":"workspace","participants":[{"sessionId":"b","provider":"Codex","seat":"A","state":"idle"},{"sessionId":"c","provider":"Codex","seat":"B","state":"idle"}],"createdAt":"t","updatedAt":"t"}).to_string()]).unwrap();
        conn.execute(
            "INSERT INTO roundtable_participants(room_id,session_id,seat) VALUES('second','c','B')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO groups VALUES('existing','{}',0);
             INSERT INTO group_members VALUES('existing','b','taken',0);",
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        migrate(&tx).unwrap();
        tx.commit().unwrap();
        let handles = conn
            .prepare("SELECT handle FROM group_members WHERE group_id='second' ORDER BY handle")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(handles, vec!["codex-2"]);
        assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(*) FROM group_messages WHERE group_id='second' AND json_extract(data,'$.author')='system'",[],|r|r.get(0)).unwrap(),1);
    }
}
