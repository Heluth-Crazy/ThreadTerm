use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};

use super::protocol::{BridgeDevice, DevicePermission, PairQrResponse, PairRequest, PairResponse};

const OTP_TTL: Duration = Duration::from_secs(5 * 60);
const DEVICE_TOKEN_TTL_SECONDS: u64 = 24 * 60 * 60;

#[derive(Default)]
pub struct PairingStore {
    inner: Mutex<PairingInner>,
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
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let now = now_seconds();
        inner.pending.retain(|_, pending| pending.expires_at > now);

        let pending = inner
            .pending
            .remove(&request.otp)
            .ok_or_else(|| "Invalid or expired pairing code".to_string())?;

        let token = random_token(48);
        let device = BridgeDevice {
            id: format!("dev_{}", random_token(16)),
            name: clean_device_name(&request.device_name),
            permission: request.permission.unwrap_or(DevicePermission::Full),
            created_at: now,
            last_seen_at: Some(now),
        };

        let hash = token_hash(&token);
        inner.devices.insert(
            hash.clone(),
            StoredDevice {
                device: device.clone(),
                expires_at: now + DEVICE_TOKEN_TTL_SECONDS,
            },
        );

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
        let mut inner = self.inner.lock().ok()?;
        let hash = token_hash(token);
        let now = now_seconds();
        if inner
            .devices
            .get(&hash)
            .map(|stored| stored.expires_at <= now)
            .unwrap_or(false)
        {
            inner.devices.remove(&hash);
            return None;
        }

        let stored = inner.devices.get_mut(&hash)?;
        stored.device.last_seen_at = Some(now_seconds());
        Some(stored.device.clone())
    }

    pub fn list_devices(&self) -> Vec<BridgeDevice> {
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
        self.inner
            .lock()
            .map(|mut inner| {
                let before = inner.devices.len();
                inner
                    .devices
                    .retain(|_, stored| stored.device.id != device_id);
                inner.devices.len() != before
            })
            .unwrap_or(false)
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

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::thread;

    #[test]
    fn pairing_otp_is_single_use() {
        let store = PairingStore::default();
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
        let store = PairingStore::default();
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
        let store = PairingStore::default();
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
        let store = Arc::new(PairingStore::default());
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
        let store = PairingStore::default();
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
}
