use crate::db::CHAT_TIMELINE_STRIDE;
use crate::domain::{ChatItem, ChatTurnOrigin, NativeForkAnchor, NativeTurnStatus};
use crate::providers::{NativeChatMessage, NativeChatMessageRole};
use anyhow::{anyhow, bail, Result};
use chrono::Utc;
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use std::collections::HashMap;

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

/// Match turns by native coordinates. A reloaded app-server can assign
/// reconstructed item IDs, while the explicit native turn ID remains stable.
pub(crate) fn plan(
    tx: &Transaction<'_>,
    session_id: &str,
    native_id: &str,
    messages: &[NativeChatMessage],
) -> Result<Vec<HistoryInsertion>> {
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
    if !eligible || messages.is_empty() {
        return Ok(Vec::new());
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
                local_command: row.get::<_, Option<String>>(6)?.is_some_and(|text| {
                    // These commands are handled by Codex dispatch_slash without
                    // starting a native turn. Native commands and skills must
                    // retain the conservative unbound-user fence, including
                    // slash text forwarded verbatim through native steering.
                    matches!(
                        text.split_whitespace().next(),
                        Some(
                            "/diff"
                                | "/init"
                                | "/mcp"
                                | "/skills"
                                | "/memory"
                                | "/undo"
                                | "/help"
                                | "/model"
                                | "/plan"
                                | "/approvals"
                                | "/sandbox"
                                | "/status"
                                | "/usage"
                        )
                    )
                }),
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
    for message in messages {
        if message.thread_id != native_id {
            bail!("invalid_history_transcript");
        }
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
    let mut spans = HashMap::<&str, (i64, i64)>::new();
    let mut unbound_users = Vec::new();
    for row in &local {
        match row
            .turn_id
            .as_deref()
            .and_then(|turn| public_to_native.get(turn))
            .copied()
        {
            Some(native_turn) => {
                let span = spans
                    .entry(native_turn)
                    .or_insert((row.sequence, row.sequence));
                span.1 = row.sequence;
            }
            None if row.role == "user" && !row.local_command => unbound_users.push(row.sequence),
            None => {}
        }
    }
    let mut additions = Vec::new();
    let mut waiting = Vec::new();
    let mut previous_anchor = 0;
    let mut seen = std::collections::HashSet::new();
    let created_at = Utc::now().to_rfc3339();
    for turn in messages.chunk_by(|left, right| left.turn_id == right.turn_id) {
        let native_turn = turn[0].turn_id.as_str();
        if native_turn.is_empty() || !seen.insert(native_turn) {
            bail!("invalid_history_transcript");
        }
        if let Some(&(first, last)) = spans.get(native_turn) {
            if first <= previous_anchor {
                // Existing native anchors moved or conflict. Refresh is
                // append-only, so keep the local transcript intact.
                return Ok(Vec::new());
            }
            let before = local.partition_point(|row| row.sequence < first);
            let prior = before.checked_sub(1).map_or(0, |i| local[i].sequence);
            let unbound = unbound_users
                .iter()
                .any(|&seq| seq > previous_anchor && seq < first);
            if !unbound {
                place(&mut additions, &mut waiting, prior, Some(first))?;
            }
            waiting.clear();
            previous_anchor = last;
        } else {
            let selected = turn.iter().enumerate().filter(|(_, message)| {
                !message.text.is_empty() && message.phase.as_deref() != Some("commentary")
            });
            let final_reply = selected
                .clone()
                .filter(|(_, message)| message.role == NativeChatMessageRole::Assistant)
                .map(|(index, _)| index)
                .last();
            for (index, message) in selected {
                waiting.push(project(
                    session_id,
                    &created_at,
                    message,
                    index,
                    final_reply == Some(index),
                ));
            }
        }
    }
    if !unbound_users.iter().any(|&seq| seq > previous_anchor) {
        place(
            &mut additions,
            &mut waiting,
            local.last().map_or(0, |row| row.sequence),
            None,
        )?;
    }
    Ok(additions)
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
    ChatItem {
        id: format!("{session_id}:history-refresh:{}:{index}", message.turn_id),
        role: if assistant { "assistant" } else { "user" }.into(),
        parts: vec![part],
        created_at: created_at.into(),
        turn_id: Some(format!("{session_id}:history:{}", message.turn_id)),
        elapsed_ms: None,
        turn_status: final_reply.then_some(NativeTurnStatus::Completed),
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
    additions: Vec<HistoryInsertion>,
) -> Result<Value> {
    let added = additions.len();
    for HistoryInsertion { sequence, item } in additions {
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at,timeline_seq) VALUES (?1,?2,?3,'history',?4,?5,?6)",
            params![item.id, session_id, item.turn_id, serde_json::to_string(&item)?, item.created_at, sequence],
        )?;
    }
    let now = Utc::now().to_rfc3339();
    if added > 0 {
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
        })
        .collect()
    }

    fn refresh(
        db: &Database,
        session: &str,
        operation: &str,
        messages: &[NativeChatMessage],
    ) -> Value {
        db.transaction(|tx| {
            let additions = plan(tx, session, "native", messages)?;
            commit(tx, session, operation, additions)
        })
        .unwrap()
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
