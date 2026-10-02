use crate::domain::{
    ChatItem, Project, Session, SessionDelegation, SessionOrganization, SessionOrganize, Settings,
    Snapshot,
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

pub struct Database {
    connection: Mutex<Connection>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let connection =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, worktree_path TEXT, title TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, native_id TEXT, exit_code INTEGER, followed INTEGER NOT NULL DEFAULT 0, read_only INTEGER NOT NULL DEFAULT 0);
             CREATE UNIQUE INDEX IF NOT EXISTS active_native_owner ON sessions(provider, native_id) WHERE native_id IS NOT NULL AND status NOT IN ('exited','interrupted','error');
             CREATE TABLE IF NOT EXISTS settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, sessions TEXT NOT NULL, layout TEXT NOT NULL, commands TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS usage_records (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, provider TEXT NOT NULL, recorded_at TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost REAL, currency TEXT, model TEXT);
             CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, method TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS operation_requests (id TEXT PRIMARY KEY, method TEXT NOT NULL, params TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS external_operations (id TEXT PRIMARY KEY, started_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS leases (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, client_id TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS output_chunks (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, start_cursor INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(session_id,start_cursor));
             CREATE TABLE IF NOT EXISTS deferred_codex_launches (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, phase TEXT NOT NULL, error_code TEXT, error_message TEXT, cwd TEXT);
             CREATE TABLE IF NOT EXISTS chat_items (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS chat_drafts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, text TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS session_organization (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS session_activity (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, revision INTEGER NOT NULL, turn_id TEXT, reason TEXT);
             CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
             INSERT OR IGNORE INTO settings(singleton,revision,value) VALUES (1,0,'{}');"
        )?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, worktree_path TEXT, revision INTEGER NOT NULL, layout TEXT NOT NULL, updated_at TEXT NOT NULL);")?;
        // Agent delegation: one row per delegated Chat session. Deleting either
        // session drops the link; the other session stays a normal session.
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE, agent TEXT NOT NULL, workspace TEXT NOT NULL, workspace_path TEXT NOT NULL, branch TEXT, prompt TEXT NOT NULL, operation_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parent_session_id);",
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
        Ok(Self {
            connection: Mutex::new(connection),
            path: path.to_owned(),
        })
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
            tx.execute("UPDATE sessions SET status='error',updated_at=? WHERE read_only=0 AND mode='chat' AND status IN ('starting','running','idle','waiting') AND (? IS NULL OR id=?)",params![now(),session_id,session_id])?;
            emit(tx,"runtime.degraded",json!({"area":"chat","sessionId":session_id,"reason":reason}))?;
            emit(tx,"state.changed",json!({"kind":"chat.degraded"}))
        })
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
        let presets = collect_presets(&conn)?;
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
            presets,
            inbox: collect_inbox(&conn)?,
            providers: vec![],
        })
    }
    pub fn events_after(&self, after: i64) -> Result<Vec<(i64, String, Value)>> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
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
        crate::chat_projection::record(self, session_id, turn_id, kind, data)
    }
    pub fn chat_items(&self, session_id: &str) -> Result<Vec<ChatItem>> {
        Ok(self.chat_snapshot(session_id)?.0)
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
            tx.execute("UPDATE sessions SET worktree_path=COALESCE(?,worktree_path),native_id=COALESCE(?,native_id) WHERE id=?",params![cwd,native_id,id])?;
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
        self.transaction(|tx| {
            for source in items {
                let mut item=source.clone();item.id=format!("{id}:history:{}",source.id);
                item.turn_id=None;
                let changed=tx.execute("INSERT OR IGNORE INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,NULL,'message',?,?)",params![item.id,id,serde_json::to_string(&item)?,item.created_at])?;
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
            let mut source_ids = HashSet::with_capacity(request.transcript.len());
            if request
                .transcript
                .iter()
                .any(|item| item.id.is_empty() || !source_ids.insert(item.id.as_str()))
            {
                return Err(anyhow!("invalid_history_transcript"));
            }
            let timestamp=now();
            let session=Session { id:Uuid::new_v4().to_string(), project_id:request.project_id.map(str::to_owned), worktree_path:Some(request.cwd.to_owned()), title:request.title.unwrap_or(request.provider).to_owned(), provider:request.provider.to_owned(), mode:request.mode.to_owned(), status:"idle".into(), created_at:timestamp.clone(), updated_at:timestamp, native_id:Some(request.native_id.to_owned()), exit_code:None, cols:None, rows:None, followed:false, read_only:true, activity:None, delegation:None, organization:SessionOrganization::default() };
            tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,exit_code,followed,read_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",params![session.id,session.project_id,session.worktree_path,session.title,session.provider,session.mode,session.status,session.created_at,session.updated_at,session.native_id,session.exit_code,session.followed])?;
            tx.execute(
                "INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES(?,1,?,?,?,?,?,NULL,'[]',NULL)",
                params![session.id, request.provider, request.mode, request.cwd, request.project_id, request.title],
            )?;
            for source in request.transcript {
                let mut item = source.clone();
                item.id = format!("{}:history:{}", session.id, source.id);
                item.turn_id = None;
                tx.execute(
                    "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,NULL,'message',?,?)",
                    params![item.id, session.id, serde_json::to_string(&item)?, item.created_at],
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
        self.transaction(|tx| {
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
            if mode=="terminal"&&status=="exited"&&previous!="exited" {
                let kind=match exit_code{Some(0)=>"completed",Some(_)=>"failed",None=>"interrupted"};
                tx.execute("INSERT OR IGNORE INTO inbox(id,session_id,kind,data,resolved,created_at) VALUES (?,?,?,?,1,?)",params![format!("{id}:exit"),id,kind,json!({"exitCode":exit_code}).to_string(),now()])?;
            }
            Ok(())
        })
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
            "SELECT COALESCE(MAX(start_cursor+length(data)),0) FROM output_chunks WHERE session_id=?",
            [session_id],
            |row| row.get(0),
        )?)
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
        let from = if tail {
            end.saturating_sub(max_bytes as i64).max(0)
        } else {
            cursor.unwrap_or(0)
        };
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
        let truncated = if tail { from > 0 } else { next < end };
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
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn complete<T: serde::Serialize>(
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
    let mut stmt=conn.prepare("SELECT id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,exit_code,followed,read_only,cols,rows FROM sessions ORDER BY created_at")?;
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
            organization: SessionOrganization::default(),
        })
    })?;
    let mut sessions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for session in &mut sessions {
        session.organization = session_organization(conn, &session.id)?;
        session.activity = session_activity(conn, &session.id)?;
        session.delegation = session_delegation(conn, &session.id)?;
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
    let mut stmt=conn.prepare("SELECT inbox.id,inbox.session_id,inbox.kind,sessions.title,inbox.created_at,inbox.read FROM inbox JOIN sessions ON sessions.id=inbox.session_id WHERE inbox.kind!='reply' ORDER BY inbox.created_at DESC,inbox.id")?;
    let rows=stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"sessionId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"title":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?,"read":r.get::<_,bool>(5)?})))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
fn collect_presets(conn: &Connection) -> Result<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT id,name,revision,sessions,layout,commands FROM presets ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(id, name, revision, sessions, layout, commands)| {
            Ok(json!({
                "id": id,
                "name": name,
                "revision": revision,
                "sessions": serde_json::from_str::<Value>(&sessions)?,
                "layout": serde_json::from_str::<Value>(&layout)?,
                "commands": serde_json::from_str::<Value>(&commands)?,
            }))
        })
        .collect()
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
        "SELECT id,parent_session_id,workspace,branch,state FROM delegations WHERE child_session_id=?",
        [id],
        |row| {
            Ok(SessionDelegation {
                id: row.get(0)?,
                parent_session_id: row.get(1)?,
                workspace: row.get(2)?,
                branch: row.get(3)?,
                state: row.get(4)?,
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
    let mut session = conn.query_row("SELECT id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,exit_code,followed,read_only,cols,rows FROM sessions WHERE id=?",[id],|r|Ok(Session{id:r.get(0)?,project_id:r.get(1)?,worktree_path:r.get(2)?,title:r.get(3)?,provider:r.get(4)?,mode:r.get(5)?,status:r.get(6)?,created_at:r.get(7)?,updated_at:r.get(8)?,native_id:r.get(9)?,exit_code:r.get(10)?,followed:r.get(11)?,read_only:r.get(12)?,cols:r.get(13)?,rows:r.get(14)?,activity:None,delegation:None,organization:SessionOrganization::default()}))?;
    session.organization = session_organization(conn, id)?;
    session.activity = session_activity(conn, id)?;
    session.delegation = session_delegation(conn, id)?;
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
    fn history_item(id: &str, text: &str) -> ChatItem {
        ChatItem {
            id: id.into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":text})],
            created_at: "2026-09-10T00:00:00Z".into(),
            turn_id: Some("native-turn".into()),
            elapsed_ms: None,
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
        assert_eq!(db.chat_items(&imported.id).unwrap().len(), 1);
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
}
