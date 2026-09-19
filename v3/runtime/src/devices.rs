//! Pairing and device credential authority for the HTTPS remote-access surface.
//!
//! Pairing secrets and bearer tokens are deliberately write-only: only their
//! SHA-256 digests are persisted. The caller gets each credential once.
use crate::db::Database;
use anyhow::{bail, Context, Result};
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    str::FromStr,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const PAIRING_TTL_MINUTES: i64 = 5;
pub const DEVICE_TOKEN_TTL_HOURS: i64 = 24;
pub const MAX_PAIRING_ATTEMPTS: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePermission {
    Readonly,
    Fullcontrol,
}

impl fmt::Display for DevicePermission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Readonly => "readonly",
            Self::Fullcontrol => "fullcontrol",
        })
    }
}

impl FromStr for DevicePermission {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "readonly" => Ok(Self::Readonly),
            "fullcontrol" => Ok(Self::Fullcontrol),
            _ => bail!("invalid_device_permission"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub permission: DevicePermission,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub id: String,
    pub code: String,
    pub qr_payload: String,
    pub permission: DevicePermission,
    pub expires_at: String,
    pub server_url: String,
    pub tls_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub token: String,
    pub device: PairedDevice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedDevice {
    pub id: String,
    pub permission: DevicePermission,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAccessPreference {
    pub enabled: bool,
    pub port: Option<u16>,
    pub last_error: Option<String>,
}

struct NewPairing {
    id: String,
    secret: String,
    permission: DevicePermission,
    expires_at: String,
}

enum PairAttempt {
    Paired(PairingResult),
    Rejected,
}

#[derive(Clone)]
pub struct DeviceManager {
    db: Arc<Database>,
    pairing_replays: Arc<Mutex<HashMap<String, PairingOffer>>>,
}

impl DeviceManager {
    pub fn new(db: Arc<Database>) -> Result<Self> {
        let this = Self {
            db,
            pairing_replays: Arc::new(Mutex::new(HashMap::new())),
        };
        this.initialize()?;
        Ok(this)
    }

    fn initialize(&self) -> Result<()> {
        self.db.transaction(|tx| {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS remote_access_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    enabled INTEGER NOT NULL,
                    port INTEGER,
                    last_error TEXT
                 );
                 INSERT OR IGNORE INTO remote_access_state(singleton,enabled) VALUES(1,0);
                 CREATE TABLE IF NOT EXISTS device_pairings (
                    id TEXT PRIMARY KEY,
                    secret_hash BLOB NOT NULL,
                    permission TEXT NOT NULL CHECK(permission IN ('readonly','fullcontrol')),
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    consumed_at TEXT
                 );
                 CREATE TABLE IF NOT EXISTS paired_devices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    token_hash BLOB NOT NULL UNIQUE,
                    permission TEXT NOT NULL CHECK(permission IN ('readonly','fullcontrol')),
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    revoked_at TEXT
                 );
                 CREATE INDEX IF NOT EXISTS paired_devices_expiry ON paired_devices(expires_at);
                 CREATE INDEX IF NOT EXISTS device_pairings_expiry ON device_pairings(expires_at);",
            )?;
            let columns = {
                let mut statement = tx.prepare("PRAGMA table_info(remote_access_state)")?;
                let values = statement
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                values
            };
            if !columns.iter().any(|column| column == "port") {
                tx.execute(
                    "ALTER TABLE remote_access_state ADD COLUMN port INTEGER",
                    [],
                )?;
            }
            if !columns.iter().any(|column| column == "last_error") {
                tx.execute(
                    "ALTER TABLE remote_access_state ADD COLUMN last_error TEXT",
                    [],
                )?;
            }
            Ok(())
        })
    }

    pub fn enabled(&self) -> Result<bool> {
        Ok(self.remote_access_preference()?.enabled)
    }

    pub fn remote_access_preference(&self) -> Result<RemoteAccessPreference> {
        self.db.transaction(|tx| {
            let (enabled, port, last_error) = tx.query_row(
                "SELECT enabled,port,last_error FROM remote_access_state WHERE singleton=1",
                [],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            let port = port
                .map(u16::try_from)
                .transpose()
                .map_err(|_| anyhow::anyhow!("invalid stored remote port"))?;
            Ok(RemoteAccessPreference {
                enabled,
                port,
                last_error,
            })
        })
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        let current = self.remote_access_preference()?;
        self.set_remote_access_preference(enabled, current.port, current.last_error.as_deref())
    }

    pub fn set_remote_access_preference(
        &self,
        enabled: bool,
        port: Option<u16>,
        last_error: Option<&str>,
    ) -> Result<()> {
        self.db.transaction(|tx| {
            tx.execute(
                "UPDATE remote_access_state SET enabled=?,port=?,last_error=? WHERE singleton=1",
                params![enabled, port.map(i64::from), last_error],
            )?;
            Ok(())
        })
    }

    pub fn create_pairing(
        &self,
        permission: DevicePermission,
        operation_id: &str,
        server_url: &str,
        tls_fingerprint: &str,
    ) -> Result<PairingOffer> {
        self.create_pairing_at(
            permission,
            operation_id,
            server_url,
            tls_fingerprint,
            Utc::now(),
        )
    }

    fn create_pairing_at(
        &self,
        permission: DevicePermission,
        operation_id: &str,
        server_url: &str,
        tls_fingerprint: &str,
        now: DateTime<Utc>,
    ) -> Result<PairingOffer> {
        if operation_id.is_empty() {
            bail!("invalid operationId")
        }
        let mut replays = self
            .pairing_replays
            .lock()
            .map_err(|_| anyhow::anyhow!("pairing replay lock poisoned"))?;
        replays.retain(|_, offer| {
            parse_timestamp(&offer.expires_at)
                .map(|expires| expires > now)
                .unwrap_or(false)
        });
        if let Some(offer) = replays.get(operation_id) {
            return Ok(offer.clone());
        }
        let pairing = self.db.transaction(|tx| {
            if operation_exists(tx, operation_id)? {
                bail!("pairing_operation_already_completed")
            }
            let id = Uuid::new_v4().to_string();
            let mut secret_bytes = [0_u8; 16];
            rand::thread_rng().fill_bytes(&mut secret_bytes);
            let secret = hex::encode_upper(secret_bytes);
            let expires_at = timestamp(now + Duration::minutes(PAIRING_TTL_MINUTES));
            tx.execute(
                "INSERT INTO device_pairings(id,secret_hash,permission,created_at,expires_at,failed_attempts,consumed_at)
                 VALUES(?,?,?,?,?,0,NULL)",
                params![id, digest(secret.as_bytes()).as_slice(), permission.to_string(), timestamp(now), expires_at],
            )?;
            complete_operation(tx, operation_id, "device.pairing.create", &json!({"pairingId":id}))?;
            emit_device_change(tx, "pairing.created")?;
            Ok(NewPairing { id, secret, permission, expires_at })
        })?;
        let code = group_code(&pairing.secret);
        let data = json!({
            "v": 1,
            "serverUrl": server_url,
            "pairingId": pairing.id,
            "code": code,
            "tlsFingerprint": tls_fingerprint,
        });
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&data)?);
        let offer = PairingOffer {
            id: pairing.id,
            code,
            qr_payload: format!("threadterm://pair?data={encoded}"),
            permission: pairing.permission,
            expires_at: pairing.expires_at,
            server_url: server_url.to_owned(),
            tls_fingerprint: tls_fingerprint.to_owned(),
        };
        replays.insert(operation_id.to_owned(), offer.clone());
        Ok(offer)
    }

    pub fn pair(&self, pairing_id: &str, code: &str, device_name: &str) -> Result<PairingResult> {
        self.pair_at(pairing_id, code, device_name, Utc::now())
    }

    fn pair_at(
        &self,
        pairing_id: &str,
        code: &str,
        device_name: &str,
        now: DateTime<Utc>,
    ) -> Result<PairingResult> {
        let name = device_name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            bail!("invalid_device_name")
        }
        let normalized = normalize_code(code);
        let code_shape_valid = normalized.len() == 32
            && normalized
                .chars()
                .all(|character| character.is_ascii_hexdigit());
        let supplied_hash = digest(normalized.as_bytes());
        let attempt = self.db.transaction(|tx| {
            let row = tx
                .query_row(
                    "SELECT secret_hash,permission,expires_at,failed_attempts,consumed_at
                     FROM device_pairings WHERE id=?",
                    [pairing_id],
                    |row| {
                        Ok((
                            row.get::<_, Vec<u8>>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((expected_hash, permission, expires_at, failures, consumed_at)) = row else {
                return Ok(PairAttempt::Rejected)
            };
            let valid_window = consumed_at.is_none()
                && failures < MAX_PAIRING_ATTEMPTS
                && parse_timestamp(&expires_at)? > now;
            let valid_secret = code_shape_valid
                && expected_hash.len() == supplied_hash.len()
                && bool::from(expected_hash.ct_eq(supplied_hash.as_slice()));
            if !valid_window || !valid_secret {
                if consumed_at.is_none() && failures < MAX_PAIRING_ATTEMPTS {
                    let next = failures + 1;
                    tx.execute(
                        "UPDATE device_pairings SET failed_attempts=?, consumed_at=CASE WHEN ?>=? THEN ? ELSE consumed_at END WHERE id=? AND consumed_at IS NULL",
                        params![next, next, MAX_PAIRING_ATTEMPTS, timestamp(now), pairing_id],
                    )?;
                }
                return Ok(PairAttempt::Rejected)
            }
            let changed = tx.execute(
                "UPDATE device_pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
                params![timestamp(now), pairing_id],
            )?;
            if changed != 1 {
                return Ok(PairAttempt::Rejected)
            }
            let permission = DevicePermission::from_str(&permission)?;
            let mut token_bytes = [0_u8; 32];
            rand::thread_rng().fill_bytes(&mut token_bytes);
            let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
            let device = PairedDevice {
                id: Uuid::new_v4().to_string(),
                name: name.to_owned(),
                permission,
                created_at: timestamp(now),
                expires_at: timestamp(now + Duration::hours(DEVICE_TOKEN_TTL_HOURS)),
                last_seen_at: None,
                revoked_at: None,
            };
            tx.execute(
                "INSERT INTO paired_devices(id,name,token_hash,permission,created_at,expires_at,last_seen_at,revoked_at)
                 VALUES(?,?,?,?,?,?,NULL,NULL)",
                params![device.id, device.name, digest(token.as_bytes()).as_slice(), device.permission.to_string(), device.created_at, device.expires_at],
            )?;
            emit_device_change(tx, "device.paired")?;
            Ok(PairAttempt::Paired(PairingResult { token, device }))
        })?;
        match attempt {
            PairAttempt::Paired(result) => {
                if let Ok(mut replays) = self.pairing_replays.lock() {
                    replays.retain(|_, offer| offer.id != pairing_id);
                }
                Ok(result)
            }
            PairAttempt::Rejected => bail!("invalid_pairing"),
        }
    }

    pub fn authenticate(&self, token: &str) -> Result<AuthenticatedDevice> {
        self.authenticate_at(token, Utc::now())
    }

    fn authenticate_at(&self, token: &str, now: DateTime<Utc>) -> Result<AuthenticatedDevice> {
        if token.len() < 32 || token.len() > 128 {
            bail!("invalid_device_token")
        }
        let token_hash = digest(token.as_bytes());
        self.db.transaction(|tx| {
            let row = tx
                .query_row(
                    "SELECT id,permission,expires_at,revoked_at FROM paired_devices WHERE token_hash=?",
                    [token_hash.as_slice()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .optional()?;
            let Some((id, permission, expires_at, revoked_at)) = row else {
                bail!("invalid_device_token")
            };
            if revoked_at.is_some() || parse_timestamp(&expires_at)? <= now {
                bail!("invalid_device_token")
            }
            tx.execute(
                "UPDATE paired_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL",
                params![timestamp(now), id],
            )?;
            Ok(AuthenticatedDevice {
                id,
                permission: DevicePermission::from_str(&permission)?,
            })
        })
    }

    pub fn list(&self) -> Result<Vec<PairedDevice>> {
        self.db.transaction(|tx| {
            let mut statement = tx.prepare(
                "SELECT id,name,permission,created_at,expires_at,last_seen_at,revoked_at
                 FROM paired_devices ORDER BY created_at DESC,id",
            )?;
            let rows = statement.query_map([], |row| {
                let permission = row.get::<_, String>(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    permission,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })?;
            rows.map(|row| {
                let (id, name, permission, created_at, expires_at, last_seen_at, revoked_at) = row?;
                Ok(PairedDevice {
                    id,
                    name,
                    permission: DevicePermission::from_str(&permission)?,
                    created_at,
                    expires_at,
                    last_seen_at,
                    revoked_at,
                })
            })
            .collect()
        })
    }

    pub fn cancel_pairing(&self, pairing_id: &str, operation_id: &str) -> Result<()> {
        self.cancel_pairing_at(pairing_id, operation_id, Utc::now())
    }

    fn cancel_pairing_at(
        &self,
        pairing_id: &str,
        operation_id: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if pairing_id.is_empty() || operation_id.is_empty() {
            bail!("invalid_pairing_cancel")
        }
        // Serialize cancellation with offer creation/replay. Pairing itself is
        // serialized by the database transaction. Cancelling an already
        // consumed/expired offer is a safe cleanup no-op and never revokes the
        // device that may have been created from it.
        let mut replays = self
            .pairing_replays
            .lock()
            .map_err(|_| anyhow::anyhow!("pairing replay lock poisoned"))?;
        self.db.transaction(|tx| {
            if operation_value(tx, operation_id)?.is_some() {
                return Ok(());
            }
            let changed = tx.execute(
                "UPDATE device_pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
                params![timestamp(now), pairing_id],
            )?;
            complete_operation(tx, operation_id, "device.pairing.cancel", &Value::Null)?;
            if changed == 1 {
                emit_device_change(tx, "pairing.cancelled")?;
            }
            Ok(())
        })?;
        replays.retain(|_, offer| offer.id != pairing_id);
        Ok(())
    }

    pub fn rename(&self, device_id: &str, name: &str, operation_id: &str) -> Result<PairedDevice> {
        let name = name.trim();
        if device_id.is_empty()
            || operation_id.is_empty()
            || name.is_empty()
            || name.chars().count() > 80
        {
            bail!("invalid_device_name")
        }
        self.db.transaction(|tx| {
            if let Some(prior) = operation_value(tx, operation_id)? {
                return serde_json::from_value(prior).context("decoding device.rename replay");
            }
            let mut device =
                paired_device(tx, device_id)?.ok_or_else(|| anyhow::anyhow!("device_not_found"))?;
            tx.execute(
                "UPDATE paired_devices SET name=? WHERE id=?",
                params![name, device_id],
            )?;
            device.name = name.to_owned();
            let result = serde_json::to_value(&device)?;
            complete_operation(tx, operation_id, "device.rename", &result)?;
            emit_device_change(tx, "device.renamed")?;
            Ok(device)
        })
    }

    pub fn renew(&self, device_id: &str, operation_id: &str) -> Result<PairedDevice> {
        self.renew_at(device_id, operation_id, Utc::now())
    }

    fn renew_at(
        &self,
        device_id: &str,
        operation_id: &str,
        now: DateTime<Utc>,
    ) -> Result<PairedDevice> {
        if device_id.is_empty() || operation_id.is_empty() {
            bail!("invalid_device_renew")
        }
        self.db.transaction(|tx| {
            if let Some(prior) = operation_value(tx, operation_id)? {
                return serde_json::from_value(prior).context("decoding device.renew replay");
            }
            let mut device =
                paired_device(tx, device_id)?.ok_or_else(|| anyhow::anyhow!("device_not_found"))?;
            if device.revoked_at.is_some() {
                bail!("device_revoked")
            }
            device.expires_at = timestamp(now + Duration::hours(DEVICE_TOKEN_TTL_HOURS));
            tx.execute(
                "UPDATE paired_devices SET expires_at=? WHERE id=? AND revoked_at IS NULL",
                params![device.expires_at, device_id],
            )?;
            let result = serde_json::to_value(&device)?;
            complete_operation(tx, operation_id, "device.renew", &result)?;
            emit_device_change(tx, "device.renewed")?;
            Ok(device)
        })
    }

    pub fn revoke(&self, device_id: &str, operation_id: &str) -> Result<()> {
        if device_id.is_empty() || operation_id.is_empty() {
            bail!("invalid_device_revoke")
        }
        self.db.transaction(|tx| {
            if operation_exists(tx, operation_id)? {
                return Ok(());
            }
            let revoked_at = timestamp(Utc::now());
            tx.execute(
                "UPDATE paired_devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
                params![revoked_at, device_id],
            )?;
            // Preserve the lease epoch while expiring it. A later claimant
            // increments the epoch, fencing any input prepared by this device.
            tx.execute(
                "UPDATE leases SET expires_at=? WHERE client_id=?",
                params![revoked_at, format!("device:{device_id}")],
            )?;
            complete_operation(tx, operation_id, "device.revoke", &Value::Null)?;
            emit_device_change(tx, "device.revoked")
        })
    }

    pub fn operation_completed(&self, operation_id: &str) -> Result<bool> {
        if operation_id.is_empty() {
            bail!("invalid operationId")
        }
        self.db.transaction(|tx| operation_exists(tx, operation_id))
    }

    pub fn complete_marker(&self, operation_id: &str, method: &str) -> Result<()> {
        if operation_id.is_empty() {
            bail!("invalid operationId")
        }
        self.db.transaction(|tx| {
            if operation_exists(tx, operation_id)? {
                return Ok(());
            }
            complete_operation(tx, operation_id, method, &Value::Null)
        })
    }

    #[cfg(test)]
    fn failed_attempts(&self, pairing_id: &str) -> Result<i64> {
        self.db.transaction(|tx| {
            Ok(tx.query_row(
                "SELECT failed_attempts FROM device_pairings WHERE id=?",
                [pairing_id],
                |row| row.get(0),
            )?)
        })
    }
}

fn digest(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("invalid stored timestamp {value}"))?
        .with_timezone(&Utc))
}

fn group_code(value: &str) -> String {
    value
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect()
}

fn operation_exists(tx: &Transaction<'_>, operation_id: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM operations WHERE id=?",
            [operation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn operation_value(tx: &Transaction<'_>, operation_id: &str) -> Result<Option<Value>> {
    let raw = tx
        .query_row(
            "SELECT result FROM operations WHERE id=?",
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

fn paired_device(tx: &Transaction<'_>, device_id: &str) -> Result<Option<PairedDevice>> {
    let row = tx
        .query_row(
            "SELECT id,name,permission,created_at,expires_at,last_seen_at,revoked_at
             FROM paired_devices WHERE id=?",
            [device_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(id, name, permission, created_at, expires_at, last_seen_at, revoked_at)| {
            Ok(PairedDevice {
                id,
                name,
                permission: DevicePermission::from_str(&permission)?,
                created_at,
                expires_at,
                last_seen_at,
                revoked_at,
            })
        },
    )
    .transpose()
}

fn complete_operation(
    tx: &Transaction<'_>,
    operation_id: &str,
    method: &str,
    result: &Value,
) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            operation_id,
            method,
            serde_json::to_string(result)?,
            timestamp(Utc::now())
        ],
    )?;
    Ok(())
}

fn emit_device_change(tx: &Transaction<'_>, kind: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![json!({"kind":kind}).to_string(), timestamp(Utc::now())],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use tempfile::tempdir;

    fn manager() -> (tempfile::TempDir, DeviceManager) {
        let directory = tempdir().unwrap();
        let db = Arc::new(Database::open(&directory.path().join("runtime.sqlite3")).unwrap());
        (directory, DeviceManager::new(db).unwrap())
    }

    #[test]
    fn pairing_is_one_time_and_tokens_are_hashed_and_revocable() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let offer = manager
            .create_pairing_at(
                DevicePermission::Fullcontrol,
                "pair-op",
                "https://127.0.0.1:4444",
                "AA:BB",
                now,
            )
            .unwrap();
        let replay = manager
            .create_pairing_at(
                DevicePermission::Fullcontrol,
                "pair-op",
                "https://127.0.0.1:4444",
                "AA:BB",
                now,
            )
            .unwrap();
        assert_eq!(replay, offer);
        assert!(offer.qr_payload.starts_with("threadterm://pair?data="));
        assert!(!offer.qr_payload.contains("token"));
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Phone", now)
            .unwrap();
        assert_eq!(paired.device.permission, DevicePermission::Fullcontrol);
        assert!(manager
            .pair_at(&offer.id, &offer.code, "Other", now)
            .is_err());
        let authenticated = manager.authenticate_at(&paired.token, now).unwrap();
        assert_eq!(authenticated.id, paired.device.id);
        let lease_session = manager
            .db
            .create_session(crate::db::CreateSession {
                project_id: None,
                title: Some("Leased terminal"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "lease-session",
            })
            .unwrap();
        manager
            .db
            .put_lease(
                &lease_session.id,
                &format!("device:{}", paired.device.id),
                7,
                &timestamp(now + Duration::hours(1)),
            )
            .unwrap();
        manager.revoke(&paired.device.id, "revoke-op").unwrap();
        assert!(manager.authenticate_at(&paired.token, now).is_err());
        let (_, epoch, lease_expiry) = manager.db.lease(&lease_session.id).unwrap().unwrap();
        assert_eq!(epoch, 7);
        assert!(parse_timestamp(&lease_expiry).unwrap() <= Utc::now());

        manager
            .db
            .transaction(|tx| {
                let operation: String = tx.query_row(
                    "SELECT result FROM operations WHERE id='pair-op'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(!operation.contains(&offer.code));
                let raw: Option<Vec<u8>> = tx
                    .query_row(
                        "SELECT token_hash FROM paired_devices WHERE id=?",
                        [&paired.device.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                assert_eq!(
                    raw.as_deref(),
                    Some(digest(paired.token.as_bytes()).as_slice())
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn pairing_expires_and_five_failures_invalidate_it() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let expired = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "expired-op",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        assert!(manager
            .pair_at(
                &expired.id,
                &expired.code,
                "Phone",
                now + Duration::minutes(PAIRING_TTL_MINUTES) + Duration::milliseconds(1),
            )
            .is_err());

        let offer = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "attempt-op",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        for _ in 0..MAX_PAIRING_ATTEMPTS {
            assert!(manager
                .pair_at(&offer.id, "malformed", "Phone", now)
                .is_err());
        }
        assert_eq!(
            manager.failed_attempts(&offer.id).unwrap(),
            MAX_PAIRING_ATTEMPTS
        );
        assert!(manager
            .pair_at(&offer.id, &offer.code, "Phone", now)
            .is_err());
    }

    #[test]
    fn device_token_has_a_fixed_twenty_four_hour_lifetime() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let offer = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "token-op",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Phone", now)
            .unwrap();
        assert!(manager
            .authenticate_at(
                &paired.token,
                now + Duration::hours(24) - Duration::milliseconds(1)
            )
            .is_ok());
        assert!(manager
            .authenticate_at(&paired.token, now + Duration::hours(24))
            .is_err());
    }

    #[test]
    fn rename_trims_persists_and_replays_the_committed_device() {
        let (directory, manager) = manager();
        let now = Utc::now();
        let offer = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "rename-pair",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Original", now)
            .unwrap();

        let renamed = manager
            .rename(&paired.device.id, "  Living room tablet  ", "rename-op")
            .unwrap();
        assert_eq!(renamed.name, "Living room tablet");
        assert_eq!(manager.list().unwrap()[0].name, "Living room tablet");
        drop(manager);
        let reopened = DeviceManager::new(Arc::new(
            Database::open(&directory.path().join("runtime.sqlite3")).unwrap(),
        ))
        .unwrap();
        assert_eq!(reopened.list().unwrap()[0].name, "Living room tablet");
        assert_eq!(
            reopened
                .rename(&paired.device.id, "Living room tablet", "rename-op")
                .unwrap(),
            renamed
        );
        assert!(reopened
            .rename(&paired.device.id, "   ", "invalid-rename")
            .is_err());
        assert!(reopened
            .rename(&paired.device.id, &"x".repeat(81), "long-rename")
            .is_err());
    }

    #[test]
    fn renew_accepts_expired_unrevoked_device_without_rotating_token() {
        let (_directory, manager) = manager();
        let paired_at = Utc::now();
        let offer = manager
            .create_pairing_at(
                DevicePermission::Fullcontrol,
                "renew-pair",
                "https://x",
                "AA",
                paired_at,
            )
            .unwrap();
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Controller", paired_at)
            .unwrap();
        let token_hash_before = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT token_hash FROM paired_devices WHERE id=?",
                    [&paired.device.id],
                    |row| row.get::<_, Vec<u8>>(0),
                )?)
            })
            .unwrap();
        let renewed_at = paired_at + Duration::hours(48);
        assert!(manager.authenticate_at(&paired.token, renewed_at).is_err());

        let renewed = manager
            .renew_at(&paired.device.id, "renew-op", renewed_at)
            .unwrap();
        assert_eq!(
            renewed.expires_at,
            timestamp(renewed_at + Duration::hours(DEVICE_TOKEN_TTL_HOURS))
        );
        assert_eq!(
            manager
                .renew_at(
                    &paired.device.id,
                    "renew-op",
                    renewed_at + Duration::hours(1)
                )
                .unwrap(),
            renewed
        );
        assert!(manager.authenticate_at(&paired.token, renewed_at).is_ok());
        let token_hash_after = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT token_hash FROM paired_devices WHERE id=?",
                    [&paired.device.id],
                    |row| row.get::<_, Vec<u8>>(0),
                )?)
            })
            .unwrap();
        assert_eq!(token_hash_after, token_hash_before);

        manager.revoke(&paired.device.id, "renew-revoke").unwrap();
        assert!(manager
            .renew_at(&paired.device.id, "renew-after-revoke", renewed_at)
            .is_err());
    }

    #[test]
    fn cancelled_pairing_cannot_pair_or_reopen_on_create_replay() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let cancelled = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "cancelled-create",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        let unaffected = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "unaffected-create",
                "https://x",
                "AA",
                now,
            )
            .unwrap();

        manager
            .cancel_pairing_at(&cancelled.id, "cancel-op", now)
            .unwrap();
        manager
            .cancel_pairing_at(&cancelled.id, "cancel-op", now)
            .unwrap();
        assert!(manager
            .pair_at(&cancelled.id, &cancelled.code, "Cancelled", now)
            .is_err());
        assert!(manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "cancelled-create",
                "https://x",
                "AA",
                now,
            )
            .is_err());
        let paired = manager
            .pair_at(&unaffected.id, &unaffected.code, "Unaffected", now)
            .unwrap();
        manager
            .cancel_pairing_at(&unaffected.id, "consumed-cancel", now)
            .unwrap();
        manager
            .cancel_pairing_at("missing-offer", "missing-cancel", now)
            .unwrap();
        assert_eq!(manager.list().unwrap()[0].id, paired.device.id);
    }

    #[test]
    fn concurrent_pairing_consumption_issues_exactly_one_token() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let offer = manager
            .create_pairing_at(
                DevicePermission::Readonly,
                "concurrent-op",
                "https://x",
                "AA",
                now,
            )
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let attempts = (0..2)
            .map(|index| {
                let manager = manager.clone();
                let barrier = Arc::clone(&barrier);
                let pairing_id = offer.id.clone();
                let code = offer.code.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    manager.pair_at(&pairing_id, &code, &format!("Phone {index}"), now)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let outcomes = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap().is_ok())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|success| **success).count(), 1);
    }
}
