use crate::db::CHAT_TIMELINE_STRIDE;
use crate::domain::{ChatItem, ChatTurnOrigin, NativeForkAnchor};
use crate::providers::{NativeChatHistory, NativeChatMessage, NativeChatMessageRole};
use anyhow::{anyhow, bail, Result};
use chrono::Utc;
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) const METHOD: &str = "chat.refreshHistory";

struct LocalItem {
    id: String,
    turn_id: Option<String>,
    sequence: i64,
    role: String,
    anchor_thread: Option<String>,
    anchor_turn: Option<String>,
    local_command: bool,
}

pub(crate) struct HistoryInsertion {
    sequence: i64,
    item: ChatItem,
}

/// What one refresh writes: rows to add, and the rows of turns an earlier,
/// text-only refresh imported, which the full transcript of the same turn
/// replaces in place.
#[derive(Default)]
pub(crate) struct HistoryChanges {
    additions: Vec<HistoryInsertion>,
    replaced: Vec<String>,
}

impl HistoryChanges {
    pub(crate) fn is_empty(&self) -> bool {
        self.additions.is_empty() && self.replaced.is_empty()
    }
}

/// Match turns by native coordinates. A reloaded app-server can assign
/// reconstructed item IDs, while the explicit native turn ID remains stable.
///
/// A turn this chat does not have yet arrives with everything the other client
/// showed: progress notes, tools, reasoning, and how it ended (a stopped or
/// failed turn included). The text-only projection is the fallback when the
/// provider has no transcript for that turn.
pub(crate) fn plan(
    tx: &Transaction<'_>,
    session_id: &str,
    native_id: &str,
    history: &NativeChatHistory,
) -> Result<HistoryChanges> {
    let messages = &history.messages;
    let eligible: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sessions WHERE id=?1 AND native_id=?2 AND provider='codex'
              AND mode='chat' AND read_only=0 AND (status='idle' OR released=1)
              AND NOT EXISTS(SELECT 1 FROM metadata WHERE key=?3)
        )",
        params![
            session_id,
            native_id,
            format!("chat.integrity:{session_id}")
        ],
        |row| row.get(0),
    )?;
    if !eligible || (messages.is_empty() && history.transcript.is_empty()) {
        return Ok(HistoryChanges::default());
    }
    let mut statement = tx.prepare(
        "SELECT id,turn_id,timeline_seq,json_extract(data,'$.role'),
                json_extract(data,'$.forkAnchor.nativeId'),json_extract(data,'$.forkAnchor.turnId'),
                CASE WHEN json_extract(data,'$.parts[0].data.steered')=1 THEN NULL
                     ELSE json_extract(data,'$.parts[0].text') END
         FROM chat_items WHERE session_id=?1 ORDER BY timeline_seq,id",
    )?;
    let local = statement
        .query_map([session_id], |row| {
            Ok(LocalItem {
                id: row.get(0)?,
                turn_id: row.get(1)?,
                sequence: row.get(2)?,
                role: row.get(3)?,
                anchor_thread: row.get(4)?,
                anchor_turn: row.get(5)?,
                // Commands Codex dispatch_slash answers without a native turn. Native
                // commands and skills keep the conservative unbound-user fence,
                // including slash text forwarded verbatim through native steering
                // (the query reads no text for steered rows).
                local_command: row
                    .get::<_, Option<String>>(6)?
                    .is_some_and(|text| crate::providers::codex_slash_starts_no_native_turn(&text)),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let history_prefix = format!("{session_id}:history:");
    let rows_by_id = local
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let mut public_to_native = HashMap::new();
    for row in &local {
        let Some(public_turn) = row.turn_id.as_deref() else {
            continue;
        };
        let native_turn = public_turn.strip_prefix(&history_prefix).or_else(|| {
            (row.anchor_thread.as_deref() == Some(native_id))
                .then_some(row.anchor_turn.as_deref())
                .flatten()
        });
        if let Some(native_turn) = native_turn {
            bind_turn(&mut public_to_native, public_turn, native_turn)?;
        }
    }
    let mut message_order = Vec::new();
    let mut messages_by_turn = HashMap::<&str, Vec<&NativeChatMessage>>::new();
    for message in messages {
        if message.thread_id != native_id || message.turn_id.is_empty() {
            bail!("invalid_history_transcript");
        }
        let turn = message.turn_id.as_str();
        if message_order.last() != Some(&turn) {
            if messages_by_turn.contains_key(turn) {
                bail!("invalid_history_transcript");
            }
            message_order.push(turn);
        }
        messages_by_turn.entry(turn).or_default().push(message);
        if message.role != NativeChatMessageRole::User {
            continue;
        }
        if let Some(client) = &message.client_id {
            let user_id = format!("{session_id}:user:{client}");
            if let Some(row) = rows_by_id.get(user_id.as_str()) {
                if let Some(public_turn) = row.turn_id.as_deref() {
                    bind_turn(&mut public_to_native, public_turn, &message.turn_id)?;
                }
            }
        }
    }
    // Every finished turn has transcript items (its boundary at least), so the
    // transcript gives the native order; messages alone are the fallback.
    let mut turn_order = Vec::new();
    let mut transcript_by_turn = HashMap::<&str, Vec<&ChatItem>>::new();
    for item in &history.transcript {
        let Some(turn) = item.turn_id.as_deref().filter(|turn| !turn.is_empty()) else {
            continue;
        };
        if turn_order.last() != Some(&turn) {
            if transcript_by_turn.contains_key(turn) {
                bail!("invalid_history_transcript");
            }
            turn_order.push(turn);
        }
        transcript_by_turn.entry(turn).or_default().push(item);
    }
    if turn_order.is_empty() {
        turn_order = message_order;
    }
    let native_of = |row: &LocalItem| {
        row.turn_id
            .as_deref()
            .and_then(|turn| public_to_native.get(turn))
            .copied()
    };
    let unbound = |row: &LocalItem| row.role == "user" && !row.local_command && native_of(row).is_none();
    // Turns an earlier refresh imported as bare text come back in full, once.
    // Only when no local prompt is unbound: a fenced gap drops its imports,
    // and the old rows must not go with them.
    let earlier_refresh = format!("{session_id}:history-refresh:");
    let mut replaced_turns = HashSet::new();
    if !local.iter().any(|row| unbound(row)) {
        let mut rows_by_turn = HashMap::<&str, Vec<&LocalItem>>::new();
        for row in &local {
            if let Some(native_turn) = native_of(row) {
                rows_by_turn.entry(native_turn).or_default().push(row);
            }
        }
        replaced_turns.extend(rows_by_turn.into_iter().filter_map(|(turn, rows)| {
            (transcript_by_turn.contains_key(turn)
                && rows.iter().all(|row| row.id.starts_with(&earlier_refresh)))
            .then_some(turn)
        }));
    }
    let (replaced_rows, kept): (Vec<&LocalItem>, Vec<&LocalItem>) = local
        .iter()
        .partition(|row| native_of(row).is_some_and(|turn| replaced_turns.contains(turn)));
    let mut spans = HashMap::<&str, (i64, i64)>::new();
    let mut unbound_users = Vec::new();
    for row in &kept {
        match native_of(row) {
            Some(native_turn) => {
                let span = spans
                    .entry(native_turn)
                    .or_insert((row.sequence, row.sequence));
                span.1 = row.sequence;
            }
            None if unbound(row) => unbound_users.push(row.sequence),
            None => {}
        }
    }
    let mut changes = HistoryChanges {
        additions: Vec::new(),
        replaced: replaced_rows.iter().map(|row| row.id.clone()).collect(),
    };
    let mut waiting = Vec::new();
    let mut previous_anchor = 0;
    let created_at = Utc::now().to_rfc3339();
    let mut ids = local.iter().map(|row| row.id.clone()).collect::<HashSet<_>>();
    let mut budget = crate::chat_repair::MAX_HISTORY_BYTES;
    for native_turn in turn_order {
        if let Some(&(first, last)) = spans.get(native_turn) {
            if first <= previous_anchor {
                // Existing native anchors moved or conflict. Refresh is
                // append-only, so keep the local transcript intact.
                return Ok(HistoryChanges::default());
            }
            let before = kept.partition_point(|row| row.sequence < first);
            let prior = before.checked_sub(1).map_or(0, |i| kept[i].sequence);
            let fenced = unbound_users
                .iter()
                .any(|&seq| seq > previous_anchor && seq < first);
            if !fenced {
                place(&mut changes.additions, &mut waiting, prior, Some(first))?;
            }
            waiting.clear();
            previous_anchor = last;
        } else {
            let turn_messages = messages_by_turn.get(native_turn).map(Vec::as_slice).unwrap_or_default();
            let items = transcript_by_turn
                .get(native_turn)
                .and_then(|items| full_turn(session_id, &created_at, items, &ids, &mut budget))
                .unwrap_or_else(|| text_turn(session_id, &created_at, turn_messages));
            ids.extend(items.iter().map(|item| item.id.clone()));
            waiting.extend(items);
        }
    }
    if !unbound_users.iter().any(|&seq| seq > previous_anchor) {
        place(
            &mut changes.additions,
            &mut waiting,
            kept.last().map_or(0, |row| row.sequence),
            None,
        )?;
    }
    Ok(changes)
}

fn bind_turn<'a>(
    bindings: &mut HashMap<&'a str, &'a str>,
    public: &'a str,
    native: &'a str,
) -> Result<()> {
    if bindings
        .insert(public, native)
        .is_some_and(|previous| previous != native)
    {
        bail!("invalid_history_transcript");
    }
    Ok(())
}

/// A native turn as imported history shows it, scoped to this session. None
/// when an item cannot be stored as is, or the turn would pass the history
/// size limit; the caller then falls back to the turn's text.
fn full_turn(
    session_id: &str,
    created_at: &str,
    sources: &[&ChatItem],
    taken: &HashSet<String>,
    budget: &mut usize,
) -> Option<Vec<ChatItem>> {
    let mut items = Vec::with_capacity(sources.len());
    let mut fresh = HashSet::new();
    for source in sources {
        if source.id.is_empty()
            || source.id == "unknown"
            || !matches!(source.role.as_str(), "user" | "assistant" | "tool" | "system")
            || source.parts.iter().any(|part| crate::chat_repair::validate_part(part).is_err())
        {
            return None;
        }
        let mut item = crate::db::scoped_history_item(session_id, source);
        if taken.contains(&item.id) || !fresh.insert(item.id.clone()) {
            return None;
        }
        item.created_at = created_at.to_owned();
        items.push(item);
    }
    let size = serde_json::to_vec(&items).ok()?.len();
    *budget = budget.checked_sub(size)?;
    Some(items)
}

/// The fallback: a turn's messages as text, progress notes included; the
/// last reply that is not a progress note carries how the turn ended.
fn text_turn(session_id: &str, created_at: &str, turn: &[&NativeChatMessage]) -> Vec<ChatItem> {
    let selected = turn.iter().enumerate().filter(|(_, message)| !message.text.is_empty());
    let final_reply = selected
        .clone()
        .filter(|(_, message)| {
            message.role == NativeChatMessageRole::Assistant && message.phase.as_deref() != Some("commentary")
        })
        .map(|(index, _)| index)
        .last();
    selected
        .map(|(index, message)| project(session_id, created_at, message, index, final_reply == Some(index)))
        .collect()
}

fn project(
    session_id: &str,
    created_at: &str,
    message: &NativeChatMessage,
    index: usize,
    final_reply: bool,
) -> ChatItem {
    let assistant = message.role == NativeChatMessageRole::Assistant;
    let mut part = json!({"type":"text","text":message.text});
    if let Some(phase) = &message.phase {
        part["phase"] = json!(phase);
    }
    // R8: this fallback rebuilds the turn from native messages alone.
    if !assistant && crate::delegation_wake::is_automatic_text(&message.text) {
        part["automatic"] = json!(true);
    }
    ChatItem {
        id: format!("{session_id}:history-refresh:{}:{index}", message.turn_id),
        role: if assistant { "assistant" } else { "user" }.into(),
        parts: vec![part],
        created_at: created_at.into(),
        turn_id: Some(format!("{session_id}:history:{}", message.turn_id)),
        elapsed_ms: None,
        turn_status: final_reply.then_some(message.turn_status),
        turn_origin: Some(ChatTurnOrigin::History),
        fork_anchor: final_reply.then(|| NativeForkAnchor {
            native_id: message.thread_id.clone(),
            turn_id: Some(message.turn_id.clone()),
            message_id: Some(message.item_id.clone()),
            entry_id: None,
        }),
        turn_model: None,
        turn_usage: None,
        turn_review: None,
    }
}

fn place(
    additions: &mut Vec<HistoryInsertion>,
    waiting: &mut Vec<ChatItem>,
    prior: i64,
    next: Option<i64>,
) -> Result<()> {
    if waiting.is_empty() {
        return Ok(());
    }
    let stride = next.map_or(CHAT_TIMELINE_STRIDE, |next| {
        (next - prior) / (waiting.len() as i64 + 1)
    });
    if stride < 1 {
        bail!("history_order_exhausted");
    }
    let mut sequence = prior;
    for item in waiting.drain(..) {
        sequence = sequence
            .checked_add(stride)
            .ok_or_else(|| anyhow!("history_order_exhausted"))?;
        additions.push(HistoryInsertion { sequence, item });
    }
    Ok(())
}

pub(crate) fn commit(
    tx: &Transaction<'_>,
    session_id: &str,
    operation_id: &str,
    changes: HistoryChanges,
) -> Result<Value> {
    let changed = !changes.is_empty();
    let added = changes.additions.len();
    for id in &changes.replaced {
        tx.execute(
            "DELETE FROM chat_items WHERE session_id=?1 AND id=?2",
            params![session_id, id],
        )?;
    }
    for HistoryInsertion { sequence, item } in changes.additions {
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at,timeline_seq) VALUES (?1,?2,?3,'history',?4,?5,?6)",
            params![item.id, session_id, item.turn_id, serde_json::to_string(&item)?, item.created_at, sequence],
        )?;
    }
    let now = Utc::now().to_rfc3339();
    if changed {
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?1,?2)",
            params![
                json!({"kind":"chat.history.refresh","sessionId":session_id}).to_string(),
                now
            ],
        )?;
    }
    let result = json!({"added":added});
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES (?1,?2,?3,?4)",
        params![operation_id, METHOD, result.to_string(), now],
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CreateSession, Database};
    use crate::domain::NativeTurnStatus;

    fn fixture() -> (tempfile::TempDir, Database, String) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("refresh.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: Some("native"),
                operation_id: "create",
            })
            .unwrap()
            .id;
        db.transaction(|tx| {
            tx.execute("UPDATE sessions SET status='idle' WHERE id=?", [&session])?;
            Ok(())
        })
        .unwrap();
        (root, db, session)
    }

    fn messages(turn: &str) -> Vec<NativeChatMessage> {
        [
            NativeChatMessageRole::User,
            NativeChatMessageRole::Assistant,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, role)| NativeChatMessage {
            thread_id: "native".into(),
            turn_id: turn.into(),
            item_id: format!("{turn}-{index}"),
            client_id: None,
            role,
            phase: None,
            text: format!("{turn}-{index}"),
            turn_status: NativeTurnStatus::Completed,
        })
        .collect()
    }

    fn refresh(
        db: &Database,
        session: &str,
        operation: &str,
        messages: &[NativeChatMessage],
    ) -> Value {
        refresh_history(db, session, operation, &NativeChatHistory { messages: messages.to_vec(), transcript: Vec::new() })
    }

    fn refresh_history(db: &Database, session: &str, operation: &str, history: &NativeChatHistory) -> Value {
        db.transaction(|tx| {
            let changes = plan(tx, session, "native", history)?;
            commit(tx, session, operation, changes)
        })
        .unwrap()
    }

    fn item(id: &str, turn: &str, role: &str, part: Value) -> ChatItem {
        ChatItem {
            id: id.into(),
            role: role.into(),
            parts: vec![part],
            created_at: "2026-11-17T00:00:00Z".into(),
            turn_id: Some(turn.into()),
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        }
    }

    /// A Codex app turn as `thread/read` projects it: prompt, a progress note,
    /// a command, the answer and the boundary that says how it ended.
    fn native_turn(turn: &str, status: NativeTurnStatus, client: Option<&str>) -> NativeChatHistory {
        let user = NativeChatMessage {
            thread_id: "native".into(),
            turn_id: turn.into(),
            item_id: format!("{turn}-user"),
            client_id: client.map(Into::into),
            role: NativeChatMessageRole::User,
            phase: None,
            text: format!("{turn} prompt"),
            turn_status: status,
        };
        let note = NativeChatMessage {
            item_id: format!("{turn}-note"),
            role: NativeChatMessageRole::Assistant,
            phase: Some("commentary".into()),
            text: format!("{turn} looking at the parser"),
            client_id: None,
            ..user.clone()
        };
        let mut transcript = vec![
            item(&format!("{turn}-user"), turn, "user", json!({"type":"text","text":format!("{turn} prompt")})),
            item(&format!("{turn}-note"), turn, "assistant", json!({"type":"text","text":format!("{turn} looking at the parser"),"phase":"commentary"})),
            item(&format!("{turn}-command"), turn, "tool", json!({"type":"tool","toolName":"commandExecution","toolId":format!("{turn}-command"),"status":"completed","data":{"command":"cargo test"}})),
        ];
        let mut messages = vec![user, note];
        if status == NativeTurnStatus::Completed {
            messages.push(NativeChatMessage {
                item_id: format!("{turn}-answer"),
                phase: Some("final_answer".into()),
                text: format!("{turn} fixed"),
                ..messages[1].clone()
            });
            let mut answer = item(&format!("{turn}-answer"), turn, "assistant", json!({"type":"text","text":format!("{turn} fixed"),"phase":"final_answer"}));
            answer.turn_status = Some(status);
            transcript.push(answer);
        } else {
            let mut boundary = item(&format!("turn:{turn}:boundary"), turn, "assistant", json!({"type":"error","data":{"native":{"message":"stopped"}}}));
            boundary.turn_status = Some(status);
            transcript.push(boundary);
        }
        NativeChatHistory { messages, transcript }
    }

    fn join(turns: &[NativeChatHistory]) -> NativeChatHistory {
        NativeChatHistory {
            messages: turns.iter().flat_map(|turn| turn.messages.clone()).collect(),
            transcript: turns.iter().flat_map(|turn| turn.transcript.clone()).collect(),
        }
    }

    fn texts(db: &Database, session: &str) -> Vec<String> {
        db.chat_items(session)
            .unwrap()
            .iter()
            .map(|item| {
                let part = &item.parts[0];
                part["text"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    part["type"].as_str().unwrap_or_default().to_owned()
                })
            })
            .collect()
    }

    #[test]
    fn a_turn_from_the_other_client_arrives_with_its_progress_tools_and_how_it_ended() {
        let (_root, db, session) = fixture();
        let history = join(&[
            native_turn("fixed", NativeTurnStatus::Completed, None),
            native_turn("stopped", NativeTurnStatus::Interrupted, None),
            native_turn("failed", NativeTurnStatus::Failed, None),
        ]);
        assert_eq!(refresh_history(&db, &session, "return", &history), json!({"added":12}));
        assert_eq!(
            texts(&db, &session),
            [
                "fixed prompt", "fixed looking at the parser", "tool", "fixed fixed",
                "stopped prompt", "stopped looking at the parser", "tool", "error",
                "failed prompt", "failed looking at the parser", "tool", "error",
            ]
        );
        let items = db.chat_items(&session).unwrap();
        assert!(items.iter().all(|item| item.turn_origin == Some(ChatTurnOrigin::History)));
        assert!(items.iter().all(|item| item.id.starts_with(&format!("{session}:history:"))));
        let ended = |turn: &str| items.iter().rev().find(|item| item.turn_id.as_deref() == Some(format!("{session}:history:{turn}").as_str())).unwrap().turn_status;
        assert_eq!(ended("fixed"), Some(NativeTurnStatus::Completed));
        assert_eq!(ended("stopped"), Some(NativeTurnStatus::Interrupted));
        assert_eq!(ended("failed"), Some(NativeTurnStatus::Failed));
        assert_eq!(refresh_history(&db, &session, "again", &history), json!({"added":0}));
        assert_eq!(db.chat_items(&session).unwrap(), items);
    }

    #[test]
    fn a_turn_the_earlier_text_only_refresh_imported_comes_back_in_full_once() {
        let (_root, db, session) = fixture();
        let first = join(&[
            native_turn("one", NativeTurnStatus::Completed, None),
            native_turn("two", NativeTurnStatus::Completed, None),
        ]);
        // The earlier refresh: prompt and answer text only, no progress notes, no transcript.
        let mut text_only = NativeChatHistory { messages: first.messages.clone(), transcript: Vec::new() };
        text_only.messages.retain(|message| message.phase.as_deref() != Some("commentary"));
        assert_eq!(refresh_history(&db, &session, "earlier", &text_only), json!({"added":4}));
        assert_eq!(texts(&db, &session), ["one prompt", "one fixed", "two prompt", "two fixed"]);
        // ThreadTerm's own turn after them stays where it is.
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at,timeline_seq) VALUES (?1,?2,'own','message',?3,'now',?4)",
                params![format!("{session}:user:own"), session, json!({"id":format!("{session}:user:own"),"role":"user","parts":[{"type":"text","text":"own prompt"}],"createdAt":"now","turnId":"own"}).to_string(), 5 * CHAT_TIMELINE_STRIDE],
            )?;
            tx.execute(
                "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at,timeline_seq) VALUES (?1,?2,'own','message',?3,'now',?4)",
                params![format!("{session}:answer:own"), session, json!({"id":format!("{session}:answer:own"),"role":"assistant","parts":[{"type":"text","text":"own answer"}],"createdAt":"now","turnId":"own","turnStatus":"completed","forkAnchor":{"nativeId":"native","turnId":"own"}}).to_string(), 6 * CHAT_TIMELINE_STRIDE],
            )?;
            Ok(())
        })
        .unwrap();
        let own = join(&[first, NativeChatHistory {
            messages: vec![NativeChatMessage {
                thread_id: "native".into(), turn_id: "own".into(), item_id: "own-user".into(), client_id: None,
                role: NativeChatMessageRole::User, phase: None, text: "own prompt".into(), turn_status: NativeTurnStatus::Completed,
            }],
            transcript: vec![item("own-user", "own", "user", json!({"type":"text","text":"own prompt"}))],
        }]);
        assert_eq!(refresh_history(&db, &session, "now", &own), json!({"added":8}));
        assert_eq!(
            texts(&db, &session),
            [
                "one prompt", "one looking at the parser", "tool", "one fixed",
                "two prompt", "two looking at the parser", "tool", "two fixed",
                "own prompt", "own answer",
            ]
        );
        let items = db.chat_items(&session).unwrap();
        assert!(!items.iter().any(|item| item.id.contains(":history-refresh:")));
        assert_eq!(refresh_history(&db, &session, "later", &own), json!({"added":0}));
        assert_eq!(db.chat_items(&session).unwrap(), items);
    }

    #[test]
    fn a_stopped_threadterm_turn_binds_by_its_client_id_and_no_longer_hides_later_turns() {
        let (_root, db, session) = fixture();
        // ThreadTerm sent a prompt, then the turn was stopped: no answer, no fork anchor.
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at,timeline_seq) VALUES (?1,?2,'stopped-here','message',?3,'now',?4)",
                params![format!("{session}:user:op-1"), session, json!({"id":format!("{session}:user:op-1"),"role":"user","parts":[{"type":"text","text":"stopped-here prompt"}],"createdAt":"now","turnId":"stopped-here"}).to_string(), CHAT_TIMELINE_STRIDE],
            )?;
            Ok(())
        })
        .unwrap();
        let history = join(&[
            native_turn("stopped-here", NativeTurnStatus::Interrupted, Some("op-1")),
            native_turn("continued", NativeTurnStatus::Completed, None),
        ]);
        assert_eq!(refresh_history(&db, &session, "return", &history), json!({"added":4}));
        assert_eq!(
            texts(&db, &session),
            ["stopped-here prompt", "continued prompt", "continued looking at the parser", "tool", "continued fixed"]
        );
    }

    #[test]
    fn a_turn_too_large_for_the_history_limit_falls_back_to_its_text() {
        let (_root, db, session) = fixture();
        let mut history = native_turn("huge", NativeTurnStatus::Completed, None);
        history.transcript[2].parts[0]["data"]["aggregatedOutput"] = json!("x".repeat(crate::chat_repair::MAX_HISTORY_BYTES));
        assert_eq!(refresh_history(&db, &session, "return", &history), json!({"added":3}));
        assert_eq!(texts(&db, &session), ["huge prompt", "huge looking at the parser", "huge fixed"]);
    }

    #[test]
    fn local_slash_commands_allow_later_refresh_without_changing_existing_rows() {
        for command in [
            "help",
            "status",
            "usage",
            "model",
            "plan",
            "approvals",
            "sandbox",
            "diff",
            "init",
            "mcp",
            "skills",
            "memory",
            "undo",
        ] {
            let (_root, db, session) = fixture();
            let mut native = messages("original");
            assert_eq!(refresh(&db, &session, "seed", &native), json!({"added":2}));
            db.record_provider_event(
                &session,
                Some("local-command"),
                "message.user",
                &json!({"text":format!("  /{command}  ")}),
            )
            .unwrap();
            db.record_provider_event(
                &session,
                Some("local-command"),
                "chat.item",
                &json!({"command":command,"parts":[{"type":"text","text":"local reply"}]}),
            )
            .unwrap();
            db.record_provider_event(
                &session,
                Some("local-command"),
                "chat.turn.completed",
                &json!({"command":command}),
            )
            .unwrap();
            let before = db.chat_items(&session).unwrap();
            assert!(before
                .iter()
                .filter(|item| item.turn_id.as_deref() == Some("local-command"))
                .all(|item| item
                    .fork_anchor
                    .as_ref()
                    .and_then(|anchor| anchor.turn_id.as_ref())
                    .is_none()));
            native.extend(messages("external-one"));
            native.extend(messages("external-two"));
            assert_eq!(
                refresh(&db, &session, "return", &native),
                json!({"added":4}),
                "{command}"
            );
            let after = db.chat_items(&session).unwrap();
            assert_eq!(&after[..before.len()], before.as_slice(), "{command}");
            assert_eq!(
                after[before.len()..]
                    .iter()
                    .map(|item| item.parts[0]["text"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "external-one-0",
                    "external-one-1",
                    "external-two-0",
                    "external-two-1"
                ]
            );
            assert_eq!(
                refresh(&db, &session, "return-again", &native),
                json!({"added":0})
            );
            assert_eq!(db.chat_items(&session).unwrap(), after);
        }
    }

    #[test]
    fn unbound_native_prompts_still_block_tail_refresh() {
        for (text, steered) in [
            ("ordinary prompt", false),
            ("/review", false),
            ("/compact", false),
            ("/custom-skill", false),
            ("/Help", false),
            ("/help", true),
            ("/status", true),
        ] {
            let (_root, db, session) = fixture();
            db.record_provider_event(
                &session,
                Some("unbound"),
                "message.user",
                &json!({"text":text,"steered":steered}),
            )
            .unwrap();
            db.record_provider_event(&session, Some("unbound"), "chat.turn.completed", &json!({}))
                .unwrap();
            let before = db.chat_items(&session).unwrap();
            assert_eq!(
                refresh(&db, &session, "return", &messages("external")),
                json!({"added":0}),
                "{text}"
            );
            assert_eq!(db.chat_items(&session).unwrap(), before);
        }
    }
}
