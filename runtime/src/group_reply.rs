//! Group-only answer selection; ordinary Chat retains every native record.
use crate::domain::ChatItem;
use anyhow::Result;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct Cutoff {
    item: String,
    part: usize,
    bytes: usize,
    hash: String,
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS group_reply_cutoffs(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,turn_id)); DELETE FROM group_reply_cutoffs;")?;
    Ok(())
}

fn items(tx: &Transaction<'_>, session: &str, turn: &str) -> Result<Vec<ChatItem>> {
    let mut statement = tx.prepare(
        "SELECT data FROM chat_items WHERE session_id=? AND turn_id=? ORDER BY created_at,rowid",
    )?;
    let rows = statement.query_map(params![session, turn], |row| row.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        if let Ok(item) = serde_json::from_str::<ChatItem>(&row?) {
            items.push(item);
        }
    }
    Ok(items)
}

fn is_tool(part: &Value) -> bool {
    matches!(
        part["type"].as_str(),
        Some("tool" | "tool_use" | "tool_result" | "approval" | "question")
    )
}

fn is_text(part: &Value) -> bool {
    part["type"] == "text" && part.pointer("/data/kind").and_then(Value::as_str) != Some("plan")
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Tool updates can merge into an old transcript row (ACP), or text can be
/// replaced in the turn's first row (Claude/Pi). Preserve the event boundary as
/// byte offsets plus prefix hashes, without copying transcript bodies again.
pub(super) fn observe_tool(
    tx: &Transaction<'_>,
    session: &str,
    turn: &str,
    kind: &str,
    data: &Value,
) -> Result<()> {
    let interaction = matches!(kind, "chat.approval" | "chat.question");
    if kind != "chat.item" && !interaction {
        return Ok(());
    }
    let parts = data["parts"].as_array();
    let raw = data
        .get("item")
        .or_else(|| data.pointer("/raw/params/item"));
    let raw_tool = raw
        .and_then(|item| item["type"].as_str())
        .is_some_and(|kind| {
            !matches!(
                kind,
                "agentMessage"
                    | "assistant"
                    | "message"
                    | "userMessage"
                    | "plan"
                    | "agentThought"
                    | "reasoning"
                    | "thinking"
            )
        });
    let last_tool = parts.and_then(|parts| parts.iter().rposition(is_tool));
    if !interaction && !raw_tool && !data.get("part").is_some_and(is_tool) && last_tool.is_none() {
        return Ok(());
    }
    let native = raw.and_then(|item| item["id"].as_str()).unwrap_or(turn);
    let current = format!("{session}:assistant:{native}");
    let mut cutoffs = Vec::new();
    for item in items(tx, session, turn)?
        .into_iter()
        .filter(|item| item.role == "assistant")
    {
        for (index, part) in item
            .parts
            .iter()
            .enumerate()
            .filter(|(_, part)| is_text(part))
        {
            // A complete mixed snapshot can already include text after its tool.
            if item.id == current && last_tool.is_some_and(|last| index > last) {
                continue;
            }
            if let Some(text) = part["text"].as_str() {
                cutoffs.push(Cutoff {
                    item: item.id.clone(),
                    part: index,
                    bytes: text.len(),
                    hash: hash(text),
                });
            }
        }
    }
    tx.execute("INSERT INTO group_reply_cutoffs(session_id,turn_id,data) VALUES(?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET data=excluded.data", params![session, turn, serde_json::to_string(&cutoffs)?])?;
    Ok(())
}

pub(super) fn answer(tx: &Transaction<'_>, session: &str, turn: &str) -> Result<String> {
    let saved: Option<String> = tx
        .query_row(
            "SELECT data FROM group_reply_cutoffs WHERE session_id=? AND turn_id=?",
            params![session, turn],
            |row| row.get(0),
        )
        .optional()?;
    let cutoffs = saved
        .map(|raw| serde_json::from_str::<Vec<Cutoff>>(&raw))
        .transpose()?;
    let body = select(&items(tx, session, turn)?, cutoffs.as_deref());
    clear(tx, session, turn)?;
    Ok(body)
}

pub(super) fn clear(tx: &Transaction<'_>, session: &str, turn: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM group_reply_cutoffs WHERE session_id=? AND turn_id=?",
        params![session, turn],
    )?;
    Ok(())
}

pub(super) fn clear_session(tx: &Transaction<'_>, session: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM group_reply_cutoffs WHERE session_id=?",
        [session],
    )?;
    Ok(())
}

fn select(items: &[ChatItem], cutoffs: Option<&[Cutoff]>) -> String {
    let mut all = Vec::new();
    let mut final_text = Vec::new();
    let mut tail = Vec::new();
    for item in items.iter().filter(|item| item.role == "assistant") {
        for (index, part) in item.parts.iter().enumerate() {
            if cutoffs.is_none() && is_tool(part) {
                tail.clear();
            }
            if !is_text(part) {
                continue;
            }
            let Some(text) = part["text"].as_str().filter(|text| !text.trim().is_empty()) else {
                continue;
            };
            all.push(text.trim());
            if part["phase"] == "final_answer" {
                final_text.push(text.trim());
            }
            if part["phase"] == "commentary" {
                continue;
            }
            let cutoff = cutoffs.and_then(|values| {
                values
                    .iter()
                    .find(|value| value.item == item.id && value.part == index)
            });
            let after = if let Some(cutoff) = cutoff {
                match text
                    .get(..cutoff.bytes)
                    .filter(|prefix| hash(prefix) == cutoff.hash)
                {
                    Some(_) => &text[cutoff.bytes..],
                    None => text, // The native provider replaced this text row.
                }
            } else {
                text
            };
            if !after.trim().is_empty() {
                tail.push(after.trim());
            }
        }
    }
    if !final_text.is_empty() {
        final_text.join("\n\n")
    } else if !tail.is_empty() {
        tail.join("\n\n")
    } else {
        all.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, parts: Value) -> ChatItem {
        serde_json::from_value(
            json!({"id":id,"role":"assistant","parts":parts,"createdAt":"now","turnId":"turn"}),
        )
        .unwrap()
    }

    #[test]
    fn codex_final_phase_wins_over_later_commentary_and_tools() {
        let rows = [item(
            "one",
            json!([{"type":"text","phase":"commentary","text":"I will edit"},{"type":"text","phase":"final_answer","text":"Done"},{"type":"tool"},{"type":"text","phase":"commentary","text":"Afterword"}]),
        )];
        assert_eq!(select(&rows, None), "Done");
    }

    #[test]
    fn claude_and_pi_replaced_first_text_row_keeps_answer() {
        for provider in ["claude", "pi"] {
            let cutoff = [Cutoff {
                item: provider.into(),
                part: 0,
                bytes: 10,
                hash: hash("I will run"),
            }];
            let rows = [
                item(provider, json!([{"type":"text","text":"Tests passed"}])),
                item("tool", json!([{"type":"tool"}])),
            ];
            assert_eq!(select(&rows, Some(&cutoff)), "Tests passed");
        }
    }

    #[test]
    fn grok_old_tool_row_cutoff_excludes_later_progress_segment() {
        let rows = [
            item(
                "base",
                json!([{"type":"text","text":"First reading"},{"type":"tool"}]),
            ),
            item("seg18", json!([{"type":"text","text":"Next run tests"}])),
            item(
                "seg25",
                json!([{"type":"text","text":"Tests pass"},{"type":"text","text":"No findings"}]),
            ),
        ];
        let cutoff = [
            Cutoff {
                item: "base".into(),
                part: 0,
                bytes: 13,
                hash: hash("First reading"),
            },
            Cutoff {
                item: "seg18".into(),
                part: 0,
                bytes: 14,
                hash: hash("Next run tests"),
            },
        ];
        assert_eq!(select(&rows, Some(&cutoff)), "Tests pass\n\nNo findings");
    }

    #[test]
    fn kimi_and_opencode_split_answers_after_last_tool_are_preserved() {
        for provider in ["kimi", "opencode"] {
            let rows = [
                item(
                    "before",
                    json!([{"type":"text","text":"Working"},{"type":"tool"}]),
                ),
                item(
                    provider,
                    json!([{"type":"thinking","text":"hidden"},{"type":"text","text":"Done"},{"type":"text","text":"路径"}]),
                ),
            ];
            assert_eq!(select(&rows, None), "Done\n\n路径");
        }
    }

    #[test]
    fn same_row_appended_text_uses_utf8_boundary_and_empty_tail_falls_back() {
        let cutoff = [Cutoff {
            item: "same".into(),
            part: 0,
            bytes: "读取".len(),
            hash: hash("读取"),
        }];
        assert_eq!(
            select(
                &[item("same", json!([{"type":"text","text":"读取\n完成"}]))],
                Some(&cutoff)
            ),
            "完成"
        );
        assert_eq!(
            select(
                &[item("same", json!([{"type":"text","text":"读取"}]))],
                Some(&cutoff)
            ),
            "读取"
        );
        assert_eq!(select(&[item("tool", json!([{"type":"tool"}]))], None), "");
    }
}
