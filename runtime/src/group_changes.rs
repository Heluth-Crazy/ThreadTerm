//! Durable turn windows and conservative attribution for shared group folders.
use super::{load, message, put_message, string, touch};
use crate::{db::Database, domain::ChatItem};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_OUTPUTS: usize = 64;
#[path = "group_change_retention.rs"]
mod retention;

fn attribution_gate(db: &Database) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<BTreeMap<std::path::PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    gates.retain(|_, gate| Arc::strong_count(gate) > 1);
    gates.entry(db.path().to_owned()).or_default().clone()
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS group_change_turns(id TEXT PRIMARY KEY,delivery_id TEXT,group_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT,cwd TEXT NOT NULL,handle TEXT NOT NULL,read_only INTEGER NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,compared_at TEXT,before_json TEXT,delta_json TEXT,base_outputs TEXT,reply_id TEXT,uncertain INTEGER NOT NULL DEFAULT 1);
        CREATE INDEX IF NOT EXISTS group_change_folder_window ON group_change_turns(cwd,started_at);
        CREATE INDEX IF NOT EXISTS group_change_session_turn ON group_change_turns(session_id,turn_id);
        CREATE TABLE IF NOT EXISTS group_editor_saves(cwd TEXT NOT NULL,path TEXT NOT NULL,saved_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS group_editor_save_window ON group_editor_saves(cwd,saved_at);")?;
    // Recovery never compares today's folder with an interrupted historical turn.
    tx.execute("UPDATE group_change_turns SET ended_at=COALESCE(ended_at,?),compared_at=COALESCE(compared_at,?),before_json=NULL WHERE compared_at IS NULL",params![Utc::now().to_rfc3339(),Utc::now().to_rfc3339()])?;
    Ok(())
}

/// Called on the durable queue worker before handing the prompt to a provider.
pub(super) fn begin(
    db: &Database,
    delivery: &str,
    queue: &str,
    group: &Value,
    member: &Value,
) -> Result<Value> {
    let cwd = string(group, "cwd")?;
    {
        let gate = attribution_gate(db);
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        db.transaction(|tx| {
            // Failed sends may have no completion/enrichment event to clean up.
            prune_outputs(tx, cwd)?;
            tx.execute("INSERT OR REPLACE INTO group_change_turns(id,delivery_id,group_id,session_id,cwd,handle,read_only,started_at) VALUES(?,?,?,?,?,?,?,?)",params![queue,delivery,string(group,"id")?,string(member,"sessionId")?,cwd,string(member,"handle")?,member["mode"]=="read_only",Utc::now().to_rfc3339()])?;
            Ok(())
        })?;
    }
    let before = crate::group_folder::capture(cwd);
    db.transaction(|tx| {
        store_baseline(tx, queue, &before)?;
        Ok(())
    })?;
    Ok(before)
}

fn stored_incomplete(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT before_json FROM group_change_turns WHERE id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(raw
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .as_ref()
        .is_some_and(retention::incomplete_marker))
}

fn store_baseline(tx: &Transaction<'_>, id: &str, before: &Value) -> Result<()> {
    // Retention can invalidate context while this worker is capturing the folder.
    if !stored_incomplete(tx, id)? {
        tx.execute(
            "UPDATE group_change_turns SET before_json=? WHERE id=?",
            params![before.to_string(), id],
        )?;
    }
    Ok(())
}

fn claims_only(base: &Value) -> Value {
    let paths = base["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    json!({
        "files":base["files"].as_array().cloned().unwrap_or_default(),
        "urls":base["urls"].as_array().cloned().unwrap_or_default(),
        "changed":paths,
        "changedIncomplete":true
    })
}

fn prune_outputs(tx: &Transaction<'_>, cwd: &str) -> Result<()> {
    for affected in retention::prune(tx, cwd)?.affected_replies {
        let mut value = message(tx, &affected.group_id, &affected.reply_id)?;
        value["outputs"] = claims_only(&affected.base_outputs);
        put_message(tx, &affected.group_id, &value)?;
        touch(tx, &affected.group_id)?;
    }
    Ok(())
}

/// Projection records timestamps only; filesystem and Git work stay on workers.
pub(super) fn observe(
    tx: &Transaction<'_>,
    session: &str,
    turn: Option<&str>,
    kind: &str,
) -> Result<()> {
    let Some(turn) = turn.filter(|turn| !turn.is_empty()) else {
        if kind == "session.closed" {
            let end = Utc::now().to_rfc3339();
            tx.execute("UPDATE group_change_turns SET ended_at=COALESCE(ended_at,?),compared_at=COALESCE(compared_at,?),before_json=NULL WHERE session_id=? AND ended_at IS NULL",params![end,end,session])?;
        }
        return Ok(());
    };
    if matches!(kind, "message.user" | "chat.turn.started") {
        let active: Option<String> = tx.query_row("SELECT id FROM group_change_turns WHERE session_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",[session],|r|r.get(0)).optional()?;
        if let Some(id) = active {
            tx.execute("UPDATE group_change_turns SET turn_id=? WHERE id=? AND (turn_id IS NULL OR turn_id LIKE 'queue:%')",params![turn,id])?;
        } else if kind == "message.user" {
            let Some(link) = super::session_link(tx, session)? else {
                return Ok(());
            };
            let group = load(tx, &link.id)?;
            // Private member Chat turns can overlap group deliveries, too.
            tx.execute("INSERT OR IGNORE INTO group_change_turns(id,group_id,session_id,turn_id,cwd,handle,read_only,started_at) VALUES(?,?,?,?,?,?,?,?)",params![format!("private:{session}:{turn}"),link.id,session,turn,string(&group,"cwd")?,link.handle,super::member(&group,session)?["mode"]=="read_only",Utc::now().to_rfc3339()])?;
        }
    }
    if matches!(
        kind,
        "chat.turn.completed" | "chat.error" | "session.closed"
    ) {
        tx.execute("UPDATE group_change_turns SET ended_at=? WHERE session_id=? AND turn_id=? AND ended_at IS NULL",params![Utc::now().to_rfc3339(),session,turn])?;
        if kind != "chat.turn.completed" {
            tx.execute("UPDATE group_change_turns SET compared_at=ended_at,before_json=NULL WHERE session_id=? AND turn_id=? AND reply_id IS NULL",params![session,turn])?;
        }
    }
    Ok(())
}

pub(super) fn abandon(tx: &Transaction<'_>, delivery: &str) -> Result<()> {
    let end = Utc::now().to_rfc3339();
    tx.execute("UPDATE group_change_turns SET ended_at=COALESCE(ended_at,?),compared_at=COALESCE(compared_at,?),before_json=NULL WHERE delivery_id=? AND reply_id IS NULL",params![end,end,delivery])?;
    Ok(())
}

pub(super) fn editor_saved(tx: &Transaction<'_>, cwd: &str, path: &str) -> Result<()> {
    // Registered editor roots can enclose a group's more specific folder.
    let full = std::path::Path::new(cwd).join(path);
    let mut stmt=tx.prepare("SELECT DISTINCT cwd FROM group_change_turns WHERE compared_at IS NULL AND (ended_at IS NULL OR delivery_id IS NOT NULL) LIMIT 257")?;
    let folders = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for folder in folders {
        let Ok(relative) = full.strip_prefix(std::path::Path::new(&folder)) else {
            continue;
        };
        tx.execute(
            "INSERT INTO group_editor_saves(cwd,path,saved_at) VALUES(?,?,?)",
            params![
                folder,
                relative.to_string_lossy().replace('\\', "/"),
                Utc::now().to_rfc3339()
            ],
        )?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct Window {
    id: String,
    group: String,
    session: String,
    turn: Option<String>,
    handle: String,
    readonly: bool,
    start: String,
    end: Option<String>,
    reply: Option<String>,
    base: Value,
    delta: Option<Vec<Value>>,
    uncertain: bool,
}

fn overlaps(a: &Window, b: &Window) -> bool {
    a.id != b.id
        && a.session != b.session
        && a.end.as_ref().is_none_or(|end| b.start <= *end)
        && b.end.as_ref().is_none_or(|end| a.start <= *end)
}

fn claims(window: &Window) -> BTreeSet<String> {
    window.base["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Claims always win. Only exclusive folder evidence becomes a definite change.
fn attribute(index: usize, windows: &[Window], saves: &[(String, String)]) -> Value {
    let own = &windows[index];
    let mut output = own.base.clone();
    let claimed = claims(own);
    let mut details: BTreeMap<String, Value> = claimed
        .iter()
        .map(|path| {
            (
                path.clone(),
                json!({"path":path,"status":"changed","evidence":"tool"}),
            )
        })
        .collect();
    let mut possible = BTreeSet::new();
    let mut with = BTreeSet::new();
    let mut incomplete = own.delta.is_none() || own.base["changedIncomplete"] == true;
    if let Some(delta) = &own.delta {
        for file in delta {
            let Some(path) = file["path"].as_str() else {
                continue;
            };
            if claimed.contains(path) {
                if let Some(detail) = details.get_mut(path) {
                    detail["status"] = file["status"].clone();
                    if own.base["commandClaims"]
                        .as_array()
                        .is_some_and(|paths| paths.iter().any(|value| value.as_str() == Some(path)))
                    {
                        detail["evidence"] = json!("folder");
                    }
                }
            }
        }
    }
    if !own.readonly {
        // Consider overlapping snapshots as well: a peer may have observed a
        // write before this turn's baseline was finished.
        for source in windows
            .iter()
            .filter(|source| source.id == own.id || overlaps(own, source))
        {
            let Some(delta) = &source.delta else { continue };
            for file in delta {
                let Some(path) = file["path"].as_str() else {
                    continue;
                };
                if claimed.contains(path) {
                    continue;
                }
                let peers = windows
                    .iter()
                    .filter(|peer| overlaps(source, peer))
                    .collect::<Vec<_>>();
                if claims(source).contains(path)
                    || peers.iter().any(|peer| claims(peer).contains(path))
                {
                    continue;
                }
                let editor = saves.iter().any(|(saved, time)| {
                    saved == path
                        && *time >= source.start
                        && source.end.as_ref().is_none_or(|end| time <= end)
                });
                let mut candidates = peers
                    .iter()
                    .copied()
                    .filter(|peer| !peer.readonly && peer.uncertain)
                    .collect::<Vec<_>>();
                if !source.readonly && (source.uncertain || candidates.is_empty()) {
                    candidates.push(source);
                }
                if !candidates.iter().any(|candidate| candidate.id == own.id) {
                    continue;
                }
                if candidates.len() == 1 && !editor && source.id == own.id {
                    details.insert(path.into(), file.clone());
                } else if candidates.len() > 1 || editor {
                    possible.insert(path.to_owned());
                    for candidate in candidates.iter().filter(|candidate| candidate.id != own.id) {
                        with.insert(candidate.handle.clone());
                    }
                    if editor {
                        with.insert("you".into());
                    }
                }
            }
        }
    }
    if details.len() > MAX_OUTPUTS || possible.len() > MAX_OUTPUTS {
        incomplete = true;
    }
    output["changed"] = json!(details.keys().take(MAX_OUTPUTS).collect::<Vec<_>>());
    output["changedDetails"] = json!(details.into_values().take(MAX_OUTPUTS).collect::<Vec<_>>());
    output["possiblyChanged"] = json!(possible.into_iter().take(MAX_OUTPUTS).collect::<Vec<_>>());
    output["possiblyChangedWith"] = json!(with.into_iter().take(12).collect::<Vec<_>>());
    output["changedIncomplete"] = json!(incomplete);
    output
}

fn windows(db: &Database, cwd: &str, start: &str, end: &str) -> Result<Vec<Window>> {
    db.transaction(|tx| {
        let mut stmt=tx.prepare("SELECT id,group_id,session_id,turn_id,handle,read_only,started_at,COALESCE(compared_at,ended_at),reply_id,base_outputs,delta_json,uncertain FROM group_change_turns WHERE cwd=? AND started_at<=? AND COALESCE(compared_at,ended_at,'9999')>=? ORDER BY started_at,id LIMIT 257")?;
        let values=stmt.query_map(params![cwd,end,start],|r|Ok(Window{id:r.get(0)?,group:r.get(1)?,session:r.get(2)?,turn:r.get(3)?,handle:r.get(4)?,readonly:r.get(5)?,start:r.get(6)?,end:r.get(7)?,reply:r.get(8)?,base:r.get::<_,Option<String>>(9)?.and_then(|v|serde_json::from_str(&v).ok()).unwrap_or(json!({"files":[],"urls":[],"changed":[]})),delta:r.get::<_,Option<String>>(10)?.and_then(|v|serde_json::from_str(&v).ok()),uncertain:r.get(11)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(values)
    })
}

pub(super) fn finish(
    db: &Database,
    session: &str,
    turn: &str,
    reply: &str,
    base: &Value,
    items: &[ChatItem],
) -> Result<Option<Vec<String>>> {
    let row: Option<(String,String,String,Option<String>)> = db.transaction(|tx|Ok(tx.query_row("SELECT id,cwd,started_at,before_json FROM group_change_turns WHERE session_id=? AND turn_id=? ORDER BY started_at DESC LIMIT 1",params![session,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?))?;
    let Some((id, cwd, start, before)) = row else {
        let output = claims_only(base);
        db.transaction(|tx| {
            let group: String = tx.query_row(
                "SELECT group_id FROM group_messages WHERE id=?",
                [reply],
                |r| r.get(0),
            )?;
            let mut value = message(tx, &group, reply)?;
            value["outputs"] = output.clone();
            put_message(tx, &group, &value)?;
            Ok(())
        })?;
        return Ok(None);
    };
    let before = before
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .unwrap_or(Value::Null);
    let attribution_incomplete = retention::incomplete_marker(&before);
    let mut delta = if attribution_incomplete {
        None
    } else {
        crate::review::completed_group_turn_changes(db, session, turn, &cwd)
            .or_else(|| crate::group_folder::diff(&before, &crate::group_folder::capture(&cwd)))
    };
    let end = Utc::now().to_rfc3339();
    let mut base = base.clone();
    if attribution_incomplete {
        base["changedIncomplete"] = json!(true);
    }
    base["commandClaims"] = json!(crate::group_outputs::command_claims(&cwd, items));
    let gate = attribution_gate(db);
    let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
    db.transaction(|tx| {
        // A different completion can evict overlap evidence during our capture.
        if stored_incomplete(tx, &id)? {
            delta = None;
            base["changedIncomplete"] = json!(true);
        }
        tx.execute("UPDATE group_change_turns SET compared_at=?,ended_at=COALESCE(ended_at,?),delta_json=?,base_outputs=?,reply_id=?,uncertain=?,before_json=NULL WHERE id=?",params![end,end,delta.as_ref().map(|v|json!(v).to_string()),base.to_string(),reply,crate::group_outputs::could_write_unclaimed(items) || base["changedIncomplete"] == true,id])?;
        Ok(())
    })?;
    refresh_locked(db, &cwd, &start, &end)?;
    Ok(retention::delta_paths(delta.as_deref()))
}

fn refresh_locked(db: &Database, cwd: &str, start: &str, end: &str) -> Result<()> {
    let targets = windows(db, cwd, start, end)?;
    let earliest = targets
        .iter()
        .map(|window| window.start.as_str())
        .min()
        .unwrap_or(start);
    let latest = targets
        .iter()
        .filter_map(|window| window.end.as_deref())
        .max()
        .unwrap_or(end)
        .max(end);
    let mut turns = windows(db, cwd, earliest, latest)?;
    let capped = turns.len() > 256;
    // Running/private peers have no enrichment job; inspect their persisted own
    // turn events without filesystem work or holding the SQLite transaction.
    for peer in &mut turns {
        if peer.reply.is_none() {
            if let Some(turn) = &peer.turn {
                let items = db
                    .chat_items(&peer.session)?
                    .into_iter()
                    .filter(|item| item.turn_id.as_ref() == Some(turn))
                    .collect::<Vec<_>>();
                peer.base = crate::group_outputs::output(cwd, "", &items, &[]);
                peer.uncertain = peer.end.is_none()
                    || crate::group_outputs::could_write_unclaimed(&items)
                    || peer.base["changedIncomplete"] == true;
            }
        }
    }
    let saves=db.transaction(|tx|{let mut stmt=tx.prepare("SELECT path,saved_at FROM group_editor_saves WHERE cwd=? AND saved_at>=? AND saved_at<=? LIMIT 20001")?;let rows=stmt.query_map(params![cwd,earliest,latest],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)})?;
    let mut updates = Vec::new();
    for (index, window) in turns.iter().enumerate().filter(|(_, window)| {
        window.reply.is_some() && targets.iter().any(|target| target.id == window.id)
    }) {
        let mut output = if capped || saves.len() > 20000 {
            let mut own = window.clone();
            own.delta = None;
            attribute(0, &[own], &[])
        } else {
            attribute(index, &turns, &saves)
        };
        if capped || saves.len() > 20000 {
            output["changedIncomplete"] = json!(true);
        }
        output = crate::group_outputs::validate_files(cwd, &output);
        updates.push((window.group.clone(), window.reply.clone().unwrap(), output));
    }
    db.transaction(|tx| {
        for (group, reply, outputs) in updates {
            let mut value = message(tx, &group, &reply)?;
            if value["outputs"] != outputs {
                value["outputs"] = outputs;
                put_message(tx, &group, &value)?;
                touch(tx, &group)?;
            }
        }
        prune_outputs(tx, cwd)?;
        Ok(())
    })?;
    Ok(())
}

pub(super) fn refresh_session(db: &Database, session: &str) -> Result<()> {
    let row:Option<(String,String)>=db.transaction(|tx|Ok(tx.query_row("SELECT cwd,started_at FROM group_change_turns WHERE session_id=? ORDER BY started_at DESC LIMIT 1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?))?;
    if let Some((cwd, start)) = row {
        let gate = attribution_gate(db);
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        refresh_locked(db, &cwd, &start, &Utc::now().to_rfc3339())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(id: &str, claims: &[&str], uncertain: bool, readonly: bool) -> Window {
        Window {
            id: id.into(),
            group: "g".into(),
            session: id.into(),
            turn: Some(id.into()),
            handle: id.into(),
            readonly,
            start: "1".into(),
            end: Some("3".into()),
            reply: Some(id.into()),
            base: json!({"files":[],"urls":[],"changed":claims}),
            delta: Some(vec![
                json!({"path":"a.txt","status":"added","evidence":"folder"}),
                json!({"path":"b.txt","status":"deleted","evidence":"folder"}),
            ]),
            uncertain,
        }
    }
    #[test]
    fn single_turn_folder_catches_writes_and_deletions() {
        let result = attribute(0, &[window("a", &[], true, false)], &[]);
        assert_eq!(result["changed"], json!(["a.txt", "b.txt"]));
        assert_eq!(result["changedDetails"][1]["status"], "deleted");
    }
    #[test]
    fn overlapping_claims_never_cross_attribute() {
        let turns = [
            window("a", &["a.txt"], false, false),
            window("b", &["b.txt"], false, false),
        ];
        assert_eq!(attribute(0, &turns, &[])["changed"], json!(["a.txt"]));
        assert_eq!(attribute(1, &turns, &[])["changed"], json!(["b.txt"]));
    }
    #[test]
    fn claimed_editor_and_shell_writer_get_exclusive_paths() {
        let turns = [
            window("a", &["a.txt"], false, false),
            window("b", &[], true, false),
        ];
        assert_eq!(attribute(0, &turns, &[])["changed"], json!(["a.txt"]));
        assert_eq!(attribute(1, &turns, &[])["changed"], json!(["b.txt"]));
    }
    #[test]
    fn concurrent_shell_writers_preserve_possibilities_on_both() {
        let turns = [window("a", &[], true, false), window("b", &[], true, false)];
        for index in 0..2 {
            let result = attribute(index, &turns, &[]);
            assert_eq!(result["changed"], json!([]));
            assert_eq!(result["possiblyChanged"], json!(["a.txt", "b.txt"]));
        }
    }
    #[test]
    fn readonly_only_claims_and_incomplete_keeps_tool_evidence() {
        let mut own = window("a", &["a.txt"], true, true);
        assert_eq!(
            attribute(0, &[own.clone()], &[])["changed"],
            json!(["a.txt"])
        );
        own.delta = None;
        let result = attribute(0, &[own], &[]);
        assert_eq!(result["changed"], json!(["a.txt"]));
        assert_eq!(result["changedIncomplete"], true);
    }
    #[test]
    fn tool_claim_without_own_folder_delta_has_unknown_status() {
        for delta in [None, Some(Vec::new())] {
            let mut own = window("a", &["tool-only.txt"], false, false);
            own.delta = delta;
            let mut peer = window("b", &[], true, false);
            peer.delta = Some(vec![
                json!({"path":"tool-only.txt","status":"added","evidence":"folder"}),
            ]);
            let result = attribute(0, &[own, peer], &[]);
            assert_eq!(
                result["changedDetails"],
                json!([
                    {"path":"tool-only.txt","status":"changed","evidence":"tool"}
                ])
            );
        }
    }
    #[test]
    fn retention_marker_survives_a_late_baseline_capture() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        initialize(&tx).unwrap();
        tx.execute("INSERT INTO group_change_turns(id,group_id,session_id,cwd,handle,read_only,started_at,before_json) VALUES('q','g','s','folder','member',0,'01',?)", [r#"{"attributionIncomplete":true}"#]).unwrap();
        store_baseline(&tx, "q", &json!({"complete":true,"files":[]})).unwrap();
        assert!(stored_incomplete(&tx, "q").unwrap());
    }
    #[test]
    fn claims_only_fallback_preserves_the_output_byte_bound() {
        let paths = (0..MAX_OUTPUTS)
            .map(|index| format!("{index:02}-{}.txt", "a".repeat(900)))
            .collect::<Vec<_>>();
        let base = json!({"files":[],"urls":[],"changed":paths});
        let output = claims_only(&base);
        assert_eq!(output["changed"], base["changed"]);
        assert!(output["changedDetails"].is_null());
        assert!(serde_json::to_vec(&output).unwrap().len() < 64 * 1024);
    }
    #[test]
    fn editor_save_does_not_become_members_definite_change() {
        let result = attribute(
            0,
            &[window("a", &[], true, false)],
            &[("a.txt".into(), "2".into())],
        );
        assert_eq!(result["changed"], json!(["b.txt"]));
        assert_eq!(result["possiblyChanged"], json!(["a.txt"]));
        assert_eq!(result["possiblyChangedWith"], json!(["you"]));
    }
}
