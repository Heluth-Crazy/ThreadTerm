//! Desktop peer transport. The pipe framing and lanes begin after this TLS-only handshake.
use crate::{db::Database, devices::DeviceManager, domain::RpcError, service::RuntimeService};
use anyhow::{anyhow, bail, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

pub(crate) const ALPN: &[u8] = b"threadterm-peer/1";
const CONTROL_CONNECTIONS: usize = 16;
const DEPENDENT_CONNECTIONS: usize = 32;
const TUNNEL_CONNECTIONS: usize = 64;
/// Credential and gate checks hit SQLite at most this often per device, so a
/// busy remote terminal costs no database work per frame. Revoke still fences
/// immediately through the in-memory group table.
const VALIDATION_INTERVAL: Duration = Duration::from_secs(1);

/// Host administration is deliberately guarded outside the local device dispatcher.
pub(crate) const DENIED_METHODS: &[&str] = &[
    "device.status",
    "device.enable",
    "device.tailscaleOnly.set",
    "device.iroh.set",
    "device.peer.dial",
    "device.disable",
    "device.identity.reset",
    "device.pairing.create",
    "device.pairing.cancel",
    "device.list",
    "device.rename",
    "device.renew",
    "device.revoke",
    "runtime.shutdown",
    "runtime.resourceSample",
    "data.status",
    "data.backup",
    "data.backup.verify",
    "data.relocation.status",
    "data.relocation.prepare",
    "data.relocation.cancel",
    "qa.chat.projection.fail",
];

/// The peer ALPN can only authenticate desktop-profile credentials.  Keep the
/// navigation surface explicit nevertheless: a future method below this prefix
/// is host-only until it is deliberately reviewed for desktop authority.
pub(crate) const DESKTOP_EDITOR_NAVIGATION_METHODS: &[&str] = &[
    "editorNavigation.configuration",
    "editorNavigation.configure",
    "editorNavigation.prepare",
    "editorNavigation.status",
    "editorNavigation.sync",
    "editorNavigation.definition",
    "editorNavigation.documentSymbols",
    "editorNavigation.cancel",
    "editorNavigation.release",
];

type GroupKey = (String, String);
struct Group {
    epoch: String,
    closed: watch::Sender<bool>,
}

pub(crate) struct ConnectionGroups {
    groups: Arc<Mutex<HashMap<GroupKey, Group>>>,
    validated: Mutex<HashMap<String, Instant>>,
    controls: Arc<Semaphore>,
    dependents: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    tunnels: Arc<Semaphore>,
    #[cfg(test)]
    pub(crate) credential_bytes: std::sync::atomic::AtomicUsize,
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
            #[cfg(test)]
            credential_bytes: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl ConnectionGroups {
    pub(crate) fn connected(&self, device: &str) -> bool {
        self.groups.lock().map(|groups| groups.keys().any(|(id, _)| id == device)).unwrap_or(false)
    }

    fn contains(&self, device: &str, client: &str) -> bool {
        self.groups
            .lock()
            .map(|groups| groups.contains_key(&(device.into(), client.into())))
            .unwrap_or(false)
    }

    /// The gate is on and the credential is live; extends the idle expiry.
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
        if !devices.remote_machines_enabled()? {
            bail!("remote_machines_disabled");
        }
        devices.peer_activity(device)?;
        if let Ok(mut validated) = self.validated.lock() {
            validated.insert(device.to_owned(), Instant::now());
        }
        Ok(())
    }

    /// Called by local revoke after credential invalidation. Wake every channel
    /// and fence lease effects immediately, preserving lease epochs.
    pub(crate) fn revoke(&self, device: &str, db: &Database) -> Result<()> {
        if let Ok(mut validated) = self.validated.lock() {
            validated.remove(device);
        }
        let mut groups = self
            .groups
            .lock()
            .map_err(|_| anyhow!("peer groups poisoned"))?;
        groups.retain(|(id, _), group| {
            if id == device {
                group.closed.send_replace(true);
                false
            } else {
                true
            }
        });
        drop(groups);
        db.transaction(|tx| {
            tx.execute(
                "UPDATE leases SET expires_at=? WHERE substr(client_id,1,length(?))=?",
                rusqlite::params![
                    chrono::Utc::now().to_rfc3339(),
                    format!("peer:{device}:"),
                    format!("peer:{device}:")
                ],
            )?;
            Ok(())
        })
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
        let principal = format!("peer:{}:{}", self.key.0, self.key.1);
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

/// Authority is device-scoped (`peer:<device>`); the principal passed on to
/// lease/browser services includes the client id so windows cannot share presence.
/// Run again at execution, rather than only at enqueue, to reject revoked work.
pub(crate) fn guard(
    service: &RuntimeService,
    principal: &str,
    method: &str,
) -> std::result::Result<(), RpcError> {
    let Some(identity) = principal.strip_prefix("peer:") else {
        return Ok(());
    };
    if method.starts_with("desktop.files.")
        || DENIED_METHODS.contains(&method)
        || (method.starts_with("editorNavigation.")
            && !DESKTOP_EDITOR_NAVIGATION_METHODS.contains(&method))
    {
        return Err(failure(
            "peer_forbidden",
            "This method is available only on the host",
        ));
    }
    let (device, client) = identity
        .split_once(':')
        .ok_or_else(|| failure("peer_revoked", "Peer connection is unavailable"))?;
    let remote = service
        .remote
        .get()
        .ok_or_else(|| failure("peer_revoked", "Peer connection is unavailable"))?;
    if !remote.is_enabled() || !remote.peers.contains(device, client) {
        return Err(failure("peer_revoked", "Peer connection is unavailable"));
    }
    remote
        .peers
        .validate(&remote.devices, device)
        .map_err(|_| failure("peer_revoked", "Peer credential is no longer valid"))
}

/// Test-only version skew. Release binaries contain no environment override.
pub(crate) fn advertised_contract() -> u32 {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("THREADTERM_QA_PEER_CONTRACT") {
        if let Ok(contract) = value.parse() { return contract; }
    }
    crate::PROTOCOL_CONTRACT
}

#[cfg(windows)]
pub(crate) async fn accept<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: T,
    remote: Arc<crate::remote_access::RemoteAccess>,
    generation: u64,
    address: String,
) -> Result<()> {
    use crate::{
        transport::{read_json, write_json},
        PROTOCOL_VERSION, RUNTIME_VERSION,
    };
    use base64::Engine;
    use rand::RngCore;
    use serde_json::{json, Value};
    use tokio::time::timeout;

    if !remote.peer_enabled(generation) {
        bail!("remote_machines_disabled");
    }
    let handshake_permit = Arc::clone(&remote.peers.handshakes)
        .try_acquire_owned()
        .map_err(|_| anyhow!("peer handshake limit"))?;
    let service = remote
        .runtime()
        .ok_or_else(|| anyhow!("runtime unavailable"))?;
    let contract = advertised_contract();
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
    write_json(
        &mut stream,
        &json!({"kind":"challenge", "protocol":PROTOCOL_VERSION,
        "contract":contract, "nonce":nonce, "version":RUNTIME_VERSION}),
    )
    .await?;
    let auth = timeout(Duration::from_secs(10), read_json(&mut stream)).await??;
    #[cfg(test)]
    remote.peers.credential_bytes.fetch_add(
        auth.get("credential")
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0),
        std::sync::atomic::Ordering::Relaxed,
    );
    if auth.get("kind").and_then(Value::as_str) != Some("auth") {
        bail!("authentication required");
    }
    if auth.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
        || auth.get("contract").and_then(Value::as_u64) != Some(contract as u64)
    {
        let mut incompatible = json!({"kind":"incompatible", "code":"protocol_incompatible",
            "protocol":PROTOCOL_VERSION, "contract":contract, "version":RUNTIME_VERSION});
        for (source, target) in [
            ("protocol", "receivedProtocol"),
            ("contract", "receivedContract"),
        ] {
            if let Some(value) = auth.get(source).and_then(Value::as_u64) {
                incompatible[target] = json!(value);
            }
        }
        if let Some(version) = auth.get("version").and_then(Value::as_str) {
            incompatible["receivedVersion"] = json!(version);
        }
        write_json(&mut stream, &incompatible).await?;
        bail!("protocol_incompatible");
    }
    if auth.get("nonce").and_then(Value::as_str) != Some(&nonce) {
        bail!("invalid nonce");
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
    if !matches!(channel, "control" | "output" | "browser" | "tunnel") {
        bail!("unsupported peer channel");
    }
    let target = if channel == "tunnel" {
        Some(crate::tunnel::target(&auth)?)
    } else {
        None
    };
    let pool = if channel == "tunnel" {
        &remote.peers.tunnels
    } else if channel == "control" {
        &remote.peers.controls
    } else {
        &remote.peers.dependents
    };
    let _permit = Arc::clone(pool)
        .try_acquire_owned()
        .map_err(|_| anyhow!("peer connection limit"))?;
    let credential = auth
        .get("credential")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("credential required"))?
        .to_owned();
    let devices = remote.devices.clone();
    let device =
        tokio::task::spawn_blocking(move || devices.authenticate_peer(&credential)).await??;
    let epoch = service.db.epoch()?;
    let key = (device.id.clone(), client.to_owned());
    let mut lifetime = None;
    let mut closed = {
        let mut groups = remote
            .peers
            .groups
            .lock()
            .map_err(|_| anyhow!("peer groups poisoned"))?;
        // Recheck after authentication and before publication, including a
        // revoke racing the handshake. No stream is acknowledged before this.
        remote.devices.validate_peer(&device.id)?;
        if channel == "control" {
            if auth.get("epoch") != Some(&Value::Null) {
                bail!("control epoch must be null");
            }
            if groups.contains_key(&key) {
                bail!("control already connected");
            }
            let (sender, receiver) = watch::channel(false);
            groups.insert(
                key.clone(),
                Group {
                    epoch: epoch.clone(),
                    closed: sender,
                },
            );
            lifetime = Some(ControlLifetime {
                groups: Arc::clone(&remote.peers.groups),
                key,
                db: Arc::clone(&service.db),
            });
            receiver
        } else {
            let group = groups
                .get(&key)
                .ok_or_else(|| anyhow!("live control required"))?;
            if auth.get("epoch").and_then(Value::as_str) != Some(group.epoch.as_str()) {
                bail!("control epoch mismatch");
            }
            group.closed.subscribe()
        }
    };
    let principal = format!("peer:{}:{client}", device.id);
    remote.devices.peer_activity(&device.id)?;
    // Persist only an address, never credentials. Authentication activity itself
    // is recorded by DeviceManager, coalesced for long-lived streams.
    remote.record_peer_address(&device.id, &address)?;
    drop(handshake_permit);
    let result = {
        let connection = async {
            // Target establishment is cancellable by the same group/gate/shutdown
            // select as forwarding. Never acknowledge a failed target connection.
            let mut target_stream = if let Some(target) = target {
                match crate::tunnel::connect(target).await {
                    Ok(socket) => Some(socket),
                    Err(error) => {
                        write_json(&mut stream, &json!({"kind":"tunnel_failed", "code":crate::tunnel::failure_code(&error)})).await?;
                        return Ok(());
                    }
                }
            } else {
                None
            };
            write_json(
                &mut stream,
                &json!({"kind":"authenticated", "protocol":PROTOCOL_VERSION,
            "contract":contract, "principal":principal, "epoch":epoch}),
            )
            .await?;
            match channel {
                "control" => {
                    crate::transport::serve_control(stream, Arc::clone(&service), principal).await
                }
                "output" => {
                    crate::transport::serve_output(stream, Arc::clone(&service), principal).await
                }
                "browser" => {
                    crate::transport::serve_browser(stream, Arc::clone(&service), principal).await
                }
                "tunnel" => {
                    tokio::io::copy_bidirectional(&mut stream, target_stream.as_mut().expect("tunnel target")).await?;
                    Ok(())
                }
                _ => unreachable!(),
            }
        };
        tokio::pin!(connection);
        loop {
            tokio::select! {
                result = &mut connection => break result,
                _ = closed.changed() => break Ok(()),
                _ = service.wait_for_shutdown() => break Ok(()),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if !remote.is_generation_enabled(generation)
                        || remote.peers.validate(&remote.devices, &device.id).is_err()
                    {
                        break Ok(());
                    }
                }
            }
        }
    }; // Drop the TLS stream before lease cleanup can wait for SQLite.
    drop(lifetime);
    result
}
