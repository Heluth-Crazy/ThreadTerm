//! Runtime-owned state for ThreadTerm's app-hosted Chat tools.
//!
//! Tool processes receive an opaque token for one provider worker generation.
//! The model cannot choose the caller identity. Ask calls wait on a condition
//! variable and are settled by the existing Chat question lifecycle, without
//! polling or holding a SQLite/provider lock while the user decides.

use crate::{db::Database, providers::Providers};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
};

const MAX_QUESTIONS: usize = 4;
const MAX_OPTIONS: usize = 6;
const MAX_ASK_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_ITEMS: usize = 20;
const MAX_TRANSCRIPT_BYTES: usize = 16 * 1024;
const MAX_FEEDBACK_PER_TURN: i64 = 20;
const MAX_FEEDBACK_CHARS: usize = 4_000;
const MAX_FEEDBACK_READ: i64 = MAX_FEEDBACK_PER_TURN * 2;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS chat_feedback_notes (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting','received')),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_feedback_session_turn
 ON chat_feedback_notes(session_id,turn_id,created_at,id);";

#[derive(Clone)]
struct Grant {
    token: String,
    generation: String,
    ask: bool,
    session_info: bool,
    feedback: bool,
}

#[derive(Clone, Copy)]
enum Capability {
    Ask,
    SessionInfo,
    Feedback,
}

#[derive(Clone)]
struct AnswerKey {
    id: String,
    question: String,
    multi_select: bool,
}

struct PendingAsk {
    session_id: String,
    turn_id: String,
    approval_id: String,
    data: Value,
    answers: Vec<AnswerKey>,
    outcome: Mutex<Option<Value>>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    grants: HashMap<String, Grant>,
    pending: HashMap<String, Arc<PendingAsk>>,
}

pub(crate) struct ChatTools {
    db: Arc<Database>,
    state: Mutex<State>,
    #[cfg(test)]
    authorization_pause: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
    #[cfg(test)]
    ask_publication_pause: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
}

pub(crate) struct AskWaiter(Arc<PendingAsk>);

impl std::fmt::Debug for AskWaiter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("AskWaiter")
            .field(&self.0.approval_id)
            .finish()
    }
}

/// One registry per open runtime database, without extending `RuntimeService`
/// struct literals used by adapter fixtures. Production keeps a strong owner
/// in the installed resolver; dead test/runtime registries are pruned here.
pub(crate) fn shared(path: &Path, db: Arc<Database>) -> Result<Arc<ChatTools>> {
    static REGISTRIES: OnceLock<Mutex<HashMap<PathBuf, Weak<ChatTools>>>> = OnceLock::new();
    let mut registries = REGISTRIES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow!("chat_tools_registry_poisoned"))?;
    registries.retain(|_, registry| registry.strong_count() > 0);
    if let Some(registry) = registries.get(path).and_then(Weak::upgrade) {
        return Ok(registry);
    }
    let registry = Arc::new(ChatTools::new(db)?);
    registries.insert(path.to_owned(), Arc::downgrade(&registry));
    Ok(registry)
}

impl ChatTools {
    fn new(db: Arc<Database>) -> Result<Self> {
        db.transaction(|tx| Ok(tx.execute_batch(SCHEMA)?))?;
        let tools = Self {
            db,
            state: Mutex::new(State::default()),
            #[cfg(test)]
            authorization_pause: Mutex::new(None),
            #[cfg(test)]
            ask_publication_pause: Mutex::new(None),
        };
        tools.expire_orphaned_asks()?;
        Ok(tools)
    }

    /// Issue authority for exactly one provider worker generation. Reconnect
    /// rotates both values and settles any waiter owned by the prior process.
    pub(crate) fn issue(
        &self,
        session_id: &str,
        generation: String,
        ask: bool,
        session_info: bool,
        feedback: bool,
    ) -> Result<String> {
        if session_id.is_empty() || generation.is_empty() {
            return Err(anyhow!("chat_tool_invalid_grant"));
        }
        self.cancel_session(session_id, false)?;
        let token = uuid::Uuid::new_v4().to_string();
        self.state
            .lock()
            .map_err(|_| anyhow!("chat_tools_state_poisoned"))?
            .grants
            .insert(
                session_id.to_owned(),
                Grant {
                    token: token.clone(),
                    generation,
                    ask,
                    session_info,
                    feedback,
                },
            );
        Ok(token)
    }

    pub(crate) fn dispatch(
        &self,
        providers: &Providers,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        match method {
            "chat.tool.ask" => self.ask(providers, parse(params)?),
            "chat.tool.sessionInfo" => self.session_info(providers, parse(params)?),
            "chat.tool.feedback" => self.feedback_check(providers, parse(params)?),
            _ => Err(anyhow!("unknown_method")),
        }
    }

    fn with_authorized<T>(
        &self,
        providers: &Providers,
        session_id: &str,
        token: &str,
        capability: Capability,
        action: impl FnOnce(&mut State) -> Result<T>,
    ) -> Result<T> {
        let grant = self
            .state
            .lock()
            .map_err(|_| anyhow!("chat_tools_state_poisoned"))?
            .grants
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("chat_tool_unauthorized"))?;
        use subtle::ConstantTimeEq;
        if token.as_bytes().ct_eq(grant.token.as_bytes()).unwrap_u8() != 1 {
            return Err(anyhow!("chat_tool_unauthorized"));
        }
        let allowed = match capability {
            Capability::Ask => grant.ask,
            Capability::SessionInfo => grant.session_info,
            Capability::Feedback => grant.feedback,
        };
        if !allowed {
            return Err(anyhow!("chat_tool_disabled"));
        }
        #[cfg(test)]
        if let Some((reached, resume)) = self
            .authorization_pause
            .lock()
            .map_err(|_| anyhow!("chat_tools_test_pause_poisoned"))?
            .take()
        {
            reached.wait();
            resume.wait();
        }
        providers
            .with_current_preview_generation(session_id, &grant.generation, || {
                // Recheck after acquiring the provider registry fence. A
                // reconnect follows the same provider -> grant -> DB order,
                // so this grant remains current through the short action.
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| anyhow!("chat_tools_state_poisoned"))?;
                let current = state
                    .grants
                    .get(session_id)
                    .ok_or_else(|| anyhow!("chat_tool_unauthorized"))?;
                if token.as_bytes().ct_eq(current.token.as_bytes()).unwrap_u8() != 1
                    || current.generation != grant.generation
                {
                    return Err(anyhow!("chat_tool_stale_generation"));
                }
                action(&mut state)
            })
            .ok_or_else(|| anyhow!("chat_tool_stale_generation"))?
    }

    #[cfg(test)]
    pub(crate) fn pause_next_authorization(
        &self,
        reached: Arc<std::sync::Barrier>,
        resume: Arc<std::sync::Barrier>,
    ) {
        *self.authorization_pause.lock().unwrap() = Some((reached, resume));
    }

    #[cfg(test)]
    pub(crate) fn pause_next_ask_publication(
        &self,
        reached: Arc<std::sync::Barrier>,
        resume: Arc<std::sync::Barrier>,
    ) {
        *self.ask_publication_pause.lock().unwrap() = Some((reached, resume));
    }

    fn ask(&self, providers: &Providers, request: AskRequest) -> Result<Value> {
        self.prepare_ask_value(providers, request)?.wait()
    }

    pub(crate) fn prepare_ask(&self, providers: &Providers, params: &Value) -> Result<AskWaiter> {
        self.prepare_ask_value(providers, parse(params)?)
    }

    fn prepare_ask_value(&self, providers: &Providers, request: AskRequest) -> Result<AskWaiter> {
        self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Ask,
            |state| {
                validate_questions(&request.questions)?;
                let session = self
                    .db
                    .session_by_id(&request.caller_session_id)?
                    .ok_or_else(|| anyhow!("session_not_found"))?;
                let turn_id = session
                    .activity
                    .filter(|activity| activity.state == "running")
                    .and_then(|activity| activity.turn_id)
                    .ok_or_else(|| anyhow!("chat_turn_inactive"))?;
                let approval_id = format!("threadterm-ask-{}", uuid::Uuid::new_v4());
                let (data, answers) = question_data(&approval_id, request.questions);
                let pending = Arc::new(PendingAsk {
                    session_id: request.caller_session_id.clone(),
                    turn_id: turn_id.clone(),
                    approval_id: approval_id.clone(),
                    data: data.clone(),
                    answers,
                    outcome: Mutex::new(None),
                    changed: Condvar::new(),
                });
                #[cfg(test)]
                if let Some((reached, resume)) = self.ask_publication_pause.lock().unwrap().take() {
                    reached.wait();
                    resume.wait();
                }
                state
                    .pending
                    .insert(approval_id.clone(), Arc::clone(&pending));
                let published = match crate::chat_projection::record_if_active(
                    &self.db,
                    &request.caller_session_id,
                    &turn_id,
                    "chat.approval",
                    &json!({
                        "approvalId":approval_id,
                        "part":{"type":"approval","approvalId":approval_id,"data":data}
                    }),
                ) {
                    Ok(published) => published,
                    Err(error) => {
                        state.pending.remove(&approval_id);
                        return Err(error);
                    }
                };
                if !published {
                    state.pending.remove(&approval_id);
                    return Err(anyhow!("chat_turn_inactive"));
                }
                Ok(AskWaiter(pending))
            },
        )
    }

    /// Settle an app-owned question. False leaves the native provider answer
    /// path unchanged. Matching is exact across session, turn and approval.
    pub(crate) fn answer(
        &self,
        session_id: &str,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: Option<&str>,
    ) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("chat_tools_state_poisoned"))?;
        let Some(pending) = state.pending.get(approval_id).cloned() else {
            return Ok(false);
        };
        if pending.session_id != session_id || pending.turn_id != turn_id {
            return Ok(false);
        }
        if let Some(operation_id) = operation_id {
            if !self.db.claim_external_operation(operation_id)? {
                return Err(anyhow!("operation_outcome_unknown"));
            }
        }
        let (status, result) = if response.get("action").and_then(Value::as_str) == Some("dismiss")
        {
            (
                "dismissed",
                json!({"dismissed":true,"note":"The user dismissed the question; use your own judgment."}),
            )
        } else {
            ("answered", pending.answer_result(response)?)
        };
        self.db.record_provider_event(
            session_id,
            Some(turn_id),
            "chat.approval.resolved",
            &json!({
                "approvalId":approval_id,
                "status":status,
                "outcome":"submitted",
                "answerSummary":crate::chat_questions::answer_summary(&pending.data,response),
            }),
        )?;
        state.pending.remove(approval_id);
        pending.set_outcome(result);
        Ok(true)
    }

    pub(crate) fn cancel_turn(&self, session_id: &str, turn_id: &str) -> Result<()> {
        self.cancel_matching(|pending| {
            pending.session_id == session_id && pending.turn_id == turn_id
        })
    }

    /// `revoke=true` is used for close/EOF. Generation replacement calls this
    /// before installing the next grant, so an old process cannot authenticate.
    pub(crate) fn revoke_session(&self, session_id: &str) -> Result<()> {
        self.cancel_session(session_id, true)?;
        self.clear_waiting_feedback(session_id, None)
    }

    pub(crate) fn revoke_all(&self) -> Result<()> {
        let sessions = {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("chat_tools_state_poisoned"))?;
            state
                .grants
                .keys()
                .chain(state.pending.values().map(|pending| &pending.session_id))
                .cloned()
                .collect::<HashSet<_>>()
        };
        for session in sessions {
            self.revoke_session(&session)?;
        }
        Ok(())
    }

    fn cancel_session(&self, session_id: &str, revoke: bool) -> Result<()> {
        if revoke {
            self.state
                .lock()
                .map_err(|_| anyhow!("chat_tools_state_poisoned"))?
                .grants
                .remove(session_id);
        }
        self.cancel_matching(|pending| pending.session_id == session_id)
    }

    fn cancel_matching(&self, matches: impl Fn(&PendingAsk) -> bool) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("chat_tools_state_poisoned"))?;
        let ids = state
            .pending
            .iter()
            .filter(|(_, pending)| matches(pending))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let Some(pending) = state.pending.get(&id).cloned() else {
                continue;
            };
            self.db.record_provider_event(
                &pending.session_id,
                Some(&pending.turn_id),
                "chat.approval.resolved",
                &json!({
                    "approvalId":pending.approval_id,
                    "status":"expired",
                    "outcome":"cancelled",
                    "message":"Request cancelled",
                }),
            )?;
            state.pending.remove(&id);
            pending.set_outcome(json!({"cancelled":true}));
        }
        Ok(())
    }

    fn expire_orphaned_asks(&self) -> Result<()> {
        let sessions = self.db.snapshot()?.sessions;
        for session in sessions {
            for item in self.db.chat_items(&session.id)? {
                for part in item.parts {
                    if part["type"] == "approval"
                        && part["status"] == "pending"
                        && part.pointer("/data/threadtermTool").and_then(Value::as_str)
                            == Some("ask_user")
                    {
                        if let (Some(turn_id), Some(approval_id)) =
                            (item.turn_id.as_deref(), part["approvalId"].as_str())
                        {
                            self.db.record_provider_event(
                                &session.id,
                                Some(turn_id),
                                "chat.approval.resolved",
                                &json!({
                                    "approvalId":approval_id,
                                    "status":"expired",
                                    "outcome":"cancelled",
                                    "message":"Runtime restarted",
                                }),
                            )?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn session_info(&self, providers: &Providers, request: SessionInfoRequest) -> Result<Value> {
        let (session, cwd, input_tokens, output_tokens, items, branch) = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::SessionInfo,
            |_| {
                let target = normalize_session_reference(&request.session);
                let session = self
                    .db
                    .session_by_id(target)?
                    .ok_or_else(|| anyhow!("session_not_found"))?;
                if let Some(delegation) = &session.delegation {
                    if session.id != request.caller_session_id
                        && delegation.parent_session_id != request.caller_session_id
                    {
                        return Err(anyhow!("session_info_scope_denied"));
                    }
                }
                let cwd = crate::session_configs::read(&self.db, &session.id)?
                    .map(|config| config.launch.cwd)
                    .or_else(|| session.worktree_path.clone());
                let (input_tokens, output_tokens): (i64, i64) = self.db.transaction(|tx| {
                    Ok(tx.query_row(
                        "SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0) FROM usage_records WHERE session_id=?",
                        [&session.id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?)
                })?;
                let items: Vec<crate::domain::ChatItem> = self.db.transaction(|tx| {
                    let mut statement = tx.prepare(
                        "SELECT data FROM (
                            SELECT data,created_at,id FROM chat_items
                            WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT ?
                         ) ORDER BY created_at,id",
                    )?;
                    let items = statement
                        .query_map(params![session.id, MAX_TRANSCRIPT_ITEMS as i64], |row| {
                            row.get::<_, String>(0)
                        })?
                        .map(|row| Ok(serde_json::from_str(&row?)?))
                        .collect();
                    items
                })?;
                let branch = session
                    .delegation
                    .as_ref()
                    .and_then(|delegation| delegation.branch.clone())
                    .or_else(|| {
                        session.worktree_path.as_deref().and_then(|path| {
                            self.db
                                .transaction(|tx| {
                                    Ok(tx
                                        .query_row(
                                            "SELECT branch FROM worktrees WHERE path=?",
                                            [path],
                                            |row| row.get::<_, Option<String>>(0),
                                        )
                                        .optional()?
                                        .flatten())
                                })
                                .ok()
                                .flatten()
                        })
                    });
                Ok((session, cwd, input_tokens, output_tokens, items, branch))
            },
        )?;
        // Rendering and truncation can walk user/tool text. Do that after the
        // short provider-generation fence; the bounded DB snapshot above is
        // the authorization linearization point.
        let rendered = items
            .iter()
            .map(render_item)
            .collect::<Vec<_>>()
            .join("\n\n");
        let (transcript, truncated) = cap_transcript(rendered);
        let mut result = json!({
            "id":session.id,
            "title":session.title,
            "provider":session.provider,
            "status":session.status,
            "createdAt":session.created_at,
            "updatedAt":session.updated_at,
            "tokenTotals":{"input":input_tokens,"output":output_tokens,"total":input_tokens.saturating_add(output_tokens)},
            "transcript":transcript,
            "truncated":truncated,
        });
        if let Some(cwd) = cwd {
            result["cwd"] = json!(cwd);
        }
        if let Some(branch) = branch {
            result["branch"] = json!(branch);
        }
        if let Some(activity) = session.activity {
            result["activity"] = serde_json::to_value(activity)?;
        }
        Ok(result)
    }

    fn feedback_check(&self, providers: &Providers, request: ToolCaller) -> Result<Value> {
        self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Feedback,
            |_| {
                let session = self
                    .db
                    .session_by_id(&request.caller_session_id)?
                    .ok_or_else(|| anyhow!("session_not_found"))?;
                let Some(turn_id) = session
                    .activity
                    .filter(|activity| activity.state == "running")
                    .and_then(|activity| activity.turn_id)
                else {
                    return Ok(json!({"notes":[]}));
                };
                self.db.transaction(|tx| {
                    let mut statement = tx.prepare(
                        "SELECT id,session_id,turn_id,text,status,created_at FROM chat_feedback_notes WHERE session_id=? AND turn_id=? AND status='waiting' ORDER BY created_at,id",
                    )?;
                    let notes = statement
                        .query_map(params![request.caller_session_id, turn_id], note_row)?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    if notes.is_empty() {
                        return Ok(json!({"notes":[]}));
                    }
                    tx.execute(
                        "UPDATE chat_feedback_notes SET status='received' WHERE session_id=? AND turn_id=? AND status='waiting'",
                        params![request.caller_session_id, turn_id],
                    )?;
                    let received = notes
                        .into_iter()
                        .map(|mut note| {
                            note.status = "received".into();
                            note
                        })
                        .collect::<Vec<_>>();
                    emit_feedback(tx, &request.caller_session_id, &received)?;
                    Ok(json!({"notes":received}))
                })
            },
        )
    }

    pub(crate) fn feedback_add(&self, request: FeedbackAdd) -> Result<Value> {
        validate_feedback_add(&request)?;
        self.db.transaction(|tx| {
            let existing: Option<(String, String)> = tx
                .query_row(
                    "SELECT method,result FROM operations WHERE id=?",
                    [&request.operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((method, existing)) = existing {
                if method != "chat.feedback.add" {
                    return Err(anyhow!("operation_conflict"));
                }
                return Ok(serde_json::from_str(&existing)?);
            }
            let session_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND mode='chat')",
                [&request.session_id],
                |row| row.get(0),
            )?;
            if !session_exists {
                return Err(anyhow!("session_not_found"));
            }
            let current_activity: Option<(String, String)> = tx
                .query_row(
                    "SELECT state,turn_id FROM session_activity WHERE session_id=? AND turn_id IS NOT NULL",
                    [&request.session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if !current_activity.as_ref().is_some_and(|(state, turn)| {
                turn == &request.turn_id
                    && matches!(
                        state.as_str(),
                        "running" | "awaiting_approval" | "awaiting_parent"
                    )
            }) {
                return Err(anyhow!("feedback_turn_inactive"));
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM chat_feedback_notes WHERE session_id=? AND turn_id=?",
                params![request.session_id, request.turn_id],
                |row| row.get(0),
            )?;
            if count >= MAX_FEEDBACK_PER_TURN {
                return Err(anyhow!("feedback_turn_capacity"));
            }
            let note = FeedbackNote {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: request.session_id.clone(),
                turn_id: request.turn_id.clone(),
                text: request.text.clone(),
                status: "waiting".into(),
                created_at: Utc::now().to_rfc3339(),
            };
            tx.execute(
                "INSERT INTO chat_feedback_notes(id,session_id,turn_id,operation_id,text,status,created_at) VALUES(?,?,?,?,?,'waiting',?)",
                params![note.id, note.session_id, note.turn_id, request.operation_id, note.text, note.created_at],
            )?;
            // The UI only presents the current and previous note-bearing
            // turns. Retain those two bounded groups (20 each) and remove
            // older rows, including unread rows that can no longer surface.
            let retained_turns = {
                let mut statement = tx.prepare(
                    "SELECT turn_id FROM chat_feedback_notes WHERE session_id=? GROUP BY turn_id ORDER BY MAX(created_at) DESC LIMIT 2",
                )?;
                let turns = statement
                    .query_map([&request.session_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                turns
            };
            let removed = feedback_ids_outside_turns(tx, &request.session_id, &retained_turns)?;
            for id in &removed {
                tx.execute("DELETE FROM chat_feedback_notes WHERE id=?", [id])?;
            }
            let result = json!({"note":note});
            tx.execute(
                "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
                params![request.operation_id, "chat.feedback.add", serde_json::to_string(&result)?, Utc::now().to_rfc3339()],
            )?;
            emit_feedback_change(tx, &request.session_id, std::slice::from_ref(&note), &removed)?;
            Ok(result)
        })
    }

    pub(crate) fn feedback_read(&self, session_id: &str) -> Result<Value> {
        if session_id.is_empty() || self.db.session_by_id(session_id)?.is_none() {
            return Err(anyhow!("session_not_found"));
        }
        self.db.transaction(|tx| {
            let mut statement = tx.prepare(
                "SELECT id,session_id,turn_id,text,status,created_at FROM (SELECT id,session_id,turn_id,text,status,created_at FROM chat_feedback_notes WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT ?) ORDER BY created_at,id",
            )?;
            let notes = statement
                .query_map(params![session_id, MAX_FEEDBACK_READ], note_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"notes":notes}))
        })
    }

    /// E2: the user sent unread notes as a message, so retire exactly those
    /// rows. Scoped to the session, and only rows still `waiting` are removed.
    pub(crate) fn feedback_dismiss(&self, request: FeedbackDismiss) -> Result<Value> {
        if request.session_id.is_empty() || request.note_ids.is_empty() || request.note_ids.len() > MAX_FEEDBACK_READ as usize {
            return Err(anyhow!("invalid_feedback"));
        }
        if self.db.session_by_id(&request.session_id)?.is_none() {
            return Err(anyhow!("session_not_found"));
        }
        self.db.transaction(|tx| {
            let mut removed = Vec::new();
            for id in &request.note_ids {
                let changed = tx.execute(
                    "DELETE FROM chat_feedback_notes WHERE id=? AND session_id=? AND status='waiting'",
                    params![id, request.session_id],
                )?;
                if changed > 0 {
                    removed.push(id.clone());
                }
            }
            if !removed.is_empty() {
                emit_feedback_change(tx, &request.session_id, &[], &removed)?;
            }
            Ok(json!({"removed":removed}))
        })
    }

    /// Explicit turn cancellation and session close retire undelivered notes.
    /// A normal successful completion deliberately does not call this: E2 lets
    /// the user resend those waiting notes as a regular message.
    pub(crate) fn clear_waiting_feedback(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<()> {
        self.db.transaction(|tx| {
            let sql = if turn_id.is_some() {
                "SELECT id FROM chat_feedback_notes WHERE session_id=? AND turn_id=? AND status='waiting' ORDER BY created_at,id"
            } else {
                "SELECT id FROM chat_feedback_notes WHERE session_id=? AND status='waiting' ORDER BY created_at,id"
            };
            let removed = {
                let mut statement = tx.prepare(sql)?;
                if let Some(turn_id) = turn_id {
                    statement
                        .query_map(params![session_id, turn_id], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                } else {
                    statement
                        .query_map([session_id], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                }
            };
            for id in &removed {
                tx.execute("DELETE FROM chat_feedback_notes WHERE id=?", [id])?;
            }
            if !removed.is_empty() {
                emit_feedback_change(tx, session_id, &[], &removed)?;
            }
            Ok(())
        })
    }
}

impl AskWaiter {
    pub(crate) fn wait(self) -> Result<Value> {
        let mut outcome = self
            .0
            .outcome
            .lock()
            .map_err(|_| anyhow!("chat_tool_waiter_poisoned"))?;
        while outcome.is_none() {
            outcome = self
                .0
                .changed
                .wait(outcome)
                .map_err(|_| anyhow!("chat_tool_waiter_poisoned"))?;
        }
        Ok(outcome.take().expect("ask outcome checked"))
    }
}

impl PendingAsk {
    fn answer_result(&self, response: &Value) -> Result<Value> {
        let values = response
            .get("values")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("answer_invalid"))?;
        let mut answers = Map::new();
        for key in &self.answers {
            let selected = values
                .get(&key.id)
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("answer_invalid"))?;
            if key.multi_select {
                answers.insert(key.question.clone(), Value::Array(selected.clone()));
            } else {
                answers.insert(
                    key.question.clone(),
                    selected
                        .first()
                        .cloned()
                        .ok_or_else(|| anyhow!("answer_invalid"))?,
                );
            }
        }
        Ok(json!({"answers":answers}))
    }

    fn set_outcome(&self, value: Value) {
        let Ok(mut outcome) = self.outcome.lock() else {
            return;
        };
        if outcome.is_none() {
            *outcome = Some(value);
            self.changed.notify_all();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskRequest {
    caller_session_id: String,
    caller_token: String,
    questions: Vec<Question>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Question {
    header: Option<String>,
    question: String,
    options: Vec<QuestionOption>,
    #[serde(default)]
    multi_select: bool,
    #[serde(default)]
    allow_other: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuestionOption {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInfoRequest {
    caller_session_id: String,
    caller_token: String,
    session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolCaller {
    caller_session_id: String,
    caller_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackAdd {
    pub session_id: String,
    pub turn_id: String,
    pub text: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackDismiss {
    pub session_id: String,
    pub note_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FeedbackNote {
    id: String,
    session_id: String,
    turn_id: String,
    text: String,
    status: String,
    created_at: String,
}

fn parse<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| anyhow!("invalid_request"))
}

fn validate_questions(questions: &[Question]) -> Result<()> {
    if !(1..=MAX_QUESTIONS).contains(&questions.len())
        || serde_json::to_vec(questions).map_or(true, |value| value.len() > MAX_ASK_BYTES)
    {
        return Err(anyhow!("invalid_questions"));
    }
    let mut prompts = HashSet::new();
    for question in questions {
        if question.question.trim().is_empty()
            || question.question.chars().count() > 4_000
            || question
                .header
                .as_ref()
                .is_some_and(|header| header.trim().is_empty() || header.chars().count() > 80)
            || !(2..=MAX_OPTIONS).contains(&question.options.len())
            || !prompts.insert(question.question.clone())
        {
            return Err(anyhow!("invalid_questions"));
        }
        let mut labels = HashSet::new();
        for option in &question.options {
            if option.label.trim().is_empty()
                || option.label.chars().count() > 256
                || option
                    .description
                    .as_ref()
                    .is_some_and(|description| description.chars().count() > 2_000)
                || !labels.insert(option.label.clone())
            {
                return Err(anyhow!("invalid_questions"));
            }
        }
    }
    Ok(())
}

fn question_data(approval_id: &str, questions: Vec<Question>) -> (Value, Vec<AnswerKey>) {
    let mut answer_keys = Vec::with_capacity(questions.len());
    let forms = questions
        .into_iter()
        .enumerate()
        .map(|(index, question)| {
            let id = format!("question-{}", index + 1);
            answer_keys.push(AnswerKey {
                id: id.clone(),
                question: question.question.clone(),
                multi_select: question.multi_select,
            });
            json!({
                "id":id,
                "header":question.header,
                "question":question.question,
                "options":question.options,
                "multiSelect":question.multi_select,
                "allowOther":question.allow_other,
            })
        })
        .collect::<Vec<_>>();
    (
        json!({
            "approvalId":approval_id,
            "interaction":"question",
            "answerable":true,
            "submittable":true,
            "threadtermTool":"ask_user",
            "form":{"kind":"questions","questions":forms},
        }),
        answer_keys,
    )
}

fn normalize_session_reference(reference: &str) -> &str {
    let reference = reference.trim();
    reference
        .strip_prefix("@session:")
        .or_else(|| reference.strip_prefix("session:"))
        .unwrap_or(reference)
}

fn render_item(item: &crate::domain::ChatItem) -> String {
    let mut lines = vec![format!("{}:", item.role)];
    for part in &item.parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text" | "thinking") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    lines.push(text.to_owned());
                }
            }
            Some("tool") => lines.push(format!(
                "[tool {} {}] {}",
                part.get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                part.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                part.get("data").map(Value::to_string).unwrap_or_default(),
            )),
            Some("approval") => {
                let questions = part
                    .pointer("/data/form/questions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|question| question.get("question").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("; ");
                lines.push(format!(
                    "[question {}] {}",
                    part.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    questions,
                ));
            }
            _ => lines.push(part.to_string()),
        }
    }
    lines.join("\n")
}

fn cap_transcript(transcript: String) -> (String, bool) {
    if transcript.len() <= MAX_TRANSCRIPT_BYTES {
        return (transcript, false);
    }
    const NOTE: &str = "[Earlier transcript text truncated to 16 KB.]\n";
    let budget = MAX_TRANSCRIPT_BYTES - NOTE.len();
    let mut start = transcript.len().saturating_sub(budget);
    while !transcript.is_char_boundary(start) {
        start += 1;
    }
    (format!("{NOTE}{}", &transcript[start..]), true)
}

fn validate_feedback_add(request: &FeedbackAdd) -> Result<()> {
    if request.session_id.is_empty()
        || request.turn_id.is_empty()
        || request.operation_id.is_empty()
        || request.text.trim().is_empty()
        || request.text.chars().count() > MAX_FEEDBACK_CHARS
    {
        return Err(anyhow!("invalid_feedback"));
    }
    Ok(())
}

fn note_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedbackNote> {
    Ok(FeedbackNote {
        id: row.get(0)?,
        session_id: row.get(1)?,
        turn_id: row.get(2)?,
        text: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn emit_feedback(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    notes: &[FeedbackNote],
) -> Result<()> {
    emit_feedback_change(tx, session_id, notes, &[])
}

fn emit_feedback_change(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    notes: &[FeedbackNote],
    removed_ids: &[String],
) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('chat.feedback',?,?)",
        params![
            serde_json::to_string(
                &json!({"sessionId":session_id,"notes":notes,"removedIds":removed_ids})
            )?,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn feedback_ids_outside_turns(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    retained_turns: &[String],
) -> Result<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT id,turn_id FROM chat_feedback_notes WHERE session_id=? ORDER BY created_at,id",
    )?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, turn_id)| !retained_turns.contains(turn_id))
        .map(|(id, _)| id)
        .collect())
}
