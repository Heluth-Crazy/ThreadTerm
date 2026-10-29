//! Event-driven, bounded retention of replay queues and completed receipts.
use crate::db::Database;
use anyhow::Result;

pub(crate) const HISTORY_DAYS: i64 = 30;
pub(crate) const GIT_UNDO_HISTORY_DAYS: i64 = 7;
pub(crate) const GIT_UNDO_PER_WORKTREE: usize = 50;
pub(crate) const OUTBOX_FLOOR: i64 = 10_000;
// An ended terminal retains a useful scrollback suffix. Live replay has no
// durable screen checkpoint, so its only redraw basis must remain untouched.
pub(crate) const TERMINAL_BYTES: i64 = 8 * 1024 * 1024;
pub(crate) const BATCH_ROWS: usize = 200;

/// Between batches, step away from the shared writer long enough for waiting
/// requests to take it: the database mutex is not fair, so a bare yield let one
/// real 700 MB compaction keep `runtime.health` waiting for 17 s.
fn pause_for_foreground() {
    std::thread::sleep(std::time::Duration::from_millis(5));
}

impl Database {
    /// Called only after the first snapshot response is delivered. The worker
    /// sleeps on a bounded channel; session ends coalesce, with no idle timer.
    pub(crate) fn start_retention(self: &std::sync::Arc<Self>) {
        let mut slot = self.retention.lock().expect("retention lock poisoned");
        if slot.is_some() {
            return;
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let database = std::sync::Arc::downgrade(self);
        match std::thread::Builder::new()
            .name("history-retention".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    let Some(db) = database.upgrade() else {
                        break;
                    };
                    if let Err(error) = compact(&db) {
                        eprintln!("History retention deferred: {error:#}");
                    }
                }
            }) {
            Ok(_) => {
                let _ = sender.try_send(());
                *slot = Some(sender);
            }
            Err(error) => eprintln!("History retention could not start: {error}"),
        }
    }

    pub(crate) fn schedule_retention(&self) {
        if let Ok(slot) = self.retention.lock() {
            if let Some(sender) = slot.as_ref() {
                let _ = sender.try_send(());
            }
        }
    }

    /// Startup only: a Git request whose binding has neither a receipt nor a claim
    /// was rejected before it touched Git, and older builds kept those rows forever.
    /// Every startup sweeps them, which is always safe because nothing is in flight
    /// before the runtime accepts requests. Bounded pages need no
    /// `pause_for_foreground()`: there is no foreground writer to yield to yet.
    pub fn release_orphan_git_bindings(&self) -> Result<usize> {
        let mut removed = 0;
        loop {
            let count = batch(self, |tx| {
                tx.execute(
                    "DELETE FROM operation_requests WHERE id IN (
                        SELECT id FROM operation_requests
                        WHERE method LIKE 'git.%'
                          AND NOT EXISTS(SELECT 1 FROM operations WHERE id=operation_requests.id)
                          AND NOT EXISTS(SELECT 1 FROM external_operations WHERE id=operation_requests.id)
                        ORDER BY id LIMIT ?)",
                    rusqlite::params![BATCH_ROWS],
                )
                .map_err(Into::into)
            })?;
            removed += count;
            if count < BATCH_ROWS {
                break;
            }
        }
        Ok(removed)
    }
}

/// A transaction can mutate at most 1,000 rows, including projections and
/// deletion triggers. Release the single writer between every small batch.
fn batch<T>(
    db: &Database,
    action: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
) -> Result<T> {
    db.transaction(|tx| {
        let before = tx.total_changes();
        let value = action(tx)?;
        anyhow::ensure!(
            tx.total_changes() - before <= 1_000,
            "retention_batch_limit"
        );
        Ok(value)
    })
}

pub(crate) fn compact(db: &Database) -> Result<usize> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(HISTORY_DAYS)).to_rfc3339();
    let mut changed = 0;
    loop {
        let (removed, finished) = batch(db, |tx| {
            let floor: i64 = tx.query_row(
                "SELECT COALESCE((SELECT seq FROM outbox ORDER BY seq DESC LIMIT 1 OFFSET ?),0)",
                [OUTBOX_FLOOR - 1],
                |row| row.get(0),
            )?;
            let rows = tx.prepare("SELECT seq,event,CASE WHEN event IN ('session.status','chat.ui') THEN data ELSE '' END,created_at FROM outbox WHERE seq<? AND created_at<? ORDER BY created_at,seq LIMIT ?")?
                .query_map(rusqlite::params![floor,cutoff,BATCH_ROWS], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut through = 0;
            let mut processed = 0;
            let started = std::time::Instant::now();
            for (seq, event, data, at) in &rows {
                if processed > 0 && started.elapsed() >= std::time::Duration::from_millis(15) {
                    break;
                }
                if matches!(event.as_str(), "session.status" | "chat.ui") {
                    let value: serde_json::Value = serde_json::from_str(data)?;
                    if let Some(id) = value["sessionId"].as_str() {
                        tx.execute("INSERT INTO retention_event_state(session_id,event,seq,data,created_at) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM sessions WHERE id=?1) ON CONFLICT(session_id,event) DO UPDATE SET seq=excluded.seq,data=excluded.data,created_at=excluded.created_at WHERE excluded.seq>retention_event_state.seq",rusqlite::params![id,event,seq,data,at])?;
                    }
                }
                tx.execute("DELETE FROM outbox WHERE seq=?", [seq])?;
                through = through.max(*seq);
                processed += 1;
            }
            if through > 0 {
                tx.execute("INSERT INTO metadata(key,value) VALUES('retention.outboxPrunedThrough',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(metadata.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",[through.to_string()])?;
            }
            Ok((
                processed,
                rows.len() < BATCH_ROWS && processed == rows.len(),
            ))
        })?;
        changed += removed;
        if finished {
            break;
        }
        pause_for_foreground();
    }
    changed += compact_receipts(db, &cutoff)?;
    changed += compact_git_undo(db)?;
    // Sessions are paged by primary key, without holding the writer during the pass.
    let mut after = String::new();
    loop {
        let sessions = db.transaction(|tx| {
            Ok(tx.prepare("SELECT id FROM sessions WHERE id>? AND status IN ('exited','interrupted','error') ORDER BY id LIMIT ?")?
                .query_map(rusqlite::params![after,BATCH_ROWS],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;
        if sessions.is_empty() {
            break;
        }
        for id in &sessions {
            changed += compact_output(db, id, &cutoff)?;
        }
        after = sessions.last().unwrap().clone();
        pause_for_foreground();
    }
    // incremental_vacuum is intentionally not requested unless a future schema
    // enables auto_vacuum=INCREMENTAL. Freed pages are reused without a hot VACUUM.
    Ok(changed)
}

fn table_exists(tx: &rusqlite::Transaction<'_>, name: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [name],
        |row| row.get(0),
    )?)
}

fn compact_receipts(db: &Database, cutoff: &str) -> Result<usize> {
    use rusqlite::OptionalExtension;
    let mut after = (String::new(), String::new());
    let mut removed = 0;
    loop {
        let (last, count, scanned) = batch(db, |tx| {
            let mut protection = String::new();
            for (table,predicate) in [
                ("chat_queue_items", "EXISTS(SELECT 1 FROM chat_queue_items q WHERE substr(o.id,1,6)='queue:' AND q.id=substr(o.id,7))"),
                ("group_deliveries", "EXISTS(SELECT 1 FROM group_deliveries g WHERE g.state IN ('queued','working','needs_user') AND substr(o.id,1,6)='queue:' AND g.queue_id=substr(o.id,7))"),
                ("chat_fork_intents", "EXISTS(SELECT 1 FROM chat_fork_intents f WHERE o.id=f.operation_id OR substr(o.id,1,length(f.operation_id)+6)=f.operation_id||':fork:')"),
                ("session_retry_attempts", "EXISTS(SELECT 1 FROM session_retry_attempts r WHERE r.operation_id=o.id AND r.status IN ('pending','claimed'))"),
                ("delegations", "EXISTS(SELECT 1 FROM delegations d WHERE d.state IN ('starting','running','awaiting_parent','awaiting_user','cancelling','cancel_failed') AND (o.id=d.operation_id OR substr(o.id,1,length(d.operation_id)+1)=d.operation_id||':'))"),
                // A Git undo row names the original operation receipt as its
                // replay fence. Keep that receipt until the journal expires.
                ("git_undo", "EXISTS(SELECT 1 FROM git_undo g WHERE g.operation_id=o.id)"),
                // Auto-setup reconstruction uses worktree.create receipts as a
                // durable creation catalogue. Keep these until its owner moves
                // that catalogue into a dedicated state table.
            ] {
                if table_exists(tx,table)? { protection.push_str(" OR "); protection.push_str(predicate); }
            }
            let rows = tx.prepare("SELECT id,method,created_at FROM operations WHERE (created_at,id)>(?1,?2) AND created_at<?3 ORDER BY created_at,id LIMIT ?4")?
                .query_map(rusqlite::params![after.0,after.1,cutoff,BATCH_ROWS], |row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let protected_sql = format!("SELECT o.method IN ('worktree.create','worktree.setup.auto') {protection} FROM operations o WHERE o.id=?");
            let mut count = 0;
            let mut last = None;
            let started = std::time::Instant::now();
            for (id, method, created_at) in &rows {
                if last.is_some() && started.elapsed() >= std::time::Duration::from_millis(15) {
                    break;
                }
                last = Some((created_at.clone(), id.clone()));
                let protected: bool = tx.query_row(&protected_sql, [id], |row| row.get(0))?;
                if protected {
                    continue;
                }
                let request: Option<String> = if matches!(
                    method.as_str(),
                    "session.update" | "session.create" | "history.import"
                ) {
                    tx.query_row(
                        "SELECT params FROM operation_requests WHERE id=?",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?
                } else {
                    None
                };
                if let Some(request) = request {
                    let p: serde_json::Value = serde_json::from_str(&request)?;
                    let result: String =
                        tx.query_row("SELECT result FROM operations WHERE id=?", [id], |row| {
                            row.get(0)
                        })?;
                    let result: serde_json::Value = serde_json::from_str(&result)?;
                    let session_id = if method == "session.update" {
                        p["sessionId"].as_str()
                    } else if matches!(method.as_str(), "session.create" | "history.import") {
                        result["id"].as_str()
                    } else {
                        None
                    };
                    if let Some(session_id) = session_id {
                        for (keep, key) in [
                            (p["title"].is_string(), "retention.userTitle:"),
                            (
                                matches!(method.as_str(), "session.create" | "history.import")
                                    && p["nativeId"].is_string(),
                                "retention.nativeHistory:",
                            ),
                        ] {
                            if keep {
                                tx.execute("INSERT OR IGNORE INTO metadata(key,value) SELECT ?,'true' WHERE EXISTS(SELECT 1 FROM sessions WHERE id=?)",rusqlite::params![format!("{key}{session_id}"),session_id])?;
                            }
                        }
                    }
                }
                // These three tables share one receipt lifetime. An uncertain
                // external claim or unfinished request (no operations row) is
                // never selected, regardless of age.
                tx.execute("DELETE FROM external_operations WHERE id=?", [id])?;
                tx.execute("DELETE FROM operation_requests WHERE id=?", [id])?;
                tx.execute("DELETE FROM operations WHERE id=?", [id])?;
                count += 1;
                if started.elapsed() >= std::time::Duration::from_millis(15) {
                    break;
                }
            }
            // A partially processed page must resume even when few rows were
            // deleted (most candidates may be protected by durable work).
            let scanned = if last
                .as_ref()
                .is_some_and(|(at, id)| rows.last().is_some_and(|row| &row.0 != id || &row.2 != at))
            {
                BATCH_ROWS
            } else {
                rows.len()
            };
            Ok((last, count, scanned))
        })?;
        removed += count;
        if scanned < BATCH_ROWS {
            break;
        }
        after = last.unwrap();
        pause_for_foreground();
    }
    Ok(removed)
}

/// Git undo rows are independently bounded: they retain recovery identifiers,
/// not content, and must disappear promptly when their Git object window ends.
fn compact_git_undo(db: &Database) -> Result<usize> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(GIT_UNDO_HISTORY_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut removed = 0;
    loop {
        let count = batch(db, |tx| {
            tx.execute(
                "DELETE FROM git_undo WHERE id IN (SELECT id FROM git_undo WHERE created_at<? ORDER BY created_at,id LIMIT ?)",
                rusqlite::params![cutoff, BATCH_ROWS],
            )
            .map_err(Into::into)
        })?;
        removed += count;
        if count < BATCH_ROWS {
            break;
        }
        pause_for_foreground();
    }
    loop {
        let count = batch(db, |tx| {
            tx.execute(
                "DELETE FROM git_undo WHERE id IN (
                    SELECT older.id FROM git_undo older
                    WHERE (SELECT COUNT(*) FROM git_undo newer
                           WHERE newer.project_id=older.project_id AND newer.worktree_path=older.worktree_path
                             AND (newer.created_at>older.created_at OR (newer.created_at=older.created_at AND newer.id>older.id))) >= ?
                    ORDER BY older.created_at,older.id LIMIT ?
                )",
                rusqlite::params![GIT_UNDO_PER_WORKTREE, BATCH_ROWS],
            )
            .map_err(Into::into)
        })?;
        removed += count;
        if count < BATCH_ROWS {
            break;
        }
        pause_for_foreground();
    }
    Ok(removed)
}

fn compact_output(db: &Database, id: &str, cutoff: &str) -> Result<usize> {
    use rusqlite::OptionalExtension;
    let mut removed = 0;
    loop {
        let count = batch(db, |tx| {
            // Recheck under the writer lock: a concurrent explicit resume must
            // retain its complete live replay basis.
            let ended: Option<String> = tx.query_row("SELECT updated_at FROM sessions WHERE id=? AND status IN ('exited','interrupted','error')",[id],|row|row.get(0)).optional()?;
            let Some(ended) = ended else {
                return Ok(0);
            };
            let end: i64 = tx.query_row("SELECT COALESCE((SELECT start_cursor+length(data) FROM output_chunks WHERE session_id=? ORDER BY start_cursor DESC LIMIT 1),0)",[id],|row|row.get(0))?;
            if end == 0 {
                return Ok(0);
            }
            let from = if ended.as_str() < cutoff {
                end
            } else {
                (end - TERMINAL_BYTES).max(0)
            };
            if from == 0 {
                return Ok(0);
            }
            tx.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(metadata.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",rusqlite::params![format!("terminal.outputEnd:{id}"),end.to_string()])?;
            let cursors = tx.prepare("SELECT start_cursor FROM output_chunks WHERE session_id=? AND start_cursor<? ORDER BY start_cursor LIMIT ?")?
                .query_map(rusqlite::params![id,from,BATCH_ROWS],|row|row.get::<_,i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for cursor in &cursors {
                let size: i64 = tx.query_row(
                    "SELECT length(data) FROM output_chunks WHERE session_id=? AND start_cursor=?",
                    rusqlite::params![id, cursor],
                    |row| row.get(0),
                )?;
                if cursor + size <= from {
                    tx.execute(
                        "DELETE FROM output_chunks WHERE session_id=? AND start_cursor=?",
                        rusqlite::params![id, cursor],
                    )?;
                } else {
                    tx.execute("UPDATE output_chunks SET data=substr(data,?3-start_cursor+1),start_cursor=?3 WHERE session_id=?1 AND start_cursor=?2",rusqlite::params![id,cursor,from])?;
                }
            }
            Ok(cursors.len())
        })?;
        removed += count;
        if count < BATCH_ROWS {
            break;
        }
        pause_for_foreground();
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use rusqlite::params;

    #[test]
    fn retention_keeps_recent_floor_and_pending_receipts_and_caps_only_ended_output() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("retention.sqlite")).unwrap();
        let live = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "live",
            })
            .unwrap();
        let ended = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "ended",
            })
            .unwrap();
        let expired = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "expired",
            })
            .unwrap();
        db.set_session_status(&ended.id, "exited", Some(0)).unwrap();
        db.set_session_status(&expired.id, "exited", Some(0))
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET updated_at='2000-01-01T00:00:00Z' WHERE id=?",
                [&expired.id],
            )?;
            for i in 0..10_251 {
                tx.execute(
                    "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}',?)",
                    [if i == 250 {
                        "2999-01-01T00:00:00Z"
                    } else {
                        "2000-01-01T00:00:00Z"
                    }],
                )?;
            }
            tx.execute(
                "INSERT INTO operations VALUES('old','test','null','2000-01-01T00:00:00Z')",
                [],
            )?;
            tx.execute(
                "INSERT INTO operation_requests VALUES('old','test','{}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO external_operations VALUES('old','2000-01-01T00:00:00Z')",
                [],
            )?;
            tx.execute(
                "INSERT INTO operation_requests VALUES('pending','test','{}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO external_operations VALUES('pending','2000-01-01T00:00:00Z')",
                [],
            )?;
            tx.execute(
                "INSERT INTO operations VALUES('recent','test','null','2999-01-01T00:00:00Z')",
                [],
            )?;
            for id in [&live.id, &ended.id] {
                for i in 0..10 {
                    tx.execute(
                        "INSERT INTO output_chunks VALUES(?,?,?)",
                        params![id, i * 1024 * 1024, vec![b'x'; 1024 * 1024]],
                    )?;
                }
            }
            tx.execute(
                "INSERT INTO output_chunks VALUES(?,0,?)",
                params![&expired.id, b"expired"],
            )?;
            Ok(())
        })
        .unwrap();
        let changed = compact(&db).unwrap();
        assert!(changed > 0, "retention must remove old rows");
        db.transaction(|tx| {
            let count = |sql| tx.query_row(sql, [], |r| r.get::<_, i64>(0));
            assert_eq!(
                count("SELECT COUNT(*) FROM outbox WHERE created_at='2000-01-01T00:00:00Z'")?,
                10_000
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM outbox WHERE created_at='2999-01-01T00:00:00Z'")?,
                1
            );
            assert_eq!(count("SELECT COUNT(*) FROM operations WHERE id='old'")?, 0);
            assert_eq!(
                count("SELECT COUNT(*) FROM operation_requests WHERE id='old'")?,
                0
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM external_operations WHERE id='old'")?,
                0
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM operation_requests WHERE id='pending'")?,
                1
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM external_operations WHERE id='pending'")?,
                1
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM operations WHERE id='recent'")?,
                1
            );
            let bytes = |id| {
                tx.query_row(
                    "SELECT COALESCE(SUM(length(data)),0) FROM output_chunks WHERE session_id=?",
                    [id],
                    |r| r.get::<_, i64>(0),
                )
            };
            assert_eq!(bytes(&live.id)?, 10 * 1024 * 1024);
            assert_eq!(bytes(&ended.id)?, TERMINAL_BYTES);
            assert_eq!(bytes(&expired.id)?, 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(db.output_end(&expired.id).unwrap(), 7);
        let refresh = db.events_after(1).unwrap();
        assert_eq!(refresh[0].1, "runtime.degraded");
        assert_eq!(refresh[0].2["reason"], "outbox_history_pruned");
        assert_eq!(refresh[0].2["snapshotRequired"], true);
        assert_eq!(
            db.output_from(&live.id, 0, 10 * 1024 * 1024)
                .unwrap()
                .iter()
                .map(|(_, d)| d.len())
                .sum::<usize>(),
            10 * 1024 * 1024
        );
    }
    #[test]
    fn retention_batches_reject_more_than_one_thousand_mutations_atomically() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("batch.sqlite")).unwrap();
        let error = batch(&db, |tx| {
            for i in 0..1001 {
                tx.execute(
                    "INSERT INTO metadata VALUES(?, 'test')",
                    [format!("batch:{i}")],
                )?;
            }
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("retention_batch_limit"));
        db.transaction(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM metadata WHERE key LIKE 'batch:%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn retention_keeps_referenced_receipts_and_projects_history_before_pruning() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("references.sqlite")).unwrap();
        crate::chat_queue::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("shell"),
                provider: "shell",
                mode: "terminal",
                native_id: Some("history"),
                operation_id: "create",
            })
            .unwrap();
        db.bind_operation(
            "create",
            "session.create",
            &serde_json::json!({"title":"shell","nativeId":"history","operationId":"create"}),
        )
        .unwrap();
        db.transaction(|tx| {
            tx.execute("UPDATE operations SET created_at='2000-01-01T00:00:00Z' WHERE id='create'",[])?;
            tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('chat.ui',?,'2000-01-01T00:00:00Z')",[serde_json::json!({"sessionId":session.id,"options":[{"id":"model","value":"kept"}]}).to_string()])?;
            tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('session.status',?,'2000-01-01T00:00:00Z')",[serde_json::json!({"sessionId":session.id,"status":"error"}).to_string()])?;
            for _ in 0..OUTBOX_FLOOR { tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}','2999-01-01T00:00:00Z')",[])?; }
            for i in 0..(BATCH_ROWS+5) {
                tx.execute("INSERT INTO chat_queue_items(id,session_id,position,text,images_json,revision,state,created_at,updated_at) VALUES(?, ?,0,'','[]',0,'failed','2000','2000')",params![format!("q{i}"),session.id])?;
                tx.execute("INSERT INTO operations VALUES(?,'chat.send','null','2000-01-01T00:00:00Z')",[format!("queue:q{i}")])?;
            }
            tx.execute("INSERT INTO operations VALUES('zzz-old','test','null','2000-01-01T00:00:00Z')",[])?;
            tx.execute("INSERT INTO session_retry_attempts VALUES('retry',?,1,'2000','pending','retry-op','2000')",[&session.id])?;
            tx.execute("INSERT INTO operations VALUES('retry-op','test','null','2000-01-01T00:00:00Z')",[])?;
            tx.execute("INSERT INTO chat_fork_intents(operation_id,source_session_id,native_id,created_at) VALUES('fork-op',?,'native','2000')",[&session.id])?;
            tx.execute("INSERT INTO operations VALUES('fork-op:fork:native-import','test','null','2000-01-01T00:00:00Z')",[])?;
            Ok(())
        }).unwrap();
        compact(&db).unwrap();
        assert_eq!(
            db.latest_chat_options(&session.id).unwrap()[0]["value"],
            "kept"
        );
        assert!(db.operation("create").unwrap().is_none());
        assert!(db.operation("zzz-old").unwrap().is_none());
        assert!(db.operation("retry-op").unwrap().is_some());
        assert!(db
            .operation("fork-op:fork:native-import")
            .unwrap()
            .is_some());
        db.transaction(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM operations WHERE id LIKE 'queue:%'",
                    [],
                    |r| r.get::<_, usize>(0)
                )?,
                BATCH_ROWS + 5
            );
            for prefix in ["retention.userTitle:", "retention.nativeHistory:"] {
                assert_eq!(
                    tx.query_row(
                        "SELECT value FROM metadata WHERE key=?",
                        [format!("{prefix}{}", session.id)],
                        |r| r.get::<_, String>(0)
                    )?,
                    "true"
                );
            }
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM retention_event_state WHERE session_id=?",
                    [&session.id],
                    |r| r.get::<_, i64>(0)
                )?,
                2
            );
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn retention_trims_a_boundary_chunk_and_session_end_schedules_without_a_timer() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("boundary.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "boundary",
            })
            .unwrap();
        db.append_output(&session.id, 0, &vec![b'z'; TERMINAL_BYTES as usize + 123])
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        *db.retention.lock().unwrap() = Some(sender);
        assert!(receiver.try_recv().is_err());
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        assert!(receiver.try_recv().is_ok());
        compact(&db).unwrap();
        assert_eq!(db.output_start(&session.id).unwrap(), Some(123));
        assert_eq!(db.output_end(&session.id).unwrap(), TERMINAL_BYTES + 123);
        let (_, _, _, page) = db
            .read_output_window(&session.id, Some(123), false, 1024)
            .unwrap();
        assert_eq!(page.len(), 1024);
        assert!(page.iter().all(|byte| *byte == b'z'));
    }

    #[test]
    fn retention_bounds_git_undo_per_worktree_and_expires_old_rows() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("git-undo-retention.sqlite")).unwrap();
        let project = db
            .add_project(root.path().to_str().unwrap(), Some("undo"), "undo-project")
            .unwrap();
        let scope = root.path().to_str().unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO git_undo(id,operation_id,project_id,worktree_path,kind,payload,created_at) VALUES('expired','expired-op',?,?, 'discard','{}','2000-01-01T00:00:00.000Z')",
                params![project.id, scope],
            )?;
            for index in 0..=GIT_UNDO_PER_WORKTREE {
                tx.execute(
                    "INSERT INTO git_undo(id,operation_id,project_id,worktree_path,kind,payload,created_at) VALUES(?,?,?,?,?,'{}',?)",
                    params![
                        format!("undo-{index:02}"),
                        format!("operation-{index:02}"),
                        project.id,
                        scope,
                        "discard",
                        format!("2999-01-01T00:00:{index:02}.000Z"),
                    ],
                )?;
            }
            Ok(())
        })
        .unwrap();
        compact(&db).unwrap();
        db.transaction(|tx| {
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM git_undo", [], |row| row.get(0))?;
            assert_eq!(count, GIT_UNDO_PER_WORKTREE as i64);
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM git_undo WHERE id='expired'", [], |row| row.get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn startup_cleanup_releases_only_unclaimed_git_bindings() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("git-bindings.sqlite")).unwrap();
        // A fresh database has nothing to sweep.
        assert_eq!(db.release_orphan_git_bindings().unwrap(), 0);
        let request = serde_json::json!({"operationId":"unused"});
        for (id, method) in [
            ("git-orphan", "git.stage"),
            ("git-receipted", "git.discard"),
            ("git-claimed", "git.push"),
            ("chat-orphan", "chat.queue.send"),
            ("session-orphan", "session.update"),
        ] {
            db.bind_operation(id, method, &request).unwrap();
        }
        db.complete_operation("git-receipted", "git.discard", &serde_json::json!({"paths":[]}))
            .unwrap();
        assert!(db.claim_external_operation("git-claimed").unwrap());
        // More orphans than one page, so the pass has to keep paging.
        db.transaction(|tx| {
            for index in 0..BATCH_ROWS + 5 {
                tx.execute(
                    "INSERT INTO operation_requests(id,method,params) VALUES(?,?,'{}')",
                    params![format!("bulk-{index:04}"), "git.stage"],
                )?;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(db.release_orphan_git_bindings().unwrap(), BATCH_ROWS + 6);
        assert!(db.operation_request("git-orphan").unwrap().is_none());
        assert!(db.operation_request("bulk-0000").unwrap().is_none());
        // A claim is not an orphan: it and its binding survive.
        assert_eq!(db.operation_request("git-claimed").unwrap().unwrap().0, "git.push");
        assert!(db.external_operation_pending("git-claimed").unwrap());
        // Receipted and non-Git rows are not this pass's business.
        for (id, method) in [
            ("git-receipted", "git.discard"),
            ("chat-orphan", "chat.queue.send"),
            ("session-orphan", "session.update"),
        ] {
            assert_eq!(db.operation_request(id).unwrap().unwrap().0, method);
        }
        // Every startup sweeps, so a later orphan does not survive the next one.
        db.bind_operation("git-late", "git.commit", &request).unwrap();
        assert_eq!(db.release_orphan_git_bindings().unwrap(), 1);
        assert!(db.operation_request("git-late").unwrap().is_none());
    }
}
