use std::{
    collections::{HashMap, HashSet},
    sync::{Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::protocol::{BridgeDevice, DevicePermission, PairQrResponse, PairRequest, PairResponse};

const OTP_TTL: Duration = Duration::from_secs(5 * 60);
const DEVICE_TOKEN_TTL_SECONDS: u64 = 24 * 60 * 60;
// 32 characters sampled uniformly from 62 alphanumeric symbols provide
// approximately 190 bits of entropy while remaining URL/query safe.
const PAIRING_SECRET_LENGTH: usize = 32;
const AUTHORIZATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

pub struct PairingStore {
    inner: Mutex<PairingInner>,
    lease_idle: Condvar,
    persistent: bool,
    auth_revision: watch::Sender<u64>,
}

#[derive(Default)]
struct PairingInner {
    pending: HashMap<String, PendingPair>,
    devices: HashMap<String, StoredDevice>,
    revoked_device_ids: HashSet<String>,
    active_leases: HashMap<String, usize>,
}

#[derive(Clone)]
struct PendingPair {
    host: String,
    port: u16,
    expires_at: u64,
    max_permission: DevicePermission,
}

#[derive(Clone)]
struct StoredDevice {
    device: BridgeDevice,
    expires_at: u64,
}

/// Proves that a Full-control authorization was revalidated atomically
/// against revocation immediately before a side effect began.
///
/// Revocation tombstones the device first, preventing new leases, then waits
/// for every existing guard to drop before it reports success.
pub(crate) struct AuthorizationLease<'a> {
    store: &'a PairingStore,
    device_id: String,
}

impl Drop for AuthorizationLease<'_> {
    fn drop(&mut self) {
        self.store.release_authorization_lease(&self.device_id);
    }
}

impl PairingStore {
    fn new(persistent: bool) -> Self {
        let (auth_revision, _) = watch::channel(0);
        Self {
            inner: Mutex::new(PairingInner::default()),
            lease_idle: Condvar::new(),
            persistent,
            auth_revision,
        }
    }

    #[cfg(test)]
    fn memory_only() -> Self {
        Self::new(false)
    }

    pub fn create_pair_qr(
        &self,
        host: String,
        port: u16,
        max_permission: DevicePermission,
    ) -> PairQrResponse {
        let mut inner = self.inner.lock().expect("pairing store poisoned");
        let now = now_seconds();
        // A newly issued code supersedes every older permission choice. This
        // prevents a previously displayed full-control QR from remaining
        // usable after the desktop switches back to read-only mode.
        inner.pending.clear();

        let otp = random_token(PAIRING_SECRET_LENGTH);
        let expires_at = now + OTP_TTL.as_secs();
        inner.pending.insert(
            otp.clone(),
            PendingPair {
                host: host.clone(),
                port,
                expires_at,
                max_permission,
            },
        );

        PairQrResponse {
            host: host.clone(),
            port,
            otp: otp.clone(),
            url: format!("http://{host}:{port}/pair?otp={otp}"),
            expires_in_seconds: OTP_TTL.as_secs(),
        }
    }

    pub fn pair(&self, request: PairRequest) -> Result<PairResponse, String> {
        self.pair_with_persist(request, |hash, device| {
            if self.persistent {
                persist_paired_device(hash, device)
            } else {
                Ok(())
            }
        })
    }

    fn pair_with_persist<F>(&self, request: PairRequest, persist: F) -> Result<PairResponse, String>
    where
        F: FnOnce(&str, &BridgeDevice) -> Result<(), String>,
    {
        let now = now_seconds();
        let token = random_token(48);
        let hash = token_hash(&token);
        let (pending, device) = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.pending.retain(|_, pending| pending.expires_at > now);

            let pending = inner
                .pending
                .remove(&request.otp)
                .ok_or_else(|| "Invalid or expired pairing code".to_string())?;

            let device = BridgeDevice {
                id: format!("dev_{}", random_token(16)),
                name: clean_device_name(&request.device_name),
                // The OTP is the server-side authority. The untrusted client
                // request may attenuate a full-control code, but can never
                // elevate a read-only code.
                permission: if matches!(&pending.max_permission, DevicePermission::Full)
                    && matches!(&request.permission, Some(DevicePermission::Full))
                {
                    DevicePermission::Full
                } else {
                    DevicePermission::ReadOnly
                },
                created_at: now,
                last_seen_at: Some(now),
            };

            // Persist before publishing the authorization and keep both
            // operations inside the pairing critical section. Otherwise a
            // concurrent revoke can delete zero DB rows between the memory
            // insert and this write, after which the token reappears on the
            // next application launch.
            persist(&hash, &device)?;

            inner.devices.insert(
                hash.clone(),
                StoredDevice {
                    device: device.clone(),
                    expires_at: device_expires_at(now),
                },
            );

            (pending, device)
        };

        tracing::info!(
            host = %pending.host,
            port = pending.port,
            device_id = %device.id,
            "Mobile bridge device paired"
        );

        Ok(PairResponse {
            device,
            device_token: token,
            expires_in_seconds: DEVICE_TOKEN_TTL_SECONDS,
        })
    }

    pub fn validate_token(&self, token: &str) -> Option<BridgeDevice> {
        let hash = token_hash(token);
        let now = now_seconds();

        let (memory_device, removed_expired) = {
            let mut inner = self.inner.lock().ok()?;
            let invalid = inner
                .devices
                .get(&hash)
                .map(|stored| {
                    stored.expires_at <= now || inner.revoked_device_ids.contains(&stored.device.id)
                })
                .unwrap_or(false);
            if invalid {
                inner.devices.remove(&hash);
                (None, true)
            } else {
                (
                    inner.devices.get_mut(&hash).map(|stored| {
                        stored.device.last_seen_at = Some(now);
                        stored.device.clone()
                    }),
                    false,
                )
            }
        };

        if removed_expired {
            self.notify_auth_changed();
        }

        if let Some(device) = memory_device {
            if self.persistent {
                if let Err(error) = update_paired_device_last_seen(&hash, now) {
                    tracing::debug!(error = %error, "Failed to update mobile bridge device last_seen_at");
                }
            }
            return Some(device);
        }

        if !self.persistent {
            return None;
        }

        let mut stored = match load_paired_device_by_hash(&hash, now) {
            Ok(Some(stored)) => stored,
            Ok(None) => return None,
            Err(error) => {
                tracing::debug!(error = %error, "Failed to load mobile bridge device from database");
                return None;
            }
        };

        stored.device.last_seen_at = Some(now);
        if let Err(error) = update_paired_device_last_seen(&hash, now) {
            tracing::debug!(error = %error, "Failed to update mobile bridge device last_seen_at");
        }

        let device = stored.device.clone();
        if let Ok(mut inner) = self.inner.lock() {
            if inner.revoked_device_ids.contains(&device.id) {
                return None;
            }
            inner.devices.insert(hash, stored);
        }
        Some(device)
    }

    pub fn subscribe_auth_revision(&self) -> watch::Receiver<u64> {
        self.auth_revision.subscribe()
    }

    pub fn is_device_active(&self, device_id: &str) -> bool {
        let now = now_seconds();
        let (active, removed_expired) = self
            .inner
            .lock()
            .map(|mut inner| {
                let before = inner.devices.len();
                let revoked = inner.revoked_device_ids.clone();
                inner.devices.retain(|_, stored| {
                    stored.expires_at > now && !revoked.contains(&stored.device.id)
                });
                let active = inner
                    .devices
                    .values()
                    .any(|stored| stored.device.id == device_id);
                (active, inner.devices.len() != before)
            })
            .unwrap_or((false, false));

        if removed_expired {
            self.notify_auth_changed();
        }
        active
    }

    pub(crate) fn acquire_active_lease(
        &self,
        device_id: &str,
    ) -> Result<AuthorizationLease<'_>, String> {
        self.acquire_authorization_lease(device_id, false)
    }

    pub(crate) fn acquire_full_lease(
        &self,
        device_id: &str,
    ) -> Result<AuthorizationLease<'_>, String> {
        self.acquire_authorization_lease(device_id, true)
    }

    fn acquire_authorization_lease(
        &self,
        device_id: &str,
        require_full: bool,
    ) -> Result<AuthorizationLease<'_>, String> {
        let now = now_seconds();
        let mut inner = self
            .inner
            .lock()
            .map_err(|error| format!("Pairing state unavailable: {error}"))?;

        if inner.revoked_device_ids.contains(device_id) {
            return Err("This mobile bridge authorization was revoked.".to_string());
        }

        let matching = inner
            .devices
            .values()
            .find(|stored| stored.device.id == device_id)
            .cloned()
            .ok_or_else(|| "This mobile bridge authorization is no longer active.".to_string())?;

        if matching.expires_at <= now {
            inner
                .devices
                .retain(|_, stored| stored.device.id != device_id);
            drop(inner);
            self.notify_auth_changed();
            return Err("This mobile bridge authorization expired.".to_string());
        }
        if require_full && matching.device.permission != DevicePermission::Full {
            return Err("This device is paired in read-only mode.".to_string());
        }

        *inner
            .active_leases
            .entry(device_id.to_string())
            .or_insert(0) += 1;

        Ok(AuthorizationLease {
            store: self,
            device_id: device_id.to_string(),
        })
    }

    fn release_authorization_lease(&self, device_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(count) = inner.active_leases.get_mut(device_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                inner.active_leases.remove(device_id);
            }
        }
        drop(inner);
        self.lease_idle.notify_all();
    }

    pub fn list_devices(&self) -> Vec<BridgeDevice> {
        let now = now_seconds();

        if self.persistent {
            match list_paired_devices(now) {
                Ok(stored_devices) => {
                    let mut seen_ids = HashSet::new();
                    let mut devices = Vec::new();

                    if let Ok(mut inner) = self.inner.lock() {
                        let revoked = inner.revoked_device_ids.clone();
                        for (hash, stored) in stored_devices {
                            if revoked.contains(&stored.device.id) {
                                continue;
                            }
                            seen_ids.insert(stored.device.id.clone());
                            devices.push(stored.device.clone());
                            inner.devices.insert(hash, stored);
                        }

                        for stored in inner.devices.values() {
                            if seen_ids.insert(stored.device.id.clone()) {
                                devices.push(stored.device.clone());
                            }
                        }
                    } else {
                        devices.extend(stored_devices.into_iter().map(|(_, stored)| stored.device));
                    }

                    devices.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
                    return devices;
                }
                Err(error) => {
                    tracing::debug!(error = %error, "Failed to list mobile bridge devices from database");
                }
            }
        }

        self.inner
            .lock()
            .map(|inner| {
                inner
                    .devices
                    .values()
                    .map(|stored| stored.device.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool, String> {
        self.revoke_device_with_timeout(device_id, AUTHORIZATION_DRAIN_TIMEOUT)
    }

    fn revoke_device_with_timeout(
        &self,
        device_id: &str,
        timeout: Duration,
    ) -> Result<bool, String> {
        let removed_from_memory = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|error| format!("Pairing state unavailable: {error}"))?;
            // Tombstone while holding the same mutex used by lease acquisition.
            // Once this insertion completes, no new Full side effect can begin.
            inner.revoked_device_ids.insert(device_id.to_string());
            let before = inner.devices.len();
            inner
                .devices
                .retain(|_, stored| stored.device.id != device_id);
            inner.devices.len() != before
        };
        self.notify_auth_changed();

        // Delete persistent authority before waiting. If the process exits
        // during a drain timeout, the revoked token cannot reappear at restart.
        let database_result = if self.persistent {
            delete_paired_device_by_id(device_id)
        } else {
            Ok(false)
        };

        let deadline = Instant::now() + timeout;
        let mut inner = self
            .inner
            .lock()
            .map_err(|error| format!("Pairing state unavailable: {error}"))?;
        loop {
            let active = inner.active_leases.get(device_id).copied().unwrap_or(0);
            if active == 0 {
                break;
            }

            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(format!(
                    "Timed out waiting for {active} active mobile authorization operation(s) to finish."
                ));
            };
            let (next, wait_result) = self
                .lease_idle
                .wait_timeout(inner, remaining)
                .map_err(|error| format!("Pairing state unavailable: {error}"))?;
            inner = next;
            if wait_result.timed_out()
                && inner.active_leases.get(device_id).copied().unwrap_or(0) > 0
            {
                let active = inner.active_leases.get(device_id).copied().unwrap_or(0);
                return Err(format!(
                    "Timed out waiting for {active} active mobile authorization operation(s) to finish."
                ));
            }
        }

        let removed_from_db = database_result?;
        Ok(removed_from_memory || removed_from_db)
    }

    fn notify_auth_changed(&self) {
        self.auth_revision
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    #[cfg(test)]
    pub(crate) fn expire_device(&self, device_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            for stored in inner.devices.values_mut() {
                if stored.device.id == device_id {
                    stored.expires_at = now_seconds().saturating_sub(1);
                }
            }
        }
        self.notify_auth_changed();
    }
}

impl Default for PairingStore {
    fn default() -> Self {
        Self::new(!cfg!(test))
    }
}

fn clean_device_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Mobile Device".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn device_expires_at(created_at: u64) -> u64 {
    created_at.saturating_add(DEVICE_TOKEN_TTL_SECONDS)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn persist_paired_device(hash: &str, device: &BridgeDevice) -> Result<(), String> {
    let conn = crate::db::get_db()?;
    persist_paired_device_with_conn(&conn, hash, device)
        .map_err(|e| format!("Failed to persist paired mobile device: {e}"))
}

fn persist_paired_device_with_conn(
    conn: &rusqlite::Connection,
    hash: &str,
    device: &BridgeDevice,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO paired_devices (id, name, token_hash, permission, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(token_hash) DO UPDATE SET
            id = excluded.id,
            name = excluded.name,
            permission = excluded.permission,
            created_at = excluded.created_at,
            last_seen_at = excluded.last_seen_at",
        params![
            device.id,
            device.name,
            hash,
            permission_to_db(&device.permission),
            seconds_to_db(device.created_at),
            device.last_seen_at.map(seconds_to_db),
        ],
    )?;
    Ok(())
}

fn load_paired_device_by_hash(hash: &str, now: u64) -> Result<Option<StoredDevice>, String> {
    let conn = crate::db::get_db()?;
    delete_expired_paired_devices_with_conn(&conn, now)
        .map_err(|e| format!("Failed to prune expired mobile bridge devices: {e}"))?;

    conn.query_row(
        "SELECT id, name, token_hash, permission, created_at, last_seen_at
         FROM paired_devices
         WHERE token_hash = ?1",
        [hash],
        |row| row_to_stored_device(row).map(|(_, stored)| stored),
    )
    .optional()
    .map_err(|e| format!("Failed to load paired mobile device: {e}"))
}

fn list_paired_devices(now: u64) -> Result<Vec<(String, StoredDevice)>, String> {
    let conn = crate::db::get_db()?;
    delete_expired_paired_devices_with_conn(&conn, now)
        .map_err(|e| format!("Failed to prune expired mobile bridge devices: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, token_hash, permission, created_at, last_seen_at
             FROM paired_devices",
        )
        .map_err(|e| format!("Failed to prepare paired device list: {e}"))?;
    let rows = stmt
        .query_map([], row_to_stored_device)
        .map_err(|e| format!("Failed to query paired devices: {e}"))?;

    let mut devices = Vec::new();
    for row in rows {
        devices.push(row.map_err(|e| format!("Failed to read paired device: {e}"))?);
    }
    Ok(devices)
}

fn update_paired_device_last_seen(hash: &str, last_seen_at: u64) -> Result<(), String> {
    let conn = crate::db::get_db()?;
    conn.execute(
        "UPDATE paired_devices SET last_seen_at = ?1 WHERE token_hash = ?2",
        params![seconds_to_db(last_seen_at), hash],
    )
    .map_err(|e| format!("Failed to update paired mobile device: {e}"))?;
    Ok(())
}

fn delete_paired_device_by_id(device_id: &str) -> Result<bool, String> {
    let conn = crate::db::get_db()?;
    let affected = conn
        .execute("DELETE FROM paired_devices WHERE id = ?1", [device_id])
        .map_err(|e| format!("Failed to delete paired mobile device: {e}"))?;
    Ok(affected > 0)
}

fn delete_expired_paired_devices_with_conn(
    conn: &rusqlite::Connection,
    now: u64,
) -> rusqlite::Result<usize> {
    let cutoff = now.saturating_sub(DEVICE_TOKEN_TTL_SECONDS);
    conn.execute(
        "DELETE FROM paired_devices WHERE created_at <= ?1",
        [seconds_to_db(cutoff)],
    )
}

fn row_to_stored_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, StoredDevice)> {
    let created_at = db_to_seconds(row.get::<_, i64>(4)?);
    let last_seen_at = row.get::<_, Option<i64>>(5)?.map(db_to_seconds);
    let hash = row.get::<_, String>(2)?;
    let device = BridgeDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        permission: permission_from_db(&row.get::<_, String>(3)?),
        created_at,
        last_seen_at,
    };
    Ok((
        hash,
        StoredDevice {
            device,
            expires_at: device_expires_at(created_at),
        },
    ))
}

fn permission_to_db(permission: &DevicePermission) -> &'static str {
    match permission {
        DevicePermission::ReadOnly => "read_only",
        DevicePermission::Full => "full",
    }
}

fn permission_from_db(value: &str) -> DevicePermission {
    match value {
        "full" => DevicePermission::Full,
        _ => DevicePermission::ReadOnly,
    }
}

fn seconds_to_db(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn db_to_seconds(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    };
    use std::thread;

    fn test_store() -> PairingStore {
        PairingStore::memory_only()
    }

    fn create_test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE paired_devices (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                token_hash  TEXT NOT NULL UNIQUE,
                permission  TEXT NOT NULL DEFAULT 'read_only',
                created_at  INTEGER NOT NULL,
                last_seen_at INTEGER
            );
            ",
        )
        .expect("create paired_devices table");
        conn
    }

    #[test]
    fn pairing_secret_is_high_entropy_url_safe_and_unique() {
        let store = test_store();
        let mut secrets = HashSet::new();

        for _ in 0..256 {
            let qr =
                store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);
            assert_eq!(qr.otp.len(), PAIRING_SECRET_LENGTH);
            assert!(qr.otp.bytes().all(|byte| byte.is_ascii_alphanumeric()));
            assert!(qr.url.ends_with(&format!("?otp={}", qr.otp)));
            assert!(secrets.insert(qr.otp), "pairing secret collision");
        }
    }

    #[test]
    fn pairing_otp_is_single_use() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);

        let response = store
            .pair(PairRequest {
                otp: qr.otp.clone(),
                device_name: "iPhone".to_string(),
                permission: None,
            })
            .expect("pair device");

        assert_eq!(response.device.name, "iPhone");
        assert_eq!(response.device.permission, DevicePermission::ReadOnly);
        assert!(store.validate_token(&response.device_token).is_some());
        assert!(store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "iPad".to_string(),
                permission: None,
            })
            .is_err());
    }

    #[test]
    fn expired_pairing_otp_is_rejected() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);

        {
            let mut inner = store.inner.lock().expect("pairing store");
            let pending = inner.pending.get_mut(&qr.otp).expect("pending otp");
            pending.expires_at = now_seconds().saturating_sub(1);
        }

        let result = store.pair(PairRequest {
            otp: qr.otp,
            device_name: "Expired".to_string(),
            permission: None,
        });

        assert!(result.is_err());
    }

    #[test]
    fn device_tokens_are_hashed_and_expire() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "iPhone".to_string(),
                permission: None,
            })
            .expect("pair device");

        assert!(response.expires_in_seconds <= 24 * 60 * 60);

        let hash = token_hash(&response.device_token);
        {
            let inner = store.inner.lock().expect("pairing store");
            assert!(!inner.devices.contains_key(&response.device_token));
            assert!(inner.devices.contains_key(&hash));
        }

        assert!(store.validate_token(&response.device_token).is_some());

        {
            let mut inner = store.inner.lock().expect("pairing store");
            inner
                .devices
                .get_mut(&hash)
                .expect("stored device")
                .expires_at = now_seconds().saturating_sub(1);
        }

        assert!(store.validate_token(&response.device_token).is_none());
    }

    #[test]
    fn concurrent_pairing_allows_only_one_consumer() {
        let store = Arc::new(test_store());
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);
        let successes = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..8)
            .map(|idx| {
                let store = Arc::clone(&store);
                let successes = Arc::clone(&successes);
                let otp = qr.otp.clone();
                thread::spawn(move || {
                    if store
                        .pair(PairRequest {
                            otp,
                            device_name: format!("device-{idx}"),
                            permission: None,
                        })
                        .is_ok()
                    {
                        successes.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().expect("pairing thread");
        }

        assert_eq!(successes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn can_revoke_paired_device() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "iPhone".to_string(),
                permission: Some(DevicePermission::ReadOnly),
            })
            .expect("pair device");

        assert!(store
            .revoke_device(&response.device.id)
            .expect("revoke device"));
        assert!(store.validate_token(&response.device_token).is_none());
    }

    #[test]
    fn revoke_waits_for_existing_read_authorization_lease() {
        let store = Arc::new(test_store());
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "leased-device".to_string(),
                permission: None,
            })
            .expect("pair device");
        let lease = store
            .acquire_active_lease(&response.device.id)
            .expect("acquire read authorization lease");
        let (done_tx, done_rx) = mpsc::channel();
        let revoke_store = Arc::clone(&store);
        let device_id = response.device.id.clone();
        let revoke = thread::spawn(move || {
            done_tx
                .send(revoke_store.revoke_device(&device_id))
                .expect("publish revoke result");
        });

        let tombstone_deadline = Instant::now() + Duration::from_secs(1);
        while store.validate_token(&response.device_token).is_some() {
            assert!(
                Instant::now() < tombstone_deadline,
                "revoke should tombstone before waiting for the lease"
            );
            thread::yield_now();
        }
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(store.acquire_active_lease(&response.device.id).is_err());

        drop(lease);
        assert!(done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("revoke should finish after lease release")
            .expect("revoke should succeed"));
        revoke.join().expect("revoke thread");
    }

    #[test]
    fn revoke_timeout_remains_tombstoned_and_reports_failure() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "slow-device".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .expect("pair device");
        let lease = store
            .acquire_full_lease(&response.device.id)
            .expect("acquire authorization lease");

        let error = store
            .revoke_device_with_timeout(&response.device.id, Duration::from_millis(20))
            .expect_err("active lease should make revoke time out");
        assert!(error.contains("Timed out waiting"));
        assert!(store.validate_token(&response.device_token).is_none());
        assert!(store.acquire_full_lease(&response.device.id).is_err());

        drop(lease);
    }

    #[test]
    fn passive_expiry_blocks_new_authorization_lease() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "expiring-device".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .expect("pair device");
        let lease = store
            .acquire_full_lease(&response.device.id)
            .expect("acquire authorization lease");

        store.expire_device(&response.device.id);
        assert!(!store.is_device_active(&response.device.id));
        assert!(store.acquire_full_lease(&response.device.id).is_err());

        drop(lease);
    }

    #[test]
    fn read_only_pairing_code_cannot_be_elevated_by_client() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);

        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "tampered-client".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .expect("pair device");

        assert_eq!(response.device.permission, DevicePermission::ReadOnly);
    }

    #[test]
    fn full_pairing_code_can_grant_or_attenuate_permission() {
        let store = test_store();
        let full_qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let full = store
            .pair(PairRequest {
                otp: full_qr.otp,
                device_name: "full-client".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .expect("pair full device");
        assert_eq!(full.device.permission, DevicePermission::Full);

        let attenuated_qr =
            store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let attenuated = store
            .pair(PairRequest {
                otp: attenuated_qr.otp,
                device_name: "read-only-client".to_string(),
                permission: None,
            })
            .expect("pair attenuated device");
        assert_eq!(attenuated.device.permission, DevicePermission::ReadOnly);
    }

    #[test]
    fn issuing_new_pairing_code_invalidates_previous_code() {
        let store = test_store();
        let old_qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let _new_qr =
            store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::ReadOnly);

        assert!(store
            .pair(PairRequest {
                otp: old_qr.otp,
                device_name: "stale-full-code".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .is_err());
    }

    #[test]
    fn revoke_waits_until_persistence_and_memory_publication_are_atomic() {
        let store = Arc::new(test_store());
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174, DevicePermission::Full);
        let (persist_started_tx, persist_started_rx) = mpsc::channel();
        let (allow_persist_tx, allow_persist_rx) = mpsc::channel();

        let pair_store = Arc::clone(&store);
        let pair_thread = thread::spawn(move || {
            pair_store.pair_with_persist(
                PairRequest {
                    otp: qr.otp,
                    device_name: "atomic-pair".to_string(),
                    permission: Some(DevicePermission::Full),
                },
                move |_, device| {
                    persist_started_tx
                        .send(device.id.clone())
                        .expect("publish persistence start");
                    allow_persist_rx.recv().expect("allow persistence");
                    Ok(())
                },
            )
        });

        let device_id = persist_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("persistence should start");
        let (revoke_started_tx, revoke_started_rx) = mpsc::channel();
        let (revoke_done_tx, revoke_done_rx) = mpsc::channel();
        let revoke_store = Arc::clone(&store);
        let revoke_thread = thread::spawn(move || {
            revoke_started_tx.send(()).expect("publish revoke start");
            let result = revoke_store.revoke_device(&device_id);
            revoke_done_tx.send(result).expect("publish revoke result");
        });

        revoke_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("revoke should start");
        assert!(revoke_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        allow_persist_tx.send(()).expect("finish persistence");

        let paired = pair_thread
            .join()
            .expect("pairing thread")
            .expect("pairing should succeed");
        assert!(revoke_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("revoke should finish")
            .expect("revoke should succeed"));
        revoke_thread.join().expect("revoke thread");
        assert!(store.validate_token(&paired.device_token).is_none());
    }

    #[test]
    fn persisted_device_can_be_loaded_by_token_hash() {
        let conn = create_test_conn();
        let now = now_seconds();
        let hash = token_hash("device-token");
        let device = BridgeDevice {
            id: "dev_test".to_string(),
            name: "iPhone".to_string(),
            permission: DevicePermission::Full,
            created_at: now,
            last_seen_at: Some(now),
        };

        persist_paired_device_with_conn(&conn, &hash, &device).expect("persist device");
        let (stored_hash, stored) = conn
            .prepare(
                "SELECT id, name, token_hash, permission, created_at, last_seen_at
                 FROM paired_devices
                 WHERE token_hash = ?1",
            )
            .expect("prepare")
            .query_row([hash.as_str()], row_to_stored_device)
            .expect("query stored device");

        assert_eq!(stored_hash, hash);
        assert_eq!(stored.device, device);
        assert_eq!(stored.expires_at, device_expires_at(now));
    }
}
