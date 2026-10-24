use anyhow::Result;
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Attribution only needs completed windows while they remain connected to a
/// turn that can still be compared. Keeping one bounded component also keeps
/// the normal overlap query below its 257-row fail-closed threshold.
const MAX_COMPLETED_TURNS: usize = 256;
const MAX_EDITOR_SAVES: usize = 20_000;
const ATTRIBUTION_INCOMPLETE_MARKER: &str = r#"{"attributionIncomplete":true}"#;

#[derive(Debug)]
pub(super) struct AffectedReply {
    pub(super) group_id: String,
    pub(super) reply_id: String,
    pub(super) base_outputs: Value,
}

#[derive(Debug, Default)]
#[cfg_attr(not(test), allow(dead_code))]
pub(super) struct PruneOutcome {
    pub(super) affected_replies: Vec<AffectedReply>,
    pub(super) deleted_turns: usize,
    pub(super) deleted_saves: usize,
    pub(super) overflowed: bool,
}

#[derive(Debug)]
struct Row {
    id: String,
    delivery_id: Option<String>,
    group_id: String,
    started_at: String,
    ended_at: Option<String>,
    compared_at: Option<String>,
    reply_id: Option<String>,
    base_outputs: Option<String>,
}

impl Row {
    fn active(&self) -> bool {
        self.compared_at.is_none() && (self.ended_at.is_none() || self.delivery_id.is_some())
    }

    fn effective_end(&self) -> Option<&str> {
        self.compared_at.as_deref().or(self.ended_at.as_deref())
    }
}

#[derive(Debug)]
struct Component {
    rows: Vec<usize>,
    max_end: Option<String>,
    active: bool,
    completed: usize,
}

impl Component {
    fn new(index: usize, row: &Row) -> Self {
        Self {
            rows: vec![index],
            max_end: row.effective_end().map(str::to_owned),
            active: row.active(),
            completed: usize::from(!row.active()),
        }
    }

    fn accepts(&self, row: &Row) -> bool {
        self.max_end
            .as_deref()
            .is_none_or(|end| row.started_at.as_str() <= end)
    }

    fn push(&mut self, index: usize, row: &Row) {
        self.rows.push(index);
        self.active |= row.active();
        self.completed += usize::from(!row.active());
        match (self.max_end.as_deref(), row.effective_end()) {
            (None, _) | (_, None) => self.max_end = None,
            (Some(current), Some(next)) if next > current => self.max_end = Some(next.to_owned()),
            _ => {}
        }
    }
}

pub(super) fn incomplete_marker(value: &Value) -> bool {
    value["attributionIncomplete"] == true
}

pub(super) fn delta_paths(delta: Option<&[Value]>) -> Option<Vec<String>> {
    delta.map(|files| {
        files
            .iter()
            .filter_map(|file| file["path"].as_str().map(str::to_owned))
            .collect()
    })
}

/// Prune storage after a comparison while the caller holds the attribution
/// gate. This function performs SQLite work only; it never touches the folder,
/// Git, or a provider.
pub(super) fn prune(tx: &Transaction<'_>, cwd: &str) -> Result<PruneOutcome> {
    let rows = {
        let mut statement = tx.prepare(
            "SELECT id,delivery_id,group_id,started_at,ended_at,compared_at,reply_id,base_outputs \
             FROM group_change_turns WHERE cwd=? ORDER BY started_at,id",
        )?;
        let values = statement
            .query_map([cwd], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    delivery_id: row.get(1)?,
                    group_id: row.get(2)?,
                    started_at: row.get(3)?,
                    ended_at: row.get(4)?,
                    compared_at: row.get(5)?,
                    reply_id: row.get(6)?,
                    base_outputs: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        values
    };

    let mut components = Vec::<Component>::new();
    for (index, row) in rows.iter().enumerate() {
        if components
            .last()
            .is_some_and(|component| component.accepts(row))
        {
            components.last_mut().unwrap().push(index, row);
        } else {
            components.push(Component::new(index, row));
        }
    }

    // Prefer the newest independent reconciliation components. If a whole
    // component does not fit, freezing that component is safer than retaining
    // a partial overlap graph and presenting optimistic folder attribution.
    let mut remaining = MAX_COMPLETED_TURNS;
    let mut overflow = vec![false; components.len()];
    for (index, component) in components.iter().enumerate().rev() {
        if !component.active {
            continue;
        }
        if component.completed <= remaining {
            remaining -= component.completed;
        } else {
            overflow[index] = true;
        }
    }

    // Saves have no component identity. Count only the suffix a normal
    // reconciliation would retain; if that suffix is itself too large, all
    // active components must fail closed before the evidence is discarded.
    let prospective_cutoff = components
        .iter()
        .enumerate()
        .filter(|(index, component)| component.active && !overflow[*index])
        .map(|(_, component)| rows[component.rows[0]].started_at.as_str())
        .min();
    let saves_overflow = if let Some(cutoff) = prospective_cutoff {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM group_editor_saves WHERE cwd=? AND saved_at>=? LIMIT 1 OFFSET ?)",
            params![cwd, cutoff, MAX_EDITOR_SAVES as i64],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        false
    };
    if saves_overflow {
        for (index, component) in components.iter().enumerate() {
            if component.active {
                overflow[index] = true;
            }
        }
    }

    let mut delete = Vec::new();
    let mut affected = BTreeMap::<(String, String), Value>::new();
    let mut cutoff: Option<&str> = None;
    for (component_index, component) in components.iter().enumerate() {
        let failed_closed = overflow[component_index];
        if component.active && !failed_closed {
            let start = rows[component.rows[0]].started_at.as_str();
            cutoff = Some(cutoff.map_or(start, |current| current.min(start)));
        }
        for index in &component.rows {
            let row = &rows[*index];
            if row.active() {
                if failed_closed {
                    tx.execute(
                        "UPDATE group_change_turns SET before_json=?,delta_json=NULL,uncertain=1 WHERE id=?",
                        params![ATTRIBUTION_INCOMPLETE_MARKER, row.id],
                    )?;
                }
                continue;
            }
            if !component.active || failed_closed {
                delete.push(row.id.clone());
            }
            if failed_closed {
                if let Some(reply) = &row.reply_id {
                    let base = row
                        .base_outputs
                        .as_deref()
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .unwrap_or_else(|| json!({"files":[],"urls":[],"changed":[]}));
                    affected.insert((row.group_id.clone(), reply.clone()), base);
                }
            }
        }
    }

    for id in &delete {
        tx.execute("DELETE FROM group_change_turns WHERE id=?", [id])?;
    }
    let deleted_saves = if let Some(cutoff) = cutoff {
        tx.execute(
            "DELETE FROM group_editor_saves WHERE cwd=? AND saved_at<?",
            params![cwd, cutoff],
        )?
    } else {
        tx.execute("DELETE FROM group_editor_saves WHERE cwd=?", [cwd])?
    };

    Ok(PruneOutcome {
        affected_replies: affected
            .into_iter()
            .map(|((group_id, reply_id), base_outputs)| AffectedReply {
                group_id,
                reply_id,
                base_outputs,
            })
            .collect(),
        deleted_turns: delete.len(),
        deleted_saves,
        overflowed: overflow.into_iter().any(|value| value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE group_change_turns(
                    id TEXT PRIMARY KEY, delivery_id TEXT, group_id TEXT NOT NULL,
                    session_id TEXT NOT NULL, turn_id TEXT, cwd TEXT NOT NULL,
                    handle TEXT NOT NULL, read_only INTEGER NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT, compared_at TEXT,
                    before_json TEXT, delta_json TEXT, base_outputs TEXT,
                    reply_id TEXT, uncertain INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE group_editor_saves(cwd TEXT NOT NULL,path TEXT NOT NULL,saved_at TEXT NOT NULL);
                CREATE TABLE group_messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,data TEXT NOT NULL);",
            )
            .unwrap();
        connection
    }

    #[allow(clippy::too_many_arguments)]
    fn turn(
        tx: &Transaction<'_>,
        id: &str,
        start: &str,
        end: Option<&str>,
        compared: Option<&str>,
        delivery: Option<&str>,
        reply: Option<&str>,
        delta: Option<Value>,
    ) {
        tx.execute(
            "INSERT INTO group_change_turns(id,delivery_id,group_id,session_id,turn_id,cwd,handle,read_only,started_at,ended_at,compared_at,before_json,delta_json,base_outputs,reply_id,uncertain)
             VALUES(?,?,?,?,?,'root','member',0,?,?,?,?,?,?,?,1)",
            params![
                id,
                delivery,
                "group",
                format!("session-{id}"),
                format!("turn-{id}"),
                start,
                end,
                compared,
                r#"{"files":[]}"#,
                delta.map(|value| value.to_string()),
                json!({"files":[],"urls":[],"changed":[format!("{id}.txt")]}).to_string(),
                reply,
            ],
        )
        .unwrap();
    }

    #[test]
    fn editor_saves_older_than_the_transitive_reconciliation_window_are_pruned() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "older",
            "01",
            Some("04"),
            Some("04"),
            None,
            Some("reply-older"),
            None,
        );
        turn(&tx, "open", "03", None, None, Some("delivery"), None, None);
        for time in ["00", "01", "02", "05"] {
            tx.execute(
                "INSERT INTO group_editor_saves(cwd,path,saved_at) VALUES('root',?,?)",
                params![format!("{time}.txt"), time],
            )
            .unwrap();
        }
        let result = prune(&tx, "root").unwrap();
        assert_eq!(result.deleted_saves, 1);
        let times = tx
            .prepare("SELECT saved_at FROM group_editor_saves ORDER BY saved_at")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(times, ["01", "02", "05"]);
    }

    #[test]
    fn closed_history_is_pruned_without_removing_persisted_replies() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "done",
            "01",
            Some("02"),
            Some("02"),
            None,
            Some("reply"),
            None,
        );
        tx.execute(
            "INSERT INTO group_messages(id,group_id,data) VALUES('reply','group','persisted')",
            [],
        )
        .unwrap();
        let result = prune(&tx, "root").unwrap();
        assert_eq!(result.deleted_turns, 1);
        assert!(result.affected_replies.is_empty());
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM group_change_turns", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM group_messages", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn active_overlap_keeps_the_whole_transitive_component() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "a",
            "01",
            Some("03"),
            Some("03"),
            None,
            Some("reply-a"),
            None,
        );
        turn(
            &tx,
            "b",
            "02",
            Some("05"),
            Some("05"),
            None,
            Some("reply-b"),
            None,
        );
        turn(&tx, "c", "04", None, None, Some("delivery-c"), None, None);
        let result = prune(&tx, "root").unwrap();
        assert_eq!(result.deleted_turns, 0);
        assert!(!result.overflowed);
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM group_change_turns", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn finished_private_turn_is_not_an_open_reconciliation_root() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(&tx, "private", "01", Some("02"), None, None, None, None);
        turn(
            &tx,
            "open",
            "03",
            None,
            None,
            Some("delivery-open"),
            None,
            None,
        );
        let result = prune(&tx, "root").unwrap();
        assert_eq!(result.deleted_turns, 1);
        assert_eq!(
            tx.query_row(
                "SELECT group_concat(id, ',') FROM group_change_turns",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "open"
        );
    }

    #[test]
    fn oversized_open_component_fails_closed_and_drops_completed_context() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "open",
            "00",
            None,
            None,
            Some("delivery-open"),
            None,
            None,
        );
        for index in 0..=MAX_COMPLETED_TURNS {
            let id = format!("done-{index:03}");
            let reply = format!("reply-{index:03}");
            turn(
                &tx,
                &id,
                "01",
                Some("02"),
                Some("02"),
                None,
                Some(&reply),
                None,
            );
        }
        let result = prune(&tx, "root").unwrap();
        assert!(result.overflowed);
        assert_eq!(result.affected_replies.len(), MAX_COMPLETED_TURNS + 1);
        assert_eq!(result.deleted_turns, MAX_COMPLETED_TURNS + 1);
        let (before, delta, uncertain): (String, Option<String>, bool) = tx
            .query_row(
                "SELECT before_json,delta_json,uncertain FROM group_change_turns WHERE id='open'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(incomplete_marker(&serde_json::from_str(&before).unwrap()));
        assert!(delta.is_none());
        assert!(uncertain);
    }

    #[test]
    fn oversized_editor_save_history_fails_closed_and_is_cleared() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "open",
            "00",
            None,
            None,
            Some("delivery-open"),
            None,
            None,
        );
        turn(
            &tx,
            "done",
            "01",
            Some("02"),
            Some("02"),
            None,
            Some("reply-done"),
            None,
        );
        {
            let mut insert = tx
                .prepare("INSERT INTO group_editor_saves(cwd,path,saved_at) VALUES('root',?,'01')")
                .unwrap();
            for index in 0..=MAX_EDITOR_SAVES {
                insert.execute([format!("save-{index}.txt")]).unwrap();
            }
        }
        let result = prune(&tx, "root").unwrap();
        assert!(result.overflowed);
        assert_eq!(result.affected_replies.len(), 1);
        assert_eq!(result.deleted_turns, 1);
        assert_eq!(result.deleted_saves, MAX_EDITOR_SAVES + 1);
        assert_eq!(
            tx.query_row(
                "SELECT before_json FROM group_change_turns WHERE id='open'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            ATTRIBUTION_INCOMPLETE_MARKER
        );
    }

    #[test]
    fn read_only_guard_paths_are_captured_before_the_finished_row_is_pruned() {
        let delta = vec![
            json!({"path":"created.txt","status":"added","evidence":"folder"}),
            json!({"path":"removed.txt","status":"deleted","evidence":"folder"}),
        ];
        let guard_paths = delta_paths(Some(&delta)).unwrap();
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        turn(
            &tx,
            "readonly",
            "01",
            Some("02"),
            Some("02"),
            None,
            Some("reply"),
            Some(json!(delta)),
        );
        let result = prune(&tx, "root").unwrap();
        assert_eq!(result.deleted_turns, 1);
        assert_eq!(guard_paths, ["created.txt", "removed.txt"]);
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM group_change_turns", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
