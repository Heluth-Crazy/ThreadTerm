//! User-routed, private-context group deliveries over ordinary durable Chat queues.
use crate::{
    chat_queue::ChatQueues,
    db::Database,
    domain::SessionGroup,
    providers::{ProviderError, ProviderEvent, ProviderRuntime, Providers},
};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};

#[path = "group_reply.rs"]
mod reply_capture;
#[path = "group_changes.rs"]
mod changes;

pub(crate) fn editor_saved(tx: &Transaction<'_>, cwd: &str, path: &str) -> Result<()> {
    if exists(tx) { changes::editor_saved(tx, cwd, path) } else { Ok(()) }
}

const BODY: usize = 64 * 1024;
const REFERENCE: usize = 8 * 1024;
pub(crate) const READ_ONLY:&str="Read-only reviewer: do not create, edit, delete or rename files, execute write commands, install packages, or change Git state. Read and explain only. Cite paths and lines. Ask the user before any action that would change files.";
pub(crate) const HEADER_RULES:&str="You only see messages addressed to you. When the user references another member's work it is included below. Save deliverables as files and put their paths/URLs in your reply. Use your own files or a folder named after your handle for independent deliverables. Other members do not receive your reply automatically. Address suggestions to the user; you cannot send messages to other members.";
static MUTATIONS: Mutex<()> = Mutex::new(());
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn err(code: &str) -> anyhow::Error {
    ProviderError::new(code, code).into()
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("invalid_request"))
}
fn bounded(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.into();
    }
    let note = "\n[shortened — ask the user for the rest]";
    let mut end = max.saturating_sub(note.len());
    while !s.is_char_boundary(end) {
        end -= 1
    }
    format!("{}{note}", &s[..end])
}
/// Canonical Windows paths may use verbatim prefixes; keep those for filesystem identity but not prompts.
fn display_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}
fn exists(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='groups' AND type='table')",
        [],
        |r| r.get(0),
    )
    .unwrap_or(false)
}
pub(crate) fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx|{
 tx.execute_batch("CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS group_members(group_id TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL,handle TEXT NOT NULL,header_sent INTEGER NOT NULL DEFAULT 0,configured INTEGER NOT NULL DEFAULT 0,saved_options TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(group_id,session_id));
 CREATE TABLE IF NOT EXISTS group_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,group_id TEXT NOT NULL,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS group_messages_room ON group_messages(group_id,sequence);
 CREATE TABLE IF NOT EXISTS group_deliveries(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,message_id TEXT NOT NULL,session_id TEXT NOT NULL,handle TEXT NOT NULL,state TEXT NOT NULL,queue_id TEXT,turn_id TEXT,prompt TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,before_json TEXT,header INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS group_delivery_session ON group_deliveries(session_id,state);
 CREATE INDEX IF NOT EXISTS group_delivery_latest ON group_deliveries(session_id);
 CREATE INDEX IF NOT EXISTS group_delivery_dispatch ON group_deliveries(state,queue_id);
 CREATE TABLE IF NOT EXISTS group_jobs(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT,reply_id TEXT NOT NULL,before_json TEXT,read_only INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
 CREATE INDEX IF NOT EXISTS group_job_pending ON group_jobs(state);")?;
 tx.execute_batch("CREATE INDEX IF NOT EXISTS group_reply_turn_items ON chat_items(session_id,turn_id,created_at);")?;
 reply_capture::initialize(tx)?;
 changes::initialize(tx)?;
 crate::group_migration::migrate(tx)?;
 let rows=tx.prepare("SELECT id,group_id,message_id FROM group_deliveries WHERE state IN ('working','needs_user') OR (state='queued' AND (queue_id IS NULL OR queue_id LIKE 'preparing:%'))")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
 for (id,group,message) in rows {tx.execute("UPDATE group_deliveries SET state='failed' WHERE id=?",[&id])?;update_delivery(tx,&message,&id,"failed",Some("Interrupted by restart — Resend"),None)?;touch(tx,&group)?;}
 tx.execute("UPDATE group_jobs SET state='pending' WHERE state='working'",[])?;
 Ok(())
 })
}
pub(crate) fn session_link(conn: &rusqlite::Connection, id: &str) -> Result<Option<SessionGroup>> {
    if !exists(conn) {
        return Ok(None);
    }
    conn.query_row(
        "SELECT group_id,handle FROM group_members WHERE session_id=?",
        [id],
        |r| {
            Ok(SessionGroup {
                id: r.get(0)?,
                handle: r.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}
fn load(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    let raw: Option<String> = tx
        .query_row("SELECT data FROM groups WHERE id=?", [id], |r| r.get(0))
        .optional()?;
    serde_json::from_str(&raw.ok_or_else(|| err("group_not_found"))?).map_err(Into::into)
}
fn store(tx: &Transaction<'_>, g: &Value) -> Result<()> {
    tx.execute(
        "UPDATE groups SET data=?,revision=? WHERE id=?",
        params![
            g.to_string(),
            g["revision"].as_i64().unwrap_or(1),
            g["id"].as_str()
        ],
    )?;
    Ok(())
}
fn touch(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let mut g = load(tx, id)?;
    g["revision"] = json!(g["revision"].as_i64().unwrap_or(0) + 1);
    g["updatedAt"] = json!(now());
    store(tx, &g)?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![json!({"kind":"group","id":id}).to_string(), now()],
    )?;
    Ok(())
}
fn put_message(tx: &Transaction<'_>, group: &str, m: &Value) -> Result<()> {
    tx.execute("INSERT INTO group_messages(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![m["id"].as_str(),group,m.to_string()])?;
    Ok(())
}
fn message(tx: &Transaction<'_>, group: &str, id: &str) -> Result<Value> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT data FROM group_messages WHERE group_id=? AND id=?",
            params![group, id],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(&raw.ok_or_else(|| err("group_message_not_found"))?).map_err(Into::into)
}
fn member<'a>(g: &'a Value, session: &str) -> Result<&'a Value> {
    g["members"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["sessionId"] == session)
        .ok_or_else(|| err("group_member_not_found"))
}
fn members_mut(g: &mut Value) -> &mut Vec<Value> {
    g["members"].as_array_mut().expect("group members")
}
fn hydrate(tx: &Transaction<'_>, mut g: Value) -> Result<Value> {
    for m in members_mut(&mut g) {
        let session = string(m, "sessionId")?.to_owned();
        let activity: Option<String> = tx
            .query_row(
                "SELECT state FROM session_activity WHERE session_id=?",
                [&session],
                |r| r.get(0),
            )
            .optional()?;
        let mut states=tx.prepare("SELECT DISTINCT state FROM group_deliveries WHERE session_id=? AND state IN ('queued','working','needs_user')")?.query_map([&session],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if states.is_empty() {
            if let Some(last)=tx.query_row("SELECT state FROM group_deliveries WHERE session_id=? ORDER BY rowid DESC LIMIT 1",[&session],|r|r.get::<_,String>(0)).optional()?{states.push(last);}
        }
        let state = if crate::chat_projection::pending_approval_route(tx, &session)? == Some("user") {
            "needs_user"
        } else if activity.as_deref() == Some("running") || states.iter().any(|s| matches!(s.as_str(), "working" | "needs_user")) {
            "working"
        } else if states.iter().any(|s| s == "queued") {
            "queued"
        } else if states.last().is_some_and(|s| s == "failed")
            || (states.is_empty() && m["state"] == "failed")
        {
            "failed"
        } else {
            "idle"
        };
        m["state"] = json!(state);
    }
    Ok(g)
}
fn read_tx(tx: &Transaction<'_>, id: &str, p: &Value) -> Result<Value> {
    let mut g = hydrate(tx, load(tx, id)?)?;
    let limit = p["limit"].as_u64().unwrap_or(100).clamp(1, 200) as usize;
    let before = if let Some(cursor) = p["before"].as_str() {
        tx.query_row(
            "SELECT sequence FROM group_messages WHERE group_id=? AND id=?",
            params![id, cursor],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| err("invalid_group_cursor"))?
    } else {
        i64::MAX
    };
    let rows=tx.prepare("SELECT data FROM group_messages WHERE group_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?")?.query_map(params![id,before,limit as i64+1],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    for raw in rows {
        if messages.len() == limit || bytes + raw.len() > 2 * 1024 * 1024 {
            more = true;
            break;
        }
        bytes += raw.len();
        messages.push(serde_json::from_str::<Value>(&raw)?)
    }
    messages.reverse();
    g["hasMore"] = json!(more);
    if let Some(m) = messages.first() {
        g["before"] = m["id"].clone();
    }
    g["messages"] = json!(messages);
    Ok(g)
}
pub(crate) fn read(db: &Database, id: &str, p: &Value) -> Result<Value> {
    db.transaction(|tx| read_tx(tx, id, p))
}
fn handle_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 24
        && s != "all"
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn next_handle(provider: &str, used: &[String]) -> String {
    let base = provider
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .take(20)
        .collect::<String>();
    let base = if base.is_empty() || base == "all" {
        "agent"
    } else {
        &base
    };
    if !used.iter().any(|s| s == base) {
        return base.into();
    }
    for i in 2..=9999 {
        let h = format!("{base}-{i}");
        if !used.contains(&h) {
            return h;
        }
    }
    unreachable!()
}
fn validate_mode(v: &Value) -> Result<&str> {
    let mode = v["mode"].as_str().unwrap_or("default");
    if !matches!(mode, "default" | "read_only") {
        return Err(err("invalid_group_mode"));
    }
    Ok(mode)
}
fn check_provider(providers: &Providers, provider: &str) -> Result<()> {
    let rows = crate::group_prerequisites::providers(providers, Some(&[json!(provider)]));
    let row = &rows[0];
    if row["usable"] != true {
        return Err(ProviderError::new(
            row["reason"].as_str().unwrap_or("agent_unavailable"),
            row["fix"]["text"]
                .as_str()
                .unwrap_or("Configure the provider in Settings → Providers"),
        )
        .with_details(json!({"fix":row["fix"]}))
        .into());
    }
    Ok(())
}
fn make_member(
    db: &Database,
    providers: &Providers,
    g: &Value,
    v: &Value,
    existing: Option<&str>,
    operation: &str,
    create: &dyn Fn(&Value) -> Result<Value>,
) -> Result<Value> {
    let provider = string(v, "provider")?;
    check_provider(providers, provider)?;
    let mode = validate_mode(v)?;
    let used = g["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["handle"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let h = v["handle"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| next_handle(provider, &used));
    if !handle_ok(&h) || used.contains(&h) {
        return Err(err("invalid_group_handle"));
    }
    if v.get("model")
        .is_some_and(|m| m.as_str().is_none_or(|s| s.is_empty() || s.len() > 512))
    {
        return Err(err("invalid_group_model"));
    }
    let session = if let Some(id) = existing {
        let s = db
            .session_by_id(id)?
            .ok_or_else(|| err("session_not_found"))?;
        if s.mode != "chat" || s.provider != provider || s.group.is_some() {
            return Err(err("invalid_group_source"));
        }
        db.require_interactive(id)?;
        let config =
            crate::session_configs::read(db, id)?.ok_or_else(|| err("launch_config_missing"))?;
        if std::fs::canonicalize(&config.launch.cwd)? != std::fs::canonicalize(string(g, "cwd")?)? {
            return Err(err("group_folder_mismatch"));
        }
        id.to_owned()
    } else {
        let s = create(
            &json!({"projectId":g["projectId"],"cwd":g["cwd"],"title":format!("{} · @{h}",string(g,"title")?),"provider":provider,"mode":"chat","operationId":operation}),
        )?;
        string(&s, "id")?.into()
    };
    Ok(
        json!({"sessionId":session,"provider":provider,"handle":h,"model":v.get("model").cloned().unwrap_or(Value::Null),"mode":mode,"state":"idle","joinedAt":now()}),
    )
}
fn insert_member(tx: &Transaction<'_>, group: &str, m: &Value, saved: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO group_members(group_id,session_id,handle,saved_options) VALUES(?,?,?,?)",
        params![
            group,
            m["sessionId"].as_str(),
            m["handle"].as_str(),
            saved.to_string()
        ],
    )?;
    Ok(())
}
fn clean_member(m: &mut Value) {
    if m["model"].is_null() {
        m.as_object_mut().unwrap().remove("model");
    }
}
fn create_group(
    db: &Database,
    providers: &Providers,
    p: &Value,
    create: &dyn Fn(&Value) -> Result<Value>,
) -> Result<Value> {
    if p["expectedRevision"]
        .as_i64()
        .is_some_and(|revision| revision != 0)
    {
        return Err(err("revision_conflict"));
    }
    let seats = p["members"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 6)
        .ok_or_else(|| err("invalid_group_members"))?;
    let cwd = std::fs::canonicalize(string(p, "cwd")?).map_err(|_| err("invalid_workspace"))?;
    if !cwd.is_dir() {
        return Err(err("invalid_workspace"));
    }
    let mut scope = None;
    for project in db
        .snapshot()?
        .projects
        .into_iter()
        .filter(|v| p["projectId"].as_str().is_none_or(|id| id == v.id))
    {
        if let Ok(root) =
            crate::workspace_services::workspace_root_for_cwd(db, &project.id, string(p, "cwd")?)
        {
            scope = Some((project, root));
            break;
        }
    }
    let (project, root) = scope.ok_or_else(|| err("invalid_workspace"))?;
    let title = p["title"].as_str().unwrap_or("Group chat");
    if title.trim().is_empty() || title.len() > 512 {
        return Err(err("invalid_group_title"));
    }
    use sha2::{Digest, Sha256};
    let id = format!(
        "group-{}",
        hex::encode(Sha256::digest(string(p, "operationId")?.as_bytes()))
    );
    if let Some(g) = db.transaction(|tx| {
        let found: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM groups WHERE id=?)",
            [&id],
            |r| r.get(0),
        )?;
        if found {
            Ok(Some(read_tx(tx, &id, &json!({}))?))
        } else {
            Ok(None)
        }
    })? {
        return Ok(g);
    }
    let mut g = json!({"id":id,"revision":0,"title":title,"projectId":project.id,"cwd":cwd.to_string_lossy(),"members":[],"lastRecipients":[],"archived":false,"createdAt":now(),"updatedAt":now()});
    if root != std::fs::canonicalize(project.path)? {
        g["worktreePath"] = json!(root.to_string_lossy());
    }
    g["filesCheck"] = json!({"state":"on"});
    // Validate all providers/handles before creating any sessions.
    let mut used = Vec::<String>::new();
    for seat in seats {
        check_provider(providers, string(seat, "provider")?)?;
        validate_mode(seat)?;
        let h = seat["handle"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| next_handle(string(seat, "provider").unwrap(), &used));
        if !handle_ok(&h) || used.contains(&h) {
            return Err(err("invalid_group_handle"));
        }
        used.push(h);
    }
    let mut saved = Vec::new();
    for (i, seat) in seats.iter().enumerate() {
        let mut m = make_member(
            db,
            providers,
            &g,
            seat,
            if i == 0 {
                p["fromSessionId"].as_str()
            } else {
                None
            },
            &format!("{}:member:{i}", string(p, "operationId")?),
            create,
        )?;
        saved.push(db.chat_option_selections(string(&m, "sessionId")?, string(&m, "provider")?)?);
        clean_member(&mut m);
        members_mut(&mut g).push(m);
    }
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO groups(id,data,revision) VALUES(?,?,0)",
            params![id, g.to_string()],
        )?;
        for (m, s) in g["members"].as_array().unwrap().iter().zip(&saved) {
            insert_member(tx, &id, m, s)?;
        }
        touch(tx, &id)?;
        let result = read_tx(tx, &id, &json!({}))?;
        receipt(tx, string(p, "operationId")?, "group.create", &result)?;
        Ok(result)
    })
}
fn refs(tx: &Transaction<'_>, g: &Value, p: &Value) -> Result<(Vec<Value>, String)> {
    let mut descriptors = Vec::new();
    let mut blocks = String::new();
    let empty = Vec::new();
    let rows = p["references"].as_array().unwrap_or(&empty);
    if rows.len() > 8 {
        return Err(err("too_many_group_references"));
    }
    for r in rows {
        let kind = string(r, "kind")?;
        let (title, content, mut descriptor) = match kind {
            "reply" | "message" => {
                let m = message(tx, string(g, "id")?, string(r, "messageId")?)?;
                if kind == "reply" && m["author"] != "member" {
                    return Err(err("invalid_group_reference"));
                }
                let title = if kind == "reply" {
                    let topic = m["replyTo"]
                        .as_str()
                        .and_then(|id| message(tx, string(g, "id").unwrap(), id).ok())
                        .and_then(|v| {
                            v["body"]
                                .as_str()
                                .map(|s| s.chars().take(80).collect::<String>())
                        })
                        .unwrap_or_default();
                    format!(
                        "@{}'s reply (to: \"{topic}\")",
                        m["handle"].as_str().unwrap_or("member")
                    )
                } else {
                    "Earlier message".into()
                };
                let content = format!(
                    "{}{}",
                    m["body"].as_str().unwrap_or_default(),
                    m.get("outputs")
                        .map(|o| format!("\nOutputs: {o}"))
                        .unwrap_or_default()
                );
                let mut d = json!({"kind":kind,"messageId":m["id"]});
                if let Some(h) = m.get("handle") {
                    d["handle"] = h.clone()
                }
                (title, content, d)
            }
            "file" => {
                let path = string(r, "path")?;
                if !safe_path(path) {
                    return Err(err("invalid_group_file"));
                }
                (
                    format!("File {path}"),
                    path.to_owned(),
                    json!({"kind":kind,"path":path}),
                )
            }
            "url" => {
                let url = string(r, "url")?;
                let parsed = reqwest::Url::parse(url).map_err(|_| err("invalid_group_url"))?;
                if !matches!(parsed.scheme(), "http" | "https")
                    || parsed.host_str().is_none()
                    || url.len() > 8192
                {
                    return Err(err("invalid_group_url"));
                }
                ("URL".into(), url.to_owned(), json!({"kind":kind,"url":url}))
            }
            _ => return Err(err("invalid_group_reference")),
        };
        let block = format!("\n\n## Referenced: {title}\n{content}");
        let short = block.len() > REFERENCE;
        let block = if kind == "reply" && short {
            let label = format!("\n\n## Referenced: {title}\n");
            if let Some((body, outputs)) = content.rsplit_once("\nOutputs:") {
                let outputs = bounded(outputs, REFERENCE / 2);
                let budget =
                    REFERENCE.saturating_sub(label.len() + "\nOutputs:".len() + outputs.len());
                format!("{label}{}\nOutputs:{outputs}", bounded(body, budget))
            } else {
                bounded(&block, REFERENCE)
            }
        } else {
            bounded(&block, REFERENCE)
        };
        descriptor["title"] = json!(bounded(&title, 512));
        descriptor["bytes"] = json!(block.len());
        if short {
            descriptor["shortened"] = json!(true)
        }
        descriptors.push(descriptor);
        blocks.push_str(&block);
    }
    Ok((descriptors, blocks))
}
fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 8192
        && !p.starts_with(['/', '\\'])
        && !p.contains(':')
        && !p.chars().any(char::is_control)
        && !p.split(['/', '\\']).any(|s| s == ".." || s.is_empty())
}
fn delivery_id(message: &str, session: &str) -> String {
    format!("{message}:{session}")
}
fn add_delivery(
    tx: &Transaction<'_>,
    g: &Value,
    message: &str,
    m: &Value,
    prompt: &str,
) -> Result<Value> {
    let session = string(m, "sessionId")?;
    let id = delivery_id(message, session);
    tx.execute("INSERT INTO group_deliveries(id,group_id,message_id,session_id,handle,state,prompt) VALUES(?,?,?,?,?,'queued',?)",params![id,g["id"].as_str(),message,session,m["handle"].as_str(),prompt])?;
    Ok(json!({"sessionId":session,"handle":m["handle"],"state":"queued"}))
}
fn send(tx: &Transaction<'_>, id: &str, p: &Value) -> Result<()> {
    let mut g = load(tx, id)?;
    if g["archived"] == true {
        return Err(err("group_archived"));
    }
    let text = string(p, "text")?;
    if text.trim().is_empty() || text.len() > BODY {
        return Err(err("invalid_group_message"));
    }
    let to = p["to"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 6)
        .ok_or_else(|| err("invalid_group_recipients"))?;
    let all = to == &vec![json!("all")];
    let selected = g["members"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| all || to.contains(&m["handle"]))
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() || (!all && selected.len() != to.len()) {
        return Err(err("invalid_group_recipients"));
    }
    let (references, blocks) = refs(tx, &g, p)?;
    let mid = uuid::Uuid::new_v4().to_string();
    let prompt = format!("{text}{blocks}");
    let mut deliveries = Vec::new();
    for m in &selected {
        deliveries.push(add_delivery(tx, &g, &mid, m, &prompt)?)
    }
    let recipients = selected
        .iter()
        .map(|m| m["handle"].clone())
        .collect::<Vec<_>>();
    let m = json!({"id":mid,"author":"user","body":text,"recipients":recipients,"references":references,"deliveries":deliveries,"createdAt":now()});
    put_message(tx, id, &m)?;
    g["lastRecipients"] = json!(recipients);
    store(tx, &g)?;
    touch(tx, id)
}
fn update_delivery(
    tx: &Transaction<'_>,
    message_id: &str,
    delivery: &str,
    state: &str,
    error: Option<&str>,
    reply: Option<&str>,
) -> Result<()> {
    let (group, session): (String, String) = tx.query_row(
        "SELECT group_id,session_id FROM group_deliveries WHERE id=?",
        [delivery],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut m = message(tx, &group, message_id)?;
    if let Some(d) = m["deliveries"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .find(|d| d["sessionId"] == session)
    {
        d["state"] = json!(state);
        if let Some(error) = error {
            d["error"] = json!(bounded(error, 2048));
        } else {
            d.as_object_mut().unwrap().remove("error");
        }
        if state == "working" && d.get("startedAt").is_none() {
            d["startedAt"] = json!(now());
        }
        if matches!(state, "replied" | "failed" | "stopped") {
            d["finishedAt"] = json!(now());
        }
        if let Some(reply) = reply {
            d["replyId"] = json!(reply);
        }
    }
    put_message(tx, &group, &m)
}

pub(crate) fn queue_changed(tx: &Transaction<'_>, session: &str) -> Result<()> {
    if !exists(tx) {
        return Ok(());
    }
    let rows=tx.prepare("SELECT id,group_id,message_id,queue_id FROM group_deliveries WHERE session_id=? AND state='queued' AND queue_id IS NOT NULL AND queue_id NOT LIKE 'preparing:%'")?.query_map([session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, group, mid, queue) in rows {
        let state: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT state,error FROM chat_queue_items WHERE id=?",
                [&queue],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let result = match state {
            None => Some(("stopped", Some("Removed from the Chat queue".into()))),
            Some((s, e)) if s == "failed" => Some(("failed", e)),
            _ => None,
        };
        if let Some((state, error)) = result {
            tx.execute(
                "UPDATE group_deliveries SET state=? WHERE id=?",
                params![state, id],
            )?;
            update_delivery(tx, &mid, &id, state, error.as_deref(), None)?;
            touch(tx, &group)?;
        }
    }
    Ok(())
}
pub(crate) fn owns_delivery(db: &Database, session: &str, operation: &str) -> Result<bool> {
    let Some(queue) = operation.strip_prefix("queue:") else {
        return Ok(false);
    };
    db.transaction(|tx| {
        if !exists(tx) {
            return Ok(false);
        }
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE queue_id=? AND session_id=?)",
            params![queue, session],
            |r| r.get(0),
        )?)
    })
}
pub(crate) fn before_send(
    db: &Database,
    providers: &Providers,
    session: &str,
    operation: &str,
    text: &str,
) -> Result<Option<String>> {
    let Some(queue) = operation.strip_prefix("queue:") else {
        return Ok(None);
    };
    let found = db.transaction(|tx| {
        if !exists(tx) {
            return Ok(None);
        }
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT id,group_id,state FROM group_deliveries WHERE queue_id=? AND session_id=?",
                params![queue, session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(row)
    })?;
    let Some((did, gid, state)) = found else {
        return Ok(None);
    };
    if state != "queued" {
        return Err(err("group_delivery_not_queued"));
    }
    let (g, m, header) = db.transaction(|tx| {
        let g = load(tx, &gid)?;
        let m = member(&g, session)?.clone();
        let sent: bool = tx.query_row(
            "SELECT header_sent FROM group_members WHERE session_id=?",
            [session],
            |r| r.get(0),
        )?;
        Ok((g, m, !sent))
    })?;
    let readonly = m["mode"] == "read_only";
    let mut prefix = String::new();
    if header {
        let handles = g["members"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["handle"].as_str().map(|h| format!("@{h}")))
            .collect::<Vec<_>>()
            .join(", ");
        prefix = format!(
            "[Group chat]\nYou are @{}. Members: {handles}. Shared folder: {}\n{HEADER_RULES}\n\n",
            string(&m, "handle")?,
            display_path(string(&g, "cwd")?)
        );
    }
    let mut policy = None;
    if readonly {
        let p = crate::group_permissions::verify(db, providers, session, string(&m, "provider")?)?;
        policy = Some(p);
        prefix.push_str(READ_ONLY);
        prefix.push_str("\n\n");
    }
    changes::begin(db, &did, queue, &g, &m)?;
    let before = Value::Null;
    db.transaction(|tx|{if let Some((level,note))=&policy{let mut current=load(tx,&gid)?;let index=current["members"].as_array().unwrap().iter().position(|m|m["sessionId"]==session).unwrap();let drift=current["members"][index]["readOnly"]=="enforced"&&level=="prompt";current["members"][index]["readOnly"]=json!(level);current["members"][index]["readOnlyNote"]=json!(note);current["filesCheck"]=json!({"state":"on"});
if drift{put_message(tx,&gid,&json!({"id":uuid::Uuid::new_v4().to_string(),"author":"system","body":format!("@{}: {note}",string(&m,"handle")?),"createdAt":now()}))?;}store(tx,&current)?;}
 tx.execute("UPDATE group_deliveries SET before_json=?,header=? WHERE id=? AND state='queued'",params![if before.is_null(){None}else{Some(before.to_string())},header,did])?;touch(tx,&gid)})?;
    Ok(Some(format!("{prefix}{text}")))
}
pub(crate) fn sent(db: &Database, session: &str, operation: &str, result: &Value) -> Result<()> {
    let Some(queue) = operation.strip_prefix("queue:") else {
        return Ok(());
    };
    db.transaction(|tx|{if !exists(tx){return Ok(())}
if let Some(turn)=result["turnId"].as_str(){tx.execute("UPDATE group_deliveries SET turn_id=? WHERE queue_id=? AND session_id=? AND state IN ('working','needs_user')",params![turn,queue,session])?;}Ok(())})
}
pub(crate) fn project_event(
    tx: &Transaction<'_>,
    session: &str,
    turn: Option<&str>,
    kind: &str,
    data: &Value,
) -> Result<()> {
    if !exists(tx) {
        return Ok(());
    }
    let Some(link) = session_link(tx, session)? else {
        return Ok(());
    };
    changes::observe(tx, session, turn, kind)?;
    if kind == "message.user" {
        if let Some(q) = data["operationId"]
            .as_str()
            .and_then(|s| s.strip_prefix("queue:"))
        {
            let row:Option<(String,String)>=tx.query_row("SELECT id,message_id FROM group_deliveries WHERE session_id=? AND queue_id=? AND state='queued'",params![session,q],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((id, mid)) = row {
                tx.execute(
                    "UPDATE group_deliveries SET state='working',turn_id=? WHERE id=?",
                    params![turn, id],
                )?;
                tx.execute(
                    "UPDATE group_members SET header_sent=1 WHERE session_id=?",
                    [session],
                )?;
                update_delivery(tx, &mid, &id, "working", None, None)?;
            }
        }
    }
    let row:Option<(String,String,Option<String>,Option<String>)>=tx.query_row("SELECT id,message_id,turn_id,before_json FROM group_deliveries WHERE session_id=? AND state IN ('working','needs_user') ORDER BY rowid LIMIT 1",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some((id, mid, bound, before)) = row {
        if kind == "chat.turn.started" && bound.as_deref().is_some_and(|s| s.starts_with("queue:"))
        {
            tx.execute(
                "UPDATE group_deliveries SET turn_id=? WHERE id=?",
                params![turn, id],
            )?;
        } else if (bound
            .as_deref()
            .zip(turn)
            .is_some_and(|(bound, turn)| !bound.is_empty() && bound == turn))
            || kind == "session.closed"
        {
            if let Some(turn) = turn.filter(|turn| !turn.is_empty()) {
                reply_capture::observe_tool(tx, session, turn, kind, data)?;
            }
            if matches!(
                kind,
                "chat.turn.completed" | "chat.error" | "session.closed"
            ) {
                let stopped = data["cancelled"] == true
                    || matches!(
                        data["status"].as_str(),
                        Some("cancelled" | "canceled" | "interrupted")
                    );
                let failed = kind != "chat.turn.completed"
                    || matches!(data["status"].as_str(), Some("error" | "failed"));
                let state = if stopped {
                    "stopped"
                } else if failed {
                    "failed"
                } else {
                    "replied"
                };
                let reply = if state == "replied" {
                    let body = reply_capture::answer(tx, session, turn.unwrap_or_default())?;
                    let rid = uuid::Uuid::new_v4().to_string();
                    put_message(
                        tx,
                        &link.id,
                        &json!({"id":rid,"author":"member","sessionId":session,"handle":link.handle,"body":bounded(&body,BODY),"replyTo":mid,"outputs":{"files":[],"urls":[],"changed":[]},"createdAt":now()}),
                    )?;
                    let g = load(tx, &link.id)?;
                    let readonly = member(&g, session)?["mode"] == "read_only";
                    tx.execute("INSERT OR IGNORE INTO group_jobs(id,group_id,session_id,turn_id,reply_id,before_json,read_only) VALUES(?,?,?,?,?,?,?)",params![format!("{id}:{}",bound.as_deref().unwrap_or("")),link.id,session,turn,rid,before,readonly])?;
                    Some(rid)
                } else {
                    if let Some(turn) = turn {
                        reply_capture::clear(tx, session, turn)?;
                    }
                    None
                };
                tx.execute(
                    "UPDATE group_deliveries SET state=? WHERE id=?",
                    params![state, id],
                )?;
                update_delivery(
                    tx,
                    &mid,
                    &id,
                    state,
                    if failed {
                        Some(
                            data["message"]
                                .as_str()
                                .unwrap_or("The member failed or disconnected — Resend"),
                        )
                    } else {
                        None
                    },
                    reply.as_deref(),
                )?;
            } else if matches!(
                kind,
                "chat.approval"
                    | "chat.question"
                    | "chat.approval.resolved"
                    | "chat.question.resolved"
            ) {
                let state = if crate::chat_projection::pending_approval_route(tx, session)? == Some("user") {
                    "needs_user"
                } else {
                    "working"
                };
                tx.execute(
                    "UPDATE group_deliveries SET state=? WHERE id=?",
                    params![state, id],
                )?;
                update_delivery(tx, &mid, &id, state, None, None)?;
            }
        }
    }
    if matches!(
        kind,
        "message.user"
            | "chat.turn.started"
            | "chat.turn.completed"
            | "chat.error"
            | "session.closed"
            | "chat.approval"
            | "chat.approval.resolved"
            | "chat.question"
            | "chat.question.resolved"
    ) {
        touch(tx, &link.id)?;
    }
    Ok(())
}

fn gate(session: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>> =
        OnceLock::new();
    let mut gates = GATES.get_or_init(Mutex::default).lock().unwrap();
    gates.retain(|_, g| g.strong_count() > 0);
    if let Some(g) = gates.get(session).and_then(std::sync::Weak::upgrade) {
        return g;
    }
    let g = Arc::new(Mutex::new(()));
    gates.insert(session.into(), Arc::downgrade(&g));
    g
}
fn configure(db: &Database, providers: &Providers, g: &Value, m: &Value) -> Result<bool> {
    let session = string(m, "sessionId")?;
    let configured = db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT configured FROM group_members WHERE session_id=?",
            [session],
            |r| r.get::<_, bool>(0),
        )?)
    })?;
    if configured && providers.chat_is_open(session) {
        return Ok(true);
    }
    let readonly = m["mode"] == "read_only";
    if providers.chat_is_open(session)
        && (readonly || m["model"].is_string())
        && !crate::chat_queue::idle(db, session)?
    {
        return Ok(false);
    }
    if readonly && !configured && providers.chat_is_open(session) {
        providers.chat_stop(session)?;
    }
    if !providers.chat_is_open(session) {
        if readonly {
            crate::group_permissions::prepare(
                db,
                providers,
                session,
                string(m, "provider")?,
                m["model"].as_str(),
            )?;
        }
        if let Err(error) = crate::service::connect_chat_session(db, providers, session) {
            if !readonly
                || m["provider"] != "claude"
                || error
                    .downcast_ref::<ProviderError>()
                    .is_none_or(|e| e.code != "chat_permission_restore_failed")
            {
                return Err(error);
            }
            let saved = db.chat_option_selections(session, "claude")?;
            let rows = saved
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["id"] != "mode" && r["id"] != "roundtable-tools")
                .cloned()
                .collect::<Vec<_>>();
            db.set_chat_option_selections(session, "claude", &json!(rows))?;
            crate::service::connect_chat_session(db, providers, session)?;
        }
    }
    // Model selection is independent from role; the shared helper only applies an explicit advertised model.
    crate::group_permissions::after_connect(
        db,
        providers,
        session,
        string(m, "provider")?,
        m["model"].as_str(),
    )?;
    db.transaction(|tx| {
        if member(&load(tx, string(g, "id")?)?, session).is_err() {
            return Ok(());
        }
        tx.execute(
            "UPDATE group_members SET configured=1 WHERE session_id=?",
            [session],
        )?;
        Ok(())
    })?;
    Ok(true)
}
fn enqueue_delivery(
    db: &Database,
    providers: &Providers,
    queues: &ChatQueues,
    did: &str,
) -> Result<()> {
    let (gid, session) = db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT group_id,session_id FROM group_deliveries WHERE id=?",
            [did],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?)
    })?;
    let lock = gate(&session);
    let _lock = lock.lock().map_err(|_| err("group_lock_poisoned"))?;
    let (g, m, state, queue) = db.transaction(|tx| {
        let g = load(tx, &gid)?;
        let m = member(&g, &session)?.clone();
        let (state, queue) = tx.query_row(
            "SELECT state,queue_id FROM group_deliveries WHERE id=?",
            [did],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )?;
        Ok((g, m, state, queue))
    })?;
    if state != "queued" || queue.is_some() {
        return Ok(());
    }
    if !configure(db, providers, &g, &m)? {
        return Ok(());
    }
    db.transaction(|tx|{let row:Option<String>=tx.query_row("SELECT prompt FROM group_deliveries WHERE id=? AND state='queued' AND queue_id IS NULL",[did],|r|r.get(0)).optional()?;if let Some(prompt)=row{member(&load(tx,&gid)?,&session)?;let q=uuid::Uuid::new_v4().to_string();tx.execute("UPDATE group_deliveries SET queue_id=? WHERE id=?",params![q,did])?;crate::chat_queue::add_owned(tx,&session,&q,&prompt)?;touch(tx,&gid)?;}Ok(())})?;
    queues.try_dispatch(db, providers, &session)
}
fn fail_delivery(db: &Database, did: &str, error: &str) -> Result<()> {
    db.transaction(|tx| {
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT group_id,message_id FROM group_deliveries WHERE id=? AND state='queued'",
                [did],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((gid, mid)) = row {
            tx.execute(
                "UPDATE group_deliveries SET state='failed' WHERE id=?",
                [did],
            )?;
            update_delivery(tx, &mid, did, "failed", Some(error), None)?;
            changes::abandon(tx, did)?;
            touch(tx, &gid)?;
        }
        Ok(())
    })
}
fn enrich(db: &Database, job: &str) -> Result<()> {
    let (gid,session,turn,reply,before,readonly)=db.transaction(|tx|Ok(tx.query_row("SELECT group_id,session_id,turn_id,reply_id,before_json,read_only FROM group_jobs WHERE id=?",[job],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,bool>(5)?)))?))?;
    let (g, m) = db.transaction(|tx| Ok((load(tx, &gid)?, message(tx, &gid, &reply)?)))?;
    let handles = g["members"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["handle"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let items = db
        .chat_items(&session)?
        .into_iter()
        .filter(|i| {
            turn.as_deref()
                .is_some_and(|turn| !turn.is_empty() && i.turn_id.as_deref() == Some(turn))
        })
        .collect::<Vec<_>>();
    let outputs = crate::group_outputs::output(
        string(&g, "cwd")?,
        m["body"].as_str().unwrap_or_default(),
        &items,
        &handles,
    );
    let outputs = crate::group_outputs::validate_files(string(&g, "cwd")?, &outputs);
    let folder_paths = changes::finish(db, &session, turn.as_deref().unwrap_or_default(), &reply, &outputs, &items)?;
    let suggestions =
        crate::group_outputs::suggestions(m["body"].as_str().unwrap_or_default(), &handles)
            .into_iter()
            .filter(|s| Some(s["handle"].as_str().unwrap_or_default()) != m["handle"].as_str())
            .collect::<Vec<_>>();
    let _ = before;
    let changed = if readonly { folder_paths } else { None };
    db.transaction(|tx|{let mut m=message(tx,&gid,&reply)?;m["suggestions"]=json!(suggestions);put_message(tx,&gid,&m)?;
if let Some(paths)=changed.filter(|p|!p.is_empty()){put_message(tx,&gid,&json!({"id":uuid::Uuid::new_v4().to_string(),"author":"system","body":json!({"kind":"read_only_files_changed","paths":paths}).to_string(),"replyTo":reply,"createdAt":now()}))?;}tx.execute("UPDATE group_jobs SET state='done' WHERE id=?",[job])?;touch(tx,&gid)})
}
pub(crate) fn kick(db: &Arc<Database>, providers: &Arc<Providers>, queues: &Arc<ChatQueues>) {
    let rows = db.transaction(|tx| {
        if !exists(tx) {
            return Ok((Vec::new(), Vec::new()));
        }
        let jobs = tx
            .prepare("SELECT id FROM group_jobs WHERE state='pending'")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in &jobs {
            tx.execute("UPDATE group_jobs SET state='working' WHERE id=?", [id])?;
        }
        let deliveries = tx
            .prepare("SELECT id FROM group_deliveries WHERE state='queued' AND queue_id IS NULL")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((jobs, deliveries))
    });
    let Ok((jobs, deliveries)) = rows else { return };
    for job in jobs {
        let db = Arc::clone(db);
        std::thread::spawn(move || {
            if let Err(e) = enrich(&db, &job) {
                eprintln!("Group reply enrichment failed: {e}");
                let _ = db.transaction(|tx| {
                    tx.execute("UPDATE group_jobs SET state='failed' WHERE id=?", [&job])?;
                    Ok(())
                });
            }
        });
    }
    for did in deliveries {
        let (db, providers, queues) = (Arc::clone(db), Arc::clone(providers), Arc::clone(queues));
        std::thread::spawn(move || {
            if let Err(e) = enqueue_delivery(&db, &providers, &queues, &did) {
                let _ = fail_delivery(&db, &did, &e.to_string());
            }
        });
    }
}
pub(crate) fn provider_event(
    db: &Arc<Database>,
    providers: &Arc<Providers>,
    queues: &Arc<ChatQueues>,
    event: &ProviderEvent,
) {
    if matches!(event.kind.as_str(), "chat.turn.completed" | "chat.error" | "session.closed") {
        let db = Arc::clone(db);
        let session = event.session_id.clone();
        std::thread::spawn(move || { let _ = changes::refresh_session(&db, &session); });
    }
    if matches!(
        event.kind.as_str(),
        "chat.turn.completed"
            | "chat.error"
            | "session.closed"
            | "session.ready"
            | "chat.connection"
            | "chat.approval.resolved"
            | "chat.question.resolved"
    ) {
        kick(db, providers, queues)
    }
}
pub(crate) fn session_stopped(db: &Database, session: &str) -> Result<()> {
    db.transaction(|tx|{if !exists(tx){return Ok(())}reply_capture::clear_session(tx,session)?;let rows=tx.prepare("SELECT id,group_id,message_id,queue_id FROM group_deliveries WHERE session_id=? AND state IN ('queued','working','needs_user')")?.query_map([session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;for(id,gid,mid,q)in rows{tx.execute("UPDATE group_deliveries SET state='stopped' WHERE id=?",[&id])?;if let Some(q)=q{tx.execute("DELETE FROM chat_queue_items WHERE id=?",[q])?;}update_delivery(tx,&mid,&id,"stopped",None,None)?;changes::abandon(tx,&id)?;touch(tx,&gid)?;}Ok(())})
}
fn stop(
    db: &Database,
    providers: &Providers,
    queues: &ChatQueues,
    gid: &str,
    mid: Option<&str>,
    handle: Option<&str>,
    session: Option<&str>,
) -> Result<()> {
    let rows=db.transaction(|tx|{let _=load(tx,gid)?;let rows=tx.prepare("SELECT id,message_id,session_id,handle FROM group_deliveries WHERE group_id=? AND state IN ('queued','working','needs_user')")?.query_map([gid],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)})?;
    for (did, message, sid, _h) in rows.into_iter().filter(|(_, m, s, h)| {
        mid.is_none_or(|id| id == m)
            && handle.is_none_or(|v| v == h)
            && session.is_none_or(|v| v == s)
    }) {
        let turn = queues.group_control(db, &sid, |tx| {
            let row: Option<(Option<String>, Option<String>, String)> = tx
                .query_row(
                    "SELECT queue_id,turn_id,state FROM group_deliveries WHERE id=?",
                    [&did],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((queue, turn, state)) = row else {
                return Ok(None);
            };
            if !matches!(state.as_str(), "queued" | "working" | "needs_user") {
                return Ok(None);
            }
            tx.execute(
                "UPDATE group_deliveries SET state='stopped' WHERE id=?",
                [&did],
            )?;
            if let Some(turn) = turn.as_deref() {
                reply_capture::clear(tx, &sid, turn)?;
            }
            if let Some(q) = queue {
                tx.execute("DELETE FROM chat_queue_items WHERE id=?", [q])?;
            }
            update_delivery(tx, &message, &did, "stopped", None, None)?;
            changes::abandon(tx, &did)?;
            touch(tx, gid)?;
            Ok(if state == "queued" { None } else { turn })
        })?;
        if let Some(turn) = turn {
            let _ = providers.chat_cancel(&sid, &turn);
        }
    }
    Ok(())
}
fn receipt(tx: &Transaction<'_>, op: &str, method: &str, value: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![op, method, value.to_string(), now()],
    )?;
    Ok(())
}
fn validate_request(method: &str, p: &Value) -> Result<()> {
    let object = p.as_object().ok_or_else(|| err("invalid_request"))?;
    let specific: &[&str] = match method {
        "group.create" => &["cwd", "projectId", "title", "members", "fromSessionId"],
        "group.list" => &["projectId"],
        "group.read" => &["id", "before", "limit"],
        "group.prerequisites" => &["cwd", "providers"],
        "group.send" => &["id", "text", "to", "references"],
        "group.stop" => &["id", "messageId", "handle"],
        "group.resend" => &["id", "messageId", "handle"],
        "group.member.add" => &["id", "provider", "handle", "model", "mode"],
        "group.member.update" => &["id", "sessionId", "handle", "mode"],
        "group.member.remove" => &["id", "sessionId"],
        "group.rename" => &["id", "title"],
        "group.archive" => &["id", "archived"],
        _ => return Err(err("unknown_method")),
    };
    if object
        .keys()
        .any(|k| !specific.contains(&k.as_str()) && k != "operationId" && k != "expectedRevision")
    {
        return Err(err("invalid_request"));
    }
    for k in [
        "id",
        "projectId",
        "messageId",
        "sessionId",
        "fromSessionId",
        "before",
        "provider",
        "handle",
        "model",
        "mode",
        "cwd",
        "title",
        "text",
    ] {
        if p.get(k).is_some_and(|v| {
            v.as_str().is_none_or(|s| {
                s.is_empty()
                    || s.len()
                        > if k == "text" {
                            BODY
                        } else if k == "cwd" {
                            32 * 1024
                        } else {
                            512
                        }
            })
        }) {
            return Err(err("invalid_request"));
        }
    }
    if p.get("expectedRevision")
        .is_some_and(|v| v.as_i64().is_none_or(|v| v < 0))
        || p.get("limit")
            .is_some_and(|v| v.as_u64().is_none_or(|v| v == 0 || v > 200))
        || p.get("archived").is_some_and(|v| !v.is_boolean())
    {
        return Err(err("invalid_request"));
    }
    if let Some(seats) = p.get("members") {
        let seats = seats
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 6)
            .ok_or_else(|| err("invalid_group_members"))?;
        for seat in seats {
            let obj = seat
                .as_object()
                .ok_or_else(|| err("invalid_group_members"))?;
            if obj
                .keys()
                .any(|k| !matches!(k.as_str(), "provider" | "handle" | "model" | "mode"))
            {
                return Err(err("invalid_group_members"));
            }
            for k in ["provider", "handle", "model", "mode"] {
                if seat
                    .get(k)
                    .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 512))
                {
                    return Err(err("invalid_group_members"));
                }
            }
        }
    }
    if p.get("references")
        .is_some_and(|v| v.as_array().is_none_or(|v| v.len() > 8))
    {
        return Err(err("invalid_group_reference"));
    }
    if let Some(rows) = p["references"].as_array() {
        for r in rows {
            let obj = r
                .as_object()
                .ok_or_else(|| err("invalid_group_reference"))?;
            if obj
                .keys()
                .any(|k| !matches!(k.as_str(), "kind" | "messageId" | "path" | "url"))
            {
                return Err(err("invalid_group_reference"));
            }
            for k in ["kind", "messageId", "path", "url"] {
                if r.get(k)
                    .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 8192))
                {
                    return Err(err("invalid_group_reference"));
                }
            }
        }
    }
    if p.get("providers").is_some_and(|v| {
        v.as_array().is_none_or(|v| {
            v.len() > 64
                || v.iter().any(|v| {
                    v.as_str().is_none_or(|id| {
                        id.len() < 2
                            || id.len() > 32
                            || !id.as_bytes()[0].is_ascii_lowercase()
                            || !id
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
                })
        })
    }) {
        return Err(err("invalid_request"));
    }
    Ok(())
}
pub(crate) fn dispatch(
    db: &Arc<Database>,
    providers: &Arc<Providers>,
    queues: &Arc<ChatQueues>,
    method: &str,
    p: &Value,
    create: &dyn Fn(&Value) -> Result<Value>,
) -> Result<Value> {
    validate_request(method, p)?;
    if method == "group.prerequisites" {
        return Ok(crate::group_prerequisites::check(providers, p));
    }
    if method == "group.read" {
        return read(db, string(p, "id")?, p);
    }
    if method == "group.list" {
        return db.transaction(|tx| {
            let rows = tx
                .prepare("SELECT data FROM groups ORDER BY json_extract(data,'$.updatedAt') DESC")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut out = Vec::new();
            for raw in rows {
                let mut g = hydrate(tx, serde_json::from_str(&raw)?)?;
                if p["projectId"]
                    .as_str()
                    .is_some_and(|id| g["projectId"] != id)
                    || g["archived"] == true
                {
                    continue;
                }
                g.as_object_mut().unwrap().retain(|k, _| {
                    matches!(
                        k.as_str(),
                        "id" | "title" | "projectId" | "worktreePath" | "members" | "updatedAt"
                    )
                });
                for m in members_mut(&mut g) {
                    m.as_object_mut().unwrap().retain(|k, _| {
                        matches!(k.as_str(), "sessionId" | "provider" | "handle" | "state")
                    });
                }
                out.push(g);
            }
            Ok(json!(out))
        });
    }
    if !matches!(
        method,
        "group.create"
            | "group.send"
            | "group.stop"
            | "group.resend"
            | "group.member.add"
            | "group.member.update"
            | "group.member.remove"
            | "group.rename"
            | "group.archive"
    ) {
        return Err(err("unknown_method"));
    }
    let _gate = MUTATIONS.lock().map_err(|_| err("group_lock_poisoned"))?;
    let op = string(p, "operationId")?;
    if op.len() > 512 {
        return Err(err("invalid_operation_id"));
    }
    db.bind_operation(op, method, p)?;
    if let Some(result) = db.operation(op)? {
        return Ok(result);
    }
    let result = if method == "group.create" {
        let g = create_group(db, providers, p, create)?;
        if db.operation(op)?.is_none() {
            db.complete_operation(op, method, &g)?;
        }
        g
    } else {
        let gid = string(p, "id")?;
        let g = db.transaction(|tx| load(tx, gid))?;
        if p["expectedRevision"]
            .as_i64()
            .is_some_and(|r| r != g["revision"].as_i64().unwrap_or(0))
        {
            return Err(err("revision_conflict"));
        }
        if matches!(method, "group.send" | "group.resend" | "group.member.add")
            && g["archived"] == true
        {
            return Err(err("group_archived"));
        }
        if method == "group.send" {
            for r in p["references"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["kind"] == "file")
            {
                let path = string(r, "path")?;
                let checked = crate::group_outputs::validate_files(
                    string(&g, "cwd")?,
                    &json!({"files":[path],"urls":[],"changed":[]}),
                );
                if checked["files"]
                    .as_array()
                    .is_none_or(|rows| rows.len() != 1)
                {
                    return Err(err("invalid_group_file"));
                }
            }
        }
        if method == "group.resend" {
            let sid=db.transaction(|tx|tx.query_row("SELECT session_id FROM group_deliveries WHERE group_id=? AND message_id=? AND handle=? AND state IN ('failed','stopped')",params![gid,p["messageId"].as_str(),p["handle"].as_str()],|r|r.get::<_,String>(0)).optional().map_err(Into::into))?;
            if let Some(sid) = sid {
                let admission = crate::chat_fork::session_admission(db, &sid)?;
                let _admission = admission.lock().map_err(|_| err("group_lock_poisoned"))?;
                if db
                    .session_by_id(&sid)?
                    .is_some_and(|s| s.status == "error" || s.status == "interrupted")
                {
                    providers.chat_stop(&sid)?;
                }
            }
        }
        if method == "group.stop" {
            let mid = string(p, "messageId")?;
            db.transaction(|tx| message(tx, gid, mid))?;
            stop(
                db,
                providers,
                queues,
                gid,
                Some(mid),
                p["handle"].as_str(),
                None,
            )?;
        }
        let mut added = None;
        let mut role_change = None;
        if method == "group.member.add" {
            if g["members"].as_array().unwrap().len() >= 6 {
                return Err(err("group_full"));
            }
            let mut m = make_member(db, providers, &g, p, None, &format!("{op}:member"), create)?;
            clean_member(&mut m);
            let saved =
                db.chat_option_selections(string(&m, "sessionId")?, string(&m, "provider")?)?;
            added = Some((m, saved));
        }
        if matches!(method, "group.member.update" | "group.member.remove") {
            let sid = string(p, "sessionId")?;
            let m = member(&g, sid)?;
            if method == "group.member.remove" {
                stop(db, providers, queues, gid, None, None, Some(sid))?;
            } else {
                if p.get("handle").is_some_and(|v| {
                    v.as_str().is_none_or(|h| {
                        !handle_ok(h)
                            || g["members"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|m| m["sessionId"] != sid && m["handle"] == h)
                    })
                }) {
                    return Err(err("invalid_group_handle"));
                }
                if p.get("mode").is_some() {
                    validate_mode(p)?;
                    if p["mode"] != m["mode"] {
                        if !crate::chat_queue::idle(db, sid)? {
                            return Err(err("group_member_busy"));
                        }
                        providers.chat_stop(sid)?;
                        let saved = db.transaction(|tx| {
                            Ok(tx.query_row(
                                "SELECT saved_options FROM group_members WHERE session_id=?",
                                [sid],
                                |r| r.get::<_, String>(0),
                            )?)
                        })?;
                        if p["mode"] == "default" {
                            db.set_chat_option_selections(
                                sid,
                                string(m, "provider")?,
                                &serde_json::from_str::<Value>(&saved)?,
                            )?;
                        }
                        role_change = Some(sid.to_owned());
                    }
                }
            }
        }
        db.transaction(|tx|{let mut g=load(tx,gid)?;match method{
 "group.send"=>send(tx,gid,p)?,
 "group.resend"=>{let mid=string(p,"messageId")?;let handle=string(p,"handle")?;let (did,sid,state):(String,String,String)=tx.query_row("SELECT id,session_id,state FROM group_deliveries WHERE group_id=? AND message_id=? AND handle=?",params![gid,mid,handle],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||err("group_delivery_not_found"))?;member(&g,&sid)?;if !matches!(state.as_str(),"failed"|"stopped"){return Err(err("group_delivery_not_retryable"))}let old:Option<String>=tx.query_row("SELECT queue_id FROM group_deliveries WHERE id=?",[&did],|r|r.get(0))?;if let Some(q)=old{tx.execute("DELETE FROM chat_queue_items WHERE id=?",[q])?;}tx.execute("UPDATE group_deliveries SET state='queued',queue_id=NULL,turn_id=NULL,before_json=NULL,attempt=attempt+1 WHERE id=?",[&did])?;update_delivery(tx,mid,&did,"queued",None,None)?;touch(tx,gid)?;},
 "group.member.add"=>{let (m,saved)=added.as_ref().unwrap();insert_member(tx,gid,m,saved)?;members_mut(&mut g).push(m.clone());store(tx,&g)?;touch(tx,gid)?;},
 "group.member.update"=>{let sid=string(p,"sessionId")?;let old_handle=member(&g,sid)?["handle"].clone();if let Some(handle)=p.get("handle"){if let Some(last)=g["lastRecipients"].as_array_mut(){for recipient in last{if *recipient==old_handle{*recipient=handle.clone();}}}}let m=members_mut(&mut g).iter_mut().find(|m|m["sessionId"]==sid).unwrap();for k in ["handle","mode"]{if let Some(v)=p.get(k){m[k]=v.clone();}}if role_change.is_some(){m.as_object_mut().unwrap().remove("readOnly");m.as_object_mut().unwrap().remove("readOnlyNote");tx.execute("UPDATE group_members SET configured=0 WHERE session_id=?",[sid])?;}tx.execute("UPDATE group_members SET handle=? WHERE session_id=?",params![m["handle"].as_str(),sid])?;store(tx,&g)?;touch(tx,gid)?;},
 "group.member.remove"=>{let sid=string(p,"sessionId")?;let old_handle=member(&g,sid)?["handle"].clone();if let Some(last)=g["lastRecipients"].as_array_mut(){last.retain(|recipient|*recipient!=old_handle);}members_mut(&mut g).retain(|m|m["sessionId"]!=sid);tx.execute("DELETE FROM group_members WHERE session_id=?",[sid])?;store(tx,&g)?;touch(tx,gid)?;},
 "group.rename"=>{let title=string(p,"title")?;if title.trim().is_empty()||title.len()>512{return Err(err("invalid_group_title"))}g["title"]=json!(title);store(tx,&g)?;touch(tx,gid)?;},
 "group.archive"=>{g["archived"]=json!(p["archived"].as_bool().unwrap_or(true));store(tx,&g)?;touch(tx,gid)?;},
 "group.stop"=>{},_=>return Err(err("unknown_method"))}
 let result=read_tx(tx,gid,&json!({}))?;receipt(tx,op,method,&result)?;Ok(result)})?
    };
    kick(db, providers, queues);
    Ok(result)
}

pub(crate) fn tool_server_resolver(
    db: Arc<Database>,
    inner: crate::providers::ToolServerResolver,
) -> crate::providers::ToolServerResolver {
    Arc::new(move |session, provider| {
        let readonly = db.transaction(|tx| {
            let Some(link) = session_link(tx, session)? else {
                return Ok(false);
            };
            let group = load(tx, &link.id)?;
            Ok(member(&group, session)?["mode"] == "read_only")
        });
        match readonly {
            Ok(false) => inner(session, provider),
            _ => None,
        }
    })
}

pub(crate) fn send_failed(
    tx: &Transaction<'_>,
    session: &str,
    queue: &str,
    error: &str,
) -> Result<()> {
    if !exists(tx) {
        return Ok(());
    }
    let row:Option<(String,String,String)>=tx.query_row("SELECT id,group_id,message_id FROM group_deliveries WHERE session_id=? AND queue_id=? AND state IN ('queued','working','needs_user')",params![session,queue],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((id, gid, mid)) = row {
        tx.execute(
            "UPDATE group_deliveries SET state='failed' WHERE id=?",
            [&id],
        )?;
        update_delivery(tx, &mid, &id, "failed", Some(error), None)?;
        changes::abandon(tx, &id)?;
        touch(tx, &gid)?;
    }
    Ok(())
}
