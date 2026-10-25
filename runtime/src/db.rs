use crate::domain::{
    ChatItem, ChatTurnOrigin, Project, Session, SessionDelegation, SessionForkedFrom,
    SessionOrganization, SessionOrganize, Settings, Snapshot,
};
use crate::session_activity::SessionActivity;
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

/// Reason carried by the terminal storage-degraded marker and event (F23).
pub const TERMINAL_STORAGE_FAILED: &str = "terminal_output_storage_failed";

pub struct Database {
    connection: Mutex<Connection>,
    path: PathBuf,
    quiet_terminal_exits: std::sync::atomic::AtomicBool,
    pub(crate) retention: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
}

#[path = "schema.rs"]
pub(crate) mod schema;

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        schema::check_reader(&connection, schema::MAIN_VERSION)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        let upgrade_backup = schema::prepare_main(&connection, path)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, worktree_path TEXT, title TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, native_id TEXT, exit_code INTEGER, followed INTEGER NOT NULL DEFAULT 0, read_only INTEGER NOT NULL DEFAULT 0);
             CREATE TRIGGER IF NOT EXISTS sessions_delete_chat_integrity AFTER DELETE ON sessions BEGIN DELETE FROM metadata WHERE key='chat.integrity:'||OLD.id; END;
             CREATE TRIGGER IF NOT EXISTS sessions_delete_terminal_storage AFTER DELETE ON sessions BEGIN DELETE FROM metadata WHERE key='terminal.storage:'||OLD.id; END;
             CREATE UNIQUE INDEX IF NOT EXISTS active_native_owner ON sessions(provider, native_id) WHERE native_id IS NOT NULL AND status NOT IN ('exited','interrupted','error');
             CREATE TABLE IF NOT EXISTS settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS usage_records (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, provider TEXT NOT NULL, recorded_at TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost REAL, currency TEXT, model TEXT);
             CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, method TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS operation_requests (id TEXT PRIMARY KEY, method TEXT NOT NULL, params TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS external_operations (id TEXT PRIMARY KEY, started_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS leases (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, client_id TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS output_chunks (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, start_cursor INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(session_id,start_cursor));
             CREATE TABLE IF NOT EXISTS deferred_codex_launches (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, phase TEXT NOT NULL, error_code TEXT, error_message TEXT, cwd TEXT);
             CREATE TABLE IF NOT EXISTS chat_items (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS chat_items_session ON chat_items(session_id, created_at, id);
             CREATE TABLE IF NOT EXISTS chat_repair_backups (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at TEXT NOT NULL, items_json TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS subagent_items (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, subagent_key TEXT NOT NULL, item_id TEXT NOT NULL, seq INTEGER NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, subagent_key, item_id));
             CREATE INDEX IF NOT EXISTS subagent_items_rev ON subagent_items(session_id, subagent_key, rev);
             CREATE TABLE IF NOT EXISTS chat_drafts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, text TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS chat_context (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS pi_chat_options (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, auto_retry INTEGER NOT NULL CHECK(auto_retry IN (0,1)));
             CREATE TABLE IF NOT EXISTS session_fork_options (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS chat_fork_intents (operation_id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, native_id TEXT NOT NULL, child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS session_organization (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS session_activity (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, revision INTEGER NOT NULL, turn_id TEXT, reason TEXT);
             CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
             INSERT OR IGNORE INTO settings(singleton,revision,value) VALUES (1,0,'{}');"
        )?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, worktree_path TEXT, revision INTEGER NOT NULL, layout TEXT NOT NULL, updated_at TEXT NOT NULL);")?;
        // Additive migration: prompt overrides are provider-neutral and separate
        // from Pi's legacy boolean table, whose readers keep their semantics.
        connection.execute_batch("CREATE TABLE IF NOT EXISTS chat_option_selections (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, provider TEXT NOT NULL, data TEXT NOT NULL);")?;
        // Agent delegation: one row per delegated Chat session. Deleting either
        // session drops the link; the other session stays a normal session.
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE, agent TEXT NOT NULL, workspace TEXT NOT NULL, workspace_path TEXT NOT NULL, branch TEXT, prompt TEXT NOT NULL, user_messages INTEGER NOT NULL DEFAULT 0, operation_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parent_session_id);",
        )?;
        let has_user_messages = connection
            .prepare("PRAGMA table_info(delegations)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "user_messages");
        if !has_user_messages {
            connection.execute(
                "ALTER TABLE delegations ADD COLUMN user_messages INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // F07: the authority a delegate was fitted to, for the delegation card.
        let has_authority = connection
            .prepare("PRAGMA table_info(delegations)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "authority");
        if !has_authority {
            connection.execute("ALTER TABLE delegations ADD COLUMN authority TEXT", [])?;
        }
        // F07: a delegation start that needs the user's explicit widening.
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS delegation_authority_requests (id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, agent TEXT NOT NULL, authority TEXT NOT NULL, parent_authority TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, request TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS delegation_authority_parent ON delegation_authority_requests(parent_session_id);",
        )?;
        let has_read = connection
            .prepare("PRAGMA table_info(inbox)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "read");
        if !has_read {
            connection.execute(
                "ALTER TABLE inbox ADD COLUMN read INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_read_only = connection
            .prepare("PRAGMA table_info(sessions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "read_only");
        if !has_read_only {
            connection.execute(
                "ALTER TABLE sessions ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_deferred_cwd = connection
            .prepare("PRAGMA table_info(deferred_codex_launches)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "cwd");
        if !has_deferred_cwd {
            connection.execute(
                "ALTER TABLE deferred_codex_launches ADD COLUMN cwd TEXT",
                [],
            )?;
        }
        let session_columns = connection
            .prepare("PRAGMA table_info(sessions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ["cols", "rows"] {
            if !session_columns.iter().any(|name| name == column) {
                connection.execute(
                    &format!("ALTER TABLE sessions ADD COLUMN {column} INTEGER"),
                    [],
                )?;
            }
        }
        let epoch: Option<String> = connection
            .query_row("SELECT value FROM metadata WHERE key='epoch'", [], |r| {
                r.get(0)
            })
            .optional()?;
        if epoch.is_none() {
            connection.execute(
                "INSERT INTO metadata(key,value) VALUES ('epoch',?)",
                [Uuid::new_v4().to_string()],
            )?;
        }
        crate::quick_launch::initialize_connection(&connection)?;
        crate::usage_ledger::initialize_connection(&connection)?;
        schema::migrate_main(&mut connection, upgrade_backup)?;
        Ok(Self {
            connection: Mutex::new(connection),
            path: path.to_owned(),
            quiet_terminal_exits: std::sync::atomic::AtomicBool::new(false),
            retention: Mutex::new(None),
        })
    }
    pub fn begin_shutdown(&self) {
        self.quiet_terminal_exits.store(true, std::sync::atomic::Ordering::Release);
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn backup_to(&self, target: &Path) -> Result<()> {
        let source = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let mut destination = Connection::open(target)?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
        backup.run_to_completion(128, std::time::Duration::from_millis(5), None)?;
        Ok(())
    }
    /// Extension services use this instead of opening a second SQLite writer.
    /// The closure owns one atomic state/outbox mutation on the runtime thread.
    pub fn transaction<T, F>(&self, action: F) -> Result<T>
    where
        F: FnOnce(&Transaction<'_>) -> Result<T>,
    {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let value = action(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    /// Reserve request identity before any external side effect. Replays must
    /// describe exactly the same operation even when its result is not ready.
    pub fn bind_operation(&self, id: &str, method: &str, request: &Value) -> Result<()> {
        self.transaction(|tx| {
            let serialized=serde_json::to_string(request)?;
            let prior:Option<(String,String)>=tx.query_row("SELECT method,params FROM operation_requests WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((prior_method,prior_params))=prior {
                if prior_method!=method || prior_params!=serialized { return Err(anyhow!("operation_conflict: operationId was already used with different parameters")); }
            } else {
                let completed_method:Option<String>=tx.query_row("SELECT method FROM operations WHERE id=?",[id],|r|r.get(0)).optional()?;
                if completed_method.is_some_and(|previous| previous!=method) { return Err(anyhow!("operation_conflict: operationId belongs to another method")); }
                tx.execute("INSERT INTO operation_requests(id,method,params) VALUES (?,?,?)",params![id,method,serialized])?;
            }
            Ok(())
        })
    }
    pub fn mark_chat_degraded(&self, session_id: Option<&str>, reason: &str) -> Result<()> {
        self.transaction(|tx| {
            // Lost transcript updates do not stop a native worker. Preserve its
            // running/waiting state and Stop target instead of exposing a new send.
            emit(tx,"runtime.degraded",json!({"area":"chat","sessionId":session_id,"reason":reason}))?;
            if let Some(session_id) = session_id {
                let revision = tx.last_insert_rowid();
                let marker = json!({"degraded":true,"reason":reason,"revision":revision});
                tx.execute(
                    "INSERT INTO metadata(key,value) SELECT ?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND mode='chat') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![format!("chat.integrity:{session_id}"), serde_json::to_string(&marker)?, session_id],
                )?;
            }
            Ok(())
        })
    }
    /// Records one global ingress warning and durably marks only the Chat workers
    /// that were registered when that failure occurred. Callers must capture the
    /// registry set before entering this transaction; later sessions are not
    /// backfilled from the global outbox event.
    pub fn mark_chat_degraded_for_sessions(
        &self,
        session_ids: &[String],
        reason: &str,
    ) -> Result<()> {
        self.transaction(|tx| {
            emit(
                tx,
                "runtime.degraded",
                json!({"area":"chat","sessionId":Value::Null,"reason":reason}),
            )?;
            let revision = tx.last_insert_rowid();
            let marker = serde_json::to_string(
                &json!({"degraded":true,"reason":reason,"revision":revision}),
            )?;
            let mut unique = HashSet::new();
            for session_id in session_ids {
                if !unique.insert(session_id) {
                    continue;
                }
                tx.execute(
                    "INSERT INTO metadata(key,value) SELECT ?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND mode='chat') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![format!("chat.integrity:{session_id}"), &marker, session_id],
                )?;
            }
            Ok(())
        })
    }
    /// Terminal output the database refused stays in memory in the output store
    /// (bounded) while the PTY reader keeps draining the process, so the session
    /// keeps its running status. This durable marker is the visible state.
    pub fn mark_terminal_storage_degraded(&self, session_id: &str, cursor: i64) -> Result<()> {
        self.transaction(|tx| {
            let marker = json!({"degraded":true,"reason":TERMINAL_STORAGE_FAILED,"cursor":cursor});
            tx.execute(
                "INSERT INTO metadata(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![format!("terminal.storage:{session_id}"), serde_json::to_string(&marker)?, session_id],
            )?;
            emit(tx, "terminal.storage", json!({"sessionId":session_id,"degraded":true,"reason":TERMINAL_STORAGE_FAILED,"cursor":cursor}))?;
            Ok(())
        })
    }
    /// Storage accepted the pending bytes again: recording continues from the
    /// unchanged cursor, so the client reads them instead of a gap.
    pub fn clear_terminal_storage_degraded(&self, session_id: &str) -> Result<()> {
        self.transaction(|tx| {
            tx.execute(
                "DELETE FROM metadata WHERE key=?",
                [format!("terminal.storage:{session_id}")],
            )?;
            emit(tx, "terminal.storage", json!({"sessionId":session_id,"degraded":false}))?;
            Ok(())
        })
    }
    pub fn terminal_storage_degraded(&self, session_id: &str) -> Result<Option<Value>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?",
                [format!("terminal.storage:{session_id}")],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn claim_external_operation(&self, operation_id: &str) -> Result<bool> {
        self.transaction(|tx| {
            Ok(tx.execute(
                "INSERT OR IGNORE INTO external_operations(id,started_at) VALUES (?,?)",
                params![operation_id, now()],
            )? == 1)
        })
    }
    pub fn complete_operation(
        &self,
        operation_id: &str,
        method: &str,
        result: &Value,
    ) -> Result<()> {
        self.transaction(|tx| complete(tx, operation_id, method, result))
    }
    pub(crate) fn clone_fork_launch_config(
        &self,
        source_session_id: &str,
        child_session_id: &str,
        title: &str,
        options: &Value,
    ) -> Result<()> {
        self.transaction(|tx| {
            let config: (String, String, String, Option<String>, Option<String>, String) = tx
                .query_row(
                    "SELECT provider,mode,cwd,project_id,executable,args_json FROM session_launch_configs WHERE session_id=?",
                    [source_session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                )?;
            tx.execute(
                "INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES (?,1,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=session_launch_configs.revision+1,provider=excluded.provider,mode=excluded.mode,cwd=excluded.cwd,project_id=excluded.project_id,title=excluded.title,executable=excluded.executable,args_json=excluded.args_json,source_session_id=excluded.source_session_id",
                params![child_session_id, config.0, config.1, config.2, config.3, title, config.4, config.5, source_session_id],
            )?;
            tx.execute(
                "INSERT INTO session_fork_options(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
                params![child_session_id, serde_json::to_string(options)?],
            )?;
            Ok(())
        })
    }
    pub(crate) fn chat_fork_intent(&self, operation_id: &str) -> Result<Option<(String, Option<String>)>> {
        self.transaction(|tx| {
            tx.query_row(
                "SELECT native_id,child_session_id FROM chat_fork_intents WHERE operation_id=?",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(Into::into)
        })
    }
    pub(crate) fn save_chat_fork_native_intent(
        &self,
        operation_id: &str,
        source_session_id: &str,
        native_id: &str,
    ) -> Result<()> {
        self.transaction(|tx| {
            let prior: Option<(String, String)> = tx.query_row(
                "SELECT source_session_id,native_id FROM chat_fork_intents WHERE operation_id=?",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if prior.as_ref().is_some_and(|value| value != &(source_session_id.to_owned(), native_id.to_owned())) {
                return Err(anyhow!("operation_conflict"));
            }
            tx.execute(
                "INSERT OR IGNORE INTO chat_fork_intents(operation_id,source_session_id,native_id,child_session_id,created_at) VALUES (?,?,?,NULL,?)",
                params![operation_id, source_session_id, native_id, now()],
            )?;
            Ok(())
        })
    }
    pub(crate) fn save_chat_fork_child_intent(&self, operation_id: &str, child_session_id: &str) -> Result<()> {
        self.transaction(|tx| {
            if tx.execute(
                "UPDATE chat_fork_intents SET child_session_id=? WHERE operation_id=? AND (child_session_id IS NULL OR child_session_id=?)",
                params![child_session_id, operation_id, child_session_id],
            )? != 1 {
                return Err(anyhow!("operation_outcome_unknown"));
            }
            Ok(())
        })
    }
    pub(crate) fn recover_chat_fork_child_intent(&self, operation_id: &str, child_session_id: &str) -> Result<bool> {
        self.transaction(|tx| {
            let matched: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_fork_intents i JOIN sessions s ON s.id=? WHERE i.operation_id=? AND i.child_session_id IS NULL AND s.native_id=i.native_id)",
                params![child_session_id, operation_id],
                |row| row.get(0),
            )?;
            if matched {
                tx.execute(
                    "UPDATE chat_fork_intents SET child_session_id=? WHERE operation_id=? AND child_session_id IS NULL",
                    params![child_session_id, operation_id],
                )?;
            }
            Ok(matched)
        })
    }
    pub(crate) fn pending_fork_options(&self, session_id: &str) -> Result<Value> {
        self.transaction(|tx| {
            let raw: Option<String> = tx.query_row(
                "SELECT data FROM session_fork_options WHERE session_id=?",
                [session_id],
                |row| row.get(0),
            ).optional()?;
            raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
                .unwrap_or_else(|| Ok(json!([])))
        })
    }
    pub(crate) fn latest_chat_options(&self, session_id: &str) -> Result<Value> {
        self.transaction(|tx| {
            let raw: Option<String> = tx.query_row(
                "SELECT data FROM (SELECT seq,data FROM outbox WHERE event='chat.ui' AND json_extract(data,'$.sessionId')=?1 UNION ALL SELECT seq,data FROM retention_event_state WHERE event='chat.ui' AND session_id=?1) ORDER BY seq DESC LIMIT 1",
                [session_id],
                |row| row.get(0),
            ).optional()?;
            let payload = raw.map(|value| serde_json::from_str::<Value>(&value)).transpose()?;
            Ok(payload.and_then(|value| value.get("options").cloned()).unwrap_or_else(|| json!([])))
        })
    }
    pub(crate) fn clear_pending_fork_options(&self, session_id: &str) -> Result<()> {
        self.transaction(|tx| {
            tx.execute("DELETE FROM session_fork_options WHERE session_id=?", [session_id])?;
            Ok(())
        })
    }
    pub(crate) fn complete_chat_fork(
        &self,
        child_session_id: &str,
        source_session_id: &str,
        item_id: Option<&str>,
        source_title: &str,
        mode: &str,
        operation_id: &str,
    ) -> Result<Value> {
        self.transaction(|tx| {
            if let Some(result) = operation_tx(tx, operation_id)? {
                return Ok(result);
            }
            let mut session = session_tx(tx, child_session_id)?;
            session.organization.forked_from = Some(SessionForkedFrom {
                session_id: source_session_id.to_owned(),
                item_id: item_id.map(str::to_owned),
                title: Some(source_title.to_owned()),
            });
            session.organization.organization_revision += 1;
            tx.execute(
                "INSERT INTO session_organization(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
                params![child_session_id, serde_json::to_string(&session.organization)?],
            )?;
            let result = json!({"session":session,"mode":mode});
            complete(tx, operation_id, "chat.fork", &result)?;
            emit(tx, "chat.forked", json!({
                "sessionId":source_session_id,
                "operationId":operation_id,
                "session":session,
                "mode":mode,
            }))?;
            emit(tx, "state.changed", json!({"sessionId":child_session_id,"kind":"chat.fork"}))?;
            // The fork is resolved: its native-intent fence is no longer needed
            // and must not accumulate one row per fork.
            tx.execute(
                "DELETE FROM chat_fork_intents WHERE operation_id=?",
                [operation_id],
            )?;
            Ok(result)
        })
    }
    pub fn read_inbox(&self, ids: &[String], operation_id: &str) -> Result<()> {
        self.mutate_null(operation_id, "inbox.read", |tx| {
            for id in ids {
                tx.execute("UPDATE inbox SET read=1 WHERE id=?", [id])?;
            }
            emit(tx, "state.changed", json!({"kind":"inbox"}))
        })
    }
    pub fn acknowledge_session_replies(&self, session_id: &str) -> Result<()> {
        self.transaction(|tx| acknowledge_session_replies_tx(tx, session_id))
    }
    pub fn acknowledge_session_attention(
        &self,
        session_id: &str,
        expected_revision: i64,
        operation_id: &str,
    ) -> Result<Session> {
        self.transaction(|tx| {
            if let Some(value) = operation_tx(tx, operation_id)? {
                return serde_json::from_value(value).map_err(Into::into);
            }
            let activity = session_activity_tx(tx, session_id)?
                .ok_or_else(|| anyhow!("attention_not_found"))?;
            if activity.revision != expected_revision {
                return Err(anyhow!("revision_conflict"));
            }
            if activity.state != "awaiting_input" {
                return Err(anyhow!("attention_not_actionable"));
            }
            if has_pending_attention_approval_tx(tx, session_id)? {
                return Err(anyhow!("attention_approval_pending"));
            }
            let next = SessionActivity::new(
                "idle",
                activity.revision + 1,
                activity.turn_id.as_deref(),
                None,
            );
            let changed = tx.execute(
                "UPDATE session_activity SET state=?,revision=?,turn_id=?,reason=NULL WHERE session_id=? AND revision=? AND state='awaiting_input'",
                params![&next.state, next.revision, &next.turn_id, session_id, expected_revision],
            )?;
            if changed != 1 { return Err(anyhow!("revision_conflict")); }
            let session = session_tx(tx, session_id)?;
            complete(tx, operation_id, "session.attention.acknowledge", &session)?;
            emit(
                tx,
                "session.activity",
                json!({"sessionId":session_id,"activity":next}),
            )?;
            emit(
                tx,
                "state.changed",
                json!({"sessionId":session_id,"kind":"session.activity"}),
            )?;
            Ok(session)
        })
    }
    /// Native hook workers may report only authoritative activity. The durable
    /// native-id check fences a recycled terminal/session pair before it can
    /// affect the renderer snapshot.
    pub fn apply_native_session_activity(
        &self,
        session_id: &str,
        native_id: &str,
        state: &str,
        turn_id: Option<&str>,
        reason: Option<&str>,
    ) -> Result<Option<SessionActivity>> {
        if !matches!(
            state,
            "running" | "awaiting_approval" | "awaiting_input" | "idle" | "unknown"
        ) {
            return Err(anyhow!("invalid_activity_state"));
        }
        self.transaction(|tx| {
            let owner: Option<(Option<String>, String, bool, String)> = tx.query_row(
                "SELECT native_id,mode,read_only,status FROM sessions WHERE id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional()?;
            let Some((owner_native_id, mode, read_only, status)) = owner else { return Ok(None); };
            if mode != "terminal" || read_only || owner_native_id.as_deref() != Some(native_id)
                || matches!(status.as_str(), "exited" | "interrupted" | "error") {
                return Ok(None);
            }
            let current = session_activity_tx(tx, session_id)?;
            if current.as_ref().is_some_and(|activity| activity.state == state && activity.turn_id.as_deref() == turn_id && activity.reason.as_deref() == reason) {
                return Ok(current);
            }
            let next = SessionActivity::new(state, current.as_ref().map_or(1, |activity| activity.revision + 1), turn_id, reason);
            tx.execute(
                "INSERT INTO session_activity(session_id,state,revision,turn_id,reason) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,turn_id=excluded.turn_id,reason=excluded.reason",
                params![session_id, &next.state, next.revision, &next.turn_id, &next.reason],
            )?;
            emit(tx, "session.activity", json!({"sessionId":session_id,"activity":next}))?;
            emit(tx, "state.changed", json!({"sessionId":session_id,"kind":"session.activity"}))?;
            session_activity_tx(tx, session_id)
        })
    }
    /// Replaces the client operation id with the provider's canonical turn id
    /// after a successful send. A prior/late turn cannot overwrite a newer
    /// accepted user operation.
    pub fn bind_chat_activity_turn(
        &self,
        session_id: &str,
        operation_id: &str,
        turn_id: &str,
    ) -> Result<Option<SessionActivity>> {
        self.transaction(|tx| {
            let current = session_activity_tx(tx, session_id)?;
            let Some(activity) = current else { return Ok(None); };
            if activity.state != "running" || activity.turn_id.as_deref() != Some(operation_id) {
                return Ok(None);
            }
            let next = SessionActivity::new("running", activity.revision + 1, Some(turn_id), None);
            tx.execute(
                "UPDATE session_activity SET state=?,revision=?,turn_id=?,reason=NULL WHERE session_id=? AND revision=? AND state='running' AND turn_id=?",
                params![&next.state, next.revision, &next.turn_id, session_id, activity.revision, operation_id],
            )?;
            emit(tx, "session.activity", json!({"sessionId":session_id,"activity":next}))?;
            emit(tx, "state.changed", json!({"sessionId":session_id,"kind":"session.activity"}))?;
            session_activity_tx(tx, session_id)
        })
    }
    pub fn epoch(&self) -> Result<String> {
        self.value("epoch")
    }
    fn value(&self, key: &str) -> Result<String> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |r| {
                r.get(0)
            })
            .map_err(Into::into)
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let projects = collect_projects(&conn)?;
        let sessions = collect_sessions(&conn)?;
        let settings = settings(&conn)?;
        let revision: i64 =
            conn.query_row("SELECT COALESCE(MAX(seq),0) FROM outbox", [], |r| r.get(0))?;
        let epoch: String =
            conn.query_row("SELECT value FROM metadata WHERE key='epoch'", [], |r| {
                r.get(0)
            })?;
        Ok(Snapshot {
            epoch,
            revision,
            projects,
            sessions,
            settings,
            workspaces: collect_workspaces(&conn)?,
            inbox: collect_inbox(&conn)?,
            providers: vec![],
        })
    }
    pub fn events_after(&self, after: i64) -> Result<Vec<(i64, String, Value)>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let pruned: i64 = conn.query_row(
            "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='retention.outboxPrunedThrough'),0)",
            [], |row| row.get(0),
        )?;
        if after < pruned {
            let revision: i64 = conn.query_row("SELECT COALESCE(MAX(seq),0) FROM outbox", [], |row| row.get(0))?;
            return Ok(vec![(revision, "runtime.degraded".into(), json!({"reason":"outbox_history_pruned","snapshotRequired":true,"oldestCursor":pruned}))]);
        }
        let mut statement =
            conn.prepare("SELECT seq,event,data FROM outbox WHERE seq>? ORDER BY seq LIMIT 256")?;
        let rows = statement.query_map([after], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (seq, event, data) = row?;
            Ok((seq, event, serde_json::from_str(&data)?))
        })
        .collect()
    }
    pub fn record_provider_event(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        kind: &str,
        data: &Value,
    ) -> Result<()> {
        let result = crate::chat_projection::record(self, session_id, turn_id, kind, data);
        if result.is_ok() && kind == "session.closed" { self.schedule_retention(); }
        result
    }
    pub fn chat_items(&self, session_id: &str) -> Result<Vec<ChatItem>> {
        Ok(self.chat_snapshot(session_id)?.0)
    }
    /// On-demand read of one inline image that a bounded snapshot page replaced
    /// with a reference. The item must belong to the session.
    pub fn chat_image(
        &self,
        session_id: &str,
        item_id: &str,
        part: usize,
        index: usize,
    ) -> Result<Value> {
        let data: Option<String> = self.transaction(|tx| {
            Ok(tx
                .query_row(
                    "SELECT data FROM chat_items WHERE session_id=? AND id=?",
                    params![session_id, item_id],
                    |r| r.get(0),
                )
                .optional()?)
        })?;
        let data = data.ok_or_else(|| anyhow!("image_not_found"))?;
        let item: Value = serde_json::from_str(&data)?;
        let image = item
            .get("parts")
            .and_then(Value::as_array)
            .and_then(|parts| parts.get(part))
            .and_then(|part| part.get("data"))
            .and_then(|data| data.get("images"))
            .and_then(Value::as_array)
            .and_then(|images| images.get(index))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("image_not_found"))?;
        Ok(json!({"data":image}))
    }
    pub fn subagent_card(&self, session_id: &str, key: &str) -> Result<Option<ChatItem>> {
        self.transaction(|tx| subagent_card_tx(tx, session_id, key))
    }
    pub fn subagent_items_after(
        &self,
        session_id: &str,
        key: &str,
        after_rev: i64,
    ) -> Result<(Vec<ChatItem>, i64, bool)> {
        self.transaction(|tx| subagent_items_after_tx(tx, session_id, key, after_rev))
    }
    pub fn chat_draft(&self, session_id: &str) -> Result<Value> {
        self.transaction(|tx| {
            let value: Option<(i64, String)> = tx
                .query_row(
                    "SELECT revision,text FROM chat_drafts WHERE session_id=?",
                    [session_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (revision, text) = value.unwrap_or((0, String::new()));
            Ok(json!({"revision":revision,"text":text}))
        })
    }
    pub fn save_chat_draft(
        &self,
        session_id: &str,
        text: &str,
        expected: i64,
        operation_id: &str,
    ) -> Result<Value> {
        if text.len() > 1024 * 1024 {
            return Err(anyhow!("draft_too_large"));
        }
        self.transaction(|tx| {
            if let Some(value)=operation_tx(tx,operation_id)? {return Ok(value);}
            let revision:Option<i64>=tx.query_row("SELECT revision FROM chat_drafts WHERE session_id=?",[session_id],|r|r.get(0)).optional()?;
            if revision.unwrap_or(0)!=expected {return Err(anyhow!("revision_conflict"));}
            let next=expected+1;
            tx.execute("INSERT INTO chat_drafts(session_id,revision,text) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,text=excluded.text",params![session_id,next,text])?;
            let result=json!({"revision":next,"text":text});
            complete(tx,operation_id,"chat.draft.save",&result)?;
            emit(tx,"chat.draft.changed",json!({"sessionId":session_id,"revision":next}))?;
            Ok(result)
        })
    }
    pub fn chat_context(&self, session_id: &str) -> Result<Option<Value>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let value: Option<(String, String)> = conn
            .query_row(
                "SELECT data,updated_at FROM chat_context WHERE session_id=?",
                [session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        value
            .map(|(text, updated_at)| {
                let mut snapshot: Value = serde_json::from_str(&text)?;
                if snapshot
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
                {
                    snapshot["updatedAt"] = json!(updated_at);
                }
                Ok(snapshot)
            })
            .transpose()
    }
    pub fn pi_auto_retry(&self, session_id: &str) -> Result<Option<bool>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.query_row(
            "SELECT auto_retry FROM pi_chat_options WHERE session_id=?",
            [session_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(Into::into)
    }
    pub(crate) fn chat_option_selections(&self, session_id: &str, provider: &str) -> Result<Value> {
        self.transaction(|tx| {
            let raw: Option<String> = tx.query_row(
                "SELECT data FROM chat_option_selections WHERE session_id=? AND provider=?",
                params![session_id, provider], |row| row.get(0),
            ).optional()?;
            raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).unwrap_or_else(|| Ok(json!([])))
        })
    }
    pub(crate) fn set_chat_option_selections(&self, session_id: &str, provider: &str, selections: &Value) -> Result<()> {
        let Some(rows) = selections.as_array().filter(|rows| rows.len() <= 32) else { return Err(anyhow!("invalid_chat_options")) };
        let mut ids = HashSet::new();
        for row in rows {
            let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(|| anyhow!("invalid_chat_options"))?;
            if !ids.insert(id) || row.get("value").and_then(Value::as_str).is_none() { return Err(anyhow!("invalid_chat_options")); }
        }
        self.transaction(|tx| {
            let changed = tx.execute(
                "INSERT INTO chat_option_selections(session_id,provider,data) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND provider=? AND mode='chat') ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,data=excluded.data",
                params![session_id, provider, serde_json::to_string(selections)?, session_id, provider],
            )?;
            if changed != 1 { return Err(anyhow!("chat_session_not_found")); }
            Ok(())
        })
    }
    pub fn set_pi_auto_retry(&self, session_id: &str, enabled: bool) -> Result<()> {
        self.transaction(|tx| {
            let changed = tx.execute(
                "INSERT INTO pi_chat_options(session_id,auto_retry) SELECT ?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND provider='pi') ON CONFLICT(session_id) DO UPDATE SET auto_retry=excluded.auto_retry",
                params![session_id, enabled, session_id],
            )?;
            if changed != 1 {
                return Err(anyhow!("pi_chat_session_not_found"));
            }
            Ok(())
        })
    }
    pub fn chat_snapshot(&self, session_id: &str) -> Result<(Vec<ChatItem>, i64)> {
        self.transaction(|tx| {
            let mut statement = tx
                .prepare("SELECT data FROM chat_items WHERE session_id=? ORDER BY created_at,id")?;
            let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
            let mut items = Vec::new();
            for row in rows {
                items.push(serde_json::from_str(&row?)?);
            }
            let revision =
                tx.query_row("SELECT COALESCE(MAX(seq),0) FROM outbox", [], |r| r.get(0))?;
            Ok((items, revision))
        })
    }

    pub fn operation(&self, operation_id: &str) -> Result<Option<Value>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let result: Option<String> = conn
            .query_row(
                "SELECT result FROM operations WHERE id=?",
                [operation_id],
                |r| r.get(0),
            )
            .optional()?;
        result
            .map(|raw| serde_json::from_str(&raw).context("decoding idempotent result"))
            .transpose()
    }
    pub fn deferred_codex_launch(&self, session_id: &str) -> Result<Option<Value>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.query_row(
            "SELECT phase,error_code,error_message FROM deferred_codex_launches WHERE session_id=?",
            [session_id],
            |row| {
                let phase: String = row.get(0)?;
                let code: Option<String> = row.get(1)?;
                let message: Option<String> = row.get(2)?;
                let mut result = json!({"phase":phase});
                if let (Some(code), Some(message)) = (code, message) {
                    result["error"] = json!({"code":code,"message":message});
                }
                Ok(result)
            },
        )
        .optional()
        .map_err(Into::into)
    }
    pub fn deferred_codex_cwd(&self, session_id: &str) -> Result<Option<String>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.query_row(
            "SELECT cwd FROM deferred_codex_launches WHERE session_id=?",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map(|cwd| cwd.flatten())
        .map_err(Into::into)
    }
    pub fn begin_deferred_codex_launch(&self, session_id: &str) -> Result<()> {
        self.transaction(|tx| {
            let session = session_tx(tx, session_id)?;
            if session.provider != "codex" || session.mode != "terminal" || session.status != "starting" {
                return Err(anyhow!("invalid_deferred_launch_state"));
            }
            tx.execute(
                "INSERT INTO deferred_codex_launches(session_id,phase,error_code,error_message) VALUES (?,'preparing',NULL,NULL) ON CONFLICT(session_id) DO UPDATE SET phase='preparing',error_code=NULL,error_message=NULL",
                [session_id],
            )?;
            emit(tx, "state.changed", json!({"sessionId":session_id,"kind":"session.launch"}))?;
            Ok(())
        })
    }
    pub fn set_deferred_codex_launch_phase(&self, session_id: &str, phase: &str) -> Result<()> {
        if !matches!(phase, "launching" | "running") {
            return Err(anyhow!("invalid_deferred_launch_phase"));
        }
        self.transaction(|tx| {
            if tx.execute(
                "UPDATE deferred_codex_launches SET phase=?,error_code=NULL,error_message=NULL WHERE session_id=? AND phase IN ('preparing','launching')",
                params![phase, session_id],
            )? != 1 {
                return Err(anyhow!("invalid_deferred_launch_state"));
            }
            emit(tx, "state.changed", json!({"sessionId":session_id,"kind":"session.launch"}))?;
            Ok(())
        })
    }
    pub fn fail_deferred_codex_launch(
        &self,
        session_id: &str,
        code: &str,
        message: &str,
    ) -> Result<()> {
        self.transaction(|tx| {
            let previous: String = tx.query_row("SELECT status FROM sessions WHERE id=?",[session_id],|row|row.get(0))?;
            if !matches!(previous.as_str(), "starting" | "running" | "error") {
                return Err(anyhow!("invalid_deferred_launch_state"));
            }
            if previous != "error" {
                tx.execute("UPDATE sessions SET status='error',exit_code=NULL,updated_at=? WHERE id=?", params![now(),session_id])?;
                let data=json!({"sessionId":session_id,"status":"error","previousStatus":previous,"exitCode":null});
                emit(tx,"session.status",data.clone())?;
                emit(tx,"state.changed",data)?;
            }
            if tx.execute(
                "UPDATE deferred_codex_launches SET phase='failed',error_code=?,error_message=? WHERE session_id=? AND phase IN ('preparing','launching')",
                params![code,message,session_id],
            )? != 1 {
                return Err(anyhow!("invalid_deferred_launch_state"));
            }
            emit(tx,"state.changed",json!({"sessionId":session_id,"kind":"session.launch"}))?;
            Ok(())
        })
    }
    pub fn cancel_deferred_codex_launch(&self, session_id: &str) -> Result<()> {
        self.transaction(|tx| {
            let previous: String = tx.query_row("SELECT status FROM sessions WHERE id=?",[session_id],|row|row.get(0))?;
            if previous == "starting" {
                tx.execute("UPDATE sessions SET status='exited',exit_code=NULL,updated_at=? WHERE id=?", params![now(),session_id])?;
                let data=json!({"sessionId":session_id,"status":"exited","previousStatus":"starting","exitCode":null});
                emit(tx,"session.status",data.clone())?;
                emit(tx,"state.changed",data)?;
            }
            tx.execute("UPDATE deferred_codex_launches SET phase='cancelled',error_code=NULL,error_message=NULL WHERE session_id=? AND phase IN ('preparing','launching')",[session_id])?;
            emit(tx,"state.changed",json!({"sessionId":session_id,"kind":"session.launch"}))?;
            Ok(())
        })
    }
    /// Binds a provider-native conversation identity captured for a terminal
    /// session (pre-assigned at launch or parsed from the provider's own exit
    /// output), then announces the change so session lists pick up the new
    /// resumable identity. Unlike `bind_session` this emits `state.changed`;
    /// it is for one-shot terminal captures, not chat worker events.
    pub fn bind_native_id(&self, id: &str, native_id: &str) -> Result<()> {
        self.transaction(|tx| {
            let prior:Option<String>=tx.query_row("SELECT native_id FROM sessions WHERE id=?",[id],|r|r.get(0))?;
            if let Some(prior)=prior.as_deref() {
                if prior==native_id { return Ok(false); }
                return Err(anyhow!("native_identity_conflict"));
            }
            let owner:Option<String>=tx.query_row("SELECT other.id FROM sessions other JOIN sessions current ON current.id=? WHERE other.provider=current.provider AND other.native_id=? AND other.id<>? LIMIT 1",params![id,native_id,id],|r|r.get(0)).optional()?;
            if let Some(owner)=owner{return Err(anyhow!("native_session_exists:{owner}"));}
            tx.execute("UPDATE sessions SET native_id=?,updated_at=? WHERE id=?",params![native_id,now(),id])?;
            emit(tx,"state.changed",json!({"sessionId":id,"kind":"session.native_bound"}))?;
            Ok(true)
        })?;
        Ok(())
    }
    pub fn bind_session(&self, id: &str, cwd: Option<&str>, native_id: Option<&str>) -> Result<()> {
        self.transaction(|tx| {
            let prior:Option<String>=tx.query_row("SELECT native_id FROM sessions WHERE id=?",[id],|r|r.get(0))?;
            if prior.as_deref().zip(native_id).is_some_and(|(a,b)|a!=b) { return Err(anyhow!("native_identity_conflict")); }
            if let Some(native_id)=native_id {
                let owner:Option<String>=tx.query_row("SELECT other.id FROM sessions other JOIN sessions current ON current.id=? WHERE other.provider=current.provider AND other.native_id=? AND other.id<>? LIMIT 1",params![id,native_id,id],|r|r.get(0)).optional()?;
                if let Some(owner)=owner{return Err(anyhow!("native_session_exists:{owner}"));}
            }
            // Most worker events carry the identity already bound at connection.
            // Preserve conflict checks without dirtying a SQLite page each time.
            tx.execute("UPDATE sessions SET worktree_path=COALESCE(?,worktree_path),native_id=COALESCE(?,native_id) WHERE id=? AND ((? IS NOT NULL AND worktree_path IS NOT ?) OR (? IS NOT NULL AND native_id IS NOT ?))",params![cwd,native_id,id,cwd,cwd,native_id,native_id])?;
            Ok(())
        })
    }
    /// Replaces a Pi Chat session's native identity only for an explicit,
    /// worker-scoped `/new` event. Generic provider events must keep using
    /// `bind_session`, which continues to reject identity changes.
    pub fn replace_pi_chat_native_id(
        &self,
        id: &str,
        expected_prior: Option<&str>,
        new_native_id: &str,
    ) -> Result<()> {
        if new_native_id.trim().is_empty() {
            return Err(anyhow!("invalid_native_id"));
        }
        self.transaction(|tx| {
            let (provider, mode, prior): (String, String, Option<String>) = tx.query_row(
                "SELECT provider,mode,native_id FROM sessions WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            if provider != "pi" || mode != "chat" {
                return Err(anyhow!("native_identity_replacement_unsupported"));
            }
            if prior.as_deref() != expected_prior {
                return Err(anyhow!("native_identity_conflict"));
            }
            if prior.as_deref() == Some(new_native_id) {
                return Ok(());
            }
            let owner: Option<String> = tx
                .query_row(
                    "SELECT id FROM sessions WHERE provider='pi' AND native_id=? AND id<>? LIMIT 1",
                    params![new_native_id, id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner {
                return Err(anyhow!("native_session_exists:{owner}"));
            }
            tx.execute(
                "UPDATE sessions SET native_id=?,updated_at=? WHERE id=?",
                params![new_native_id, now(), id],
            )?;
            // session_launch_configs contains launch parameters, not native
            // identity. The sessions row remains the single durable owner.
            emit(
                tx,
                "state.changed",
                json!({"sessionId":id,"kind":"session.native_replaced"}),
            )?;
            Ok(())
        })
    }
    /// Atomically accepts a newly opened Chat worker into durable state.
    ///
    /// A concurrent stop can win before provider startup begins or after the
    /// worker has been published. In either case, the caller must close that
    /// worker when this returns `false`. Provider events may also have already
    /// advanced a live session to running/waiting/idle, so only `starting` is
    /// changed to `idle` here.
    pub fn accept_chat_connection(&self, id: &str, native_id: Option<&str>) -> Result<bool> {
        self.transaction(|tx| {
            let (status, read_only, prior, provider): (String, bool, Option<String>, String) = tx
                .query_row(
                    "SELECT status,read_only,native_id,provider FROM sessions WHERE id=?",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            if read_only
                || !matches!(status.as_str(), "starting" | "running" | "idle" | "waiting")
            {
                return Ok(false);
            }
            if prior
                .as_deref()
                .zip(native_id)
                .is_some_and(|(existing, opened)| existing != opened)
            {
                return Err(anyhow!("native_identity_conflict"));
            }
            if let Some(native_id) = native_id {
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT id FROM sessions WHERE provider=? AND native_id=? AND id<>? LIMIT 1",
                        params![provider, native_id, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(owner) = owner {
                    return Err(anyhow!("native_session_exists:{owner}"));
                }
            }
            tx.execute(
                "UPDATE sessions SET native_id=COALESCE(?,native_id) WHERE id=?",
                params![native_id, id],
            )?;
            if status == "starting" {
                tx.execute(
                    "UPDATE sessions SET status='idle',exit_code=NULL,updated_at=? WHERE id=?",
                    params![now(), id],
                )?;
                let data = json!({"sessionId":id,"status":"idle","previousStatus":"starting","exitCode":null});
                emit(tx, "session.status", data.clone())?;
                emit(tx, "state.changed", data)?;
            }
            Ok(true)
        })
    }
    /// Checks whether replacing a missing provider-native Chat identity is
    /// conservative. Absence means no projected record of any kind, no prompt
    /// queue row, no claimed native Chat action, no fork/delegation/rerun
    /// provenance, and no degraded or repaired transcript evidence.
    pub(crate) fn empty_chat_native_recovery_eligible(
        &self,
        id: &str,
        expected_native_id: &str,
    ) -> Result<bool> {
        self.transaction(|tx| empty_chat_native_recovery_eligible_tx(tx, id, expected_native_id))
    }

    /// Rechecks the complete empty-Chat predicate and replaces the exact
    /// missing identity in one transaction. The provider registry holds its
    /// generation fence while this runs, so the new worker cannot be accepted
    /// against an obsolete or unowned durable identity.
    pub(crate) fn replace_empty_chat_native_id(
        &self,
        id: &str,
        expected_native_id: &str,
        replacement_native_id: &str,
    ) -> Result<bool> {
        if replacement_native_id.trim().is_empty() {
            return Err(anyhow!("invalid_native_id"));
        }
        if replacement_native_id == expected_native_id {
            return Err(anyhow!("native_identity_conflict"));
        }
        self.transaction(|tx| {
            if !empty_chat_native_recovery_eligible_tx(tx, id, expected_native_id)? {
                return Ok(false);
            }
            let provider: String =
                tx.query_row("SELECT provider FROM sessions WHERE id=?", [id], |row| row.get(0))?;
            let owner: Option<String> = tx
                .query_row(
                    "SELECT id FROM sessions WHERE provider=? AND native_id=? AND id<>? LIMIT 1",
                    params![provider, replacement_native_id, id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner {
                return Err(anyhow!("native_session_exists:{owner}"));
            }
            if tx.execute(
                "UPDATE sessions SET native_id=?,updated_at=? WHERE id=? AND native_id=?",
                params![replacement_native_id, now(), id, expected_native_id],
            )? != 1
            {
                return Ok(false);
            }
            emit(
                tx,
                "state.changed",
                json!({"sessionId":id,"kind":"session.native_replaced"}),
            )?;
            Ok(true)
        })
    }
    /// Reserves an explicit provider connection against the current durable
    /// lifecycle. Failed and restart-interrupted sessions become live attempts
    /// before provider startup, allowing a concurrent stop to fence them with
    /// `exited`. Already-live states retain their provider-event status.
    pub fn begin_chat_connection(&self, id: &str) -> Result<bool> {
        self.transaction(|tx| {
            let (status, read_only): (String, bool) = tx.query_row(
                "SELECT status,read_only FROM sessions WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if read_only || status == "exited" {
                return Ok(false);
            }
            if matches!(status.as_str(), "error" | "interrupted") {
                tx.execute(
                    "UPDATE sessions SET status='starting',exit_code=NULL,updated_at=? WHERE id=?",
                    params![now(), id],
                )?;
                let data = json!({"sessionId":id,"status":"starting","previousStatus":status,"exitCode":null});
                emit(tx, "session.status", data.clone())?;
                emit(tx, "state.changed", data)?;
            }
            Ok(true)
        })
    }
    pub fn session_by_id(&self, id: &str) -> Result<Option<Session>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?)",
            [id],
            |r| r.get(0),
        )?;
        if exists {
            Ok(Some(read_session(&conn, id)?))
        } else {
            Ok(None)
        }
    }
    pub fn native_owner(&self, provider: &str, native_id: &str) -> Result<Option<Session>> {
        self.transaction(|tx| {
            let id: Option<String> = tx.query_row("SELECT id FROM sessions WHERE provider=? AND native_id=? ORDER BY (read_only=0 AND status IN ('starting','running','idle','waiting')) DESC,created_at LIMIT 1",params![provider,native_id],|r|r.get(0)).optional()?;
            id.map(|id|session_tx(tx,&id)).transpose()
        })
    }
    pub fn reserve_resume(
        &self,
        id: &str,
        workspace_root: &str,
        cwd: &str,
        operation_id: &str,
    ) -> Result<Session> {
        self.transaction(|tx| {
            if let Some(value) = operation_tx(tx, operation_id)? {return Ok(serde_json::from_value(value)?);}
            let mut session = session_tx(tx,id)?;
            if !session.read_only && !matches!(session.status.as_str(),"exited"|"interrupted"|"error") {return Err(anyhow!("session_already_active"));}
            session.status="starting".into();session.exit_code=None;session.worktree_path=Some(workspace_root.into());
            session.organization.archived=false;session.organization.organization_revision+=1;
            session.read_only=false;
            tx.execute("UPDATE sessions SET status='starting',exit_code=NULL,read_only=0,worktree_path=?,updated_at=? WHERE id=?",params![workspace_root,now(),id])?;
            if tx.execute(
                "UPDATE session_launch_configs SET cwd=?,revision=revision+1 WHERE session_id=?",
                params![cwd, id],
            )? != 1
            {
                return Err(anyhow!("launch_config_missing"));
            }
            tx.execute("INSERT INTO session_organization(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",params![id,serde_json::to_string(&session.organization)?])?;
            complete(tx,operation_id,"session.resume",&session)?;
            emit(tx,"state.changed",json!({"sessionId":id,"kind":"session.resume"}))?;
            Ok(session)
        })
    }
    pub fn import_chat_history(&self, id: &str, items: &[ChatItem]) -> Result<()> {
        let native_id = self.session_by_id(id)?.and_then(|session| session.native_id);
        let mut items = normalize_history_transcript(id, items)?;
        add_generic_fork_anchors(&mut items, native_id.as_deref());
        self.transaction(|tx| {
            for item in &items {
                let changed=tx.execute("INSERT OR IGNORE INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,'message',?,?)",params![item.id,id,item.turn_id,serde_json::to_string(&item)?,item.created_at])?;
                if changed>0 {emit(tx,"chat.item",json!({"sessionId":id,"item":item}))?;}
            }
            Ok(())
        })
    }
    pub fn import_history_session(
        &self,
        request: ImportHistorySession<'_>,
    ) -> Result<(Session, bool)> {
        self.transaction(|tx| {
            if let Some(value)=operation_tx(tx,request.operation_id)? { return Ok((serde_json::from_value(value)?, false)); }
            if let Some(owner)=tx.query_row("SELECT id FROM sessions WHERE provider=? AND native_id=? LIMIT 1",params![request.provider,request.native_id],|r|r.get::<_,String>(0)).optional()? {
                let session=session_tx(tx,&owner)?;
                complete(tx,request.operation_id,"history.import",&session)?;
                return Ok((session,false));
            }
            let timestamp=now();
            let session=Session { id:Uuid::new_v4().to_string(), project_id:request.project_id.map(str::to_owned), worktree_path:Some(request.cwd.to_owned()), title:request.title.unwrap_or(request.provider).to_owned(), provider:request.provider.to_owned(), mode:request.mode.to_owned(), status:"idle".into(), created_at:timestamp.clone(), updated_at:timestamp, native_id:Some(request.native_id.to_owned()), exit_code:None, cols:None, rows:None, followed:false, read_only:true, activity:None, delegation:None, group:None, run:None, organization:SessionOrganization::default() };
            let mut transcript = normalize_history_transcript(&session.id, request.transcript)?;
            add_generic_fork_anchors(&mut transcript, Some(request.native_id));
            tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,exit_code,followed,read_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",params![session.id,session.project_id,session.worktree_path,session.title,session.provider,session.mode,session.status,session.created_at,session.updated_at,session.native_id,session.exit_code,session.followed])?;
            tx.execute(
                "INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES(?,1,?,?,?,?,?,NULL,'[]',NULL)",
                params![session.id, request.provider, request.mode, request.cwd, request.project_id, request.title],
            )?;
            for item in &transcript {
                tx.execute(
                    "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,'message',?,?)",
                    params![item.id, session.id, item.turn_id, serde_json::to_string(&item)?, item.created_at],
                )?;
                emit(tx,"chat.item",json!({"sessionId":session.id,"item":item}))?;
            }
            complete(tx,request.operation_id,"history.import",&session)?;
            emit(tx,"state.changed",json!({"sessionId":session.id,"kind":"history.import"}))?;
            Ok((session,true))
        })
    }
    pub fn require_interactive(&self, id: &str) -> Result<()> {
        if self
            .session_by_id(id)?
            .is_some_and(|session| session.read_only)
        {
            Err(anyhow!("session_read_only_resume_required"))
        } else {
            Ok(())
        }
    }
    pub fn set_session_terminal_size(&self, id: &str, cols: i32, rows: i32) -> Result<()> {
        self.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET cols=?,rows=? WHERE id=?",
                params![cols, rows, id],
            )?;
            Ok(())
        })
    }
    pub fn restore_imported_read_only(&self, original: &Session) -> Result<()> {
        if !original.read_only {
            return Err(anyhow!("session_was_not_imported_read_only"));
        }
        self.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET status=?,exit_code=?,read_only=1,worktree_path=?,updated_at=? WHERE id=?",
                params![original.status, original.exit_code, original.worktree_path, now(), original.id],
            )?;
            tx.execute(
                "INSERT INTO session_organization(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
                params![original.id, serde_json::to_string(&original.organization)?],
            )?;
            emit(tx, "state.changed", json!({"sessionId":original.id,"kind":"history.import.restore"}))
        })
    }
    pub fn presentation_request(
        &self,
        session_id: &str,
        placement: &str,
        presentation: &str,
        workspace_path: Option<&str>,
        operation_id: &str,
    ) -> Result<()> {
        self.transaction(|tx| {
            acknowledge_session_replies_tx(tx, session_id)?;
            if operation_tx(tx,operation_id)?.is_none() {
                complete(tx,operation_id,"session.present",&json!({"queued":true}))?;
                emit(tx,"presentation.requested",json!({"sessionId":session_id,"placement":placement,"presentation":presentation,"workspacePath":workspace_path,"operationId":operation_id}))?;
            }
            Ok(())
        })
    }

    pub fn add_project(
        &self,
        path: &str,
        name: Option<&str>,
        operation_id: &str,
    ) -> Result<Project> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        if let Some(value) = operation_tx(&tx, operation_id)? {
            return serde_json::from_value(value).map_err(Into::into);
        }
        let now = now();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name
                .unwrap_or_else(|| {
                    path.rsplit(['\\', '/'])
                        .next()
                        .filter(|v| !v.is_empty())
                        .unwrap_or(path)
                })
                .to_owned(),
            path: path.to_owned(),
            created_at: now.clone(),
        };
        tx.execute(
            "INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)",
            params![project.id, project.name, project.path, project.created_at],
        )?;
        complete(&tx, operation_id, "project.add", &project)?;
        emit(&tx, "state.changed", json!({"kind":"project"}))?;
        tx.commit()?;
        Ok(project)
    }

    pub fn remove_project(&self, id: &str, operation_id: &str) -> Result<()> {
        self.mutate_null(operation_id, "project.remove", |tx| {
            tx.execute("DELETE FROM projects WHERE id=?", [id])?;
            emit(tx, "state.changed", json!({"kind":"project"}))
        })
    }

    pub fn create_session(&self, request: CreateSession<'_>) -> Result<Session> {
        self.create_session_with_deferred(request, None)
    }
    pub fn create_session_with_deferred(
        &self,
        request: CreateSession<'_>,
        deferred_cwd: Option<&str>,
    ) -> Result<Session> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        if let Some(value) = operation_tx(&tx, request.operation_id)? {
            return serde_json::from_value(value).map_err(Into::into);
        }
        if let Some(native_id) = request.native_id {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT id FROM sessions WHERE provider=? AND native_id=? LIMIT 1",
                    params![request.provider, native_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner {
                return Err(anyhow!("native_session_exists:{owner}"));
            }
        }
        let now = now();
        let mut session = Session {
            id: Uuid::new_v4().to_string(),
            project_id: request.project_id.map(str::to_owned),
            worktree_path: None,
            title: request.title.unwrap_or(request.provider).to_owned(),
            provider: request.provider.to_owned(),
            mode: request.mode.to_owned(),
            status: "starting".into(),
            created_at: now.clone(),
            updated_at: now,
            native_id: request.native_id.map(str::to_owned),
            exit_code: None,
            cols: None,
            rows: None,
            followed: false,
            read_only: false,
            activity: None,
            delegation: None,
            group: None,
            run: None,
            organization: SessionOrganization::default(),
        };
        tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,exit_code,followed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", params![session.id,session.project_id,session.worktree_path,session.title,session.provider,session.mode,session.status,session.created_at,session.updated_at,session.native_id,session.exit_code,session.followed])?;
        let activity = SessionActivity::new(
            if request.mode == "chat" {
                "idle"
            } else {
                "unknown"
            },
            1,
            None,
            None,
        );
        tx.execute("INSERT INTO session_activity(session_id,state,revision,turn_id,reason) VALUES (?,?,?,?,?)",params![session.id,activity.state,activity.revision,activity.turn_id,activity.reason])?;
        session.activity = Some(activity);
        if let Some(cwd) = deferred_cwd {
            if request.provider != "codex"
                || request.mode != "terminal"
                || request.native_id.is_some()
            {
                return Err(anyhow!("deferred_launch_unsupported"));
            }
            tx.execute(
                "INSERT INTO deferred_codex_launches(session_id,phase,error_code,error_message,cwd) VALUES (?,'preparing',NULL,NULL,?)",
                params![session.id,cwd],
            )?;
        }
        complete(&tx, request.operation_id, "session.create", &session)?;
        emit(&tx, "state.changed", json!({"kind":"session"}))?;
        tx.commit()?;
        Ok(session)
    }

    pub fn update_session(
        &self,
        id: &str,
        title: Option<&str>,
        followed: Option<bool>,
        operation_id: &str,
    ) -> Result<Session> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        if let Some(value) = operation_tx(&tx, operation_id)? {
            return serde_json::from_value(value).map_err(Into::into);
        }
        if let Some(title) = title {
            tx.execute(
                "UPDATE sessions SET title=?,updated_at=? WHERE id=?",
                params![title, now(), id],
            )?;
        }
        if let Some(followed) = followed {
            tx.execute(
                "UPDATE sessions SET followed=?,updated_at=? WHERE id=?",
                params![followed, now(), id],
            )?;
        }
        let session = session_tx(&tx, id)?;
        complete(&tx, operation_id, "session.update", &session)?;
        emit(&tx, "state.changed", json!({"kind":"session"}))?;
        tx.commit()?;
        Ok(session)
    }

    pub fn organize_session(&self, request: &SessionOrganize) -> Result<Session> {
        self.transaction(|tx| {
            if let Some(result) = operation_tx(tx, &request.operation_id)? {
                return Ok(serde_json::from_value(result)?);
            }
            let mut session = session_tx(tx, &request.session_id)?;
            if session.organization.organization_revision != request.expected_revision {
                return Err(anyhow!("revision_conflict"));
            }
            if let Some(archived) = request.archived {
                if archived && !session.read_only && !matches!(session.status.as_str(), "exited" | "error" | "interrupted") {
                    return Err(anyhow!("end_session_before_archiving"));
                }
                session.organization.archived = archived;
                if archived { session.organization.pinned = false; }
            }
            if let Some(pinned) = request.pinned {
                if pinned && session.organization.archived { return Err(anyhow!("restore_session_before_pinning")); }
                if pinned && !session.organization.pinned {
                    let count: i64 = tx.query_row("SELECT COUNT(*) FROM session_organization WHERE json_extract(data,'$.pinned')=1", [], |r| r.get(0))?;
                    if count >= 6 { return Err(anyhow!("pin_limit_six")); }
                }
                session.organization.pinned = pinned;
            }
            if let Some(bookmarked) = request.bookmarked { session.organization.bookmarked = bookmarked; }
            if let Some(intent) = &request.intent {
                if !matches!(intent.as_str(), "none" | "review" | "fix" | "research" | "test" | "docs") { return Err(anyhow!("invalid_intent")); }
                session.organization.intent = (intent != "none").then(|| intent.clone());
            }
            if let Some(sort_order) = request.sort_order {
                if !(0..=9_007_199_254_740_991).contains(&sort_order) { return Err(anyhow!("invalid_sort_order")); }
                session.organization.sort_order = sort_order;
            }
            session.organization.organization_revision += 1;
            tx.execute("INSERT INTO session_organization(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data", params![session.id, serde_json::to_string(&session.organization)?])?;
            complete(tx, &request.operation_id, "session.organize", &session)?;
            emit(tx, "state.changed", json!({"sessionId":session.id,"kind":"session.organization"}))?;
            Ok(session)
        })
    }

    pub fn set_session_status(&self, id: &str, status: &str, exit_code: Option<i32>) -> Result<()> {
        let result = self.transaction(|tx| {
            let (previous,prior_code,mode):(String,Option<i32>,String)=tx.query_row("SELECT status,exit_code,mode FROM sessions WHERE id=?",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            if previous==status&&prior_code==exit_code{return Ok(());}
            tx.execute("UPDATE sessions SET status=?,exit_code=?,updated_at=? WHERE id=?",params![status,exit_code,now(),id])?;
            if matches!(status, "exited" | "interrupted" | "error") {
                if let Some(activity) = session_activity_tx(tx, id)? {
                    // A completed Chat reply remains a durable user decision,
                    // even if its connection dies before acknowledgement.
                    // Terminal liveness is only observational, so a stopped
                    // native process becomes unknown rather than a completion.
                    let next_state = if mode == "chat" && activity.state == "awaiting_input" {
                        None
                    } else if mode == "terminal" {
                        Some("unknown")
                    } else {
                        Some("idle")
                    };
                    if let Some(next_state) = next_state {
                        let next = SessionActivity::new(next_state, activity.revision + 1, activity.turn_id.as_deref(), Some(status));
                        tx.execute("UPDATE session_activity SET state=?,revision=?,turn_id=?,reason=? WHERE session_id=?",params![&next.state,next.revision,&next.turn_id,&next.reason,id])?;
                        emit(tx,"session.activity",json!({"sessionId":id,"activity":next}))?;
                    }
                }
            }
            let data=json!({"sessionId":id,"status":status,"previousStatus":previous,"exitCode":exit_code});
            emit(tx,"session.status",data.clone())?;
            emit(tx,"state.changed",data)?;
            if mode=="terminal"&&status=="exited"&&previous!="exited"&&!self.quiet_terminal_exits.load(std::sync::atomic::Ordering::Acquire)&&!crate::quick_launch::quiet_exit_tx(tx,id,exit_code)? {
                let kind=match exit_code{Some(0)=>"completed",Some(_)=>"failed",None=>"interrupted"};
                tx.execute("INSERT OR IGNORE INTO inbox(id,session_id,kind,data,resolved,created_at) VALUES (?,?,?,?,1,?)",params![format!("{id}:exit"),id,kind,json!({"exitCode":exit_code}).to_string(),now()])?;
            }
            Ok(())
        });
        if result.is_ok() && matches!(status, "exited" | "interrupted" | "error") { self.schedule_retention(); }
        result
    }

    pub fn settings_value(&self) -> Result<Value> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        Ok(settings(&conn)?.value)
    }

    /// A failed initial connection must not overwrite an explicit stop which
    /// won the race while the provider was still initializing.
    pub fn fail_starting_session(&self, id: &str) -> Result<bool> {
        self.transaction(|tx| {
            let changed = tx.execute(
                "UPDATE sessions SET status='error',exit_code=NULL,updated_at=? WHERE id=? AND status='starting'",
                params![now(), id],
            )?;
            if changed == 0 { return Ok(false); }
            let mode: String = tx.query_row("SELECT mode FROM sessions WHERE id=?", [id], |row| row.get(0))?;
            if let Some(activity) = session_activity_tx(tx, id)? {
                let next_state = if mode == "terminal" { "unknown" } else { "idle" };
                if !(mode == "chat" && activity.state == "awaiting_input")
                    && (activity.state != next_state || activity.reason.as_deref() != Some("error")) {
                    let next = SessionActivity::new(next_state, activity.revision + 1, activity.turn_id.as_deref(), Some("error"));
                    tx.execute("UPDATE session_activity SET state=?,revision=?,turn_id=?,reason=? WHERE session_id=?",params![&next.state,next.revision,&next.turn_id,&next.reason,id])?;
                    emit(tx,"session.activity",json!({"sessionId":id,"activity":next}))?;
                }
            }
            let data = json!({"sessionId":id,"status":"error","previousStatus":"starting","exitCode":null});
            emit(tx, "session.status", data.clone())?;
            emit(tx, "state.changed", data)?;
            Ok(true)
        })
    }

    pub fn update_settings(
        &self,
        patch: &Value,
        expected_revision: i64,
        operation_id: &str,
    ) -> Result<Settings> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        if let Some(value) = operation_tx(&tx, operation_id)? {
            return serde_json::from_value(value).map_err(Into::into);
        }
        let current = settings(&tx)?;
        if current.revision != expected_revision {
            return Err(anyhow!("revision_conflict"));
        }
        let mut value = current.value;
        merge(&mut value, patch);
        crate::providers::network::validate_settings(&value)?;
        let next = Settings {
            revision: current.revision + 1,
            value,
        };
        tx.execute(
            "UPDATE settings SET revision=?,value=? WHERE singleton=1",
            params![next.revision, serde_json::to_string(&next.value)?],
        )?;
        complete(&tx, operation_id, "settings.update", &next)?;
        emit(&tx, "state.changed", json!({"kind":"settings"}))?;
        tx.commit()?;
        Ok(next)
    }

    pub fn append_output(&self, session_id: &str, start: i64, data: &[u8]) -> Result<()> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.execute(
            "INSERT INTO output_chunks(session_id,start_cursor,data) VALUES (?,?,?)",
            params![session_id, start, data],
        )?;
        Ok(())
    }
    /// The persisted end cursor of a session's output stream. Resume seeds the
    /// in-memory store from this so post-restart appends never reuse cursor 0.
    pub fn output_end(&self, session_id: &str) -> Result<i64> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        Ok(conn.query_row(
            "SELECT MAX(\
                COALESCE((SELECT MAX(start_cursor+length(data)) FROM output_chunks WHERE session_id=?),0),\
                COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key=?),0)\
             )",
            params![session_id, format!("terminal.outputEnd:{session_id}")],
            |row| row.get(0),
        )?)
    }
    /// The first cursor still backed by durable output after retention pruning.
    /// `None` distinguishes a fully-pruned stream from a stream beginning at 0.
    pub fn output_start(&self, session_id: &str) -> Result<Option<i64>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.query_row(
            "SELECT MIN(start_cursor) FROM output_chunks WHERE session_id=?",
            [session_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    }
    pub fn output_from(
        &self,
        session_id: &str,
        cursor: i64,
        max_bytes: usize,
    ) -> Result<Vec<(i64, Vec<u8>)>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        // `start_cursor + length(data) > cursor` cannot use the second half of
        // the output_chunks primary key.  On a long-lived terminal that made
        // every 64 KiB credit scan the complete persisted prefix.  Seek once
        // to the possible containing chunk, then walk the ordered suffix.
        //
        // A preceding chunk can be stale when a stream has a persisted gap, so
        // retain the old overlap predicate below rather than assuming cursor
        // continuity from the key lookup alone.
        let first_start = conn
            .query_row(
                "SELECT start_cursor FROM output_chunks \
                 WHERE session_id=? AND start_cursor<=? \
                 ORDER BY start_cursor DESC LIMIT 1",
                params![session_id, cursor],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(cursor);
        let mut stmt = conn.prepare(
            "SELECT start_cursor,data FROM output_chunks \
             WHERE session_id=? AND start_cursor>=? ORDER BY start_cursor",
        )?;
        let mut out = Vec::new();
        let mut total: usize = 0;
        let rows = stmt.query_map(params![session_id, first_start], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?;
        let mut expected_cursor = cursor;
        for row in rows {
            let row = row?;
            let end = row.0.saturating_add(row.1.len() as i64);
            if row.1.is_empty() || end <= cursor {
                continue;
            }
            let next_total = total.saturating_add(row.1.len());
            if next_total > max_bytes && !out.is_empty() {
                break;
            }
            if row.0 > expected_cursor {
                return Err(anyhow!("terminal_history_gap"));
            }
            out.push(row);
            total = next_total;
            expected_cursor = expected_cursor.max(end);
        }
        Ok(out)
    }
    pub fn read_output_window(
        &self,
        session_id: &str,
        cursor: Option<i64>,
        tail: bool,
        max_bytes: usize,
    ) -> Result<(i64, i64, bool, Vec<u8>)> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?)",
            [session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(anyhow!("session_not_found"));
        }
        let end: i64 = conn
            .query_row(
                "SELECT start_cursor + length(data) FROM output_chunks WHERE session_id=? ORDER BY start_cursor DESC LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let retained_end: Option<i64> = conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM metadata WHERE key=?",
            [format!("terminal.outputEnd:{session_id}")], |row| row.get(0),
        ).optional()?;
        let end = end.max(retained_end.unwrap_or(0));
        let requested = if tail {
            end.saturating_sub(max_bytes as i64).max(0)
        } else {
            cursor.unwrap_or(0)
        };
        // The retention watermark distinguishes a pruned prefix from corrupt
        // history. Compute the boundary and page under this same lock so a
        // background batch cannot race terminal.read between separate reads.
        let from = if retained_end.is_some() {
            let oldest: Option<i64> = conn.query_row("SELECT MIN(start_cursor) FROM output_chunks WHERE session_id=?", [session_id], |row| row.get(0))?;
            requested.max(oldest.unwrap_or(end))
        } else { requested };
        let prior: Option<(i64, i64)> = conn
            .query_row(
                "SELECT start_cursor,start_cursor + length(data) FROM output_chunks WHERE session_id=? AND start_cursor<=? ORDER BY start_cursor DESC LIMIT 1",
                params![session_id, from],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let first_start = prior
            .filter(|(_, chunk_end)| *chunk_end > from)
            .map(|(start, _)| start)
            .unwrap_or(from);
        let mut statement = conn.prepare(
            "SELECT start_cursor,data FROM output_chunks WHERE session_id=? AND start_cursor>=? ORDER BY start_cursor",
        )?;
        let rows = statement.query_map(params![session_id, first_start], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut data = Vec::with_capacity(max_bytes.min((end - from).max(0) as usize));
        let mut expected_cursor = from;
        for row in rows {
            let (start, chunk) = row?;
            if chunk.is_empty() {
                continue;
            }
            let offset = (from - start).max(0) as usize;
            if offset >= chunk.len() {
                continue;
            }
            let take = (max_bytes - data.len()).min(chunk.len() - offset);
            if take == 0 {
                break;
            }
            let actual_start = start.saturating_add(offset as i64);
            if actual_start > expected_cursor {
                return Err(anyhow!("terminal_history_gap"));
            }
            data.extend_from_slice(&chunk[offset..offset + take]);
            expected_cursor = expected_cursor.max(actual_start.saturating_add(take as i64));
            if data.len() == max_bytes {
                break;
            }
        }
        let next = expected_cursor;
        let truncated = from > requested || if tail { from > 0 } else { next < end };
        Ok((from, next, truncated, data))
    }
    pub fn mark_live_sessions_interrupted(&self) -> Result<()> {
        self.transaction(|tx| {
            let timestamp = now();
            tx.execute(
                "UPDATE sessions SET status='interrupted',updated_at=? WHERE read_only=0 AND status IN ('starting','running','idle','waiting') AND NOT EXISTS (SELECT 1 FROM session_activity WHERE session_activity.session_id=sessions.id AND state='awaiting_input')",
                [&timestamp],
            )?;
            tx.execute(
                "UPDATE session_activity SET state='unknown',revision=revision+1,reason='runtime_interrupted' WHERE session_id IN (SELECT id FROM sessions WHERE status='interrupted' AND mode='terminal') AND (state<>'unknown' OR COALESCE(reason,'')<>'runtime_interrupted')",
                [],
            )?;
            tx.execute(
                "UPDATE session_activity SET state='idle',revision=revision+1,reason='runtime_interrupted' WHERE session_id IN (SELECT id FROM sessions WHERE status='interrupted' AND mode='chat') AND state NOT IN ('idle','awaiting_input')",
                [],
            )?;
            tx.execute(
                "UPDATE deferred_codex_launches SET phase='failed',error_code='runtime_interrupted',error_message='Runtime stopped during Codex startup; retry this session' WHERE phase IN ('preparing','launching') AND session_id IN (SELECT id FROM sessions WHERE status='interrupted')",
                [],
            )?;
            // Older builds classified imported idle cards as live during startup.
            // Heal those rows back to the only valid non-interactive import state.
            tx.execute(
                "UPDATE sessions SET status='idle',exit_code=NULL,updated_at=? WHERE read_only=1 AND status<>'idle'",
                [&timestamp],
            )?;
            Ok(())
        })
    }
    pub fn lease(&self, session_id: &str) -> Result<Option<(String, i64, String)>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.query_row(
            "SELECT client_id,epoch,expires_at FROM leases WHERE session_id=?",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(Into::into)
    }
    pub fn put_lease(
        &self,
        session_id: &str,
        client_id: &str,
        epoch: i64,
        expires_at: &str,
    ) -> Result<()> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        conn.execute("INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET client_id=excluded.client_id,epoch=excluded.epoch,expires_at=excluded.expires_at",params![session_id,client_id,epoch,expires_at])?;
        Ok(())
    }
    pub fn delete_lease(&self, session_id: &str, epoch: i64) -> Result<bool> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        Ok(conn.execute(
            "DELETE FROM leases WHERE session_id=? AND epoch=?",
            params![session_id, epoch],
        )? > 0)
    }
    pub fn complete_null_operation(&self, operation_id: &str, method: &str) -> Result<bool> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let fresh = operation_tx(&tx, operation_id)?.is_none();
        if fresh {
            complete(&tx, operation_id, method, &Value::Null)?;
        }
        tx.commit()?;
        Ok(fresh)
    }

    fn mutate_null<F>(&self, operation_id: &str, method: &str, action: F) -> Result<()>
    where
        F: FnOnce(&Transaction<'_>) -> Result<()>,
    {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = conn.transaction()?;
        if operation_tx(&tx, operation_id)?.is_none() {
            action(&tx)?;
            complete(&tx, operation_id, method, &Value::Null)?;
        };
        tx.commit()?;
        Ok(())
    }
}

pub struct CreateSession<'a> {
    pub project_id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub provider: &'a str,
    pub mode: &'a str,
    pub native_id: Option<&'a str>,
    pub operation_id: &'a str,
}
pub struct ImportHistorySession<'a> {
    pub project_id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub provider: &'a str,
    pub mode: &'a str,
    pub cwd: &'a str,
    pub native_id: &'a str,
    pub operation_id: &'a str,
    pub transcript: &'a [ChatItem],
}

/// Native history IDs are provider-local. Persist a session-scoped copy so
/// unrelated imported sessions cannot accidentally share a presentation turn.
pub(crate) fn scoped_history_item(session_id: &str, source: &ChatItem) -> ChatItem {
    let mut item = source.clone();
    for part in &mut item.parts {
        let Some(data) = part.get_mut("data").and_then(Value::as_object_mut) else { continue };
        if data.get("server").and_then(Value::as_str) != Some("threadterm")
            || data.get("resultRedacted").and_then(Value::as_bool) != Some(true)
            || !data.get("tool").and_then(Value::as_str).is_some_and(|tool| crate::browser_tools::TOOL_NAMES.contains(&tool) || tool == "browser_eval")
        { continue; }
        if let Some(activity) = data.get_mut("browserActivity").and_then(Value::as_object_mut) {
            activity.insert("callerSessionId".to_owned(), json!(session_id));
        }
    }
    item.id = format!("{session_id}:history:{}", source.id);
    item.turn_id = source
        .turn_id
        .as_deref()
        .map(|turn_id| format!("{session_id}:history:{turn_id}"));
    item.turn_origin = Some(ChatTurnOrigin::History);
    item
}

fn add_generic_fork_anchors(items: &mut [ChatItem], native_id: Option<&str>) {
    let Some(native_id) = native_id.filter(|value| !value.is_empty()) else { return };
    for item in items {
        let statusless_history_reply = item.turn_status.is_none()
            && item.turn_origin == Some(ChatTurnOrigin::History)
            && item.parts.iter().any(|part| {
                part.get("type").and_then(Value::as_str) == Some("text")
                    && part.get("phase").and_then(Value::as_str) != Some("commentary")
                    && part.pointer("/data/kind").and_then(Value::as_str) != Some("plan")
                    && part.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty())
            })
            && !item.parts.iter().any(|part| matches!(
                part.get("status").and_then(Value::as_str),
                Some("streaming" | "running" | "pending")
            ));
        if item.role == "assistant" && item.fork_anchor.is_none()
            && (item.turn_status == Some(crate::domain::NativeTurnStatus::Completed)
                || statusless_history_reply)
        {
            item.fork_anchor = Some(crate::domain::NativeForkAnchor {
                native_id: native_id.to_owned(), turn_id: None, message_id: None, entry_id: None,
            });
        }
    }
}

/// Validate provider data before an import transaction writes anything, then
/// give every stored row a strictly increasing timestamp in native array order.
/// Retain native instants where possible, clamping duplicate/backward values.
/// UTC with fixed precision also keeps `(created_at, id)` order chronological.
fn normalize_history_transcript(session_id: &str, sources: &[ChatItem]) -> Result<Vec<ChatItem>> {
    if serde_json::to_vec(sources)?.len() > crate::chat_repair::MAX_HISTORY_BYTES {
        return Err(anyhow!("invalid_history_transcript: history exceeds 8 MiB"));
    }
    let mut ids = HashSet::with_capacity(sources.len());
    let mut previous: Option<chrono::DateTime<Utc>> = None;
    let items: Vec<ChatItem> = sources
        .iter()
        .map(|source| {
            if source.id.is_empty() || source.id == "unknown" || !ids.insert(source.id.as_str()) {
                return Err(anyhow!("invalid_history_transcript: missing, fallback or duplicate item id"));
            }
            if source.turn_id.as_deref().is_some_and(str::is_empty) {
                return Err(anyhow!("invalid_history_transcript: empty turn id"));
            }
            if !matches!(source.role.as_str(), "user" | "assistant" | "tool" | "system") {
                return Err(anyhow!("invalid_history_transcript: unsupported item role"));
            }
            for part in &source.parts {
                crate::chat_repair::validate_part(part)?;
            }
            let mut item = scoped_history_item(session_id, source);
            let native = chrono::DateTime::parse_from_rfc3339(&source.created_at)
                .ok().map(|value| value.with_timezone(&Utc));
            let timestamp = match previous {
                Some(tail) if native.is_none_or(|value| value <= tail) => tail
                    .checked_add_signed(chrono::Duration::nanoseconds(1))
                    .ok_or_else(|| anyhow!("invalid_history_transcript: timestamp overflow"))?,
                _ => native.unwrap_or_else(Utc::now),
            };
            item.created_at = timestamp.to_rfc3339_opts(chrono::SecondsFormat::Nanos, false);
            previous = Some(timestamp);
            Ok(item)
        })
        .collect::<Result<_>>()?;
    if serde_json::to_vec(&items)?.len()
        > crate::chat_repair::MAX_HISTORY_BYTES - crate::chat_repair::HISTORY_FRAME_HEADROOM_BYTES
    {
        return Err(anyhow!("invalid_history_transcript: normalized snapshot exceeds frame limit"));
    }
    Ok(items)
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn subagent_card_tx(
    tx: &Transaction<'_>,
    session: &str,
    key: &str,
) -> Result<Option<ChatItem>> {
    let data: Option<String> = tx
        .query_row(
            "SELECT data FROM chat_items WHERE session_id=? AND id=?",
            params![session, format!("{session}:assistant:subagent:{key}")],
            |r| r.get(0),
        )
        .optional()?;
    data.map(|data| serde_json::from_str(&data).map_err(Into::into))
        .transpose()
}

/// Bound every string by UTF-8 bytes, retaining a visible truncation marker.
pub(crate) fn bound_json(value: &mut Value) {
    const LIMIT: usize = 16 * 1024;
    const SUFFIX: &str = "…[truncated]";
    match value {
        Value::String(text) if text.len() > LIMIT => {
            let mut end = LIMIT - SUFFIX.len();
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str(SUFFIX);
        }
        Value::Array(items) => items.iter_mut().for_each(bound_json),
        Value::Object(fields) => fields.values_mut().for_each(bound_json),
        _ => {}
    }
}

pub(crate) fn upsert_subagent_item(
    tx: &Transaction<'_>,
    session: &str,
    key: &str,
    item: &ChatItem,
    merge: bool,
) -> Result<i64> {
    let previous: Option<String> = tx
        .query_row(
            "SELECT data FROM subagent_items WHERE session_id=? AND subagent_key=? AND item_id=?",
            params![session, key, item.id],
            |r| r.get(0),
        )
        .optional()?;
    let mut stored = item.clone();
    if let Some(previous) = previous {
        let previous: ChatItem = serde_json::from_str(&previous)?;
        stored.created_at = previous.created_at;
        if merge {
            let incoming = std::mem::replace(&mut stored.parts, previous.parts);
            for mut part in incoming {
                let existing = part.get("toolId").and_then(Value::as_str).and_then(|id| {
                    stored
                        .parts
                        .iter_mut()
                        .find(|p| p.get("toolId").and_then(Value::as_str) == Some(id))
                });
                if let Some(existing) = existing {
                    crate::file_references::enrich_tool_part(&mut part, Some(existing));
                    if let (Some(target), Some(source)) =
                        (existing.as_object_mut(), part.as_object())
                    {
                        for (field, value) in source {
                            target.insert(field.clone(), value.clone());
                        }
                    }
                } else {
                    crate::file_references::enrich_tool_part(&mut part, None);
                    stored.parts.push(part);
                }
            }
        }
    }
    stored.parts.truncate(64);
    let mut data = serde_json::to_value(&stored)?;
    bound_json(&mut data);
    let (seq, rev): (i64, i64) = tx.query_row(
        "SELECT COALESCE(MAX(seq),0)+1,COALESCE(MAX(rev),0)+1 FROM subagent_items WHERE session_id=? AND subagent_key=?",
        params![session, key], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    tx.execute(
        "INSERT INTO subagent_items(session_id,subagent_key,item_id,seq,rev,data,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id,subagent_key,item_id) DO UPDATE SET rev=excluded.rev,data=excluded.data",
        params![session, key, item.id, seq, rev, serde_json::to_string(&data)?, stored.created_at],
    )?;
    let dropped = tx.execute(
        "DELETE FROM subagent_items WHERE session_id=? AND subagent_key=? AND item_id IN (SELECT item_id FROM subagent_items WHERE session_id=? AND subagent_key=? ORDER BY seq DESC LIMIT -1 OFFSET 500)",
        params![session, key, session, key],
    )?;
    if dropped > 0 {
        tx.execute(
            "UPDATE chat_items SET data=json_set(data,'$.parts[0].data.truncated',json('true')) WHERE session_id=? AND id=?",
            params![session, format!("{session}:assistant:subagent:{key}")],
        )?;
    }
    Ok(rev)
}

pub(crate) fn subagent_items_after_tx(
    tx: &Transaction<'_>,
    session: &str,
    key: &str,
    after_rev: i64,
) -> Result<(Vec<ChatItem>, i64, bool)> {
    let mut statement = tx.prepare(
        "SELECT data FROM subagent_items WHERE session_id=? AND subagent_key=? AND rev>? ORDER BY seq",
    )?;
    let rows = statement.query_map(params![session, key, after_rev], |r| r.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(serde_json::from_str(&row?)?);
    }
    let rev = tx.query_row(
        "SELECT COALESCE(MAX(rev),0) FROM subagent_items WHERE session_id=? AND subagent_key=?",
        params![session, key],
        |r| r.get(0),
    )?;
    let truncated = subagent_card_tx(tx, session, key)?.is_some_and(|card| {
        card.parts
            .first()
            .and_then(|part| part.pointer("/data/truncated"))
            .and_then(Value::as_bool)
            == Some(true)
    });
    Ok((items, rev, truncated))
}

pub(crate) fn subagent_item_projection_tx(
    tx: &Transaction<'_>,
    session: &str,
    key: &str,
) -> Result<(i64, i64, Option<ChatItem>, bool)> {
    let item_count = tx.query_row(
        "SELECT COUNT(*) FROM subagent_items WHERE session_id=? AND subagent_key=?",
        params![session, key],
        |r| r.get(0),
    )?;
    let tool_count = tx.query_row(
        "SELECT COUNT(DISTINCT CASE WHEN json_type(p.value,'$.toolId')='text' THEN json_extract(p.value,'$.toolId') ELSE s.item_id||':'||p.key END) FROM subagent_items s, json_each(s.data,'$.parts') p WHERE s.session_id=? AND s.subagent_key=? AND json_extract(p.value,'$.type')='tool'",
        params![session, key],
        |r| r.get(0),
    )?;
    let newest: Option<String> = tx
        .query_row(
            "SELECT data FROM subagent_items WHERE session_id=? AND subagent_key=? ORDER BY seq DESC LIMIT 1",
            params![session, key],
            |r| r.get(0),
        )
        .optional()?;
    let newest: Option<ChatItem> = newest
        .map(|data| serde_json::from_str(&data).map_err(anyhow::Error::from))
        .transpose()?;
    let truncated = tx.query_row(
        "SELECT COALESCE(json_extract(data,'$.parts[0].data.truncated'),0) FROM chat_items WHERE session_id=? AND id=?",
        params![session, format!("{session}:assistant:subagent:{key}")],
        |r| r.get::<_, bool>(0),
    ).optional()?.unwrap_or(false);
    Ok((item_count, tool_count, newest, truncated))
}

pub(crate) fn complete<T: serde::Serialize>(
    tx: &Transaction<'_>,
    id: &str,
    method: &str,
    result: &T,
) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES (?,?,?,?)",
        params![id, method, serde_json::to_string(result)?, now()],
    )?;
    Ok(())
}
fn operation_tx(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row("SELECT result FROM operations WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(Into::into))
        .transpose()
}
fn acknowledge_session_replies_tx(tx: &Transaction<'_>, session_id: &str) -> Result<()> {
    let changed = tx.execute(
        "UPDATE inbox SET read=1 WHERE session_id=? AND kind='reply' AND read=0",
        [session_id],
    )?;
    if changed > 0 {
        emit(
            tx,
            "state.changed",
            json!({"kind":"inbox","sessionId":session_id}),
        )?;
    }
    Ok(())
}
fn emit(tx: &Transaction<'_>, event: &str, data: Value) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES (?,?,?)",
        params![event, serde_json::to_string(&data)?, now()],
    )?;
    Ok(())
}
fn collect_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt =
        conn.prepare("SELECT id,name,path,created_at FROM projects ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
            path: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    let projects = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(projects)
}
fn collect_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt=conn.prepare("SELECT sessions.id,sessions.project_id,sessions.worktree_path,sessions.title,sessions.provider,sessions.mode,sessions.status,sessions.created_at,sessions.updated_at,sessions.native_id,sessions.exit_code,sessions.followed,sessions.read_only,sessions.cols,sessions.rows,quick_launch_runs.snapshot_json,quick_launch_runs.url,quick_launch_runs.url_source,quick_launch_runs.stop_requested FROM sessions LEFT JOIN quick_launch_runs ON quick_launch_runs.session_id=sessions.id ORDER BY sessions.created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Session {
            id: r.get(0)?,
            project_id: r.get(1)?,
            worktree_path: r.get(2)?,
            title: r.get(3)?,
            provider: r.get(4)?,
            mode: r.get(5)?,
            status: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
            native_id: r.get(9)?,
            exit_code: r.get(10)?,
            followed: r.get(11)?,
            read_only: r.get(12)?,
            cols: r.get(13)?,
            rows: r.get(14)?,
            activity: None,
            delegation: None,
            group: None,
            run: crate::quick_launch::run_from_row(r, 15)?,
            organization: SessionOrganization::default(),
        })
    })?;
    let mut sessions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for session in &mut sessions {
        session.organization = session_organization(conn, &session.id)?;
        session.activity = session_activity(conn, &session.id)?;
        session.delegation = session_delegation(conn, &session.id)?;
        session.group = crate::group_chat::session_link(conn, &session.id)?;
    }
    Ok(sessions)
}
fn collect_workspaces(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT id,name,revision,layout,project_id,worktree_path FROM workspaces ORDER BY updated_at,id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })?;
    rows.map(|row| { let (id,name,revision,layout,project,worktree)=row?;
        let mut value=json!({"id":id,"name":name,"revision":revision,"layout":serde_json::from_str::<Value>(&layout)?});
        if let Some(project)=project {value["projectId"]=json!(project);}
        if let Some(worktree)=worktree {value["worktreePath"]=json!(worktree);}
        Ok(value)
    }).collect()
}
fn collect_inbox(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt=conn.prepare("SELECT inbox.id,inbox.session_id,inbox.kind,sessions.title,inbox.created_at,inbox.read,inbox.data FROM inbox JOIN sessions ON sessions.id=inbox.session_id WHERE inbox.kind!='reply' ORDER BY inbox.created_at DESC,inbox.id")?;
    let rows=stmt.query_map([], |r| {
        let mut title=r.get::<_,String>(3)?;
        if let Ok(data)=serde_json::from_str::<Value>(&r.get::<_,String>(6)?) {
            let payload=data.pointer("/part/data").unwrap_or(&data);
            if payload["interaction"]=="question" {
                if let Some(question)=payload.pointer("/form/questions/0/question").and_then(Value::as_str).filter(|text| !text.is_empty()) {title=question.to_owned();}
            }
        }
        Ok(json!({"id":r.get::<_,String>(0)?,"sessionId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"title":title,"createdAt":r.get::<_,String>(4)?,"read":r.get::<_,bool>(5)?}))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
fn empty_chat_native_recovery_eligible_tx(
    tx: &Transaction<'_>,
    id: &str,
    expected_native_id: &str,
) -> Result<bool> {
    struct RecoveryState {
        mode: String,
        status: String,
        read_only: bool,
        native_id: Option<String>,
        activity: Option<String>,
        activity_turn: Option<String>,
    }

    if expected_native_id.trim().is_empty() {
        return Ok(false);
    }
    let session: Option<RecoveryState> = tx
        .query_row(
            "SELECT s.mode,s.status,s.read_only,s.native_id,a.state,a.turn_id \
             FROM sessions s LEFT JOIN session_activity a ON a.session_id=s.id WHERE s.id=?",
            [id],
            |row| {
                Ok(RecoveryState {
                    mode: row.get(0)?,
                    status: row.get(1)?,
                    read_only: row.get(2)?,
                    native_id: row.get(3)?,
                    activity: row.get(4)?,
                    activity_turn: row.get(5)?,
                })
            },
        )
        .optional()?;
    let Some(session) = session else {
        return Ok(false);
    };
    if session.mode != "chat"
        || session.read_only
        || !matches!(session.status.as_str(), "starting" | "idle")
        || session.native_id.as_deref() != Some(expected_native_id)
        || session.activity.as_deref() != Some("idle")
        || session.activity_turn.is_some()
    {
        return Ok(false);
    }

    // A missing launch row is ambiguous. A source link identifies a rerun or
    // fork lineage whose native history must never be silently replaced.
    let launch_source: Option<Option<String>> = tx
        .query_row(
            "SELECT source_session_id FROM session_launch_configs WHERE session_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if !matches!(launch_source, Some(None)) {
        return Ok(false);
    }
    let organization: Option<String> = tx
        .query_row(
            "SELECT data FROM session_organization WHERE session_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if organization
        .map(|raw| serde_json::from_str::<SessionOrganization>(&raw))
        .transpose()?
        .is_some_and(|organization| organization.forked_from.is_some())
    {
        return Ok(false);
    }

    let integrity_key = format!("chat.integrity:{id}");
    let conflicting_evidence: bool = tx.query_row(
        "SELECT
           EXISTS(SELECT 1 FROM chat_items WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM chat_queue_items WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM subagent_items WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM inbox WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM session_fork_options WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM chat_fork_intents WHERE source_session_id=?1 OR child_session_id=?1)
        OR EXISTS(SELECT 1 FROM delegations WHERE parent_session_id=?1 OR child_session_id=?1)
        OR EXISTS(SELECT 1 FROM chat_repair_backups WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM metadata WHERE key=?2)
        OR EXISTS(
             SELECT 1 FROM operation_requests
             WHERE method='chat.repair' AND json_extract(params,'$.sessionId')=?1
           )
        OR EXISTS(
             SELECT 1 FROM external_operations e
             JOIN operation_requests r ON r.id=e.id
             WHERE r.method LIKE 'chat.%' AND json_extract(r.params,'$.sessionId')=?1
           )",
        params![id, integrity_key],
        |row| row.get(0),
    )?;
    Ok(!conflicting_evidence)
}
fn session_organization(conn: &Connection, id: &str) -> Result<SessionOrganization> {
    let data: Option<String> = conn
        .query_row(
            "SELECT data FROM session_organization WHERE session_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    data.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .unwrap_or_else(|| Ok(SessionOrganization::default()))
}
fn session_delegation(conn: &Connection, id: &str) -> Result<Option<SessionDelegation>> {
    conn.query_row(
        "SELECT id,parent_session_id,workspace,branch,state,user_messages,authority FROM delegations WHERE child_session_id=?",
        [id],
        |row| {
            Ok(SessionDelegation {
                id: row.get(0)?,
                parent_session_id: row.get(1)?,
                workspace: row.get(2)?,
                branch: row.get(3)?,
                state: row.get(4)?,
                user_messages: row.get(5)?,
                authority: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}
fn session_activity(conn: &Connection, id: &str) -> Result<Option<SessionActivity>> {
    conn.query_row(
        "SELECT state,revision,turn_id,reason FROM session_activity WHERE session_id=?",
        [id],
        |row| {
            Ok(SessionActivity {
                state: row.get(0)?,
                revision: row.get(1)?,
                turn_id: row.get(2)?,
                reason: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn has_pending_attention_approval_tx(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<bool> {
    let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=?")?;
    let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let item: ChatItem = serde_json::from_str(&row?)?;
        if item.parts.iter().any(|part| {
            part.get("type").and_then(Value::as_str) == Some("approval")
                && matches!(part.get("status").and_then(Value::as_str), Some("pending" | "submitting"))
        }) {
            return Ok(true);
        }
    }
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM inbox WHERE session_id=? AND kind='approval' AND resolved=0)",
        [session_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn session_activity_tx(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<Option<SessionActivity>> {
    session_activity(tx, session_id)
}

/// Writes a canonical activity transition inside the caller's transaction.
/// Terminal/read-only/ended sessions intentionally have no activity row, so a
/// delayed provider event cannot make them actionable again.
pub(crate) fn set_session_activity_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    state: &str,
    turn_id: Option<&str>,
    reason: Option<&str>,
) -> Result<Option<SessionActivity>> {
    let session: Option<(String, bool, String)> = tx
        .query_row(
            "SELECT mode,read_only,status FROM sessions WHERE id=?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((mode, read_only, status)) = session else {
        return Ok(None);
    };
    if mode != "chat" || read_only || matches!(status.as_str(), "exited" | "interrupted") {
        return Ok(None);
    }
    let current = session_activity_tx(tx, session_id)?;
    if current.as_ref().is_some_and(|activity| {
        activity.state == state
            && activity.turn_id.as_deref() == turn_id
            && activity.reason.as_deref() == reason
    }) {
        return Ok(current);
    }
    let next = SessionActivity::new(
        state,
        current.as_ref().map_or(1, |activity| activity.revision + 1),
        turn_id,
        reason,
    );
    tx.execute(
        "INSERT INTO session_activity(session_id,state,revision,turn_id,reason) VALUES (?,?,?,?,?) \
         ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,turn_id=excluded.turn_id,reason=excluded.reason",
        params![session_id, next.state, next.revision, next.turn_id, next.reason],
    )?;
    Ok(Some(next))
}

fn read_session(conn: &Connection, id: &str) -> Result<Session> {
    let mut session = conn.query_row("SELECT sessions.id,sessions.project_id,sessions.worktree_path,sessions.title,sessions.provider,sessions.mode,sessions.status,sessions.created_at,sessions.updated_at,sessions.native_id,sessions.exit_code,sessions.followed,sessions.read_only,sessions.cols,sessions.rows,quick_launch_runs.snapshot_json,quick_launch_runs.url,quick_launch_runs.url_source,quick_launch_runs.stop_requested FROM sessions LEFT JOIN quick_launch_runs ON quick_launch_runs.session_id=sessions.id WHERE sessions.id=?",[id],|r|Ok(Session{id:r.get(0)?,project_id:r.get(1)?,worktree_path:r.get(2)?,title:r.get(3)?,provider:r.get(4)?,mode:r.get(5)?,status:r.get(6)?,created_at:r.get(7)?,updated_at:r.get(8)?,native_id:r.get(9)?,exit_code:r.get(10)?,followed:r.get(11)?,read_only:r.get(12)?,cols:r.get(13)?,rows:r.get(14)?,activity:None,delegation:None,group:None,run:crate::quick_launch::run_from_row(r,15)?,organization:SessionOrganization::default()}))?;
    session.organization = session_organization(conn, id)?;
    session.activity = session_activity(conn, id)?;
    session.delegation = session_delegation(conn, id)?;
    session.group = crate::group_chat::session_link(conn, id)?;
    Ok(session)
}
fn session_tx(tx: &Transaction<'_>, id: &str) -> Result<Session> {
    read_session(tx, id)
}

fn settings(conn: &Connection) -> Result<Settings> {
    let (revision, raw): (i64, String) = conn.query_row(
        "SELECT revision,value FROM settings WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Settings {
        revision,
        value: serde_json::from_str(&raw)?,
    })
}
fn merge(base: &mut Value, patch: &Value) {
    if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in patch {
            if (k == "electronCacheCleanup" && !v.is_null())
                || ["customThemes", "modelPrices", "shortcuts"].contains(&k.as_str())
            {
                base.insert(k.clone(), v.clone());
            } else if v.is_null() {
                base.remove(k);
            } else {
                merge(base.entry(k.clone()).or_insert(Value::Null), v)
            }
        }
    } else {
        *base = patch.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_browser_receipts_bind_the_target_chat_without_changing_other_tools() {
        let mut source = history_item("browser-read", "");
        source.parts = vec![
            json!({"type":"tool","data":{"type":"mcpToolCall","server":"threadterm","tool":"browser_snapshot","resultRedacted":true,"browserActivity":{"tool":"browser_snapshot","outcome":"completed","provenanceUnavailable":true,"callerSessionId":"foreign-chat"}}}),
            json!({"type":"tool","data":{"server":"other","tool":"read","browserActivity":{"callerSessionId":"ordinary-value"}}}),
        ];
        let normalized = normalize_history_transcript("target-chat", &[source.clone()]).unwrap();
        assert_eq!(normalized[0].parts[0].pointer("/data/browserActivity/callerSessionId"), Some(&json!("target-chat")));
        assert_eq!(normalized[0].parts[1], source.parts[1]);
        assert_eq!(source.parts[0].pointer("/data/browserActivity/callerSessionId"), Some(&json!("foreign-chat")));
        let repaired = scoped_history_item("repair-chat", &source);
        assert_eq!(repaired.parts[0].pointer("/data/browserActivity/callerSessionId"), Some(&json!("repair-chat")));
    }

    #[test]
    fn subagent_rows_are_revisioned_isolated_ordered_and_cascade_on_session_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("subagents.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "subagent-session",
            })
            .unwrap();
        let item = |id: &str| ChatItem {
            id: id.into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":id})],
            created_at: "first".into(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        };
        db.transaction(|tx| {
            assert_eq!(
                upsert_subagent_item(tx, &session.id, "a", &item("one"), false)?,
                1
            );
            assert_eq!(
                upsert_subagent_item(tx, &session.id, "a", &item("two"), false)?,
                2
            );
            assert_eq!(
                upsert_subagent_item(tx, &session.id, "b", &item("one"), false)?,
                1
            );
            let mut changed = item("one");
            changed.created_at = "later".into();
            changed.parts = vec![json!({"type":"text","text":"updated"})];
            assert_eq!(
                upsert_subagent_item(tx, &session.id, "a", &changed, false)?,
                3
            );
            Ok(())
        })
        .unwrap();
        let (rows, rev, truncated) = db.subagent_items_after(&session.id, "a", 0).unwrap();
        assert_eq!(
            rows.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(rows[0].created_at, "first");
        assert_eq!(rev, 3);
        assert!(!truncated);
        assert_eq!(
            db.subagent_items_after(&session.id, "a", 2).unwrap().0,
            vec![rows[0].clone()]
        );
        assert!(db
            .subagent_items_after(&session.id, "a", 3)
            .unwrap()
            .0
            .is_empty());
        assert_eq!(db.subagent_items_after(&session.id, "b", 0).unwrap().1, 1);
        db.transaction(|tx| {
            tx.execute("DELETE FROM sessions WHERE id=?", [&session.id])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            db.subagent_items_after(&session.id, "a", 0).unwrap(),
            (Vec::new(), 0, false)
        );
        assert!(db
            .subagent_items_after(&session.id, "b", 0)
            .unwrap()
            .0
            .is_empty());
    }

    #[test]
    fn subagent_projection_counts_merged_tools_and_respects_item_cap() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("subagent-counts.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "subagent-counts",
            })
            .unwrap();
        let make_item = |id: String| ChatItem {
            id,
            role: "assistant".into(),
            parts: vec![
                json!({"type":"tool","toolId":"shared","toolName":"shell","data":{"command":"run"}}),
                json!({"type":"tool","toolName":"shell","data":{"command":"run"}}),
            ],
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
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,NULL,'message',?,'now')",
                params![format!("{}:assistant:subagent:child", session.id), session.id, r#"{"parts":[{"data":{"truncated":false}}]}"#],
            )?;
            let first = make_item("item-0".into());
            upsert_subagent_item(tx, &session.id, "child", &first, false)?;
            let mut merge = first;
            merge.parts = vec![json!({"type":"tool","toolId":"shared","toolName":"shell","data":{"command":"run","output":"done"}})];
            upsert_subagent_item(tx, &session.id, "child", &merge, true)?;
            let (_, tools, newest, _) = subagent_item_projection_tx(tx, &session.id, "child")?;
            assert_eq!(tools, 2, "same toolId merges; tool parts without ids use item/index");
            assert_eq!(newest.unwrap().id, "item-0");
            for index in 1..=500 {
                upsert_subagent_item(tx, &session.id, "child", &make_item(format!("item-{index}")), false)?;
            }
            let (items, tools, newest, truncated) = subagent_item_projection_tx(tx, &session.id, "child")?;
            assert_eq!(items, 500);
            assert_eq!(tools, 501, "one shared id plus one unkeyed tool per retained item");
            assert_eq!(newest.unwrap().id, "item-500");
            assert!(truncated);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn repeated_worker_identity_binding_does_not_rewrite_session() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None, title: None, provider: "codex", mode: "chat",
            native_id: None, operation_id: "bind-once",
        }).unwrap();
        db.transaction(|tx| {
            tx.execute_batch("CREATE TABLE binding_writes(n INTEGER); INSERT INTO binding_writes VALUES(0); CREATE TEMP TRIGGER count_binding AFTER UPDATE OF native_id,worktree_path ON sessions BEGIN UPDATE binding_writes SET n=n+1; END;")?;
            Ok(())
        }).unwrap();
        db.bind_session(&session.id, Some("cwd-a"), Some("native-a")).unwrap();
        for _ in 0..100 { db.bind_session(&session.id, None, Some("native-a")).unwrap(); }
        db.bind_session(&session.id, Some("cwd-b"), None).unwrap();
        db.bind_session(&session.id, None, None).unwrap();
        assert!(db.bind_session(&session.id, None, Some("native-b")).is_err());
        let writes: i64 = db.transaction(|tx| Ok(tx.query_row("SELECT n FROM binding_writes", [], |row| row.get(0))?)).unwrap();
        assert_eq!(writes, 2);
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().native_id.as_deref(), Some("native-a"));
    }

    #[test]
    fn transcript_degradation_preserves_live_sessions_and_turn_activity() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let mut sessions = Vec::new();
        for (index, status) in ["running", "waiting", "idle"].iter().enumerate() {
            let session = db.create_session(CreateSession {
                project_id: None, title: None, provider: "codex", mode: "chat",
                native_id: None, operation_id: &format!("degraded-{index}"),
            }).unwrap();
            db.record_provider_event(&session.id, Some("active-turn"), "message.user", &json!({"text":"work"})).unwrap();
            db.set_session_status(&session.id, status, None).unwrap();
            sessions.push((session.id, status.to_string()));
        }
        db.mark_chat_degraded(None, "lost updates").unwrap();
        db.mark_chat_degraded(Some(&sessions[0].0), "failed projection").unwrap();
        for (id, status) in &sessions {
            assert_eq!(db.session_by_id(id).unwrap().unwrap().status, *status);
            let activity = db.transaction(|tx| session_activity_tx(tx, id)).unwrap().unwrap();
            assert_eq!(activity.state, "running");
            assert_eq!(activity.turn_id.as_deref(), Some("active-turn"));
        }
        let warnings: Vec<_> = db.events_after(0).unwrap().into_iter()
            .filter(|(_, event, _)| event == "runtime.degraded").collect();
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].2["sessionId"].is_null());
        assert_eq!(warnings[1].2["sessionId"], sessions[0].0);
    }
    fn history_item(id: &str, text: &str) -> ChatItem {
        ChatItem {
            id: id.into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":text})],
            created_at: "2026-09-10T00:00:00Z".into(),
            turn_id: Some("native-turn".into()),
            elapsed_ms: Some(42),
            turn_status: Some(crate::domain::NativeTurnStatus::Completed),
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        }
    }
    #[test]
    fn imported_history_is_read_only_persistent_and_reuses_its_native_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let transcript = vec![history_item("message-1", "saved answer")];
        let (imported, created) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Saved thread"),
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "thread-1",
                operation_id: "import-a",
                transcript: &transcript,
            })
            .unwrap();
        assert!(created);
        assert!(imported.read_only);
        assert_eq!(imported.status, "idle");
        let stored = db.chat_items(&imported.id).unwrap();
        assert_eq!(stored.len(), 1);
        let expected_turn_id = format!("{}:history:native-turn", imported.id);
        assert_eq!(stored[0].turn_id.as_deref(), Some(expected_turn_id.as_str()));
        assert_eq!(stored[0].elapsed_ms, Some(42));
        assert_eq!(stored[0].turn_status, Some(crate::domain::NativeTurnStatus::Completed));
        assert_eq!(stored[0].turn_origin, Some(crate::domain::ChatTurnOrigin::History));
        assert_eq!(
            crate::session_configs::read(&db, &imported.id)
                .unwrap()
                .unwrap()
                .launch
                .cwd,
            dir.path().to_string_lossy()
        );
        assert!(db
            .require_interactive(&imported.id)
            .unwrap_err()
            .to_string()
            .contains("resume_required"));
        let (owner, created_again) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Other title"),
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "thread-1",
                operation_id: "import-b",
                transcript: &[],
            })
            .unwrap();
        assert!(!created_again);
        assert_eq!(owner.id, imported.id);
        drop(db);
        let reopened = Database::open(&path).unwrap();
        let restored = reopened.session_by_id(&imported.id).unwrap().unwrap();
        assert!(restored.read_only);
        assert_eq!(restored.native_id.as_deref(), Some("thread-1"));
        crate::session_configs::initialize(&reopened).unwrap();
        assert_eq!(reopened.chat_items(&imported.id).unwrap().len(), 1);
        let resumed = reopened
            .reserve_resume(
                &imported.id,
                dir.path().to_str().unwrap(),
                dir.path().to_str().unwrap(),
                "resume-a",
            )
            .unwrap();
        assert!(!resumed.read_only);
        assert_eq!(resumed.native_id.as_deref(), Some("thread-1"));
        reopened
            .import_chat_history(&imported.id, &[history_item("message-2", "resumed answer")])
            .unwrap();
        let resumed_history = reopened.chat_items(&imported.id).unwrap();
        let resumed_item = resumed_history
            .iter()
            .find(|item| item.id.ends_with(":history:message-2"))
            .unwrap();
        assert_eq!(resumed_item.turn_id.as_deref(), Some(expected_turn_id.as_str()));
        assert_eq!(resumed_item.elapsed_ms, Some(42));
        assert_eq!(resumed_item.turn_status, Some(crate::domain::NativeTurnStatus::Completed));
        assert_eq!(resumed_item.turn_origin, Some(crate::domain::ChatTurnOrigin::History));
    }
    #[test]
    fn history_import_rolls_back_owner_config_transcript_and_result_together() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let duplicate = vec![
            history_item("same", "first"),
            history_item("same", "second"),
        ];
        assert!(db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Saved thread"),
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "atomic-thread",
                operation_id: "atomic-import",
                transcript: &duplicate,
            })
            .unwrap_err()
            .to_string()
            .contains("invalid_history_transcript"));
        assert!(db.native_owner("codex", "atomic-thread").unwrap().is_none());
        assert!(db.operation("atomic-import").unwrap().is_none());

        let valid = vec![history_item("same", "complete")];
        let (session, created) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Saved thread"),
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "atomic-thread",
                operation_id: "atomic-import",
                transcript: &valid,
            })
            .unwrap();
        assert!(created);
        assert_eq!(db.chat_items(&session.id).unwrap().len(), 1);
        assert!(crate::session_configs::read(&db, &session.id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn imports_validate_all_history_shapes_and_preserve_source_array_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        for (index, mut invalid) in [
            history_item("", "empty item id"),
            history_item("unknown", "fallback item id"),
            history_item("empty-turn", "empty turn id"),
            history_item("bad-role", "unsupported role"),
            history_item("bad-part", "malformed part"),
        ]
        .into_iter()
        .enumerate()
        {
            match index {
                2 => invalid.turn_id = Some(String::new()),
                3 => invalid.role = "foreign".into(),
                4 => invalid.parts = vec![json!("not a part")],
                _ => {}
            }
            let native_id = format!("invalid-{index}");
            assert!(db
                .import_history_session(ImportHistorySession {
                    project_id: None,
                    title: None,
                    provider: "codex",
                    mode: "chat",
                    cwd: dir.path().to_str().unwrap(),
                    native_id: &native_id,
                    operation_id: &format!("invalid-operation-{index}"),
                    transcript: &[invalid],
                })
                .unwrap_err()
                .to_string()
                .contains("invalid_history_transcript"));
            assert!(db.native_owner("codex", &native_id).unwrap().is_none());
        }

        let mut first = history_item("z-last-lexically", "first in native array");
        let mut second = history_item("a-first-lexically", "second in native array");
        first.created_at = "same".into();
        second.created_at = "same".into();
        let (session, _) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "ordered",
                operation_id: "ordered-operation",
                transcript: &[first, second],
            })
            .unwrap();
        let rows = db.chat_items(&session.id).unwrap();
        assert_eq!(
            rows.iter().map(|item| item.parts[0]["text"].as_str().unwrap()).collect::<Vec<_>>(),
            ["first in native array", "second in native array"]
        );
        assert!(rows[0].created_at < rows[1].created_at);

        let mut near_limit = history_item("near-limit", "");
        near_limit.parts[0]["text"] = json!("x".repeat(
            crate::chat_repair::MAX_HISTORY_BYTES
                - crate::chat_repair::HISTORY_FRAME_HEADROOM_BYTES
                + 1024
        ));
        assert!(
            serde_json::to_vec(&[near_limit.clone()]).unwrap().len()
                < crate::chat_repair::MAX_HISTORY_BYTES
        );
        assert!(db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "near-limit",
                operation_id: "near-limit-operation",
                transcript: &[near_limit],
            })
            .unwrap_err()
            .to_string()
            .contains("normalized snapshot exceeds frame limit"));
        assert!(db.native_owner("codex", "near-limit").unwrap().is_none());
        assert!(db.operation("near-limit-operation").unwrap().is_none());
    }
    #[test]
    fn imports_persist_native_instants_clamp_order_and_keep_next_live_item_after_tail() {
        for read_only in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("db.sqlite");
            let db = Database::open(&path).unwrap();
            crate::session_configs::initialize(&db).unwrap();
            let times = ["2090-01-01T02:00:00+02:00", "2090-01-01T00:00:00.000Z",
                "2089-12-31T23:59:59Z", "invalid", "2090-01-01T00:00:01.5Z",
                "2090-01-01T00:00:02Z"];
            let native: Vec<_> = times.iter().enumerate().map(|(index, time)| {
                let mut item = history_item(&format!("item-{}", times.len() - index), "saved");
                item.created_at = (*time).into();
                item
            }).collect();
            let session = if read_only {
                db.import_history_session(ImportHistorySession {
                    project_id: None, title: None, provider: "opencode", mode: "chat",
                    cwd: dir.path().to_str().unwrap(), native_id: "timestamp-thread",
                    operation_id: "timestamp-import", transcript: &native,
                }).unwrap().0
            } else {
                let session = db.create_session(CreateSession {
                    project_id: None, title: None, provider: "opencode", mode: "chat",
                    native_id: Some("timestamp-thread"), operation_id: "timestamp-create",
                }).unwrap();
                db.import_chat_history(&session.id, &native).unwrap();
                session
            };
            let expected = ["2090-01-01T00:00:00.000000000+00:00", "2090-01-01T00:00:00.000000001+00:00",
                "2090-01-01T00:00:00.000000002+00:00", "2090-01-01T00:00:00.000000003+00:00",
                "2090-01-01T00:00:01.500000000+00:00", "2090-01-01T00:00:02.000000000+00:00"];
            drop(db);
            let db = Database::open(&path).unwrap();
            let stored = db.chat_items(&session.id).unwrap();
            assert_eq!(stored.iter().map(|item| item.created_at.as_str()).collect::<Vec<_>>(), expected);
            for (stored, source) in stored.iter().zip(&native) {
                assert_eq!(stored.id, format!("{}:history:{}", session.id, source.id));
                assert_eq!(stored.turn_origin, Some(ChatTurnOrigin::History));
            }
            db.record_provider_event(&session.id, Some("live"), "message.user", &json!({"text":"next"})).unwrap();
            let stored = db.chat_items(&session.id).unwrap();
            assert_eq!(stored.len(), native.len() + 1);
            assert_eq!(stored.last().unwrap().role, "user");
            assert!(stored.last().unwrap().created_at.as_str() > *expected.last().unwrap());
            assert!(chrono::DateTime::parse_from_rfc3339(&stored.last().unwrap().created_at).unwrap()
                > chrono::DateTime::parse_from_rfc3339(expected.last().unwrap()).unwrap());
        }
    }

    #[test]
    fn unchanged_rebuild_preserves_imported_native_timestamps_and_next_live_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let mut native = vec![history_item("z-first", "first"), history_item("a-second", "second")];
        native[0].created_at = "2090-01-01T00:00:00Z".into();
        native[1].created_at = "2090-01-01T00:00:00Z".into();
        let (session, _) = db.import_history_session(ImportHistorySession {
            project_id: None, title: None, provider: "opencode", mode: "chat",
            cwd: dir.path().to_str().unwrap(), native_id: "rebuild-timestamp-thread",
            operation_id: "rebuild-timestamp-import", transcript: &native,
        }).unwrap();
        // Repair's unchanged comparison includes anchors, so use the same confirmed anchors.
        for item in &mut native {
            item.fork_anchor = Some(crate::domain::NativeForkAnchor {
                native_id: "rebuild-timestamp-thread".into(), turn_id: None, message_id: None, entry_id: None,
            });
        }
        let before = db.chat_items(&session.id).unwrap();
        db.mark_chat_degraded(Some(&session.id), "test rebuild").unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?,?,?,?)",
                params![session.id, "timestamp-test", 7, (Utc::now() + chrono::Duration::hours(1)).to_rfc3339()])?;
            Ok(())
        }).unwrap();
        db.bind_operation("timestamp-rebuild", "chat.repair", &json!({"sessionId":session.id})).unwrap();
        let worker = crate::chat_repair::RepairWorkerState::default();
        let capture = db.transaction(|tx| crate::chat_repair::capture(tx, &session.id, &worker, true)).unwrap();
        let plan = crate::chat_repair::prepare(&capture, &native).unwrap();
        let result = db.transaction(|tx| crate::chat_repair::commit(tx, &capture, &plan, &worker, true,
            crate::chat_repair::RepairCommitContext { principal: "timestamp-test", lease_epoch: 7,
                operation_id: "timestamp-rebuild" })).unwrap();
        assert_eq!(result.updated, 0);
        assert_eq!(result.added, 0);
        assert_eq!(result.removed, 0);
        drop(db);
        let db = Database::open(&path).unwrap();
        let rebuilt = db.chat_items(&session.id).unwrap();
        assert_eq!(serde_json::to_value(&rebuilt).unwrap(), serde_json::to_value(&before).unwrap());
        db.record_provider_event(&session.id, Some("live"), "message.user", &json!({"text":"next"})).unwrap();
        let stored = db.chat_items(&session.id).unwrap();
        assert_eq!(stored.last().unwrap().role, "user");
        assert!(stored.last().unwrap().created_at > rebuilt.last().unwrap().created_at);
    }

    #[test]
    fn read_only_import_is_archivable_not_lost_on_startup_and_restored_after_failed_resume() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let (imported, _) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Saved thread"),
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "archive-thread",
                operation_id: "archive-import",
                transcript: &[history_item("message", "durable")],
            })
            .unwrap();
        let archived = db
            .organize_session(&SessionOrganize {
                session_id: imported.id.clone(),
                archived: Some(true),
                pinned: None,
                bookmarked: Some(true),
                intent: None,
                sort_order: None,
                expected_revision: 0,
                operation_id: "archive-imported".into(),
            })
            .unwrap();
        assert!(archived.read_only && archived.organization.archived);
        db.mark_live_sessions_interrupted().unwrap();
        let after_startup = db.session_by_id(&imported.id).unwrap().unwrap();
        assert_eq!(after_startup.status, "idle");
        assert!(after_startup.read_only && after_startup.organization.archived);

        let reserved = db
            .reserve_resume(
                &imported.id,
                dir.path().to_str().unwrap(),
                dir.path().to_str().unwrap(),
                "resume-imported",
            )
            .unwrap();
        assert!(!reserved.read_only && !reserved.organization.archived);
        db.restore_imported_read_only(&after_startup).unwrap();
        let restored = db.session_by_id(&imported.id).unwrap().unwrap();
        assert_eq!(restored.status, "idle");
        assert!(restored.read_only && restored.organization.archived);
        assert!(restored.organization.bookmarked);
        assert_eq!(restored.native_id, imported.native_id);
        assert_eq!(db.chat_items(&imported.id).unwrap().len(), 1);
    }
    #[test]
    fn concurrent_resume_reservations_allow_only_one_launch_owner() {
        let dir = tempfile::tempdir().unwrap();
        let db = std::sync::Arc::new(Database::open(&dir.path().join("db.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let (imported, _) = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                cwd: dir.path().to_str().unwrap(),
                native_id: "concurrent-thread",
                operation_id: "concurrent-import",
                transcript: &[],
            })
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for operation in ["resume-one", "resume-two"] {
            let db = std::sync::Arc::clone(&db);
            let barrier = std::sync::Arc::clone(&barrier);
            let session_id = imported.id.clone();
            let cwd = dir.path().to_string_lossy().into_owned();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                db.reserve_resume(&session_id, &cwd, &cwd, operation)
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|error| error.to_string().contains("session_already_active")))
                .count(),
            1
        );
    }
    #[test]
    fn output_tail_reads_only_the_bounded_durable_suffix_with_real_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "tail-session",
            })
            .unwrap();
        assert_eq!(
            db.read_output_window(&session.id, None, true, 1).unwrap(),
            (0, 0, false, Vec::new())
        );
        db.append_output(&session.id, 0, &vec![b'a'; 6_000])
            .unwrap();
        db.append_output(&session.id, 6_000, &vec![b'b'; 6_000])
            .unwrap();
        assert_eq!(db.output_start(&session.id).unwrap(), Some(0));

        let (from, next, truncated, tail) = db
            .read_output_window(&session.id, None, true, 8_192)
            .unwrap();
        assert_eq!(
            (from, next, truncated, tail.len()),
            (3_808, 12_000, true, 8_192)
        );
        assert_eq!(&tail[..2_192], vec![b'a'; 2_192]);
        assert_eq!(&tail[2_192..], vec![b'b'; 6_000]);

        let (from, next, truncated, page) = db
            .read_output_window(&session.id, Some(5_999), false, 3)
            .unwrap();
        assert_eq!((from, next, truncated), (5_999, 6_002, true));
        assert_eq!(page, vec![b'a', b'b', b'b']);
        let short = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "short-tail",
            })
            .unwrap();
        db.append_output(&short.id, 0, b"ok").unwrap();
        assert_eq!(
            db.read_output_window(&short.id, None, true, 8192).unwrap(),
            (0, 2, false, b"ok".to_vec())
        );
        assert!(db
            .read_output_window("missing", None, true, 8_192)
            .unwrap_err()
            .to_string()
            .contains("session_not_found"));
        assert_eq!(db.output_start("missing").unwrap(), None);
    }
    #[test]
    fn output_history_gaps_fail_instead_of_forging_continuous_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let create = |operation_id| {
            db.create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id,
            })
            .unwrap()
        };

        let leading_gap = create("leading-output-gap");
        db.append_output(&leading_gap.id, 5, b"later").unwrap();
        for error in [
            db.output_from(&leading_gap.id, 0, 64)
                .unwrap_err()
                .to_string(),
            db.read_output_window(&leading_gap.id, Some(0), false, 64)
                .unwrap_err()
                .to_string(),
        ] {
            assert!(error.contains("terminal_history_gap"), "{error}");
        }

        let middle_gap = create("middle-output-gap");
        db.append_output(&middle_gap.id, 0, b"one").unwrap();
        db.append_output(&middle_gap.id, 6, b"two").unwrap();
        // A requested page ending at the first chunk never reads across the
        // gap, so it remains valid and can be resumed at the boundary.
        assert_eq!(
            db.output_from(&middle_gap.id, 0, 3).unwrap(),
            vec![(0, b"one".to_vec())]
        );
        assert_eq!(
            db.read_output_window(&middle_gap.id, Some(0), false, 3)
                .unwrap(),
            (0, 3, true, b"one".to_vec())
        );
        for error in [
            db.output_from(&middle_gap.id, 0, 64)
                .unwrap_err()
                .to_string(),
            db.read_output_window(&middle_gap.id, Some(0), false, 64)
                .unwrap_err()
                .to_string(),
        ] {
            assert!(error.contains("terminal_history_gap"), "{error}");
        }

        let contiguous = create("partial-output-chunk");
        db.append_output(&contiguous.id, 0, b"abcdefghij").unwrap();
        db.append_output(&contiguous.id, 10, b"klmnop").unwrap();
        let rows = db.output_from(&contiguous.id, 5, 64).unwrap();
        assert_eq!(
            rows,
            vec![(0, b"abcdefghij".to_vec()), (10, b"klmnop".to_vec())]
        );
        assert_eq!(
            db.read_output_window(&contiguous.id, Some(5), false, 7)
                .unwrap(),
            (5, 12, true, b"fghijkl".to_vec())
        );

        let empty = create("empty-output-chunk");
        db.append_output(&empty.id, 0, b"").unwrap();
        assert!(db.output_from(&empty.id, 0, 64).unwrap().is_empty());
        assert_eq!(
            db.read_output_window(&empty.id, Some(0), false, 64)
                .unwrap(),
            (0, 0, false, Vec::new())
        );
    }
    #[test]
    fn output_from_seeks_to_the_containing_chunk_then_scans_only_the_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "output-seek-session",
            })
            .unwrap();
        for index in 0..2_048_i64 {
            db.append_output(&session.id, index * 16, &[index as u8; 16])
                .unwrap();
        }

        // The first returned row remains whole: transport trims it at the
        // requested byte cursor, preserving its established partial-chunk API.
        let inside = db.output_from(&session.id, 16 * 1_000 + 7, 32).unwrap();
        assert_eq!(inside.len(), 2);
        assert_eq!(inside[0].0, 16 * 1_000);
        assert_eq!(inside[0].1, vec![1_000_u16 as u8; 16]);
        assert_eq!(inside[1].0, 16 * 1_001);
        assert!(db
            .output_from(&session.id, 16 * 2_048, 32)
            .unwrap()
            .is_empty());

        let conn = db.connection.lock().unwrap();
        let mut predecessor_statement = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT start_cursor FROM output_chunks \
                 WHERE session_id=? AND start_cursor<=? \
                 ORDER BY start_cursor DESC LIMIT 1",
            )
            .unwrap();
        let predecessor_detail = predecessor_statement
            .query_map(params![session.id, 16_i64 * 1_000 + 7], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut statement = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT start_cursor,data FROM output_chunks \
                 WHERE session_id=? AND start_cursor>=? ORDER BY start_cursor",
            )
            .unwrap();
        let detail = statement
            .query_map(params![session.id, 16_i64 * 1_000], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for (label, plan) in [("predecessor", &predecessor_detail), ("suffix", &detail)] {
            assert!(
                plan.iter()
                    .any(|step| step.contains("SEARCH output_chunks")),
                "expected indexed {label} seek, got {plan:?}"
            );
            assert!(
                !plan.iter().any(|step| step.contains("SCAN output_chunks")),
                "{label} query must not scan the persisted output prefix: {plan:?}"
            );
        }
    }
    #[test]
    fn interrupted_deferred_codex_startup_retains_a_retryable_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session_with_deferred(
                CreateSession {
                    project_id: None,
                    title: None,
                    provider: "codex",
                    mode: "terminal",
                    native_id: None,
                    operation_id: "interrupted-deferred",
                },
                Some(dir.path().to_str().unwrap()),
            )
            .unwrap();
        assert_eq!(
            db.deferred_codex_launch(&session.id).unwrap().unwrap()["phase"],
            "preparing"
        );
        assert_eq!(
            db.deferred_codex_cwd(&session.id).unwrap().as_deref(),
            dir.path().to_str()
        );
        db.mark_live_sessions_interrupted().unwrap();
        let after = db.session_by_id(&session.id).unwrap().unwrap();
        assert_eq!(after.status, "interrupted");
        assert!(after.native_id.is_none());
        let launch = db.deferred_codex_launch(&session.id).unwrap().unwrap();
        assert_eq!(launch["phase"], "failed");
        assert_eq!(launch["error"]["code"], "runtime_interrupted");
    }
    #[test]
    fn native_id_is_unique_even_after_the_original_session_exits() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let owner = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: Some("thread-1"),
                operation_id: "native-owner",
            })
            .unwrap();
        db.set_session_status(&owner.id, "exited", Some(0)).unwrap();
        assert!(db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: Some("thread-1"),
                operation_id: "duplicate-create",
            })
            .unwrap_err()
            .to_string()
            .contains("native_session_exists"));
        let unbound = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "unbound-session",
            })
            .unwrap();
        assert!(db
            .bind_session(&unbound.id, None, Some("thread-1"))
            .unwrap_err()
            .to_string()
            .contains("native_session_exists"));
    }
    #[test]
    fn resume_rebinds_workspace_root_and_persists_the_exact_launch_cwd_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let cwd = root.join("nested");
        std::fs::create_dir_all(&cwd).unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "resume-source",
            })
            .unwrap();
        crate::session_configs::save_new(
            &db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "shell".into(),
                mode: "terminal".into(),
                cwd: root.to_string_lossy().to_string(),
                project_id: None,
                title: None,
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let resumed = db
            .reserve_resume(
                &session.id,
                root.to_str().unwrap(),
                cwd.to_str().unwrap(),
                "resume-operation",
            )
            .unwrap();
        assert_eq!(resumed.worktree_path.as_deref(), root.to_str());
        let config = crate::session_configs::read(&db, &session.id)
            .unwrap()
            .unwrap();
        assert_eq!(config.revision, 2);
        assert_eq!(config.launch.cwd, cwd.to_string_lossy());
        db.reserve_resume(
            &session.id,
            root.to_str().unwrap(),
            cwd.to_str().unwrap(),
            "resume-operation",
        )
        .unwrap();
        assert_eq!(
            crate::session_configs::read(&db, &session.id)
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }
    #[test]
    fn organization_is_durable_revision_fenced_and_archiving_keeps_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Task"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "create-org",
            })
            .unwrap();
        let patch = |revision, operation: &str, archived| SessionOrganize {
            session_id: session.id.clone(),
            archived: Some(archived),
            pinned: None,
            bookmarked: Some(true),
            intent: Some("review".into()),
            sort_order: None,
            expected_revision: revision,
            operation_id: operation.into(),
        };
        assert!(db
            .organize_session(&patch(0, "active-archive", true))
            .unwrap_err()
            .to_string()
            .contains("end_session"));
        db.set_session_status(&session.id, "exited", Some(0))
            .unwrap();
        let saved = db.organize_session(&patch(0, "archive", true)).unwrap();
        assert!(saved.organization.archived);
        assert_eq!(
            db.organize_session(&patch(0, "archive", true)).unwrap(),
            saved
        );
        assert!(db
            .organize_session(&patch(0, "stale", false))
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        drop(db);
        let db = Database::open(&path).unwrap();
        let reopened = db.snapshot().unwrap().sessions.remove(0);
        assert!(reopened.organization.archived && reopened.organization.bookmarked);
        assert_eq!(reopened.organization.intent.as_deref(), Some("review"));
        let restored = db.organize_session(&patch(1, "restore", false)).unwrap();
        assert!(!restored.organization.archived);
        assert_eq!(restored.id, session.id);
        assert_eq!(restored.status, "exited");
    }
    #[test]
    fn operation_identity_rejects_method_and_parameter_reuse_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let request = json!({"operationId":"one","title":"A"});
        db.bind_operation("one", "session.create", &request)
            .unwrap();
        db.bind_operation("one", "session.create", &request)
            .unwrap();
        assert!(db.bind_operation("one", "session.stop", &request).is_err());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert!(db
            .bind_operation(
                "one",
                "session.create",
                &json!({"operationId":"one","title":"B"})
            )
            .is_err());
    }
    #[test]
    fn compose_drafts_are_revision_fenced_and_user_turns_remain_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "create",
            })
            .unwrap();
        db.save_chat_draft(&session.id, "unsent", 0, "draft")
            .unwrap();
        assert!(db
            .save_chat_draft(&session.id, "stale", 0, "draft-stale")
            .is_err());
        for turn in ["one", "two"] {
            db.record_provider_event(
                &session.id,
                Some(turn),
                "message.user",
                &json!({"text":turn}),
            )
            .unwrap();
        }
        assert_eq!(db.chat_items(&session.id).unwrap().len(), 2);
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.chat_draft(&session.id).unwrap()["text"], "unsent");
        assert!(db.claim_external_operation("send").unwrap());
        assert!(!db.claim_external_operation("send").unwrap());
    }
    #[test]
    fn operations_are_idempotent_and_settings_are_fenced() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let first = db.add_project("C:\\work", Some("work"), "op").unwrap();
        assert_eq!(first, db.add_project("C:\\other", None, "op").unwrap());
        assert!(db.update_settings(&json!({"theme":"dark"}), 0, "s").is_ok());
        assert!(db.update_settings(&json!({}), 0, "s2").is_err());
    }
    #[test]
    fn settings_map_patches_replace_entries_so_empty_maps_delete_them() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let saved = db
            .update_settings(
                &json!({
                    "customThemes":{"night":{"background":"#000000"}},
                    "modelPrices":{"codex/gpt-5":{"input":1}},
                    "shortcuts":{"showMainWindow":"Ctrl+Shift+T"},
                    "notifications":{"native":true}
                }),
                0,
                "settings-with-maps",
            )
            .unwrap();
        let cleared = db
            .update_settings(
                &json!({"customThemes":{},"modelPrices":{},"shortcuts":{}}),
                saved.revision,
                "clear-settings-maps",
            )
            .unwrap();
        assert_eq!(cleared.value["customThemes"], json!({}));
        assert_eq!(cleared.value["modelPrices"], json!({}));
        assert_eq!(cleared.value["shortcuts"], json!({}));
        assert_eq!(cleared.value["notifications"], json!({"native":true}));
    }
    #[test]
    fn mutations_are_available_in_monotonic_outbox_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        db.add_project("C:\\work", Some("work"), "project-op")
            .unwrap();
        let events = db.events_after(0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "state.changed");
        assert_eq!(events[0].2["kind"], "project");
        assert!(db.events_after(events[0].0).unwrap().is_empty());
    }
    #[test]
    fn snapshot_restores_layout_and_read_does_not_resolve_approval() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Review"),
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "create",
            })
            .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.approval",
            &json!({"approvalId":"approval"}),
        )
        .unwrap();
        let layout = json!({"kind":"pane","id":"pane","tabs":[],"activeTabId":null});
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO workspaces VALUES ('workspace','Desk',NULL,NULL,1,?,'now')",
                [layout.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
        let snapshot = db.snapshot().unwrap();
        assert_eq!(snapshot.workspaces[0]["layout"], layout);
        assert!(snapshot.workspaces[0].get("projectId").is_none());
        let id = snapshot.inbox[0]["id"].as_str().unwrap().to_owned();
        db.read_inbox(&[id], "read").unwrap();
        assert_eq!(db.snapshot().unwrap().inbox[0]["read"], true);
        assert_eq!(
            db.chat_items(&session.id).unwrap()[0].parts[0]["status"],
            "pending"
        );
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.snapshot().unwrap().workspaces[0]["layout"], layout);
        assert_eq!(reopened.snapshot().unwrap().inbox[0]["read"], true);
    }
    #[test]
    fn deltas_upsert_one_transcript_item() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "chat",
            })
            .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"A"}}),
        )
        .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "chat.delta",
            &json!({"part":{"type":"text","text":"B"}}),
        )
        .unwrap();
        let items = db.chat_items(&session.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].parts[0]["text"], "AB");
    }
    #[test]
    fn attention_acknowledgement_is_revision_fenced_idempotent_and_durable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "attention-create",
            })
            .unwrap();
        db.record_provider_event(
            &session.id,
            Some("turn"),
            "message.user",
            &json!({"text":"hi"}),
        )
        .unwrap();
        db.bind_chat_activity_turn(&session.id, "turn", "turn")
            .unwrap();
        db.record_provider_event(&session.id, Some("turn"), "chat.turn.completed", &json!({}))
            .unwrap();
        let pending = db
            .session_by_id(&session.id)
            .unwrap()
            .unwrap()
            .activity
            .unwrap();
        assert_eq!(pending.state, "awaiting_input");
        assert!(db
            .acknowledge_session_attention(&session.id, pending.revision - 1, "stale")
            .is_err());
        let handled = db
            .acknowledge_session_attention(&session.id, pending.revision, "handled")
            .unwrap();
        assert_eq!(handled.activity.as_ref().unwrap().state, "idle");
        assert_eq!(
            db.acknowledge_session_attention(&session.id, pending.revision, "handled")
                .unwrap(),
            handled
        );
        drop(db);
        assert_eq!(
            Database::open(&path)
                .unwrap()
                .session_by_id(&session.id)
                .unwrap()
                .unwrap()
                .activity
                .unwrap()
                .state,
            "idle"
        );
    }
    #[test]
    fn completed_chat_attention_survives_terminal_status_and_runtime_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "completed-chat",
            })
            .unwrap();
        db.record_provider_event(&session.id, Some("turn"), "message.user", &json!({"text":"hi"})).unwrap();
        db.bind_chat_activity_turn(&session.id, "turn", "turn").unwrap();
        db.record_provider_event(&session.id, Some("turn"), "chat.turn.completed", &json!({})).unwrap();
        let pending = db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap();
        db.set_session_status(&session.id, "error", None).unwrap();
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap(), pending);

        let second = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "completed-chat-recovery",
            })
            .unwrap();
        db.record_provider_event(&second.id, Some("turn"), "message.user", &json!({"text":"hi"})).unwrap();
        db.bind_chat_activity_turn(&second.id, "turn", "turn").unwrap();
        db.record_provider_event(&second.id, Some("turn"), "chat.turn.completed", &json!({})).unwrap();
        let pending_recovery = db.session_by_id(&second.id).unwrap().unwrap().activity.unwrap();
        db.mark_live_sessions_interrupted().unwrap();
        let after = db.session_by_id(&second.id).unwrap().unwrap();
        assert_eq!(after.status, "idle");
        assert_eq!(after.activity.unwrap(), pending_recovery);
    }
    #[test]
    fn terminal_loss_is_unknown_not_a_completed_attention_state() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "terminal",
                native_id: Some("native-terminal"),
                operation_id: "terminal-loss",
            })
            .unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        db.mark_live_sessions_interrupted().unwrap();
        let after = db.session_by_id(&session.id).unwrap().unwrap();
        assert_eq!(after.status, "interrupted");
        let activity = after.activity.unwrap();
        assert_eq!(activity.state, "unknown");
        assert_eq!(activity.reason.as_deref(), Some("runtime_interrupted"));
    }
    #[test]
    fn completed_chat_attention_survives_failed_reconnect_and_already_interrupted_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "failed-reconnect",
            })
            .unwrap();
        db.record_provider_event(&session.id, Some("turn"), "message.user", &json!({"text":"hi"})).unwrap();
        db.bind_chat_activity_turn(&session.id, "turn", "turn").unwrap();
        db.record_provider_event(&session.id, Some("turn"), "chat.turn.completed", &json!({})).unwrap();
        let pending = db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap();
        db.transaction(|tx| {
            tx.execute("UPDATE sessions SET status='starting' WHERE id=?", [&session.id])?;
            Ok(())
        }).unwrap();
        assert!(db.fail_starting_session(&session.id).unwrap());
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap(), pending);
        db.set_session_status(&session.id, "interrupted", None).unwrap();
        db.mark_live_sessions_interrupted().unwrap();
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap(), pending);
    }
    #[test]
    fn acknowledgement_rejects_pending_persisted_approval_even_when_activity_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "approval-ack-race",
            })
            .unwrap();
        db.record_provider_event(&session.id, Some("turn"), "message.user", &json!({"text":"hi"})).unwrap();
        db.bind_chat_activity_turn(&session.id, "turn", "turn").unwrap();
        db.record_provider_event(&session.id, Some("turn"), "chat.turn.completed", &json!({})).unwrap();
        let pending = db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap();
        // The completed turn fences activity back to awaiting-input, but the
        // persisted approval card still wins over a mark-handled request.
        db.record_provider_event(&session.id, Some("late"), "chat.approval", &json!({"approvalId":"late"})).unwrap();
        assert!(db
            .acknowledge_session_attention(&session.id, pending.revision, "blocked-by-approval")
            .unwrap_err()
            .to_string()
            .contains("attention_approval_pending"));
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().activity.unwrap(), pending);
    }
    #[test]
    fn chat_items_of_one_session_are_read_through_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let plan: Vec<String> = db
            .transaction(|tx| {
                let mut statement = tx.prepare("EXPLAIN QUERY PLAN SELECT data FROM chat_items WHERE session_id=? ORDER BY created_at,id")?;
                let rows = statement.query_map(["s"], |row| row.get::<_, String>(3))?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap();
        // A table scan would read every Chat's items to show one; the index also supplies the order.
        assert!(plan.iter().any(|step| step.contains("USING INDEX chat_items_session")), "{plan:?}");
        assert!(!plan.iter().any(|step| step.contains("TEMP B-TREE")), "{plan:?}");
    }

    #[test]
    fn pi_auto_retry_selection_survives_database_reopen_and_cascades_on_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-options.sqlite");
        let session_id;
        {
            let db = Database::open(&path).unwrap();
            let session = db.create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "pi",
                mode: "chat",
                native_id: None,
                operation_id: "pi-options-session",
            }).unwrap();
            session_id = session.id;
            assert_eq!(db.pi_auto_retry(&session_id).unwrap(), None);
            db.set_pi_auto_retry(&session_id, false).unwrap();
            assert_eq!(db.pi_auto_retry(&session_id).unwrap(), Some(false));
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.pi_auto_retry(&session_id).unwrap(), Some(false));
        db.transaction(|tx| {
            tx.execute("DELETE FROM sessions WHERE id=?", [&session_id])?;
            Ok(())
        }).unwrap();
        assert_eq!(db.pi_auto_retry(&session_id).unwrap(), None);
    }

    #[test]
    fn provider_neutral_chat_options_reopen_validate_and_cascade_without_changing_pi() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("chat-options.sqlite");
        let selections = json!([{"id":"next-model","value":"{\"providerID\":\"one/two\",\"modelID\":\"a/b\"}"},{"id":"variant","value":"high"}]);
        let id;
        {
            let db = Database::open(&path).unwrap();
            let session = db.create_session(CreateSession {project_id:None,title:None,provider:"opencode",mode:"chat",native_id:None,operation_id:"neutral-options"}).unwrap();
            id = session.id;
            assert_eq!(db.chat_option_selections(&id,"opencode").unwrap(),json!([]));
            db.set_chat_option_selections(&id,"opencode",&selections).unwrap();
            assert!(db.set_chat_option_selections(&id,"pi",&selections).is_err());
            assert!(db.set_chat_option_selections(&id,"opencode",&json!([{"id":"a","value":"x"},{"id":"a","value":"y"}])).is_err());
            assert_eq!(db.chat_option_selections(&id,"opencode").unwrap(),selections);
            assert_eq!(db.pi_auto_retry(&id).unwrap(),None);
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.chat_option_selections(&id,"opencode").unwrap(),selections);
        db.transaction(|tx| {tx.execute("DELETE FROM sessions WHERE id=?",[&id])?; Ok(())}).unwrap();
        assert_eq!(db.chat_option_selections(&id,"opencode").unwrap(),json!([]));
    }

    #[test]
    fn chat_context_reads_timestamp_from_column_for_legacy_or_invalid_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context-timestamp.sqlite");
        let db = Database::open(&path).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "claude",
            mode: "chat",
            native_id: None,
            operation_id: "context-timestamp-session",
        }).unwrap();
        let timestamp = "2026-10-13T15:30:00Z";
        db.transaction(|tx| {
            tx.execute("INSERT INTO chat_context(session_id,data,updated_at) VALUES (?,?,?)", params![session.id, json!({"usedTokens":5}).to_string(), timestamp])?;
            Ok(())
        }).unwrap();
        assert_eq!(db.chat_context(&session.id).unwrap().unwrap()["updatedAt"], timestamp);
        db.transaction(|tx| {
            tx.execute("UPDATE chat_context SET data=? WHERE session_id=?", params![json!({"updatedAt":42}).to_string(), session.id])?;
            Ok(())
        }).unwrap();
        assert_eq!(db.chat_context(&session.id).unwrap().unwrap()["updatedAt"], timestamp);
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.chat_context(&session.id).unwrap().unwrap()["updatedAt"], timestamp);
    }

    #[test]
    fn explicit_pi_chat_native_replacement_checks_prior_and_owner_without_weakening_bind() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi-native-replacement.sqlite")).unwrap();
        let session = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "pi",
            mode: "chat",
            native_id: Some("pi-old"),
            operation_id: "pi-native-owner",
        }).unwrap();
        let owner = db.create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "pi",
            mode: "chat",
            native_id: Some("pi-taken"),
            operation_id: "pi-native-other-owner",
        }).unwrap();
        db.replace_pi_chat_native_id(&session.id, Some("pi-old"), "pi-new").unwrap();
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().native_id.as_deref(), Some("pi-new"));
        assert!(db.replace_pi_chat_native_id(&session.id, Some("pi-old"), "pi-stale").is_err());
        assert!(db.replace_pi_chat_native_id(&session.id, Some("pi-new"), "pi-taken").unwrap_err().to_string().contains(&owner.id));
        assert!(db.bind_session(&session.id, None, Some("pi-generic-change")).is_err());
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().native_id.as_deref(), Some("pi-new"));
    }

    fn empty_recovery_session(db: &Database, cwd: &Path, operation: &str) -> Session {
        crate::session_configs::initialize(db).unwrap();
        crate::chat_queue::initialize(db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "chat",
                native_id: Some("missing-native"),
                operation_id: operation,
            })
            .unwrap();
        crate::session_configs::save_new(
            db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "codex".into(),
                mode: "chat".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                project_id: None,
                title: None,
                executable: None,
                args: Vec::new(),
            },
            None,
        )
        .unwrap();
        session
    }

    #[test]
    fn empty_chat_native_replacement_is_atomic_and_preserves_unique_ownership() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("empty-recovery.sqlite")).unwrap();
        let session = empty_recovery_session(&db, root.path(), "empty-recovery");
        assert!(db
            .empty_chat_native_recovery_eligible(&session.id, "missing-native")
            .unwrap());
        assert!(db
            .replace_empty_chat_native_id(&session.id, "missing-native", "fresh-native")
            .unwrap());
        assert_eq!(
            db.session_by_id(&session.id)
                .unwrap()
                .unwrap()
                .native_id
                .as_deref(),
            Some("fresh-native")
        );
        assert!(!db
            .replace_empty_chat_native_id(&session.id, "missing-native", "another-native")
            .unwrap());

        let second = empty_recovery_session(&db, root.path(), "empty-recovery-owner");
        assert!(db
            .replace_empty_chat_native_id(&second.id, "missing-native", "fresh-native")
            .unwrap_err()
            .to_string()
            .contains(&session.id));
        assert_eq!(
            db.session_by_id(&second.id)
                .unwrap()
                .unwrap()
                .native_id
                .as_deref(),
            Some("missing-native")
        );
    }

    #[test]
    fn empty_chat_recovery_rejects_every_durable_sign_of_content_or_lineage() {
        for evidence in [
            "chat-item",
            "queue-item",
            "subagent-item",
            "inbox",
            "fork-options",
            "fork-intent",
            "fork-organization",
            "launch-source",
            "delegation",
            "degraded",
            "repair-backup",
            "repair-request",
            "claimed-chat-action",
        ] {
            let root = tempfile::tempdir().unwrap();
            let db = Database::open(&root.path().join(format!("{evidence}.sqlite"))).unwrap();
            let session = empty_recovery_session(&db, root.path(), evidence);
            assert!(db
                .empty_chat_native_recovery_eligible(&session.id, "missing-native")
                .unwrap(),
                "base {evidence}"
            );
            match evidence {
                "chat-item" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO chat_items(id,session_id,kind,data,created_at) VALUES ('item',?,'system','{}','now')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "queue-item" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO chat_queue_items(id,session_id,position,text,images_json,revision,state,created_at,updated_at) VALUES ('queue',?,0,'queued','[]',1,'failed','now','now')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "subagent-item" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO subagent_items(session_id,subagent_key,item_id,seq,rev,data,created_at) VALUES (?,'child','item',1,1,'{}','now')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "inbox" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO inbox(id,session_id,kind,data,created_at) VALUES ('inbox',?,'approval','{}','now')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "fork-options" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO session_fork_options(session_id,data) VALUES (?,'[]')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "fork-intent" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO chat_fork_intents(operation_id,source_session_id,native_id,created_at) VALUES ('fork',?,'fork-native','now')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "fork-organization" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO session_organization(session_id,data) VALUES (?,?)",
                            params![session.id, json!({"forkedFrom":{"sessionId":"parent"}}).to_string()],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "launch-source" => {
                    let source = db
                        .create_session(CreateSession {
                            project_id: None,
                            title: None,
                            provider: "codex",
                            mode: "chat",
                            native_id: None,
                            operation_id: "source",
                        })
                        .unwrap();
                    crate::session_configs::link_source(&db, &session.id, &source.id).unwrap();
                }
                "delegation" => {
                    let child = db
                        .create_session(CreateSession {
                            project_id: None,
                            title: None,
                            provider: "codex",
                            mode: "chat",
                            native_id: None,
                            operation_id: "delegate-child",
                        })
                        .unwrap();
                    db.transaction(|tx| {
                        tx.execute(
                            "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,prompt,operation_id,state,created_at,updated_at) VALUES ('delegation',?,?,'codex','shared',?,'prompt','delegate','starting','now','now')",
                            params![session.id, child.id, root.path().to_string_lossy()],
                        )?;
                        Ok(())
                    })
                    .unwrap();
                }
                "degraded" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO metadata(key,value) VALUES (?, 'projection failed')",
                            [format!("chat.integrity:{}", session.id)],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "repair-backup" => db
                    .transaction(|tx| {
                        tx.execute(
                            "INSERT INTO chat_repair_backups(session_id,created_at,items_json) VALUES (?,'now','[]')",
                            [&session.id],
                        )?;
                        Ok(())
                    })
                    .unwrap(),
                "repair-request" => db
                    .bind_operation(
                        "repair",
                        "chat.repair",
                        &json!({"sessionId":session.id}),
                    )
                    .unwrap(),
                "claimed-chat-action" => {
                    db.bind_operation(
                        "send",
                        "chat.send",
                        &json!({"sessionId":session.id,"text":"lost intent"}),
                    )
                    .unwrap();
                    assert!(db.claim_external_operation("send").unwrap());
                }
                _ => unreachable!(),
            }
            assert!(!db
                .empty_chat_native_recovery_eligible(&session.id, "missing-native")
                .unwrap(),
                "evidence {evidence}"
            );
            assert!(!db
                .replace_empty_chat_native_id(&session.id, "missing-native", "fresh-native")
                .unwrap(),
                "atomic recheck {evidence}"
            );
            assert_eq!(
                db.session_by_id(&session.id)
                    .unwrap()
                    .unwrap()
                    .native_id
                    .as_deref(),
                Some("missing-native"),
                "identity {evidence}"
            );
        }
    }
}


/// Canonical eval authority read while the broker holds its transition lock.
/// Callers must use the supplied transaction and never reenter Database here.
pub(crate) struct BrowserEvalContext {
    pub project_id: Option<String>,
    pub worktree_path: Option<String>,
    pub settings_revision: i64,
    pub enabled: bool,
}

pub(crate) fn browser_eval_context_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    turn_id: &str,
    lease: Option<(&str, i64)>,
) -> Result<BrowserEvalContext> {
    type EvalSessionRow = (
        Option<String>,
        Option<String>,
        String,
        bool,
        String,
        String,
        bool,
    );
    let row: Option<EvalSessionRow> = tx
        .query_row(
            "SELECT s.project_id,s.worktree_path,s.mode,s.read_only,s.provider,s.status,
         EXISTS(SELECT 1 FROM delegations d WHERE d.child_session_id=s.id)
         FROM sessions s WHERE s.id=?",
            [session_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let (project_id, worktree_path, mode, read_only, provider, status, child) =
        row.ok_or_else(|| anyhow!("browser_unauthorized"))?;
    if mode != "chat" || read_only || child || matches!(provider.as_str(), "opencode" | "pi") {
        return Err(anyhow!("browser_unauthorized"));
    }
    let review_schema: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_reviews')",
        [],
        |row| row.get(0),
    )?;
    if review_schema
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_reviews WHERE reviewer_session_id=?)",
            [session_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(anyhow!("browser_unauthorized"));
    }
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_activity WHERE session_id=? AND turn_id=? AND state IN ('running','awaiting_approval'))",
        params![session_id, turn_id], |row| row.get(0),
    )?;
    if turn_id.is_empty()
        || !active
        || matches!(status.as_str(), "exited" | "interrupted" | "error")
    {
        return Err(anyhow!("browser_turn_inactive"));
    }
    if let Some((principal, epoch)) = lease {
        let owner: Option<(String, i64, String)> = tx
            .query_row(
                "SELECT client_id,epoch,expires_at FROM leases WHERE session_id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (holder, current, expires) = owner.ok_or_else(|| anyhow!("lease_missing"))?;
        if epoch < 1
            || holder != principal
            || current != epoch
            || chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc) <= Utc::now()
        {
            return Err(anyhow!("stale_lease"));
        }
    }
    let (settings_revision, raw): (i64, String) = tx.query_row(
        "SELECT revision,value FROM settings WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let settings: Value = serde_json::from_str(&raw)?;
    Ok(BrowserEvalContext {
        project_id,
        worktree_path,
        settings_revision,
        enabled: settings.get("browserEvalEnabled").and_then(Value::as_bool) == Some(true),
    })
}

#[cfg(test)]
mod browser_eval_context_tests {
    use super::*;

    #[test]
    fn eval_history_receipt_rebinds_only_redacted_managed_metadata() {
        let source: ChatItem = serde_json::from_value(json!({
            "id":"native-item", "role":"assistant", "turnId":"native-turn", "createdAt":"now",
            "parts":[
                {"type":"tool","data":{"server":"threadterm","tool":"browser_eval","resultRedacted":true,"browserActivity":{"callerSessionId":"old","outcome":"failed"}}},
                {"type":"tool","data":{"server":"foreign","tool":"browser_eval","resultRedacted":true,"browserActivity":{"callerSessionId":"foreign"}}},
                {"type":"tool","data":{"server":"threadterm","tool":"browser_eval","browserActivity":{"callerSessionId":"unredacted"}}}
            ]
        })).unwrap();
        let target = scoped_history_item("target", &source);
        assert_eq!(target.parts[0]["data"]["browserActivity"]["callerSessionId"], "target");
        assert_eq!(target.parts[1], source.parts[1]);
        assert_eq!(target.parts[2], source.parts[2]);
        assert_eq!(source.parts[0]["data"]["browserActivity"]["callerSessionId"], "old");
        assert_eq!(target.turn_id.as_deref(), Some("target:history:native-turn"));
        assert_eq!(target.turn_origin, Some(ChatTurnOrigin::History));
        assert!(!crate::browser_tools::TOOL_NAMES.contains(&"browser_eval"));
    }

    fn fixture() -> (tempfile::TempDir, Database) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("eval.sqlite")).unwrap();
        crate::agent_review::initialize(&db).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO projects(id,name,path,created_at) VALUES('project','Project',?,'t')",[root.path().to_string_lossy().to_string()])?;
            for session in ["s","parent"] {
                tx.execute("INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES(?,'project',?,'codex','chat','running','t','t')",params![session,session])?;
            }
            tx.execute("INSERT INTO session_activity(session_id,state,revision,turn_id) VALUES('s','running',1,'turn')",[])?;
            Ok(())
        }).unwrap();
        (root, db)
    }
    fn summary(id: &str) -> Value {
        json!({"approvalId":id,"part":{"type":"approval","approvalId":id,"status":"pending","data":{
            "runtimeOwned":true,"requestType":"threadterm.browser_eval","approvalId":id,
            "operationId":format!("operation-{id}"),"callerSessionId":"s","tabId":"tab",
            "origin":"https://example.test","codeHash":"a".repeat(64),"codeByteLength":12,
            "expiresAtUnixMs":1_900_000_000_000u64,"settingsGeneration":"epoch:1",
            "choices":[{"id":"approve_once","label":"Approve once"},{"id":"deny","label":"Deny"}]
        }}})
    }

    #[test]
    fn canonical_eval_context_fences_lease_turn_and_settings_revision() {
        let (_root, db) = fixture();
        let initial = db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", None))
            .unwrap();
        assert!(!initial.enabled);
        assert_eq!(initial.settings_revision, 0);
        assert_eq!(initial.project_id.as_deref(), Some("project"));
        db.put_lease(
            "s",
            "desktop",
            7,
            &(Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
        )
        .unwrap();
        assert!(db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", Some(("desktop", 7))))
            .is_ok());
        for lease in [("foreign", 7), ("desktop", 6)] {
            assert!(db
                .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", Some(lease)))
                .is_err());
        }
        db.put_lease(
            "s",
            "desktop",
            7,
            &(Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
        )
        .unwrap();
        assert!(db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", Some(("desktop", 7))))
            .is_err());
        db.update_settings(&json!({"browserEvalEnabled":true}), 0, "enable")
            .unwrap();
        let enabled = db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", None))
            .unwrap();
        assert!(enabled.enabled);
        assert_eq!(enabled.settings_revision, 1);
        db.update_settings(&json!({"browserEvalEnabled":false}), 1, "disable")
            .unwrap();
        let disabled = db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", None))
            .unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.settings_revision, 2);
        assert!(db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "old-turn", None))
            .is_err());
        db.transaction(|tx| {
            tx.execute("UPDATE sessions SET read_only=1 WHERE id='s'", [])?;
            Ok(())
        })
        .unwrap();
        assert!(db
            .transaction(|tx| browser_eval_context_tx(tx, "s", "turn", None))
            .is_err());
    }

    #[test]
    fn eval_context_rejects_reviewer_child_and_unsupported_provider() {
        for variant in ["reviewer", "child", "opencode", "pi", "terminal", "exited"] {
            let (root, db) = fixture();
            db.transaction(|tx| {
                match variant {
                    "reviewer" => {tx.execute("INSERT INTO agent_reviews(id,session_id,reviewer_session_id,agent,scope_json,root,state,files,truncated_json,instructions,created_at,updated_at) VALUES('review','parent','s','codex','{}',?,'running',0,'[]','Review','t','t')",[root.path().to_string_lossy().to_string()])?;},
                    "child" => {tx.execute("INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,prompt,operation_id,state,created_at,updated_at) VALUES('delegate','parent','s','codex','existing',?,'Task','delegate-op','running','t','t')",[root.path().to_string_lossy().to_string()])?;},
                    "terminal" => {tx.execute("UPDATE sessions SET mode='terminal' WHERE id='s'",[])?;},
                    "exited" => {tx.execute("UPDATE sessions SET status='exited' WHERE id='s'",[])?;},
                    provider => {tx.execute("UPDATE sessions SET provider=? WHERE id='s'",[provider])?;},
                }
                Ok(())
            }).unwrap();
            assert!(
                db.transaction(|tx| browser_eval_context_tx(tx, "s", "turn", None))
                    .is_err(),
                "{variant}"
            );
        }
    }

    #[test]
    fn eval_projection_preserves_siblings_decisions_and_expired_history_without_private_payloads() {
        let (_root, db) = fixture();
        db.update_settings(&json!({"browserEvalEnabled":true}), 0, "enable")
            .unwrap();
        for id in ["a", "b"] {
            assert!(db
                .transaction(|tx| crate::chat_projection::publish_browser_eval_tx(
                    tx,
                    "s",
                    "turn",
                    &summary(id)
                ))
                .unwrap());
        }
        assert_eq!(
            db.session_by_id("s")
                .unwrap()
                .unwrap()
                .activity
                .unwrap()
                .state,
            "awaiting_approval"
        );
        db.transaction(|tx| {
            crate::chat_projection::resolve_browser_eval_tx(tx, "s", "turn", "a", "approved")
        })
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
        db.transaction(|tx| {
            crate::chat_projection::resolve_browser_eval_tx(tx, "s", "turn", "a", "denied")
        })
        .unwrap();
        let a = db
            .chat_items("s")
            .unwrap()
            .into_iter()
            .find(|item| item.id == "s:approval:a")
            .unwrap();
        assert_eq!(a.parts[0]["data"]["outcome"], "approved");
        db.transaction(|tx| {
            crate::chat_projection::resolve_browser_eval_tx(tx, "s", "turn", "b", "denied")
        })
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
        for key in ["code", "result", "exception"] {
            let mut private = summary("private");
            private["part"]["data"][key] = json!("PRIVATE_PAYLOAD");
            assert!(db
                .transaction(|tx| crate::chat_projection::publish_browser_eval_tx(
                    tx, "s", "turn", &private
                ))
                .is_err());
        }
        assert!(!db
            .transaction(|tx| crate::chat_projection::publish_browser_eval_tx(
                tx,
                "s",
                "old-turn",
                &summary("stale")
            ))
            .unwrap());
        assert!(db
            .transaction(|tx| crate::chat_projection::publish_browser_eval_tx(
                tx,
                "s",
                "turn",
                &summary("expired")
            ))
            .unwrap());
        assert!(db.transaction(|tx| crate::chat_projection::publish_browser_eval_tx(
            tx, "s", "turn", &summary("cancelled")
        )).unwrap());
        db.transaction(|tx| {
            tx.execute(
                "UPDATE session_activity SET state='idle',turn_id='next' WHERE session_id='s'",
                [],
            )?;
            tx.execute("UPDATE sessions SET status='idle' WHERE id='s'", [])?;
            Ok(())
        })
        .unwrap();
        db.transaction(|tx| {
            crate::chat_projection::resolve_browser_eval_tx(tx, "s", "turn", "expired", "expired")
        })
        .unwrap();
        db.transaction(|tx| {
            crate::chat_projection::resolve_browser_eval_tx(tx, "s", "turn", "cancelled", "cancelled")
        }).unwrap();
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "idle");
        let cancelled = db.chat_items("s").unwrap().into_iter()
            .find(|item| item.id == "s:approval:cancelled").unwrap();
        assert_eq!(cancelled.parts[0]["status"], "expired");
        assert_eq!(cancelled.parts[0]["data"]["outcome"], "cancelled");
        let activity = db.session_by_id("s").unwrap().unwrap().activity.unwrap();
        assert_eq!(activity.state, "idle");
        assert_eq!(activity.turn_id.as_deref(), Some("next"));
        let expired = db
            .chat_items("s")
            .unwrap()
            .into_iter()
            .find(|item| item.id == "s:approval:expired")
            .unwrap();
        assert_eq!(expired.parts[0]["status"], "expired");
        let history = serde_json::to_string(&db.chat_items("s").unwrap()).unwrap();
        assert!(!history.contains("PRIVATE_PAYLOAD"));
        let outbox = db
            .transaction(|tx| {
                let mut query = tx.prepare("SELECT data FROM outbox")?;
                let rows = query
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("\n");
                Ok(rows)
            })
            .unwrap();
        assert!(!outbox.contains("PRIVATE_PAYLOAD"));
    }
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod schema_tests;
