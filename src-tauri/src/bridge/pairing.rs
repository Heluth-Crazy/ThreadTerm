use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rand::{Rng, distributions::Alphanumeric};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::protocol::{BridgeDevice, DevicePermission, PairQrResponse, PairRequest, PairResponse};

const OTP_TTL: Duration = Duration::from_secs(5 * 60);
const DEVICE_TOKEN_TTL_SECONDS: u64 = 24 * 60 * 60;

pub struct PairingStore {
    inner: Mutex<PairingInner>,
    persistent: bool,
}

#[derive(Default)]
struct PairingInner {
    pending: HashMap<String, PendingPair>,
    devices: HashMap<String, StoredDevice>,
}

#[derive(Clone)]
struct PendingPair {
    host: String,
    port: u16,
    expires_at: u64,
}

#[derive(Clone)]
struct StoredDevice {
    device: BridgeDevice,
    expires_at: u64,
}

impl PairingStore {
    fn new(persistent: bool) -> Self {
        Self {
            inner: Mutex::new(PairingInner::default()),
            persistent,
        }
    }

    #[cfg(test)]
    fn memory_only() -> Self {
        Self::new(false)
    }

    pub fn create_pair_qr(&self, host: String, port: u16) -> PairQrResponse {
        let mut inner = self.inner.lock().expect("pairing store poisoned");
        let now = now_seconds();
        inner.pending.retain(|_, pending| pending.expires_at > now);

        let otp = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000));
        let expires_at = now + OTP_TTL.as_secs();
        inner.pending.insert(
            otp.clone(),
            PendingPair {
                host: host.clone(),
                port,
                expires_at,
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
                permission: request.permission.unwrap_or(DevicePermission::Full),
                created_at: now,
                last_seen_at: Some(now),
            };

            inner.devices.insert(
                hash.clone(),
                StoredDevice {
                    device: device.clone(),
                    expires_at: device_expires_at(now),
                },
            );

            (pending, device)
        };

        if self.persistent {
            if let Err(message) = persist_paired_device(&hash, &device) {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.devices.remove(&hash);
                }
                return Err(message);
            }
        }

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

        let memory_device = {
            let mut inner = self.inner.lock().ok()?;
            let expired = inner
                .devices
                .get(&hash)
                .map(|stored| stored.expires_at <= now)
                .unwrap_or(false);
            if expired {
                inner.devices.remove(&hash);
                None
            } else {
                inner.devices.get_mut(&hash).map(|stored| {
                    stored.device.last_seen_at = Some(now);
                    stored.device.clone()
                })
            }
        };

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
            inner.devices.insert(hash, stored);
        }
        Some(device)
    }

    pub fn list_devices(&self) -> Vec<BridgeDevice> {
        let now = now_seconds();

        if self.persistent {
            match list_paired_devices(now) {
                Ok(stored_devices) => {
                    let mut seen_ids = HashSet::new();
                    let mut devices = Vec::new();

                    if let Ok(mut inner) = self.inner.lock() {
                        for (hash, stored) in stored_devices {
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

    pub fn revoke_device(&self, device_id: &str) -> bool {
        let removed_from_memory = self
            .inner
            .lock()
            .map(|mut inner| {
                let before = inner.devices.len();
                inner
                    .devices
                    .retain(|_, stored| stored.device.id != device_id);
                inner.devices.len() != before
            })
            .unwrap_or(false);

        if !self.persistent {
            return removed_from_memory;
        }

        match delete_paired_device_by_id(device_id) {
            Ok(removed_from_db) => removed_from_memory || removed_from_db,
            Err(error) => {
                tracing::debug!(error = %error, device_id, "Failed to revoke mobile bridge device from database");
                removed_from_memory
            }
        }
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
        Arc,
        atomic::{AtomicUsize, Ordering},
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
                permission  TEXT NOT NULL DEFAULT 'full',
                created_at  INTEGER NOT NULL,
                last_seen_at INTEGER
            );
            ",
        )
        .expect("create paired_devices table");
        conn
    }

    #[test]
    fn pairing_otp_is_single_use() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174);

        let response = store
            .pair(PairRequest {
                otp: qr.otp.clone(),
                device_name: "iPhone".to_string(),
                permission: None,
            })
            .expect("pair device");

        assert_eq!(response.device.name, "iPhone");
        assert!(store.validate_token(&response.device_token).is_some());
        assert!(
            store
                .pair(PairRequest {
                    otp: qr.otp,
                    device_name: "iPad".to_string(),
                    permission: None,
                })
                .is_err()
        );
    }

    #[test]
    fn expired_pairing_otp_is_rejected() {
        let store = test_store();
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174);

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
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174);
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
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174);
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
        let qr = store.create_pair_qr("127.0.0.1".to_string(), 5174);
        let response = store
            .pair(PairRequest {
                otp: qr.otp,
                device_name: "iPhone".to_string(),
                permission: Some(DevicePermission::ReadOnly),
            })
            .expect("pair device");

        assert!(store.revoke_device(&response.device.id));
        assert!(store.validate_token(&response.device_token).is_none());
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
            .query_row([hash.as_str()], |row| row_to_stored_device(row))
            .expect("query stored device");

        assert_eq!(stored_hash, hash);
        assert_eq!(stored.device, device);
        assert_eq!(stored.expires_at, device_expires_at(now));
    }
}
