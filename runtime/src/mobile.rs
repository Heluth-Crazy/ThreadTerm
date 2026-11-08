//! Mobile companion authority and projection.
//!
//! Mobile shares the remote TLS listener and framed runtime transport, but it
//! deliberately does not inherit desktop peer authority. Every request passes
//! this closed allowlist at execution, and every data-bearing scope is checked
//! against registered projects/worktrees/sessions.
use crate::{
    db::Database,
    devices::{DeviceManager, DevicePermission},
    domain::RpcError,
    service::RuntimeService,
};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

pub(crate) const ALPN: &[u8] = b"threadterm-mobile/1";
pub(crate) const CONTRACT: u32 = 1;
const CONTROL_CONNECTIONS: usize = 16;
const DEPENDENT_CONNECTIONS: usize = 32;
const TUNNEL_CONNECTIONS: usize = 32;
const VALIDATION_INTERVAL: Duration = Duration::from_secs(1);
const MAX_SUBSCRIBED_SESSIONS: usize = 4;

pub(crate) const VIEW_METHODS: &[&str] = &[
    "runtime.health",
    "project.catalog.list",
    "worktree.list",
    "worktree.branches",
    "session.lookup",
    "chat.snapshot",
    "chat.read",
    "chat.subagent.read",
    "chat.options",
    "chat.connection",
    "terminal.read",
    "filesystem.list",
    "filesystem.read",
    "filesystem.files",
    "filesystem.search",
    "filesystem.image",
    "git.status",
    "git.diff",
    "git.log",
    "git.commit.show",
    "git.commit.diff",
    "git.branches",
    "inbox.read",
    "session.attention.acknowledge",
    "attachment.read",
    "chat.image.read",
    "mobile.snapshot",
    "mobile.events.subscribe",
];

pub(crate) const CONTROL_METHODS: &[&str] = &[
    "mobile.session.create",
    "session.stop",
    "session.resume",
    "session.claim",
    "session.renew",
    "session.release",
    "chat.connect",
    "chat.option.set",
    "chat.send",
    "chat.cancel",
    "chat.approve",
    "chat.answer",
    "terminal.input",
    "terminal.resize",
    "attachment.upload",
];

type GroupKey = (String, String);

struct Group {
    epoch: String,
    permission: DevicePermission,
    closed: watch::Sender<bool>,
}

pub(crate) struct ConnectionGroups {
    groups: Arc<Mutex<HashMap<GroupKey, Group>>>,
    validated: Mutex<HashMap<String, Instant>>,
    controls: Arc<Semaphore>,
    dependents: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    tunnels: Arc<Semaphore>,
}

impl Default for ConnectionGroups {
    fn default() -> Self {
        Self {
            groups: Arc::default(),
            validated: Mutex::default(),
            controls: Arc::new(Semaphore::new(CONTROL_CONNECTIONS)),
            dependents: Arc::new(Semaphore::new(DEPENDENT_CONNECTIONS)),
            handshakes: Arc::new(Semaphore::new(32)),
            tunnels: Arc::new(Semaphore::new(TUNNEL_CONNECTIONS)),
        }
    }
}

impl ConnectionGroups {
    pub(crate) fn connected(&self, device: &str) -> bool {
        self.groups
            .lock()
            .map(|groups| groups.keys().any(|(id, _)| id == device))
            .unwrap_or(false)
    }

    fn permission(&self, device: &str, client: &str) -> Option<DevicePermission> {
        self.groups
            .lock()
            .ok()?
            .get(&(device.into(), client.into()))
            .map(|group| group.permission)
    }

    fn validate(&self, devices: &DeviceManager, device: &str) -> Result<()> {
        let fresh = self
            .validated
            .lock()
            .ok()
            .and_then(|validated| validated.get(device).copied())
            .is_some_and(|at| at.elapsed() < VALIDATION_INTERVAL);
        if fresh {
            return Ok(());
        }
        if !devices.enabled()? {
            bail!("remote_access_disabled")
        }
        devices.mobile_activity(device)?;
        if let Ok(mut validated) = self.validated.lock() {
            validated.insert(device.to_owned(), Instant::now());
        }
        Ok(())
    }

    pub(crate) fn revoke(&self, device: &str, db: &Database) -> Result<()> {
        if let Ok(mut validated) = self.validated.lock() {
            validated.remove(device);
        }
        let mut groups = self
            .groups
            .lock()
            .map_err(|_| anyhow!("mobile groups poisoned"))?;
        groups.retain(|(id, _), group| {
            if id == device {
                group.closed.send_replace(true);
                false
            } else {
                true
            }
        });
        drop(groups);
        let prefix = format!("mobile:{device}:");
        db.transaction(|tx| {
            tx.execute(
                "UPDATE leases SET expires_at=? WHERE substr(client_id,1,length(?))=?",
                rusqlite::params![chrono::Utc::now().to_rfc3339(), prefix, prefix],
            )?;
            Ok(())
        })
    }

    /// Changes authority without tearing down the view connection. A downgrade
    /// fences every outstanding mobile lease before the next guarded request.
    pub(crate) fn set_permission(
        &self,
        device: &str,
        permission: DevicePermission,
        db: &Database,
    ) -> Result<()> {
        let mut groups = self
            .groups
            .lock()
            .map_err(|_| anyhow!("mobile groups poisoned"))?;
        for ((id, _), group) in groups.iter_mut() {
            if id == device {
                group.permission = permission;
            }
        }
        drop(groups);
        if permission == DevicePermission::Readonly {
            let prefix = format!("mobile:{device}:");
            db.transaction(|tx| {
                tx.execute(
                    "UPDATE leases SET expires_at=? WHERE substr(client_id,1,length(?))=?",
                    rusqlite::params![chrono::Utc::now().to_rfc3339(), prefix, prefix],
                )?;
                Ok(())
            })?;
        }
        Ok(())
    }
}

struct ControlLifetime {
    groups: Arc<Mutex<HashMap<GroupKey, Group>>>,
    key: GroupKey,
    db: Arc<Database>,
}

impl Drop for ControlLifetime {
    fn drop(&mut self) {
        if let Ok(mut groups) = self.groups.lock() {
            if let Some(group) = groups.remove(&self.key) {
                group.closed.send_replace(true);
            }
        }
        let principal = format!("mobile:{}:{}", self.key.0, self.key.1);
        let _ = self.db.transaction(|tx| {
            tx.execute(
                "UPDATE leases SET expires_at=? WHERE client_id=?",
                rusqlite::params![chrono::Utc::now().to_rfc3339(), principal],
            )?;
            Ok(())
        });
    }
}

fn failure(code: &str, message: &str) -> RpcError {
    RpcError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

fn authentication_failed() -> Value {
    json!({
        "kind":"authentication_failed",
        "code":"mobile_revoked",
        "message":"Mobile credential is no longer valid",
    })
}

fn revoked_event(epoch: &str, reason: &str) -> Value {
    json!({
        "v":crate::PROTOCOL_VERSION,
        "event":"mobile.revoked",
        "epoch":epoch,
        "seq":0,
        "data":{"reason":reason},
    })
}

pub(crate) fn is_principal(principal: &str) -> bool {
    principal.starts_with("mobile:")
}

fn identity(principal: &str) -> std::result::Result<(&str, &str), RpcError> {
    principal
        .strip_prefix("mobile:")
        .and_then(|value| value.split_once(':'))
        .ok_or_else(|| failure("mobile_revoked", "Mobile connection is unavailable"))
}

pub(crate) fn permission(
    service: &RuntimeService,
    principal: &str,
) -> std::result::Result<DevicePermission, RpcError> {
    let (device, client) = identity(principal)?;
    let remote = service
        .remote
        .get()
        .ok_or_else(|| failure("mobile_revoked", "Mobile connection is unavailable"))?;
    if !remote.is_enabled() {
        return Err(failure(
            "mobile_revoked",
            "Mobile connection is unavailable",
        ));
    }
    let permission = remote
        .mobiles
        .permission(device, client)
        .ok_or_else(|| failure("mobile_revoked", "Mobile connection is unavailable"))?;
    remote
        .mobiles
        .validate(&remote.devices, device)
        .map_err(|_| failure("mobile_revoked", "Mobile credential is no longer valid"))?;
    Ok(permission)
}

pub(crate) fn guard_stream(
    service: &RuntimeService,
    principal: &str,
    method: &str,
) -> std::result::Result<(), RpcError> {
    let permission = permission(service, principal)?;
    authorize_method(permission, method)
}

fn authorize_method(
    permission: DevicePermission,
    method: &str,
) -> std::result::Result<(), RpcError> {
    match method {
        "runtime.event" | "terminal.output" => Ok(()),
        _ if VIEW_METHODS.contains(&method) => Ok(()),
        _ if CONTROL_METHODS.contains(&method) && permission == DevicePermission::Fullcontrol => {
            Ok(())
        }
        _ if CONTROL_METHODS.contains(&method) => Err(failure(
            "mobile_readonly",
            "This phone has view-only access",
        )),
        _ => Err(failure(
            "mobile_forbidden",
            "This method is not available to the mobile companion",
        )),
    }
}

pub(crate) fn guard_request(
    service: &RuntimeService,
    principal: &str,
    method: &str,
    params: &Value,
) -> std::result::Result<(), RpcError> {
    guard_stream(service, principal, method)?;
    let scoped = (|| -> Result<()> {
        if matches!(
            method,
            "runtime.health"
                | "project.catalog.list"
                | "mobile.snapshot"
                | "mobile.events.subscribe"
                | "session.lookup"
                | "mobile.session.create"
        ) {
            return Ok(());
        }
        if matches!(
            method,
            "worktree.list"
                | "worktree.branches"
                | "filesystem.list"
                | "filesystem.read"
                | "filesystem.files"
                | "filesystem.search"
                | "filesystem.image"
                | "git.status"
                | "git.diff"
                | "git.log"
                | "git.commit.show"
                | "git.commit.diff"
                | "git.branches"
        ) {
            return require_registered_scope(&service.db, params);
        }
        if method == "inbox.read" {
            let ids = params
                .get("ids")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("invalid_request"))?;
            if ids.len() > 500 {
                bail!("invalid_request")
            }
            for id in ids {
                let id = id
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| anyhow!("invalid_request"))?;
                let session_id: String = service.db.transaction(|tx| {
                    Ok(
                        tx.query_row("SELECT session_id FROM inbox WHERE id=?", [id], |row| {
                            row.get(0)
                        })?,
                    )
                })?;
                require_registered_session(&service.db, &session_id)?;
            }
            return Ok(());
        }
        if method == "attachment.read" {
            let asset = params
                .get("assetId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow!("invalid_request"))?;
            let session_id: String = service.db.transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT session_id FROM attachment_uploads WHERE id=? AND done=1",
                    [asset],
                    |row| row.get(0),
                )?)
            })?;
            return require_registered_session(&service.db, &session_id);
        }
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("invalid_request"))?;
        require_registered_session(&service.db, session_id)
    })();
    scoped.map_err(|_| {
        failure(
            "mobile_scope_denied",
            "The requested item is outside registered mobile access",
        )
    })
}

fn require_registered_scope(db: &Database, params: &Value) -> Result<()> {
    let project = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let worktree = params.get("worktreePath").and_then(Value::as_str);
    db.transaction(|tx| crate::workspace_services::root_for(tx, project, worktree).map(|_| ()))
}

pub(crate) fn require_registered_session(db: &Database, session_id: &str) -> Result<()> {
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    let project = session
        .project_id
        .as_deref()
        .ok_or_else(|| anyhow!("project_required"))?;
    db.transaction(|tx| {
        crate::workspace_services::root_for(tx, project, session.worktree_path.as_deref())
            .map(|_| ())
    })
}

/// Cheap continuing-authority check for already validated event/output
/// subscriptions. Session bindings store the selected project/worktree root,
/// so registration can be rechecked without filesystem I/O on every frame.
pub(crate) fn session_is_registered(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sessions s JOIN projects p ON p.id=s.project_id
                WHERE s.id=? AND (
                    s.worktree_path IS NULL OR s.worktree_path=p.path OR EXISTS(
                        SELECT 1 FROM worktrees w
                        WHERE w.project_id=s.project_id AND w.path=s.worktree_path
                    )
                )
            )",
            [session_id],
            |row| row.get(0),
        )?)
    })
}

pub(crate) fn subscription(db: &Database, params: &Value) -> Result<(BTreeSet<String>, Value)> {
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if object.len() != 1 {
        bail!("invalid_request")
    }
    let ids = object
        .get("sessionIds")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if ids.len() > MAX_SUBSCRIBED_SESSIONS {
        bail!("too_many_mobile_sessions")
    }
    let mut sessions = BTreeSet::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("invalid_request"))?;
        require_registered_session(db, id)?;
        sessions.insert(id.to_owned());
    }
    let revision = db.snapshot()?.revision;
    Ok((
        sessions.clone(),
        json!({"sessionIds":sessions,"revision":revision}),
    ))
}

pub(crate) fn project_event(
    db: &Database,
    event: &str,
    data: &Value,
    subscribed: &BTreeSet<String>,
) -> Option<(String, Value)> {
    if event == "device.changed" {
        return Some(("mobile.changed".into(), json!({"permissionChanged":true})));
    }
    if event == "runtime.degraded" {
        let mut safe = Map::new();
        for key in ["reason", "snapshotRequired", "oldestCursor"] {
            if let Some(value) = data.get(key) {
                safe.insert(key.into(), value.clone());
            }
        }
        return Some((event.into(), Value::Object(safe)));
    }
    let session = data.get("sessionId").and_then(Value::as_str);
    if matches!(event, "chat.item" | "chat.ui" | "chat.connection")
        && session.is_some_and(|id| {
            subscribed.contains(id) && session_is_registered(db, id).unwrap_or(false)
        })
    {
        return Some((event.into(), data.clone()));
    }
    if matches!(
        event,
        "state.changed"
            | "session.status"
            | "session.activity"
            | "inbox.created"
            | "inbox.resolved"
    ) {
        return Some(("mobile.changed".into(), json!({})));
    }
    None
}

pub(crate) fn snapshot(
    db: &Database,
    provider_values: Vec<Value>,
    permission: DevicePermission,
) -> Result<Value> {
    let base = db.snapshot()?;
    let projects = crate::project_catalog::dispatch(db, "project.catalog.list", &json!({}))?
        .unwrap_or_else(|| json!([]));
    let mut worktrees = Vec::new();
    let mut warnings = Vec::new();
    for project in projects.as_array().into_iter().flatten() {
        let Some(project_id) = project.get("id").and_then(Value::as_str) else {
            continue;
        };
        match crate::workspace_services::dispatch(
            db,
            "worktree.list",
            &json!({"projectId":project_id}),
        ) {
            Ok(Some(Value::Array(rows))) => worktrees.extend(rows),
            Ok(_) => {}
            Err(_) => warnings
                .push(json!({"projectId":project_id,"message":"Worktrees could not be refreshed"})),
        }
    }
    let sessions: Vec<_> = base
        .sessions
        .into_iter()
        .filter(|session| {
            !session.organization.archived
                && session.code_review.is_none()
                && session.group.is_none()
                && require_registered_session(db, &session.id).is_ok()
        })
        .collect();
    let visible: BTreeSet<_> = sessions.iter().map(|session| session.id.as_str()).collect();
    let inbox: Vec<_> = base
        .inbox
        .into_iter()
        .filter(|item| {
            item.get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| visible.contains(id))
        })
        .collect();
    let providers: Vec<_> = provider_values
        .into_iter()
        .filter_map(sanitize_provider)
        .collect();
    let mut methods = VIEW_METHODS
        .iter()
        .map(|method| (*method).to_owned())
        .collect::<Vec<_>>();
    if permission == DevicePermission::Fullcontrol {
        methods.extend(CONTROL_METHODS.iter().map(|method| (*method).to_owned()));
    }
    let mut result = json!({
        "epoch":base.epoch,
        "revision":base.revision,
        "permission":permission,
        "capabilities":{"contract":CONTRACT,"methods":methods},
        "projects":projects,
        "worktrees":worktrees,
        "sessions":sessions,
        "inbox":inbox,
        "providers":providers,
    });
    if !warnings.is_empty() {
        result["warnings"] = Value::Array(warnings);
    }
    Ok(result)
}

fn sanitize_provider(value: Value) -> Option<Value> {
    let source = value.as_object()?;
    let id = source.get("id")?.as_str()?;
    let name = source.get("name")?.as_str()?;
    let installed = source.get("installed")?.as_bool()?;
    let terminal = source.get("terminal")?.as_bool()?;
    let chat = source.get("chat")?.as_bool()?;
    let mut out =
        json!({"id":id,"name":name,"installed":installed,"terminal":terminal,"chat":chat});
    for key in ["auth", "reason", "version"] {
        if let Some(value) = source.get(key).filter(|value| value.is_string()) {
            out[key] = value.clone();
        }
    }
    Some(out)
}

pub(crate) fn resolve_mobile_cwd(
    db: &Database,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<String> {
    if project_id.is_empty() {
        bail!("invalid_request")
    }
    db.transaction(|tx| {
        let path: String = if let Some(worktree_id) = worktree_id {
            tx.query_row(
                "SELECT path FROM worktrees WHERE id=? AND project_id=?",
                rusqlite::params![worktree_id, project_id],
                |row| row.get(0),
            )?
        } else {
            tx.query_row(
                "SELECT path FROM projects WHERE id=?",
                [project_id],
                |row| row.get(0),
            )?
        };
        crate::workspace_services::root_for(tx, project_id, Some(&path))?;
        Ok(path)
    })
}

pub(crate) fn preview_target_allowed(db: &Database, target: SocketAddr) -> Result<bool> {
    let snapshot = db.snapshot()?;
    Ok(snapshot.sessions.into_iter().any(|session| {
        if matches!(session.status.as_str(), "exited" | "error" | "interrupted") {
            return false;
        }
        let Some(url) = session.run.and_then(|run| run.url) else {
            return false;
        };
        let Ok(url) = reqwest::Url::parse(&url) else {
            return false;
        };
        let loopback = url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        let port = url.port_or_known_default();
        loopback
            && port == Some(target.port())
            && require_registered_session(db, &session.id).is_ok()
    }))
}

#[cfg(windows)]
pub(crate) async fn accept<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: T,
    remote: Arc<crate::remote_access::RemoteAccess>,
    generation: u64,
    address: String,
    iroh_endpoint_id: Option<String>,
) -> Result<()> {
    use crate::{
        transport::{read_json, write_json},
        PROTOCOL_VERSION, RUNTIME_VERSION,
    };
    use base64::Engine;
    use rand::RngCore;
    use tokio::time::timeout;

    if !remote.is_generation_enabled(generation) {
        bail!("remote_access_disabled")
    }
    let handshake_permit = Arc::clone(&remote.mobiles.handshakes)
        .try_acquire_owned()
        .map_err(|_| anyhow!("mobile handshake limit"))?;
    let service = remote
        .runtime()
        .ok_or_else(|| anyhow!("runtime unavailable"))?;
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
    write_json(&mut stream, &json!({"kind":"challenge","protocol":PROTOCOL_VERSION,"contract":CONTRACT,"nonce":nonce,"version":RUNTIME_VERSION})).await?;
    let auth = timeout(Duration::from_secs(10), read_json(&mut stream)).await??;
    if auth.get("kind").and_then(Value::as_str) != Some("auth") {
        bail!("authentication required")
    }
    if auth.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
        || auth.get("contract").and_then(Value::as_u64) != Some(CONTRACT as u64)
    {
        write_json(&mut stream, &json!({"kind":"incompatible","code":"protocol_incompatible","protocol":PROTOCOL_VERSION,"contract":CONTRACT,"version":RUNTIME_VERSION})).await?;
        bail!("protocol_incompatible")
    }
    if auth.get("nonce").and_then(Value::as_str) != Some(&nonce) {
        bail!("invalid nonce")
    }
    let client = auth
        .get("clientId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("clientId required"))?;
    uuid::Uuid::parse_str(client).map_err(|_| anyhow!("invalid clientId"))?;
    let channel = auth
        .get("channel")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("channel required"))?;
    if !matches!(channel, "control" | "output" | "tunnel") {
        bail!("unsupported mobile channel")
    }
    let target = if channel == "tunnel" {
        Some(crate::tunnel::target(&auth)?)
    } else {
        None
    };
    let pool = if channel == "tunnel" {
        &remote.mobiles.tunnels
    } else if channel == "control" {
        &remote.mobiles.controls
    } else {
        &remote.mobiles.dependents
    };
    let _permit = Arc::clone(pool)
        .try_acquire_owned()
        .map_err(|_| anyhow!("mobile connection limit"))?;
    let credential = auth
        .get("credential")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("credential required"))?
        .to_owned();
    let devices = remote.devices.clone();
    let credential_for_auth = credential.clone();
    let auth_iroh = iroh_endpoint_id.clone();
    let device = match tokio::task::spawn_blocking(move || {
        devices.authenticate_mobile(&credential_for_auth, auth_iroh.as_deref())
    })
    .await?
    {
        Ok(device) => device,
        Err(_) => {
            write_json(&mut stream, &authentication_failed()).await?;
            return Ok(());
        }
    };
    if remote.devices.validate_mobile(&device.id).is_err() {
        write_json(&mut stream, &authentication_failed()).await?;
        return Ok(());
    }
    // Do not hold this synchronous barrier across I/O. It serializes the
    // current credential/permission read and group publication with an admin
    // permission change, so an old authentication result cannot become a new
    // Fullcontrol group after a completed downgrade.
    let (device, epoch, mut closed, lifetime) = {
        let _access = remote.access_read()?;
        let device = remote
            .devices
            .authenticate_mobile(&credential, iroh_endpoint_id.as_deref())?;
        remote.devices.validate_mobile(&device.id)?;
        remote.record_peer_address(&device.id, &address)?;
        let epoch = service.db.epoch()?;
        let key = (device.id.clone(), client.to_owned());
        let mut lifetime = None;
        let closed = {
            let mut groups = remote
                .mobiles
                .groups
                .lock()
                .map_err(|_| anyhow!("mobile groups poisoned"))?;
            if channel == "control" {
                if auth.get("epoch") != Some(&Value::Null) {
                    bail!("control epoch must be null")
                }
                if groups.contains_key(&key) {
                    bail!("control already connected")
                }
                let (sender, receiver) = watch::channel(false);
                groups.insert(
                    key.clone(),
                    Group {
                        epoch: epoch.clone(),
                        permission: device.permission,
                        closed: sender,
                    },
                );
                lifetime = Some(ControlLifetime {
                    groups: Arc::clone(&remote.mobiles.groups),
                    key,
                    db: Arc::clone(&service.db),
                });
                receiver
            } else {
                let group = groups
                    .get(&key)
                    .ok_or_else(|| anyhow!("live control required"))?;
                if auth.get("epoch").and_then(Value::as_str) != Some(group.epoch.as_str()) {
                    bail!("control epoch mismatch")
                }
                group.closed.subscribe()
            }
        };
        (device, epoch, closed, lifetime)
    };
    let principal = format!("mobile:{}:{client}", device.id);
    drop(handshake_permit);
    let permission = device.permission;
    let mut target_stream = if let Some(target) = target {
        if !preview_target_allowed(&service.db, target)? {
            write_json(
                &mut stream,
                &json!({"kind":"tunnel_failed","code":"preview_not_registered"}),
            )
            .await?;
            return Ok(());
        }
        match crate::tunnel::connect(target).await {
            Ok(socket) => {
                if !preview_target_allowed(&service.db, target)? {
                    write_json(
                        &mut stream,
                        &json!({"kind":"tunnel_failed","code":"preview_not_registered"}),
                    )
                    .await?;
                    return Ok(());
                }
                Some(socket)
            }
            Err(error) => {
                write_json(
                    &mut stream,
                    &json!({"kind":"tunnel_failed","code":crate::tunnel::failure_code(&error)}),
                )
                .await?;
                return Ok(());
            }
        }
    } else {
        None
    };
    write_json(&mut stream, &json!({"kind":"authenticated","protocol":PROTOCOL_VERSION,"contract":CONTRACT,"principal":principal,"epoch":epoch,"permission":permission})).await?;

    enum End {
        Connection(Result<()>),
        Revoked(&'static str),
        Silent,
    }
    let end = {
        let connection = async {
            match channel {
                "control" => {
                    crate::transport::serve_control(
                        &mut stream,
                        Arc::clone(&service),
                        principal.clone(),
                    )
                    .await
                }
                "output" => {
                    crate::transport::serve_output(
                        &mut stream,
                        Arc::clone(&service),
                        principal.clone(),
                    )
                    .await
                }
                "tunnel" => {
                    tokio::io::copy_bidirectional(
                        &mut stream,
                        target_stream.as_mut().expect("tunnel target"),
                    )
                    .await?;
                    Ok(())
                }
                _ => unreachable!(),
            }
        };
        tokio::pin!(connection);
        loop {
            tokio::select! {
                result = &mut connection => break End::Connection(result),
                _ = closed.changed() => break End::Revoked("revoked"),
                _ = service.wait_for_shutdown() => break End::Silent,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if !remote.is_generation_enabled(generation) {
                        break End::Silent
                    }
                    if let Err(error) = remote.mobiles.validate(&remote.devices, &device.id) {
                        let message = error.to_string();
                        let reason = if message == "device_expired" {
                            "credential_expired"
                        } else if message == "remote_access_disabled" {
                            break End::Silent
                        } else {
                            "revoked"
                        };
                        break End::Revoked(reason)
                    }
                }
            }
        }
    };
    let result = match end {
        End::Connection(result) => result,
        End::Revoked(reason) => {
            if channel == "control" {
                let _ = write_json(&mut stream, &revoked_event(&epoch, reason)).await;
            }
            Ok(())
        }
        End::Silent => Ok(()),
    };
    drop(lifetime);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use crate::providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
    };
    use crate::{config::RuntimeConfig, domain::RpcRequest, service::RuntimeService};

    struct MobileOptionProvider;

    impl ProviderAdapter for MobileOptionProvider {
        fn id(&self) -> &'static str {
            "mobile-options"
        }

        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source: "builtin",
                plugin_id: None,
                icon: None,
                sign_in: None,
                remote_sign_in: None,
                homepage: None,
                id: "mobile-options".into(),
                name: "Mobile options fixture".into(),
                installed: true,
                version: None,
                terminal: false,
                chat: true,
                history: false,
                resume: false,
                terminal_resume_capture: "none",
                reason: None,
                auth: "unknown".into(),
            }
        }

        fn terminal_command(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "fixture has no terminal"))
        }

        fn history_list(
            &self,
            _: Option<&str>,
            _: u32,
            _: Option<&str>,
        ) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
            Ok(json!([]))
        }

        fn open_chat(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(MobileOptionChat {
                model: "host-model-a".into(),
            }))
        }
    }

    struct MobileOptionChat {
        model: String,
    }

    impl ChatSession for MobileOptionChat {
        fn native_id(&self) -> Option<String> {
            Some("mobile-options".into())
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), ProviderError> {
            Ok(())
        }
        fn ui_state(&self) -> Value {
            json!({"options":[{"id":"model","name":"Model","value":self.model,
                "choices":[{"value":"host-model-a","name":"Host model A"},{"value":"host-model-b","name":"Host model B"}]}],
                "commands":[],"loadState":"ready"})
        }
        fn set_option(&mut self, id: &str, value: &str) -> Result<Value, ProviderError> {
            if id != "model" || !["host-model-a", "host-model-b"].contains(&value) {
                return Err(ProviderError::new(
                    "chat_option_invalid",
                    "host did not offer that option",
                ));
            }
            self.model = value.into();
            Ok(self.ui_state())
        }
    }

    fn scope_fixture() -> (tempfile::TempDir, Database, String, String, String) {
        let directory = tempfile::tempdir().unwrap();
        let project_root = directory.path().join("project");
        let worktree_root = directory.path().join("worktree");
        let outside_root = directory.path().join("outside");
        for root in [&project_root, &worktree_root, &outside_root] {
            std::fs::create_dir(root).unwrap();
        }
        let db = Database::open(&directory.path().join("mobile.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        crate::project_catalog::initialize(&db).unwrap();
        let project = db
            .add_project(
                project_root.to_str().unwrap(),
                Some("Mobile"),
                "mobile-project",
            )
            .unwrap();
        let worktree = worktree_root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('mobile-tree',?,?,'mobile','head',0,0)",
                rusqlite::params![project.id, worktree],
            )?;
            Ok(())
        })
        .unwrap();
        (
            directory,
            db,
            project.id,
            worktree,
            outside_root
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string(),
        )
    }

    #[test]
    fn event_projection_never_forwards_settings_or_unsubscribed_chat() {
        let (_directory, db, project, _worktree, _outside) = scope_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Subscribed"),
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "subscribed-session",
            })
            .unwrap();
        let project_root = resolve_mobile_cwd(&db, &project, None).unwrap();
        db.bind_session(&session.id, Some(&project_root), None)
            .unwrap();
        let subscribed = BTreeSet::from([session.id.clone()]);
        assert_eq!(
            project_event(
                &db,
                "state.changed",
                &json!({"kind":"settings","secret":"x"}),
                &subscribed
            ),
            Some(("mobile.changed".into(), json!({})))
        );
        assert_eq!(
            project_event(&db, "device.changed", &json!({"token":"x"}), &subscribed),
            Some(("mobile.changed".into(), json!({"permissionChanged":true})))
        );
        assert!(project_event(
            &db,
            "chat.context",
            &json!({"sessionId":session.id,"usage":{"secret":"x"}}),
            &subscribed
        )
        .is_none());
        assert!(project_event(
            &db,
            "chat.item",
            &json!({"sessionId":"other","item":{"text":"secret"}}),
            &subscribed
        )
        .is_none());
        assert_eq!(
            project_event(
                &db,
                "chat.item",
                &json!({"sessionId":session.id,"item":{"text":"visible"}}),
                &subscribed
            )
            .unwrap()
            .0,
            "chat.item"
        );

        db.remove_project(&project, "remove-subscribed-project")
            .unwrap();
        assert!(project_event(
            &db,
            "chat.item",
            &json!({"sessionId":session.id,"item":{"text":"must-not-leak"}}),
            &subscribed
        )
        .is_none());
    }

    #[test]
    fn readonly_permission_denies_every_control_method_and_unknown_methods() {
        for method in CONTROL_METHODS {
            assert_eq!(
                authorize_method(DevicePermission::Readonly, method)
                    .unwrap_err()
                    .code,
                "mobile_readonly"
            );
            authorize_method(DevicePermission::Fullcontrol, method).unwrap();
        }
        for method in VIEW_METHODS {
            authorize_method(DevicePermission::Readonly, method).unwrap();
        }
        assert_eq!(
            authorize_method(DevicePermission::Fullcontrol, "settings.update")
                .unwrap_err()
                .code,
            "mobile_forbidden"
        );
        assert_eq!(
            authorize_method(DevicePermission::Readonly, "runtime.snapshot")
                .unwrap_err()
                .code,
            "mobile_forbidden"
        );
    }

    #[test]
    fn option_reads_stay_visible_but_option_changes_require_control_and_a_registered_session() {
        let (_directory, db, project, _worktree, outside) = scope_fixture();
        let visible = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Visible options"),
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "visible-option-session",
            })
            .unwrap();
        let root = resolve_mobile_cwd(&db, &project, None).unwrap();
        db.bind_session(&visible.id, Some(&root), None).unwrap();

        // View may read the current host-provided option state, but cannot
        // mutate it; execution then passes through the ordinary lease fence.
        authorize_method(DevicePermission::Readonly, "chat.options").unwrap();
        assert_eq!(
            authorize_method(DevicePermission::Readonly, "chat.option.set")
                .unwrap_err()
                .code,
            "mobile_readonly"
        );
        authorize_method(DevicePermission::Fullcontrol, "chat.option.set").unwrap();
        require_registered_session(&db, &visible.id).unwrap();

        let escaped = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Escaped options"),
                provider: "codex",
                mode: "chat",
                native_id: None,
                operation_id: "escaped-option-session",
            })
            .unwrap();
        db.bind_session(&escaped.id, Some(&outside), None).unwrap();
        assert!(require_registered_session(&db, &escaped.id).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mobile_option_dispatch_enforces_view_scope_and_desktop_lease_parity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        let outside = directory.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let config = RuntimeConfig {
            data_dir: directory.path().to_owned(),
            database_path: directory.path().join("runtime.sqlite"),
            credential_path: directory.path().join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-mobile-options".into(),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::project_catalog::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::devices::DeviceManager::new(Arc::clone(&db))
            .unwrap()
            .set_remote_access_preference(true, None, None)
            .unwrap();
        let project = db
            .add_project(
                root.to_str().unwrap(),
                Some("Mobile"),
                "mobile-options-project",
            )
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Options"),
                provider: "mobile-options",
                mode: "chat",
                native_id: None,
                operation_id: "mobile-options-session",
            })
            .unwrap();
        let registered = root.canonicalize().unwrap().to_string_lossy().to_string();
        db.bind_session(&session.id, Some(&registered), None)
            .unwrap();
        db.set_session_status(&session.id, "idle", None).unwrap();

        let service = Arc::new(RuntimeService::with_test_providers(
            config.clone(),
            Arc::clone(&db),
            vec![Arc::new(MobileOptionProvider)],
        ));
        let remote = crate::remote_access::RemoteAccess::new(
            Arc::downgrade(&service),
            Arc::clone(&db),
            config,
        )
        .unwrap();
        assert!(service.remote.set(Arc::clone(&remote)).is_ok());
        let desktop_lease = service.leases.claim(&db, &session.id, "desktop").unwrap();
        service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "open-mobile-options-fixture".into(),
                    method: "chat.connect".into(),
                    params: json!({"sessionId":session.id,"leaseEpoch":desktop_lease,"operationId":"open-mobile-options-fixture"}),
                },
            )
            .unwrap();
        service
            .leases
            .release(&db, &session.id, "desktop", desktop_lease)
            .unwrap();

        let paired = |permission, operation: &str| {
            let offer = remote
                .devices
                .create_pairing_with_profile(
                    permission,
                    crate::devices::DeviceProfile::Mobile,
                    operation,
                    "https://fixture",
                    "AA",
                    None,
                )
                .unwrap();
            remote
                .devices
                .pair(&offer.id, &offer.code, operation, None)
                .unwrap()
                .device
        };
        let connect_group = |device: &crate::devices::PairedDevice| {
            let (closed, _) = watch::channel(false);
            remote.mobiles.groups.lock().unwrap().insert(
                (device.id.clone(), "fixture".into()),
                Group {
                    epoch: "fixture-epoch".into(),
                    permission: device.permission,
                    closed,
                },
            );
            format!("mobile:{}:fixture", device.id)
        };
        let readonly_device = paired(DevicePermission::Readonly, "readonly-options");
        let control_device = paired(DevicePermission::Fullcontrol, "control-options");
        let readonly = connect_group(&readonly_device);
        let control = connect_group(&control_device);
        let request = |principal: &str, method: &str, params: Value| {
            service.dispatch(
                principal,
                RpcRequest {
                    v: 1,
                    id: format!("{method}-id"),
                    method: method.into(),
                    params,
                },
            )
        };

        let current = request(&readonly, "chat.options", json!({"sessionId":session.id})).unwrap();
        assert_eq!(current["options"][0]["value"], "host-model-a");
        assert_eq!(
            request(&readonly, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-b","leaseEpoch":1,"operationId":"readonly-change"}))
                .unwrap_err().code,
            "mobile_readonly",
        );
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-b","operationId":"missing-lease"}))
                .unwrap_err().code,
            "invalid_request",
        );
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-b","leaseEpoch":1,"operationId":"wrong-lease"}))
                .unwrap_err().code,
            "stale_lease",
        );
        let unclaimed = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Unclaimed"),
                provider: "mobile-options",
                mode: "chat",
                native_id: None,
                operation_id: "mobile-options-unclaimed",
            })
            .unwrap();
        db.bind_session(&unclaimed.id, Some(&registered), None)
            .unwrap();
        let missing = request(&control, "chat.option.set", json!({"sessionId":unclaimed.id,"optionId":"model","value":"host-model-b","leaseEpoch":1,"operationId":"no-lease"})).unwrap_err();
        // The ordinary desktop RPC mapper normalizes missing and stale leases.
        assert_eq!(missing.code, "stale_lease");
        assert_eq!(missing.message, "lease_missing");
        let lease = service.leases.claim(&db, &session.id, &control).unwrap();
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-b","leaseEpoch":lease + 1,"operationId":"stale-lease"}))
                .unwrap_err().code,
            "stale_lease",
        );
        let changed = request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-b","leaseEpoch":lease,"operationId":"valid-lease"})).unwrap();
        assert_eq!(changed["options"][0]["value"], "host-model-b");
        assert_eq!(
            request(&control, "device.permission.set", json!({"deviceId":control_device.id,"permission":"readonly","operationId":"mobile-admin-denied"}))
                .unwrap_err()
                .code,
            "mobile_forbidden",
            "a connected mobile principal cannot administer paired devices"
        );
        let set = |permission, operation_id: &str| {
            remote
                .dispatch(
                    "device.permission.set",
                    &json!({"deviceId":control_device.id,"permission":permission,"operationId":operation_id}),
                )
                .unwrap()
                .unwrap()
        };
        // Hold group lookup after the real service dispatch has acquired the
        // access read side. The permission writer must wait for that in-flight
        // mobile effect, then fence the next one.
        let groups = remote.mobiles.groups.lock().unwrap();
        let effect_service = Arc::clone(&service);
        let effect_principal = control.clone();
        let effect_session = session.id.clone();
        let (effect_done, effect_result) = std::sync::mpsc::channel();
        let effect = std::thread::spawn(move || {
            let result = effect_service.dispatch(
                &effect_principal,
                RpcRequest {
                    v: 1,
                    id: "in-flight-mobile-effect".into(),
                    method: "chat.option.set".into(),
                    params: json!({"sessionId":effect_session,"optionId":"model","value":"host-model-a","leaseEpoch":lease,"operationId":"in-flight-mobile-effect"}),
                },
            );
            effect_done.send(result).unwrap();
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while remote.access_writer_available() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(
            !remote.access_writer_available(),
            "the actual mobile dispatch acquired the access read barrier"
        );
        let writer_remote = Arc::clone(&remote);
        let writer_device = control_device.id.clone();
        let (writer_done, writer_result) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let result = writer_remote.dispatch(
                "device.permission.set",
                &json!({"deviceId":writer_device,"permission":"readonly","operationId":"writer-after-mobile-effect"}),
            );
            writer_done.send(result).unwrap();
        });
        assert!(
            writer_result
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "permission writer waits for an already-authorized mobile effect"
        );
        drop(groups);
        effect_result
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
        effect.join().unwrap();
        writer_result
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap();
        writer.join().unwrap();
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-a","leaseEpoch":lease,"operationId":"after-writer-drain"}))
                .unwrap_err()
                .code,
            "mobile_readonly",
            "the next full mobile dispatch sees the completed downgrade"
        );
        set("fullcontrol", "after-writer-upgrade");
        set("readonly", "live-permission-first-downgrade");
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-a","leaseEpoch":lease,"operationId":"post-downgrade"}))
                .unwrap_err()
                .code,
            "mobile_readonly",
            "the full dispatch path observes a live downgrade"
        );
        set("fullcontrol", "live-permission-upgrade");
        set("readonly", "live-permission-second-downgrade");
        let replay = set("fullcontrol", "live-permission-upgrade");
        assert_eq!(replay["permission"], "fullcontrol", "the operation keeps its historical receipt");
        assert_eq!(
            remote.mobiles.permission(&control_device.id, "fixture"),
            Some(DevicePermission::Readonly),
            "replaying a superseded upgrade cannot restore live authority"
        );
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-a","leaseEpoch":lease,"operationId":"post-replay"}))
                .unwrap_err()
                .code,
            "mobile_readonly"
        );
        set("fullcontrol", "restore-control-for-scope");
        let upgraded_lease = service.leases.claim(&db, &session.id, &control).unwrap();
        assert!(
            request(&control, "chat.option.set", json!({"sessionId":session.id,"optionId":"model","value":"host-model-a","leaseEpoch":upgraded_lease,"operationId":"post-upgrade"}))
                .is_ok(),
            "a live upgrade permits a newly claimed control request"
        );

        let escaped = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Escaped"),
                provider: "mobile-options",
                mode: "chat",
                native_id: None,
                operation_id: "mobile-options-escaped",
            })
            .unwrap();
        db.bind_session(&escaped.id, Some(outside.to_str().unwrap()), None)
            .unwrap();
        assert_eq!(
            request(&control, "chat.option.set", json!({"sessionId":escaped.id,"optionId":"model","value":"host-model-b","leaseEpoch":lease,"operationId":"escaped-change"}))
                .unwrap_err().code,
            "mobile_scope_denied",
        );
        remote.disable().unwrap();
    }

    #[test]
    fn registered_scope_rejects_escaped_worktrees_and_sessions() {
        let (_directory, db, project, worktree, outside) = scope_fixture();
        require_registered_scope(&db, &json!({"projectId":project})).unwrap();
        require_registered_scope(&db, &json!({"projectId":project,"worktreePath":worktree}))
            .unwrap();
        assert!(require_registered_scope(
            &db,
            &json!({"projectId":project,"worktreePath":outside})
        )
        .is_err());
        assert_eq!(
            resolve_mobile_cwd(&db, &project, Some("mobile-tree")).unwrap(),
            worktree
        );
        assert!(resolve_mobile_cwd(&db, "missing-project", Some("mobile-tree")).is_err());

        let session = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Escaped"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "escaped-session",
            })
            .unwrap();
        db.bind_session(&session.id, Some(&outside), None).unwrap();
        assert!(require_registered_session(&db, &session.id).is_err());
    }

    #[test]
    fn revoke_closes_groups_and_expires_only_that_devices_leases() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("revoke.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Lease"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "lease-session",
            })
            .unwrap();
        let other = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Other"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "other-session",
            })
            .unwrap();
        let groups = ConnectionGroups::default();
        let (closed, mut closed_rx) = watch::channel(false);
        groups.groups.lock().unwrap().insert(
            ("device-a".into(), "client-a".into()),
            Group {
                epoch: "epoch".into(),
                permission: DevicePermission::Fullcontrol,
                closed,
            },
        );
        let future = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES(?,?,1,?)",
                rusqlite::params![session.id, "mobile:device-a:client-a", future],
            )?;
            tx.execute(
                "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES(?,?,1,?)",
                rusqlite::params![other.id, "mobile:device-b:client-b", future],
            )?;
            Ok(())
        })
        .unwrap();

        groups.revoke("device-a", &db).unwrap();
        assert!(*closed_rx.borrow_and_update());
        assert!(!groups.connected("device-a"));
        let revoked_expiry =
            chrono::DateTime::parse_from_rfc3339(&db.lease(&session.id).unwrap().unwrap().2)
                .unwrap()
                .with_timezone(&chrono::Utc);
        let other_expiry =
            chrono::DateTime::parse_from_rfc3339(&db.lease(&other.id).unwrap().unwrap().2)
                .unwrap()
                .with_timezone(&chrono::Utc);
        assert!(revoked_expiry <= chrono::Utc::now());
        assert!(other_expiry > chrono::Utc::now());
    }

    #[test]
    fn snapshot_is_scoped_and_exposes_only_the_mobile_provider_shape() {
        let (_directory, db, project, _worktree, _outside) = scope_fixture();
        let visible = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Visible"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "visible-session",
            })
            .unwrap();
        let project_root = resolve_mobile_cwd(&db, &project, None).unwrap();
        db.bind_session(&visible.id, Some(&project_root), None)
            .unwrap();
        let hidden = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Hidden"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "hidden-session",
            })
            .unwrap();
        db.update_settings(
            &json!({"secret":"must-not-leak","remoteMachines":{"enabled":false}}),
            0,
            "secret-setting",
        )
        .unwrap();

        let value = snapshot(
            &db,
            vec![json!({
                "id":"fixture","name":"Fixture","installed":true,"terminal":true,"chat":false,
                "auth":"authenticated","version":"1","source":"builtin","homepage":"secret",
                "signIn":{"command":"secret"}
            })],
            DevicePermission::Readonly,
        )
        .unwrap();
        let encoded = value.to_string();
        assert!(encoded.contains(&visible.id));
        assert!(!encoded.contains(&hidden.id));
        assert!(!encoded.contains("must-not-leak"));
        assert!(!encoded.contains("homepage"));
        assert!(!encoded.contains("signIn"));
        assert!(value["capabilities"]["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("mobile.snapshot")));
        assert!(!value["capabilities"]["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("chat.send")));
        let control = snapshot(&db, vec![], DevicePermission::Fullcontrol).unwrap();
        assert!(control["capabilities"]["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("chat.option.set")));
    }

    #[test]
    fn provider_projection_is_a_closed_shape() {
        let value = sanitize_provider(json!({"id":"codex","name":"Codex","installed":true,"terminal":true,"chat":true,"auth":"authenticated","version":"1","source":"builtin","homepage":"secret","signIn":{"command":"secret"}})).unwrap();
        assert_eq!(
            value,
            json!({"id":"codex","name":"Codex","installed":true,"terminal":true,"chat":true,"auth":"authenticated","version":"1"})
        );
    }

    #[test]
    fn revoked_frames_have_stable_pre_auth_and_control_shapes() {
        assert_eq!(
            authentication_failed(),
            json!({
                "kind":"authentication_failed",
                "code":"mobile_revoked",
                "message":"Mobile credential is no longer valid",
            }),
        );
        assert_eq!(
            revoked_event("runtime-epoch", "credential_expired"),
            json!({
                "v":crate::PROTOCOL_VERSION,
                "event":"mobile.revoked",
                "epoch":"runtime-epoch",
                "seq":0,
                "data":{"reason":"credential_expired"},
            }),
        );
    }

    #[test]
    fn live_permission_change_downgrades_and_upgrades_without_reconnecting() {
        let (_directory, db, project, _worktree, _outside) = scope_fixture();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project),
                title: Some("Live permission"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "live-permission-session",
            })
            .unwrap();
        let groups = ConnectionGroups::default();
        let (closed, closed_rx) = watch::channel(false);
        groups.groups.lock().unwrap().insert(
            ("phone".into(), "client".into()),
            Group {
                epoch: "epoch".into(),
                permission: DevicePermission::Fullcontrol,
                closed,
            },
        );
        let principal = "mobile:phone:client";
        let lease = chrono::Utc::now() + chrono::Duration::minutes(5);
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES(?,?,1,?)",
                rusqlite::params![session.id, principal, lease.to_rfc3339()],
            )?;
            Ok(())
        })
        .unwrap();

        groups
            .set_permission("phone", DevicePermission::Readonly, &db)
            .unwrap();
        assert_eq!(
            authorize_method(groups.permission("phone", "client").unwrap(), "terminal.input")
                .unwrap_err()
                .code,
            "mobile_readonly",
            "the next request observes the stored live permission"
        );
        assert!(!*closed_rx.borrow(), "downgrade keeps the connection available for viewing");
        let expired = chrono::DateTime::parse_from_rfc3339(
            &db.lease(&session.id).unwrap().unwrap().2,
        )
        .unwrap()
        .with_timezone(&chrono::Utc);
        assert!(expired <= chrono::Utc::now(), "downgrade releases the control lease");

        groups
            .set_permission("phone", DevicePermission::Fullcontrol, &db)
            .unwrap();
        assert!(authorize_method(
            groups.permission("phone", "client").unwrap(),
            "terminal.input"
        )
        .is_ok());
        assert_eq!(
            authorize_method(DevicePermission::Fullcontrol, "device.permission.set")
                .unwrap_err()
                .code,
            "mobile_forbidden",
            "device administration stays unavailable to mobile principals"
        );
        assert!(!*closed_rx.borrow(), "upgrade takes effect on the same connection");
    }
}
