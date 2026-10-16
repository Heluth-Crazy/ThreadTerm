//! Session-scoped preview authority and durable, explicitly acknowledged UI operations.
//! A desktop attachment is independent of a provider-open grant. No idle polling,
//! native navigation replay, or UI wait under SQLite / the ordered control lane.
use crate::{
    config::RuntimeConfig,
    db::Database,
    providers::{ChatToolServer, Providers, ToolServerResolver},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, Weak},
    time::{Duration, Instant},
};

pub(crate) const TOOL_NAMES: [&str; 2] = ["preview_present", "preview_status"];
pub(crate) const INSTRUCTIONS: &str = "ThreadTerm preview: start your development server and verify its local HTTP(S) URL with your available tools, then call preview_present with a unique requestId. It opens a page tab beside this Chat. Identical retries reuse the operation. Inspect preview_status only after a pending result or user request; never replay uncertain navigation automatically. Presented means the UI mounted and saved the tab; load_observed is an iframe event, not application readiness or content verification.";
const MAX_REQUESTS_PER_OPEN: i64 = 256;
const MAX_ASSOCIATIONS: i64 = 128;

#[derive(Clone)]
struct Grant {
    token: String,
    generation: String,
    provider: String,
    plugin_id: String,
    binding_id: String,
}
#[derive(Clone)]
struct Attachment {
    id: String,
    principal: String,
    view_id: String,
    workspace_id: Option<String>,
}
#[derive(Default)]
struct State {
    grants: HashMap<String, Grant>,
    attachments: HashMap<String, Attachment>,
    connected: HashMap<String, usize>,
}

pub(crate) struct Previews {
    db: Arc<Database>,
    state: Mutex<State>,
    changed: Condvar,
}
pub(crate) struct Presence {
    previews: Arc<Previews>,
    principal: String,
}
impl Drop for Presence {
    fn drop(&mut self) {
        let mut state = self
            .previews
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let Some(count) = state.connected.get_mut(&self.principal) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        state.connected.remove(&self.principal);
        let sessions: Vec<_> = state
            .attachments
            .iter()
            .filter(|(_, a)| a.principal == self.principal)
            .map(|(s, _)| s.clone())
            .collect();
        for session in sessions {
            if let Some(a) = state.attachments.remove(&session) {
                let _ = self.previews.interrupt_attachment(&a.id);
            }
        }
        self.previews.changed.notify_all();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Association {
    request_id: String,
    preview_id: String,
    session_id: String,
    document_id: String,
    url: String,
    #[serde(default,skip_serializing_if="Option::is_none")] observed_url:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")] observed_title:Option<String>,
    #[serde(default)] document_generation:u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    state: String,
    sequence: u64,
    navigation: String,
    application_ready: String,
    content_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}
impl Association {
    fn result(&self) -> Value {
        let mut result = json!({"requestId":self.request_id,"previewId":self.preview_id,"state":self.state,"sequence":self.sequence,"navigation":self.navigation,"applicationReady":"unknown","contentVerified":false});
        if let Some(error) = &self.error {
            result["error"] = error.clone();
        }
        result["documentGeneration"]=json!(self.document_generation);
        if let Some(url)=&self.observed_url {result["observedUrl"]=json!(url);}
        if let Some(title)=&self.observed_title {result["observedTitle"]=json!(title);}
        result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attach {
    session_id: String,
    view_id: String,
    workspace_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    session_id: String,
    attachment_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ack {
    session_id: String,
    attachment_id: String,
    request_id: String,
    preview_id: String,
    document_id: String,
    state: String,
    tab_id: Option<String>,
    workspace_id: Option<String>,
    workspace_revision: Option<i64>,
    error: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observe {
    session_id: String,
    attachment_id: String,
    request_id: String,
    preview_id: String,
    document_id: String,
    sequence: u64,
    navigation: String,
    url: Option<String>,
    title: Option<String>,
    document_generation: Option<u64>,
    error: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Close {
    session_id: String,
    attachment_id: String,
    preview_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Prepare {session_id:String,attachment_id:String,request_id:String,preview_id:String,document_id:String}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Present {
    caller_session_id: String,
    caller_token: String,
    request_id: String,
    url: String,
    title: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Status {
    caller_session_id: String,
    caller_token: String,
    request_id: String,
}

fn id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(anyhow!("preview_invalid_request"));
    }
    Ok(())
}
fn preview_error(code: &str, message: &str, retryable: bool) -> Value {
    json!({"code":code,"message":message,"retryable":retryable})
}
fn error_payload(value: &Option<Value>) -> Result<()> {
    if let Some(v) = value {
        if !v.is_object()
            || v.as_object().unwrap().len() != 3
            || v["code"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 256)
            || v["message"].as_str().is_none_or(|s| s.len() > 2048)
            || !v["retryable"].is_boolean()
        {
            return Err(anyhow!("preview_invalid_request"));
        }
    }
    Ok(())
}
fn local_url(value: &str) -> Result<String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(anyhow!("preview_invalid_url"));
    }
    let url = reqwest::Url::parse(value).map_err(|_| anyhow!("preview_invalid_url"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
                || host == "[::1]"
        })
    {
        return Err(anyhow!("preview_invalid_url"));
    }
    Ok(url.to_string())
}

impl Previews {
    pub(crate) fn new(db: Arc<Database>) -> Result<Self> {
        db.transaction(|tx|{
            tx.execute_batch("CREATE TABLE IF NOT EXISTS preview_operations (generation TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(generation,request_id)); CREATE TABLE IF NOT EXISTS preview_associations (preview_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL);")?;
            let rows={let mut statement=tx.prepare("SELECT generation,request_id,value FROM preview_operations")?; let rows=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
            for (generation,request,raw) in rows {
                let mut a:Association=serde_json::from_str(&raw)?;
                if a.state=="accepted" {a.state="interrupted".into();a.error=Some(preview_error("runtime_restarted","Runtime restarted before presentation was acknowledged.",true));a.sequence+=1;
                    tx.execute("UPDATE preview_operations SET value=? WHERE generation=? AND request_id=?",params![serde_json::to_string(&a)?,generation,request])?;
                    tx.execute("UPDATE preview_associations SET value=? WHERE preview_id=?",params![serde_json::to_string(&a)?,a.preview_id])?;
                }
            }
            // Old generations cannot authenticate after runtime boot. Keep bounded diagnostics.
            tx.execute("DELETE FROM preview_operations WHERE rowid NOT IN (SELECT rowid FROM preview_operations ORDER BY rowid DESC LIMIT 4096)",[])?;
            Ok(())
        })?;
        Ok(Self {
            db,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        })
    }
    pub(crate) fn connect(self: &Arc<Self>, principal: &str) -> Presence {
        *self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connected
            .entry(principal.into())
            .or_default() += 1;
        Presence {
            previews: Arc::clone(self),
            principal: principal.into(),
        }
    }
    fn interrupt_attachment(&self, attachment: &str) -> Result<()> {
        self.db.transaction(|tx|{
            let rows={let mut statement=tx.prepare("SELECT generation,request_id,value FROM preview_operations WHERE attachment_id=?")?;let rows=statement.query_map([attachment],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
            for (generation,request,raw) in rows {
                let mut a:Association=serde_json::from_str(&raw)?;
                if a.state=="accepted" {a.state="interrupted".into();a.error=Some(preview_error("desktop_detached","The selected desktop detached or authority was revoked before acknowledgment.",true));a.sequence+=1;Self::save_operation(tx,&generation,&a)?;
                    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('preview.cancel',?,?)",params![json!({"sessionId":a.session_id,"attachmentId":attachment,"requestId":a.request_id,"previewId":a.preview_id,"documentId":a.document_id}).to_string(),Utc::now().to_rfc3339()])?;
                }
                let _=request;
            } Ok(())
        })
    }
    fn issue(
        &self,
        session: &str,
        generation: String,
        provider: String,
        plugin_id: String,
        binding_id: String,
    ) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .grants
            .insert(
                session.into(),
                Grant {
                    token: token.clone(),
                    generation,
                    provider,
                    plugin_id,
                    binding_id,
                },
            );
        token
    }
    fn binding_current(grant: &Grant, providers: &Providers, session: &str) -> bool {
        if providers.preview_worker_token(session).as_deref() != Some(&grant.generation) {
            return false;
        }
        providers.plugin_registry().is_some_and(|registry|registry.browser_binding_enabled(&grant.plugin_id,&grant.binding_id,&grant.provider))
    }
    fn authorize<'a>(
        &self,
        state: &'a State,
        providers: &Providers,
        session: &str,
        token: &str,
    ) -> Result<&'a Grant> {
        let grant = state
            .grants
            .get(session)
            .ok_or_else(|| anyhow!("preview_unauthorized"))?;
        use subtle::ConstantTimeEq;
        if token.as_bytes().ct_eq(grant.token.as_bytes()).unwrap_u8() != 1 {
            return Err(anyhow!("preview_unauthorized"));
        }
        if !Self::binding_current(grant, providers, session) {
            return Err(anyhow!("preview_binding_disabled_or_stale"));
        }
        Ok(grant)
    }
    fn target<'a>(
        state: &'a State,
        principal: &str,
        session: &str,
        attachment: &str,
    ) -> Result<&'a Attachment> {
        let a = state
            .attachments
            .get(session)
            .filter(|a| a.id == attachment && a.principal == principal)
            .ok_or_else(|| anyhow!("preview_stale_target"))?;
        Ok(a)
    }
    fn save_operation(
        tx: &rusqlite::Transaction<'_>,
        generation: &str,
        a: &Association,
    ) -> Result<()> {
        let raw = serde_json::to_string(a)?;
        tx.execute(
            "UPDATE preview_operations SET value=? WHERE generation=? AND request_id=?",
            params![raw, generation, a.request_id],
        )?;
        // Do not let an older operation overwrite a newer association.
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM preview_associations WHERE preview_id=?",
                [&a.preview_id],
                |r| r.get(0),
            )
            .optional()?;
        if current
            .as_deref()
            .map(serde_json::from_str::<Association>)
            .transpose()?
            .is_some_and(|current| {
                current.request_id == a.request_id && current.document_id == a.document_id
            })
        {
            tx.execute(
                "UPDATE preview_associations SET value=? WHERE preview_id=?",
                params![raw, a.preview_id],
            )?;
        }
        Ok(())
    }
    fn operation(&self, generation: &str, request: &str) -> Result<Association> {
        self.db.transaction(|tx| {
            let raw: String = tx
                .query_row(
                    "SELECT value FROM preview_operations WHERE generation=? AND request_id=?",
                    params![generation, request],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| anyhow!("preview_request_not_found"))?;
            Ok(serde_json::from_str(&raw)?)
        })
    }
    fn associations(&self, session: &str) -> Result<Value> {
        self.db.transaction(|tx| {
            let mut statement = tx.prepare(
                "SELECT value FROM preview_associations WHERE session_id=? ORDER BY rowid",
            )?;
            let values = statement
                .query_map([session], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Value::Array(
                values
                    .iter()
                    .map(|v| serde_json::from_str(v))
                    .collect::<serde_json::Result<Vec<Value>>>()?,
            ))
        })
    }
    /// Called after a plugin change is committed. Disable revocation is permanent
    /// for an existing provider open, even if the plugin is later enabled again.
    pub(crate) fn revoke_disabled(&self, providers: &Providers) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
        let stale: Vec<_> = state
            .grants
            .iter()
            .filter(|(s, g)| !Self::binding_current(g, providers, s))
            .map(|(s, _)| s.clone())
            .collect();
        for session in stale {
            state.grants.remove(&session);
            if let Some(a) = state.attachments.get(&session) {
                self.interrupt_attachment(&a.id)?;
            }
        }
        self.changed.notify_all();
        Ok(())
    }
    pub(crate) fn dispatch(
        &self,
        providers: &Providers,
        principal: &str,
        method: &str,
        value: &Value,
    ) -> Result<Value> {
        match method {
            "preview.attach" => {
                let p: Attach = serde_json::from_value(value.clone())?;
                id(&p.session_id)?;
                id(&p.view_id)?;
                if let Some(w) = &p.workspace_id {
                    id(w)?;
                }
                let s = self
                    .db
                    .session_by_id(&p.session_id)?
                    .ok_or_else(|| anyhow!("session_not_found"))?;
                if s.mode != "chat"
                    || principal.starts_with("mcp-")
                    || principal.starts_with("remote:") || principal.starts_with("device:")
                {
                    return Err(anyhow!("preview_unauthorized"));
                }
                let mut state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                if let Some(a) = state.attachments.get(&p.session_id) {
                    if a.principal != principal {
                        return Err(anyhow!("preview_target_in_use"));
                    }
                    if a.view_id == p.view_id && a.workspace_id == p.workspace_id {
                        return Ok(
                            json!({"attachmentId":a.id,"associations":self.associations(&p.session_id)?}),
                        );
                    }
                    self.interrupt_attachment(&a.id)?;
                }
                let attachment = uuid::Uuid::new_v4().to_string();
                state.attachments.insert(
                    p.session_id.clone(),
                    Attachment {
                        id: attachment.clone(),
                        principal: principal.into(),
                        view_id: p.view_id,
                        workspace_id: p.workspace_id,
                    },
                );
                Ok(
                    json!({"attachmentId":attachment,"associations":self.associations(&p.session_id)?}),
                )
            }
            "preview.detach" | "preview.snapshot" => {
                let p: Target = serde_json::from_value(value.clone())?;
                id(&p.session_id)?;
                id(&p.attachment_id)?;
                let mut state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                Self::target(&state, principal, &p.session_id, &p.attachment_id)?;
                if method == "preview.snapshot" {
                    return self.associations(&p.session_id);
                }
                state.attachments.remove(&p.session_id);
                self.interrupt_attachment(&p.attachment_id)?;
                self.changed.notify_all();
                Ok(Value::Null)
            }
            "preview.tool.present" => {
                let p: Present = serde_json::from_value(value.clone())?;
                id(&p.request_id)?;
                let url = local_url(&p.url)?;
                if p.title
                    .as_ref()
                    .is_some_and(|s| s.len() > 512 || s.chars().any(char::is_control))
                {
                    return Err(anyhow!("preview_invalid_request"));
                }
                let state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                let grant =
                    self.authorize(&state, providers, &p.caller_session_id, &p.caller_token)?;
                let generation = grant.generation.clone();
                let fingerprint = json!({"url":url,"title":p.title}).to_string();
                let attachment = state.attachments.get(&p.caller_session_id).cloned();
                let a=self.db.transaction(|tx|{
                    let old:Option<(String,String)>=tx.query_row("SELECT fingerprint,value FROM preview_operations WHERE generation=? AND request_id=?",params![generation,p.request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                    if let Some((f,raw))=old {if f!=fingerprint{return Err(anyhow!("preview_idempotency_conflict"))}return Ok(serde_json::from_str::<Association>(&raw)?)}
                    let count:i64=tx.query_row("SELECT count(*) FROM preview_operations WHERE generation=?",[&generation],|r|r.get(0))?;if count>=MAX_REQUESTS_PER_OPEN{return Err(anyhow!("preview_request_capacity"))}
                    let candidates={let mut statement=tx.prepare("SELECT value FROM preview_associations WHERE session_id=?")?;let rows=statement.query_map([&p.caller_session_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
                    let existing=candidates.iter().filter_map(|raw|serde_json::from_str::<Association>(raw).ok()).find(|a|a.url==url&&a.state=="presented"&&a.workspace_id==attachment.as_ref().and_then(|a|a.workspace_id.clone()));
                    if existing.is_none()&&candidates.len() as i64>=MAX_ASSOCIATIONS{return Err(anyhow!("preview_tab_capacity"))}
                    let mut a=Association{request_id:p.request_id.clone(),preview_id:existing.as_ref().map(|a|a.preview_id.clone()).unwrap_or_else(||uuid::Uuid::new_v4().to_string()),session_id:p.caller_session_id.clone(),document_id:uuid::Uuid::new_v4().to_string(),url:url.clone(),observed_url:None,observed_title:None,document_generation:0,title:p.title.clone(),tab_id:existing.and_then(|a|a.tab_id),workspace_id:attachment.as_ref().and_then(|a|a.workspace_id.clone()),state:"accepted".into(),sequence:0,navigation:"not_started".into(),application_ready:"unknown".into(),content_verified:false,error:None};
                    if attachment.is_none(){a.state="unavailable".into();a.error=Some(preview_error("no_eligible_desktop","No attached desktop view hosts this Chat.",true));}
                    let raw=serde_json::to_string(&a)?;
                    tx.execute("INSERT INTO preview_operations(generation,request_id,session_id,attachment_id,fingerprint,value) VALUES(?,?,?,?,?,?)",params![generation,p.request_id,p.caller_session_id,attachment.as_ref().map(|a|a.id.as_str()).unwrap_or(""),fingerprint,raw])?;
                    tx.execute("INSERT INTO preview_associations(preview_id,session_id,value) VALUES(?,?,?) ON CONFLICT(preview_id) DO UPDATE SET value=excluded.value",params![a.preview_id,a.session_id,raw])?;
                    if let Some(target)=&attachment {
                        let mut event=json!({"sessionId":a.session_id,"attachmentId":target.id,"viewId":target.view_id,"requestId":a.request_id,"previewId":a.preview_id,"documentId":a.document_id,"url":a.url});
                        if let Some(workspace)=&target.workspace_id {event["workspaceId"]=json!(workspace);}
                        if let Some(title)=&a.title {event["title"]=json!(title);}
                        tx.execute("INSERT INTO outbox(event,data,created_at) VALUES ('preview.present',?,?)",params![event.to_string(),Utc::now().to_rfc3339()])?;
                    }
                    Ok(a)
                })?;
                if a.state != "accepted" {
                    return Ok(a.result());
                }
                // Condvar wait releases authority lock. No SQLite transaction or ordered lane is held.
                let until = Instant::now() + Duration::from_secs(4);
                let mut state = state;
                loop {
                    let a = self.operation(&generation, &p.request_id)?;
                    if a.state != "accepted" || Instant::now() >= until {
                        return Ok(a.result());
                    }
                    let (next, _) = self
                        .changed
                        .wait_timeout(state, until.saturating_duration_since(Instant::now()))
                        .map_err(|_| anyhow!("preview_internal"))?;
                    state = next;
                    self.authorize(&state, providers, &p.caller_session_id, &p.caller_token)?;
                }
            }
            "preview.tool.status" => {
                let p: Status = serde_json::from_value(value.clone())?;
                id(&p.request_id)?;
                let state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                let grant =
                    self.authorize(&state, providers, &p.caller_session_id, &p.caller_token)?;
                Ok(self.operation(&grant.generation, &p.request_id)?.result())
            }
            "preview.prepare" => {
                let p:Prepare=serde_json::from_value(value.clone())?;
                for value in [&p.session_id,&p.attachment_id,&p.request_id,&p.preview_id,&p.document_id]{id(value)?;}
                let state=self.state.lock().map_err(|_|anyhow!("preview_internal"))?;
                Self::target(&state,principal,&p.session_id,&p.attachment_id)?;
                let grant=state.grants.get(&p.session_id).filter(|g|Self::binding_current(g,providers,&p.session_id)).ok_or_else(||anyhow!("preview_stale_authority"))?;
                let a=self.operation(&grant.generation,&p.request_id)?;
                if a.state!="accepted"||a.preview_id!=p.preview_id||a.document_id!=p.document_id{return Err(anyhow!("preview_stale_operation"))}
                self.db.transaction(|tx|{
                    let attachment:String=tx.query_row("SELECT attachment_id FROM preview_operations WHERE generation=? AND request_id=?",params![grant.generation,p.request_id],|r|r.get(0))?;
                    let raw:String=tx.query_row("SELECT value FROM preview_associations WHERE preview_id=?",[&p.preview_id],|r|r.get(0))?;
                    let current:Association=serde_json::from_str(&raw)?;
                    if attachment!=p.attachment_id||current.request_id!=p.request_id||current.document_id!=p.document_id||current.state!="accepted"{return Err(anyhow!("preview_stale_operation"))}
                    Ok(serde_json::to_value(a)?)
                })
            }
            "preview.ack" => {
                let p: Ack = serde_json::from_value(value.clone())?;
                for s in [
                    &p.session_id,
                    &p.attachment_id,
                    &p.request_id,
                    &p.preview_id,
                    &p.document_id,
                ] {
                    id(s)?;
                }
                error_payload(&p.error)?;
                if !matches!(p.state.as_str(), "presented" | "failed") {
                    return Err(anyhow!("preview_invalid_request"));
                }
                let mut state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                let target = Self::target(&state, principal, &p.session_id, &p.attachment_id)?;
                if p.state == "presented" && target.workspace_id.as_ref().is_some_and(|workspace| Some(workspace) != p.workspace_id.as_ref()) {
                    return Err(anyhow!("preview_workspace_conflict"));
                }
                let grant = state
                    .grants
                    .get(&p.session_id)
                    .filter(|g| Self::binding_current(g, providers, &p.session_id))
                    .ok_or_else(|| anyhow!("preview_stale_authority"))?;
                let mut a = self.operation(&grant.generation, &p.request_id)?;
                if a.preview_id != p.preview_id || a.document_id != p.document_id {
                    return Err(anyhow!("preview_stale_operation"));
                }
                let operation_attachment=self.db.transaction(|tx|Ok(tx.query_row("SELECT attachment_id FROM preview_operations WHERE generation=? AND request_id=?",params![grant.generation,p.request_id],|r|r.get::<_,String>(0))?))?;
                if operation_attachment != p.attachment_id {
                    return Err(anyhow!("preview_stale_target"));
                }
                if a.state != "accepted" {
                    return Ok(a.result());
                }
                self.db.transaction(|tx|{
                    let attachment:String=tx.query_row("SELECT attachment_id FROM preview_operations WHERE generation=? AND request_id=?",params![grant.generation,p.request_id],|r|r.get(0))?;if attachment!=p.attachment_id{return Err(anyhow!("preview_stale_target"))}
                    if p.state=="presented" {
                        let workspace=p.workspace_id.as_ref().ok_or_else(||anyhow!("preview_invalid_ack"))?;let tab=p.tab_id.as_ref().ok_or_else(||anyhow!("preview_invalid_ack"))?;id(workspace)?;id(tab)?;
                        let (revision,layout):(i64,String)=tx.query_row("SELECT revision,layout FROM workspaces WHERE id=?",[workspace],|r|Ok((r.get(0)?,r.get(1)?)))?;
                        if Some(revision)!=p.workspace_revision||!contains_web_tab(&serde_json::from_str(&layout)?,tab,&a.url)||!contains_session(&serde_json::from_str(&layout)?,&p.session_id){return Err(anyhow!("preview_workspace_conflict"))}
                        a.tab_id=Some(tab.clone());a.workspace_id=Some(workspace.clone());a.navigation="pending".into();
                    }
                    a.state=p.state;a.error=p.error;a.sequence+=1;Self::save_operation(tx,&grant.generation,&a)?;Ok(())
                })?;
                if a.state=="presented" {if let Some(target)=state.attachments.get_mut(&p.session_id){target.workspace_id=a.workspace_id.clone();}}
                self.changed.notify_all();
                Ok(a.result())
            }
            "preview.observe" => {
                let p: Observe = serde_json::from_value(value.clone())?;
                for s in [
                    &p.session_id,
                    &p.attachment_id,
                    &p.request_id,
                    &p.preview_id,
                    &p.document_id,
                ] {
                    id(s)?;
                }
                error_payload(&p.error)?;
                if !matches!(
                    p.navigation.as_str(),
                    "pending" | "load_observed" | "failed"
                ) || p.sequence > 9_007_199_254_740_991
                {
                    return Err(anyhow!("preview_invalid_request"));
                }
                if p.url
                    .as_ref()
                    .is_some_and(|u| u.len() > 8192 || reqwest::Url::parse(u).is_err())
                {
                    return Err(anyhow!("preview_invalid_url"));
                }
                if p.title.as_ref().is_some_and(|t|t.len()>512||t.chars().any(char::is_control))||p.document_generation.is_some_and(|g|g>9_007_199_254_740_991){return Err(anyhow!("preview_invalid_request"))}
                let state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                Self::target(&state, principal, &p.session_id, &p.attachment_id)?;
                let grant = state
                    .grants
                    .get(&p.session_id)
                    .filter(|g| Self::binding_current(g, providers, &p.session_id))
                    .ok_or_else(|| anyhow!("preview_stale_authority"))?;
                let mut a = self.operation(&grant.generation, &p.request_id)?;
                if a.preview_id != p.preview_id || a.document_id != p.document_id {
                    return Err(anyhow!("preview_stale_operation"));
                }
                if a.state != "presented" || p.sequence <= a.sequence || p.document_generation.is_some_and(|g|g<a.document_generation) {
                    return Ok(a.result());
                }
                let current=self.db.transaction(|tx|{let raw:String=tx.query_row("SELECT value FROM preview_associations WHERE preview_id=?",[&p.preview_id],|r|r.get(0))?;Ok(serde_json::from_str::<Association>(&raw)?)})?;
                if current.document_id!=p.document_id||current.request_id!=p.request_id{return Err(anyhow!("preview_stale_operation"))}
                if let Some(g)=p.document_generation {a.document_generation=g;}
                if p.url.is_some(){a.observed_url=p.url;}
                if p.title.is_some(){a.observed_title=p.title;}
                a.sequence = p.sequence;
                a.navigation = p.navigation;
                a.error = p.error;
                self.db
                    .transaction(|tx| Self::save_operation(tx, &grant.generation, &a))?;
                self.changed.notify_all();
                Ok(a.result())
            }
            "preview.close" => {
                let p: Close = serde_json::from_value(value.clone())?;
                for s in [&p.session_id, &p.attachment_id, &p.preview_id] {
                    id(s)?;
                }
                let state = self.state.lock().map_err(|_| anyhow!("preview_internal"))?;
                Self::target(&state, principal, &p.session_id, &p.attachment_id)?;
                self.db.transaction(|tx|{let raw:String=tx.query_row("SELECT value FROM preview_associations WHERE preview_id=? AND session_id=?",params![p.preview_id,p.session_id],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("preview_not_found"))?;
                    let mut a:Association=serde_json::from_str(&raw)?;a.state="closed".into();a.sequence+=1;tx.execute("UPDATE preview_associations SET value=? WHERE preview_id=?",params![serde_json::to_string(&a)?,p.preview_id])?;
                    let rows={let mut statement=tx.prepare("SELECT generation,request_id,value FROM preview_operations WHERE session_id=?")?;let rows=statement.query_map([&p.session_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
                    for (generation,request,raw) in rows {let mut old:Association=serde_json::from_str(&raw)?;if old.preview_id==p.preview_id{old.state="closed".into();old.sequence+=1;tx.execute("UPDATE preview_operations SET value=? WHERE generation=? AND request_id=?",params![serde_json::to_string(&old)?,generation,request])?;}}Ok(())})?;
                self.changed.notify_all();
                Ok(Value::Null)
            }
            _ => Err(anyhow!("method_not_found")),
        }
    }
}

fn contains_web_tab(layout: &Value, id: &str, url: &str) -> bool {
    if layout["kind"] == "split" {
        return contains_web_tab(&layout["first"], id, url)
            || contains_web_tab(&layout["second"], id, url);
    }
    layout["tabs"].as_array().is_some_and(|tabs| {
        tabs.iter()
            .any(|t| t["id"] == id && t["kind"] == "web" && t["url"] == url)
    })
}
fn contains_session(layout: &Value, session: &str) -> bool {
    if layout["kind"] == "split" {
        return contains_session(&layout["first"], session)
            || contains_session(&layout["second"], session);
    }
    layout["tabs"].as_array().is_some_and(|tabs| {
        tabs.iter()
            .any(|t| t["kind"] == "session" && t["sessionId"] == session)
    })
}

fn generated_ui_enabled(settings: &Value) -> bool {
    settings
        .pointer("/chatTools/generatedUi")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn mcp_handoff_capable(providers: &Providers, provider: &str) -> bool {
    matches!(provider, "codex" | "claude" | "kimi" | "grok" | "gemini")
        || providers.plugin_registry().is_some_and(|registry| {
            registry
                .agents
                .iter()
                .any(|agent| agent.id == provider && agent.chat_args.is_some())
        })
}

pub(crate) struct BrowserCapabilities {
    pub previews: Arc<Previews>,
    pub tools: Arc<crate::browser_tools::BrowserTools>,
}

pub(crate) fn tool_server_resolver(
    db: Arc<Database>,
    delegations: Arc<crate::delegation::Delegations>,
    chat_tools: Arc<crate::chat_tools::ChatTools>,
    browser: BrowserCapabilities,
    providers: Weak<Providers>,
    config: RuntimeConfig,
    mcp: Option<PathBuf>,
) -> ToolServerResolver {
    let BrowserCapabilities { previews, tools: browser_tools } = browser;
    let delegation = crate::delegation::tool_server_resolver(
        Arc::clone(&db),
        delegations,
        config.clone(),
        mcp.clone(),
    );
    Arc::new(move |session, provider| {
        let mut spec = delegation(session, provider);
        // Servers are constructed per provider open. Do not let a parent
        // process environment turn a delegated, read-only, or unsupported
        // session into a generated-UI instruction recipient.
        if let Some(server) = spec.as_mut() {
            server.env.retain(|(key, _)| !matches!(key.as_str(), "THREADTERM_GENERATED_UI" | "THREADTERM_BROWSER_SESSION_ID" | "THREADTERM_BROWSER_TOKEN"));
            server.env.push(("THREADTERM_BROWSER_SESSION_ID".into(), String::new()));
            server.env.push(("THREADTERM_BROWSER_TOKEN".into(), String::new()));
        }
        let Some(registry) = providers.upgrade() else {
            return spec;
        };
        let app_eligible = db
            .session_by_id(session)
            .ok()
            .flatten()
            .is_some_and(|s| s.mode == "chat" && !s.read_only)
            && !crate::agent_review::is_reviewer(&db, session).unwrap_or(true);
        if !app_eligible {
            return spec;
        }
        // All MCP-capable built-ins use the same app-hosted tools. The
        // settings snapshot is read while this process is opened, so changing
        // a switch affects subsequent connections only.
        let supported = matches!(provider, "codex" | "claude" | "kimi" | "grok" | "gemini")
            || registry.plugin_registry().is_some_and(|r| r.agents.iter().any(|a| a.id == provider && a.chat_args.is_some()));
        let Ok(settings) = crate::delegation::chat_tool_settings(&db) else {
            return spec;
        };
        if supported && (settings.ask || settings.session_info || settings.feedback) {
            if let (Some(command), Some(generation)) = (mcp.as_ref(), registry.preview_worker_token(session)) {
                if let Ok(token) = chat_tools.issue(session, generation, settings.ask, settings.session_info, settings.feedback) {
                    let server = spec.get_or_insert_with(|| ChatToolServer {
                        name: "threadterm".into(), command: command.to_string_lossy().into_owned(), args: vec![],
                        env: vec![
                            ("THREADTERM_SESSION_ID".into(), String::new()), ("THREADTERM_SESSION_TOKEN".into(), String::new()),
                            ("THREADTERM_V3_DATA".into(), config.data_dir.to_string_lossy().into_owned()), ("THREADTERM_V3_PIPE".into(), config.pipe_base.clone()),
                        ],
                    });
                    server.env.retain(|(key, _)| !matches!(key.as_str(), "THREADTERM_MCP_PROFILE" | "THREADTERM_CHAT_SESSION_ID" | "THREADTERM_CHAT_TOKEN" | "THREADTERM_CHAT_TOOL_ASK" | "THREADTERM_CHAT_TOOL_SESSION_INFO" | "THREADTERM_CHAT_TOOL_FEEDBACK"));
                    server.env.push(("THREADTERM_MCP_PROFILE".into(), "chat-tools".into()));
                    server.env.push(("THREADTERM_CHAT_SESSION_ID".into(), session.into()));
                    server.env.push(("THREADTERM_CHAT_TOKEN".into(), token));
                    server.env.push(("THREADTERM_CHAT_TOOL_ASK".into(), if settings.ask { "1" } else { "0" }.into()));
                    server.env.push(("THREADTERM_CHAT_TOOL_SESSION_INFO".into(), if settings.session_info { "1" } else { "0" }.into()));
                    server.env.push(("THREADTERM_CHAT_TOOL_FEEDBACK".into(), if settings.feedback { "1" } else { "0" }.into()));
                }
            }
        }
        // Browser presentation is intentionally narrower: a delegated child
        // may ask its user or read its own session info, but never inherits a
        // preview authority reserved for top-level Chats.
        let preview_eligible = db.session_by_id(session).ok().flatten().is_some_and(|s| s.delegation.is_none());
        if !preview_eligible {
            return spec;
        }
        // Read tools need explicit per-tab sharing, independently from the
        // selected presentation binding and from Ask/delegation settings.
        if provider != "opencode" && supported && mcp_handoff_capable(&registry, provider) {
            if let (Some(command), Some(generation)) = (mcp.as_ref(), registry.preview_worker_token(session)) {
                if let Ok(token) = browser_tools.issue(session, &generation) {
                    let server = spec.get_or_insert_with(|| ChatToolServer {
                        name: "threadterm".into(), command: command.to_string_lossy().into_owned(), args: vec![],
                        env: vec![
                            ("THREADTERM_SESSION_ID".into(), String::new()), ("THREADTERM_SESSION_TOKEN".into(), String::new()),
                            ("THREADTERM_V3_DATA".into(), config.data_dir.to_string_lossy().into_owned()),
                            ("THREADTERM_V3_PIPE".into(), config.pipe_base.clone()),
                        ],
                    });
                    server.env.retain(|(key, _)| !matches!(key.as_str(), "THREADTERM_MCP_PROFILE" | "THREADTERM_BROWSER_SESSION_ID" | "THREADTERM_BROWSER_TOKEN"));
                    server.env.push(("THREADTERM_MCP_PROFILE".into(), "chat-tools".into()));
                    server.env.push(("THREADTERM_BROWSER_SESSION_ID".into(), session.into()));
                    server.env.push(("THREADTERM_BROWSER_TOKEN".into(), token));
                }
            }
        }
        let generated_ui = db.snapshot().ok().is_some_and(|snapshot| generated_ui_enabled(&snapshot.settings.value));
        if generated_ui && mcp_handoff_capable(&registry, provider) {
            let Some(command) = mcp.as_ref() else {
                return spec;
            };
            let server = spec.get_or_insert_with(|| ChatToolServer {
                name: "threadterm".into(),
                command: command.to_string_lossy().into_owned(),
                args: vec![],
                // `chat-tools` starts the core MCP host but grants no tool
                // credentials; generated UI adds initialize instructions only.
                env: vec![("THREADTERM_MCP_PROFILE".into(), "chat-tools".into())],
            });
            server.env.retain(|(key, _)| key != "THREADTERM_GENERATED_UI");
            server.env.push(("THREADTERM_GENERATED_UI".into(), "1".into()));
        }
        // Preview remains independently gated by its browser binding. The
        // generated-UI instruction above intentionally does not need one.
        let Some(binding) = registry.plugin_registry().and_then(|r| {
            match r.browser_binding_for_provider(provider, "mcp-stdio") {
                crate::plugins::BrowserBindingResolution::Eligible(b) => Some(b),
                _ => None,
            }
        }) else {
            return spec;
        };
        // Only adapters with implemented MCP handoff may receive this capability.
        if !supported {
            return spec;
        }
        let Some(command) = mcp.as_ref() else {
            return spec;
        };
        let Some(generation) = registry.preview_worker_token(session) else {
            return spec;
        };
        let token = previews.issue(
            session,
            generation,
            provider.into(),
            binding.plugin_id,
            binding.id,
        );
        let server = spec.get_or_insert_with(|| ChatToolServer {
            name: "threadterm".into(),
            command: command.to_string_lossy().into_owned(),
            args: vec![],
            env: vec![
                ("THREADTERM_SESSION_ID".into(), String::new()),
                ("THREADTERM_SESSION_TOKEN".into(), String::new()),
                (
                    "THREADTERM_V3_DATA".into(),
                    config.data_dir.to_string_lossy().into_owned(),
                ),
                ("THREADTERM_V3_PIPE".into(), config.pipe_base.clone()),
            ],
        });
        server
            .env
            .retain(|(key, _)| key != "THREADTERM_MCP_PROFILE");
        server
            .env
            .push(("THREADTERM_MCP_PROFILE".into(), "chat-tools".into()));
        server
            .env
            .push(("THREADTERM_PREVIEW_SESSION_ID".into(), session.into()));
        server.env.push(("THREADTERM_PREVIEW_TOKEN".into(), token));
        Some(server.clone())
    })
}

pub(crate) fn tools() -> Vec<Value> {
    vec![
        json!({"name":"preview_present","description":INSTRUCTIONS,"inputSchema":{"type":"object","additionalProperties":false,"required":["requestId","url"],"properties":{"requestId":{"type":"string","minLength":1,"maxLength":256},"url":{"type":"string","maxLength":8192},"title":{"type":"string","maxLength":512}}}}),
        json!({"name":"preview_status","description":"Read the state of an explicit preview request. It does not navigate, replay or verify application content. Use only after a pending result or user request; no idle polling.","inputSchema":{"type":"object","additionalProperties":false,"required":["requestId"],"properties":{"requestId":{"type":"string","minLength":1,"maxLength":256}}}}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: tempfile::TempDir,
        db: Arc<Database>,
        providers: Arc<Providers>,
        previews: Arc<Previews>,
        token: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
            db.transaction(|tx|{for session in ["a","b"] {tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES(?,?,'codex','chat','running','t','t')",params![session,session])?;}Ok(())}).unwrap();
            let providers = Arc::new(Providers::with_plugins(root.path(), &json!({})));
            providers.preview_test_worker("a", Some("generation-a"));
            let previews = Arc::new(Previews::new(Arc::clone(&db)).unwrap());
            let registry = providers.plugin_registry().unwrap();
            let crate::plugins::BrowserBindingResolution::Eligible(binding) =
                registry.browser_binding_for_provider("codex", "mcp-stdio")
            else {
                panic!("bundled Codex binding must be eligible")
            };
            let token = previews.issue(
                "a",
                "generation-a".into(),
                "codex".into(),
                binding.plugin_id,
                binding.id,
            );
            Self {
                root,
                db,
                providers,
                previews,
                token,
            }
        }
        fn call(&self, principal: &str, method: &str, value: Value) -> Result<Value> {
            self.previews
                .dispatch(&self.providers, principal, method, &value)
        }
        fn attach(&self) -> String {
            self.call(
                "desktop-a",
                "preview.attach",
                json!({"sessionId":"a","viewId":"view-a"}),
            )
            .unwrap()["attachmentId"]
                .as_str()
                .unwrap()
                .into()
        }
        fn params(&self, id: &str) -> Value {
            json!({"callerSessionId":"a","callerToken":self.token,"requestId":id,"url":"http://localhost:5173/"})
        }
        fn begin(&self, id: &str) -> (Value, std::thread::JoinHandle<Result<Value>>) {
            let previews = Arc::clone(&self.previews);
            let providers = Arc::clone(&self.providers);
            let params = self.params(id);
            let worker = std::thread::spawn(move || {
                previews.dispatch(
                    &providers,
                    "mcp-preview-fixture",
                    "preview.tool.present",
                    &params,
                )
            });
            let until = Instant::now() + Duration::from_secs(2);
            loop {
                if let Some((_, _, event)) = self
                    .db
                    .events_after(0)
                    .unwrap()
                    .into_iter()
                    .find(|(_, event, data)| event == "preview.present" && data["requestId"] == id)
                {
                    return (event, worker);
                }
                assert!(Instant::now() < until, "presentation event missing");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        fn workspace(&self) -> i64 {
            self.db.transaction(|tx|{let layout=json!({"kind":"split","direction":"horizontal","ratio":0.5,"first":{"kind":"pane","id":"chat-pane","tabs":[{"id":"chat-a","kind":"session","sessionId":"a"}],"activeTabId":"chat-a"},"second":{"kind":"pane","id":"browser-pane","tabs":[{"id":"web-a","kind":"web","url":"http://localhost:5173/"}],"activeTabId":"web-a"}});tx.execute("INSERT INTO workspaces(id,name,revision,layout,updated_at) VALUES('workspace-a','Preview',1,?,'t')",[layout.to_string()])?;Ok(1)}).unwrap()
        }
        fn ack(&self, event: &Value, attachment: &str) -> Value {
            self.call("desktop-a","preview.prepare",json!({"sessionId":"a","attachmentId":attachment,"requestId":event["requestId"],"previewId":event["previewId"],"documentId":event["documentId"]})).unwrap();
            self.call("desktop-a","preview.ack",json!({"sessionId":"a","attachmentId":attachment,"requestId":event["requestId"],"previewId":event["previewId"],"documentId":event["documentId"],"state":"presented","tabId":"web-a","workspaceId":"workspace-a","workspaceRevision":1})).unwrap()
        }
    }
    #[test]
    fn generated_ui_is_default_off_and_only_injects_for_eligible_open_chats() {
        assert!(!generated_ui_enabled(&json!({})));
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        db.transaction(|tx| {
            for (id, provider) in [("parent", "codex"), ("standalone", "gemini")] {
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES(?,?,?,'chat','idle','t','t')", params![id, id, provider])?;
            }
            Ok(())
        }).unwrap();
        let providers = Arc::new(Providers::with_plugins(root.path(), &json!({})));
        assert!(mcp_handoff_capable(&providers, "gemini"));
        assert!(!mcp_handoff_capable(&providers, "opencode"));
        let config = RuntimeConfig { data_dir: root.path().to_owned(), database_path: root.path().join("runtime.sqlite"), credential_path: root.path().join("credential"), pipe_base: "generated-ui-test".into() };
        let chat_tools = crate::chat_tools::shared(&config.database_path, Arc::clone(&db)).unwrap();
        let resolver = tool_server_resolver(
            Arc::clone(&db),
            Arc::new(crate::delegation::Delegations::default()),
            chat_tools,
            BrowserCapabilities {
                previews: Arc::new(Previews::new(Arc::clone(&db)).unwrap()),
                tools: Arc::new(crate::browser_tools::BrowserTools::new(Arc::clone(&db), "test-browser".into(), Arc::new(|_, _, _| false))),
            },
            Arc::downgrade(&providers),
            config,
            Some(root.path().join("threadterm-v3-mcp")),
        );
        assert!(resolver("standalone", "gemini").is_none());
        db.update_settings(&json!({"chatTools":{"generatedUi":true}}), 0, "enable-generated-ui").unwrap();
        let server = resolver("standalone", "gemini").expect("generated UI gets an instruction-only MCP host");
        assert_eq!(server.env, vec![
            ("THREADTERM_MCP_PROFILE".into(), "chat-tools".into()),
            ("THREADTERM_GENERATED_UI".into(), "1".into()),
        ]);
        assert!(resolver("standalone", "opencode").is_none());
        db.transaction(|tx| {
            tx.execute("INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,state,created_at,updated_at) VALUES('d','parent','standalone','gemini','shared','C:/fixture',NULL,'x',0,'o','running','t','t')", [])?;
            Ok(())
        }).unwrap();
        assert!(resolver("standalone", "gemini").is_none(), "delegated children never inherit generated UI instructions");
    }
    #[test]
    fn disabling_a_tool_switch_removes_it_from_the_next_connection() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES('s','s','codex','chat','idle','t','t')", [])?;
            Ok(())
        }).unwrap();
        let providers = Arc::new(Providers::with_plugins(root.path(), &json!({})));
        providers.preview_test_worker("s", Some("generation-one"));
        let config = RuntimeConfig { data_dir: root.path().to_owned(), database_path: root.path().join("runtime.sqlite"), credential_path: root.path().join("credential"), pipe_base: "chat-tools-switch-test".into() };
        let chat_tools = crate::chat_tools::shared(&config.database_path, Arc::clone(&db)).unwrap();
        let resolver = tool_server_resolver(
            Arc::clone(&db),
            Arc::new(crate::delegation::Delegations::default()),
            chat_tools,
            BrowserCapabilities {
                previews: Arc::new(Previews::new(Arc::clone(&db)).unwrap()),
                tools: Arc::new(crate::browser_tools::BrowserTools::new(Arc::clone(&db), "test-browser".into(), Arc::new(|_, _, _| false))),
            },
            Arc::downgrade(&providers),
            config,
            Some(root.path().join("threadterm-v3-mcp")),
        );
        let env_value = |server: &ChatToolServer, key: &str| server.env.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
        db.update_settings(&json!({"chatTools.ask":true,"chatTools.sessionInfo":true,"chatTools.feedback":true}), 0, "enable-all").unwrap();
        let first = resolver("s", "codex").expect("the first connection gets the app-hosted tools");
        assert_eq!(env_value(&first, "THREADTERM_CHAT_TOOL_ASK").as_deref(), Some("1"));
        assert_eq!(env_value(&first, "THREADTERM_CHAT_TOOL_SESSION_INFO").as_deref(), Some("1"));
        assert_eq!(env_value(&first, "THREADTERM_CHAT_TOOL_FEEDBACK").as_deref(), Some("1"));
        assert!(first.env.iter().all(|(key, _)| key != "THREADTERM_GENERATED_UI"), "generated UI stays off while its switch is off");
        db.update_settings(&json!({"chatTools.feedback":false}), db.snapshot().unwrap().settings.revision, "disable-feedback").unwrap();
        let second = resolver("s", "codex").expect("the next connection still gets the remaining tools");
        assert_eq!(env_value(&second, "THREADTERM_CHAT_TOOL_ASK").as_deref(), Some("1"), "the remaining switches stay on");
        assert_eq!(env_value(&second, "THREADTERM_CHAT_TOOL_FEEDBACK").as_deref(), Some("0"), "the disabled tool is off for the next connection");
    }
    #[test]
    fn acknowledgment_cannot_retarget_an_existing_workspace_lease() {
        let f = Fixture::new();
        f.workspace();
        f.db.transaction(|tx| {
            tx.execute("INSERT INTO workspaces(id,name,revision,layout,updated_at) SELECT 'workspace-b',name,revision,layout,updated_at FROM workspaces WHERE id='workspace-a'", [])?;
            Ok(())
        }).unwrap();
        let attached = f.call("desktop-a", "preview.attach", json!({"sessionId":"a","viewId":"view-a","workspaceId":"workspace-a"})).unwrap();
        let attachment = attached["attachmentId"].as_str().unwrap();
        let (event, worker) = f.begin("workspace-fence");
        let error = f.call("desktop-a", "preview.ack", json!({"sessionId":"a","attachmentId":attachment,"requestId":event["requestId"],"previewId":event["previewId"],"documentId":event["documentId"],"state":"presented","tabId":"web-a","workspaceId":"workspace-b","workspaceRevision":1})).unwrap_err();
        assert_eq!(error.to_string(), "preview_workspace_conflict");
        assert_eq!(f.ack(&event, attachment)["state"], "presented");
        assert_eq!(worker.join().unwrap().unwrap()["state"], "presented");
        assert_eq!(f.previews.state.lock().unwrap().attachments["a"].workspace_id.as_deref(), Some("workspace-a"));
    }
    #[test]
    fn first_ack_adopts_workspace_and_later_explicit_request_reuses_the_page() {
        let f = Fixture::new();
        let attachment = f.attach();
        f.workspace();
        let (first, first_worker) = f.begin("first");
        f.ack(&first, &attachment);
        first_worker.join().unwrap().unwrap();
        let (second, second_worker) = f.begin("second");
        assert_eq!(second["previewId"], first["previewId"]);
        assert_ne!(second["documentId"], first["documentId"]);
        assert_eq!(second["workspaceId"], "workspace-a");
        f.ack(&second, &attachment);
        second_worker.join().unwrap().unwrap();
    }
    #[test]
    fn preview_url_admission_is_explicit_loopback_without_credentials() {
        for url in [
            "http://localhost:5173/x",
            "https://127.0.0.1/",
            "http://[::1]:8000/",
        ] {
            assert!(local_url(url).is_ok(), "{url}")
        }
        for url in [
            "http://user:pass@localhost/",
            "https://example.org/",
            "file:///x",
            "javascript:alert(1)",
            "http://localhost.example.org/",
            "http://192.168.1.1/",
        ] {
            assert!(local_url(url).is_err(), "{url}")
        }
    }
    #[test]
    fn absent_desktop_is_unavailable_and_duplicate_never_opens_later() {
        let f = Fixture::new();
        let result = f
            .call(
                "mcp-preview-fixture",
                "preview.tool.present",
                f.params("request-a"),
            )
            .unwrap();
        assert_eq!(result["state"], "unavailable");
        assert_eq!(result["error"]["code"], "no_eligible_desktop");
        f.attach();
        assert_eq!(
            f.call(
                "mcp-preview-fixture",
                "preview.tool.present",
                f.params("request-a")
            )
            .unwrap(),
            result
        );
        assert!(!f
            .db
            .events_after(0)
            .unwrap()
            .iter()
            .any(|(_, name, _)| name == "preview.present"));
        let mut changed = f.params("request-a");
        changed["url"] = json!("http://localhost:5173/other");
        assert_eq!(
            f.call("mcp-preview-fixture", "preview.tool.present", changed)
                .unwrap_err()
                .to_string(),
            "preview_idempotency_conflict"
        );
    }
    #[test]
    fn wrong_token_session_and_replaced_provider_are_rejected() {
        let f = Fixture::new();
        let mut params = f.params("r");
        params["callerToken"] = json!("wrong");
        assert!(f
            .call("mcp-preview-fixture", "preview.tool.present", params)
            .is_err());
        let mut params = f.params("r");
        params["callerSessionId"] = json!("b");
        assert!(f
            .call("mcp-preview-fixture", "preview.tool.present", params)
            .is_err());
        f.providers.preview_test_worker("a", Some("replaced"));
        assert_eq!(
            f.call("mcp-preview-fixture", "preview.tool.present", f.params("r"))
                .unwrap_err()
                .to_string(),
            "preview_binding_disabled_or_stale"
        );
    }
    #[test]
    fn exact_saved_tab_ack_and_navigation_never_claim_content_verification() {
        let f = Fixture::new();
        let attachment = f.attach();
        f.workspace();
        let (event, worker) = f.begin("r");
        assert!(f.call("other-window","preview.ack",json!({"sessionId":"a","attachmentId":attachment,"requestId":"r","previewId":event["previewId"],"documentId":event["documentId"],"state":"failed"})).is_err());
        assert!(f.call("desktop-a","preview.ack",json!({"sessionId":"a","attachmentId":attachment,"requestId":"r","previewId":event["previewId"],"documentId":event["documentId"],"state":"presented","tabId":"web-a","workspaceId":"workspace-a","workspaceRevision":0})).is_err());
        let acknowledged = f.ack(&event, &attachment);
        assert_eq!(acknowledged["state"], "presented");
        assert_eq!(worker.join().unwrap().unwrap(), acknowledged);
        let observed=f.call("desktop-a","preview.observe",json!({"sessionId":"a","attachmentId":attachment,"requestId":"r","previewId":event["previewId"],"documentId":event["documentId"],"sequence":2,"navigation":"load_observed"})).unwrap();
        assert_eq!(observed["navigation"], "load_observed");
        assert_eq!(observed["applicationReady"], "unknown");
        assert_eq!(observed["contentVerified"], false);
        let duplicate = f
            .call("mcp-preview-fixture", "preview.tool.present", f.params("r"))
            .unwrap();
        assert_eq!(duplicate, observed);
        f.call(
            "desktop-a",
            "preview.close",
            json!({"sessionId":"a","attachmentId":attachment,"previewId":event["previewId"]}),
        )
        .unwrap();
        assert_eq!(
            f.call("mcp-preview-fixture", "preview.tool.present", f.params("r"))
                .unwrap()["state"],
            "closed"
        );
        assert_eq!(
            f.db.events_after(0)
                .unwrap()
                .iter()
                .filter(|(_, name, _)| name == "preview.present")
                .count(),
            1
        );
    }
    #[test]
    fn renderer_detach_interrupts_without_replay_and_live_grant_can_reattach() {
        let f = Fixture::new();
        let old = f.attach();
        f.workspace();
        let (event, worker) = f.begin("old");
        f.call(
            "desktop-a",
            "preview.detach",
            json!({"sessionId":"a","attachmentId":old}),
        )
        .unwrap();
        assert_eq!(worker.join().unwrap().unwrap()["state"], "interrupted");
        let new = f.attach();
        assert_ne!(old, new);
        assert!(f.call("desktop-a","preview.ack",json!({"sessionId":"a","attachmentId":new,"requestId":"old","previewId":event["previewId"],"documentId":event["documentId"],"state":"presented","tabId":"web-a","workspaceId":"workspace-a","workspaceRevision":1})).is_err());
        assert_eq!(
            f.call(
                "mcp-preview-fixture",
                "preview.tool.present",
                f.params("old")
            )
            .unwrap()["state"],
            "interrupted"
        );
        let (next, worker) = f.begin("new");
        f.ack(&next, &new);
        assert_eq!(worker.join().unwrap().unwrap()["state"], "presented");
    }
    #[test]
    fn another_window_cannot_steal_a_live_attachment() {
        let f = Fixture::new();
        f.attach();
        assert_eq!(
            f.call(
                "desktop-b",
                "preview.attach",
                json!({"sessionId":"a","viewId":"view-b"})
            )
            .unwrap_err()
            .to_string(),
            "preview_target_in_use"
        );
    }
    #[test]
    fn queued_event_revoked_before_delivery_cannot_prepare() {
        let f=Fixture::new();let attachment=f.attach();let (event,worker)=f.begin("queued");
        f.providers.rebuild_plugins(crate::plugins::PluginRegistry::discover(f.root.path(),&json!({"plugins":{"codex-preview":{"enabled":false}}})));f.previews.revoke_disabled(&f.providers).unwrap();
        assert!(f.call("desktop-a","preview.prepare",json!({"sessionId":"a","attachmentId":attachment,"requestId":"queued","previewId":event["previewId"],"documentId":event["documentId"]})).is_err());
        assert!(worker.join().unwrap().is_err());
        let events=f.db.events_after(0).unwrap();assert!(events.iter().any(|(_,name,data)|name=="preview.cancel"&&data["requestId"]=="queued"));
        let values=f.call("desktop-a","preview.snapshot",json!({"sessionId":"a","attachmentId":attachment})).unwrap();assert_eq!(values[0]["state"],"interrupted");
    }
    #[test]
    fn observed_document_metadata_and_generation_are_monotonic() {
        let f=Fixture::new();let attachment=f.attach();f.workspace();let (event,worker)=f.begin("document");f.ack(&event,&attachment);worker.join().unwrap().unwrap();
        let base=json!({"sessionId":"a","attachmentId":attachment,"requestId":"document","previewId":event["previewId"],"documentId":event["documentId"],"sequence":2,"navigation":"load_observed","url":"http://localhost:5173/route?one=1","title":"Actual document","documentGeneration":2});
        let observed=f.call("desktop-a","preview.observe",base.clone()).unwrap();assert_eq!(observed["observedTitle"],"Actual document");assert_eq!(observed["documentGeneration"],2);
        let mut stale=base;stale["sequence"]=json!(3);stale["documentGeneration"]=json!(1);stale["url"]=json!("http://localhost:5173/stale");assert_eq!(f.call("desktop-a","preview.observe",stale).unwrap(),observed);
        let associations=f.call("desktop-a","preview.snapshot",json!({"sessionId":"a","attachmentId":attachment})).unwrap();assert_eq!(associations[0]["observedUrl"],"http://localhost:5173/route?one=1");
    }
    #[test]
    fn replacing_a_grant_invalidates_the_previous_token() {
        let f=Fixture::new();f.previews.issue("a","generation-a".into(),"codex".into(),"codex-preview".into(),"codex-preview".into());
        assert_eq!(f.call("mcp-preview-fixture","preview.tool.present",f.params("old")).unwrap_err().to_string(),"preview_unauthorized");
    }
    #[test]
    fn disable_revokes_grant_even_after_reenable() {
        let f = Fixture::new();
        f.providers
            .rebuild_plugins(crate::plugins::PluginRegistry::discover(
                f.root.path(),
                &json!({"plugins":{"codex-preview":{"enabled":false}}}),
            ));
        f.previews.revoke_disabled(&f.providers).unwrap();
        f.providers
            .rebuild_plugins(crate::plugins::PluginRegistry::discover(
                f.root.path(),
                &json!({}),
            ));
        assert_eq!(
            f.call("mcp-preview-fixture", "preview.tool.present", f.params("r"))
                .unwrap_err()
                .to_string(),
            "preview_unauthorized"
        );
    }
    #[test]
    fn control_loss_ends_pending_operations_but_not_provider_grant() {
        let f = Fixture::new();
        let presence = f.previews.connect("desktop-a");
        f.attach();
        let (_event, worker) = f.begin("lost");
        drop(presence);
        assert_eq!(worker.join().unwrap().unwrap()["state"], "interrupted");
        let _new = f.previews.connect("desktop-a");
        f.attach();
        assert_eq!(
            f.call(
                "mcp-preview-fixture",
                "preview.tool.status",
                json!({"callerSessionId":"a","callerToken":f.token,"requestId":"lost"})
            )
            .unwrap()["state"],
            "interrupted"
        );
    }
}
