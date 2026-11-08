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
pub const DESKTOP_TOKEN_IDLE_TTL_DAYS: i64 = 30;
pub const DESKTOP_UNCONFIRMED_TTL_MINUTES: i64 = 10;
const PEER_ACTIVITY_WRITE_INTERVAL_MINUTES: i64 = 5;
pub const MAX_PAIRING_ATTEMPTS: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePermission {
    Readonly,
    Fullcontrol,
}

/// The credential's transport boundary. Phone credentials stay on the HTTPS
/// allowlist; desktop and mobile credentials each have their own TLS ALPN.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceProfile {
    Phone,
    Desktop,
    Mobile,
}

impl Default for DeviceProfile {
    fn default() -> Self {
        Self::Phone
    }
}

impl fmt::Display for DeviceProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Phone => "phone",
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
        })
    }
}

impl FromStr for DeviceProfile {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "phone" => Ok(Self::Phone),
            "desktop" => Ok(Self::Desktop),
            "mobile" => Ok(Self::Mobile),
            _ => bail!("invalid_device_profile"),
        }
    }
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
    /// Live control-group membership, populated only by device.list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
    pub id: String,
    pub name: String,
    pub permission: DevicePermission,
    #[serde(default)]
    pub profile: DeviceProfile,
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
    #[serde(default)]
    pub profile: DeviceProfile,
    pub expires_at: String,
    pub server_url: String,
    pub tls_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iroh: Option<IrohOffer>,
}

/// How a desktop offer is reached across networks: this PC's public iroh key, and the relay it currently uses (a hint;
/// with n0's relays the key's current relay is also published).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IrohOffer {
    pub endpoint_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
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
    pub tailscale_only: bool,
    pub enabled: bool,
    pub port: Option<u16>,
    pub last_error: Option<String>,
    /// "Connect across networks": computers reach this PC through iroh. Off by default; never with Tailscale-only.
    pub iroh_enabled: bool,
    /// A self-hosted iroh relay instead of n0's public ones.
    pub iroh_relay_url: Option<String>,
}

/// What an iroh connection from a given key may do before TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohAdmission {
    /// A paired, unrevoked computer.
    Paired,
    /// An unknown key while a desktop pairing offer is open: the pairing request only.
    PairingOnly,
    Denied,
}

struct NewPairing {
    id: String,
    secret: String,
    permission: DevicePermission,
    profile: DeviceProfile,
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
        this.cleanup_expired_long_lived()?;
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
                    profile TEXT NOT NULL DEFAULT 'phone' CHECK(profile IN ('phone','desktop','mobile')),
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
                    profile TEXT NOT NULL DEFAULT 'phone' CHECK(profile IN ('phone','desktop','mobile')),
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    last_address TEXT,
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
            let (enabled, port, last_error, tailscale_only, iroh_enabled, iroh_relay_url) = tx.query_row(
                "SELECT enabled,port,last_error,tailscale_only,iroh_enabled,iroh_relay_url FROM remote_access_state WHERE singleton=1",
                [],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )?;
            let port = port
                .map(u16::try_from)
                .transpose()
                .map_err(|_| anyhow::anyhow!("invalid stored remote port"))?;
            Ok(RemoteAccessPreference {
                tailscale_only,
                enabled,
                port,
                last_error,
                iroh_enabled,
                iroh_relay_url,
            })
        })
    }

    pub fn set_tailscale_only(&self, enabled: bool, operation_id: &str) -> Result<()> {
        self.db.transaction(|tx| {
            tx.execute("UPDATE remote_access_state SET tailscale_only=? WHERE singleton=1", [enabled])?;
            complete_operation(tx, operation_id, "device.tailscaleOnly.set", &Value::Null)
        })
    }

    pub fn set_iroh(&self, enabled: bool, relay_url: Option<&str>, operation_id: &str) -> Result<()> {
        self.db.transaction(|tx| {
            tx.execute(
                "UPDATE remote_access_state SET iroh_enabled=?,iroh_relay_url=? WHERE singleton=1",
                params![enabled, relay_url],
            )?;
            complete_operation(tx, operation_id, "device.iroh.set", &Value::Null)
        })
    }

    /// Decides, from the remote iroh key alone, whether a connection may proceed to TLS.
    pub fn iroh_admission(&self, endpoint_id: &str) -> Result<IrohAdmission> {
        self.iroh_admission_at(endpoint_id, Utc::now())
    }

    fn iroh_admission_at(&self, endpoint_id: &str, now: DateTime<Utc>) -> Result<IrohAdmission> {
        let now = timestamp(now);
        self.db.transaction(|tx| {
            let paired: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM paired_devices WHERE iroh_endpoint_id=? AND profile IN ('desktop','mobile')
                 AND revoked_at IS NULL AND expires_at>?)",
                params![endpoint_id, now],
                |row| row.get(0),
            )?;
            if paired {
                return Ok(IrohAdmission::Paired);
            }
            let offer_open: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM device_pairings WHERE profile IN ('desktop','mobile') AND consumed_at IS NULL
                 AND failed_attempts<? AND expires_at>?)",
                params![MAX_PAIRING_ATTEMPTS, now],
                |row| row.get(0),
            )?;
            Ok(if offer_open { IrohAdmission::PairingOnly } else { IrohAdmission::Denied })
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
        self.create_pairing_at(permission, operation_id, server_url, tls_fingerprint, Utc::now())
    }

    /// `iroh` is offered to long-lived desktop/mobile clients; phones keep the
    /// legacy v1 descriptor.
    pub fn create_pairing_with_profile(
        &self,
        permission: DevicePermission,
        profile: DeviceProfile,
        operation_id: &str,
        server_url: &str,
        tls_fingerprint: &str,
        iroh: Option<IrohOffer>,
    ) -> Result<PairingOffer> {
        if profile == DeviceProfile::Desktop {
            if permission != DevicePermission::Fullcontrol {
                bail!("invalid_desktop_permission")
            }
            if !self.remote_machines_enabled()? {
                bail!("remote_machines_disabled")
            }
        } else if profile == DeviceProfile::Mobile && !self.enabled()? {
            bail!("remote_access_disabled")
        }
        self.create_pairing_profile_at(
            permission,
            profile,
            operation_id,
            server_url,
            tls_fingerprint,
            iroh.filter(|_| matches!(profile, DeviceProfile::Desktop | DeviceProfile::Mobile)),
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
        self.create_pairing_profile_at(
            permission,
            DeviceProfile::Phone,
            operation_id,
            server_url,
            tls_fingerprint,
            None,
            now,
        )
    }

    fn create_pairing_profile_at(
        &self,
        permission: DevicePermission,
        profile: DeviceProfile,
        operation_id: &str,
        server_url: &str,
        tls_fingerprint: &str,
        iroh: Option<IrohOffer>,
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
                "INSERT INTO device_pairings(id,secret_hash,permission,profile,created_at,expires_at,failed_attempts,consumed_at)
                 VALUES(?,?,?,?,?,?,0,NULL)",
                params![id, digest(secret.as_bytes()).as_slice(), permission.to_string(), profile.to_string(), timestamp(now), expires_at],
            )?;
            complete_operation(tx, operation_id, "device.pairing.create", &json!({"pairingId":id}))?;
            emit_device_change(tx, "pairing.created")?;
            Ok(NewPairing { id, secret, permission, profile, expires_at })
        })?;
        let code = group_code(&pairing.secret);
        let mut data = json!({
            "v": 1,
            "serverUrl": server_url,
            "pairingId": pairing.id,
            "code": code,
            "tlsFingerprint": tls_fingerprint,
        });
        if pairing.profile == DeviceProfile::Mobile {
            data["profile"] = json!("mobile");
        }
        if let Some(iroh) = &iroh {
            data["v"] = json!(2);
            data["iroh"] = serde_json::to_value(iroh)?;
        }
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&data)?);
        let offer = PairingOffer {
            id: pairing.id,
            code,
            qr_payload: format!("threadterm://pair?data={encoded}"),
            permission: pairing.permission,
            profile: pairing.profile,
            expires_at: pairing.expires_at,
            server_url: server_url.to_owned(),
            tls_fingerprint: tls_fingerprint.to_owned(),
            iroh,
        };
        replays.insert(operation_id.to_owned(), offer.clone());
        Ok(offer)
    }

    /// `iroh_endpoint_id` is the verified remote key of the iroh connection the request arrived on, never a value
    /// taken from the request body; the host admits that key from then on.
    pub fn pair(&self, pairing_id: &str, code: &str, device_name: &str, iroh_endpoint_id: Option<&str>) -> Result<PairingResult> {
        self.pair_at_with(pairing_id, code, device_name, iroh_endpoint_id, Utc::now())
    }

    #[cfg(test)]
    fn pair_at(&self, pairing_id: &str, code: &str, device_name: &str, now: DateTime<Utc>) -> Result<PairingResult> {
        self.pair_at_with(pairing_id, code, device_name, None, now)
    }

    fn pair_at_with(
        &self,
        pairing_id: &str,
        code: &str,
        device_name: &str,
        iroh_endpoint_id: Option<&str>,
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
                    "SELECT secret_hash,permission,profile,expires_at,failed_attempts,consumed_at
                     FROM device_pairings WHERE id=?",
                    [pairing_id],
                    |row| {
                        Ok((
                            row.get::<_, Vec<u8>>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()?;
            let Some((expected_hash, permission, profile, expires_at, failures, consumed_at)) = row else {
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
            // Only a desktop/mobile offer admits an unknown iroh key
            // (IrohAdmission::PairingOnly); refusing a phone offer before
            // consuming it leaves it usable by the phone.
            if iroh_endpoint_id.is_some()
                && !matches!(DeviceProfile::from_str(&profile)?, DeviceProfile::Desktop | DeviceProfile::Mobile)
            {
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
            let profile = DeviceProfile::from_str(&profile)?;
            let mut token_bytes = [0_u8; 32];
            rand::thread_rng().fill_bytes(&mut token_bytes);
            let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
            let device = PairedDevice {
                connected: None,
                id: Uuid::new_v4().to_string(),
                name: name.to_owned(),
                permission,
                profile,
                created_at: timestamp(now),
                expires_at: timestamp(now + match profile {
                    DeviceProfile::Phone => Duration::hours(DEVICE_TOKEN_TTL_HOURS),
                    DeviceProfile::Desktop | DeviceProfile::Mobile => Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS),
                }),
                last_seen_at: None,
                revoked_at: None,
            };
            tx.execute(
                "INSERT INTO paired_devices(id,name,token_hash,permission,profile,created_at,expires_at,last_seen_at,revoked_at,iroh_endpoint_id)
                 VALUES(?,?,?,?,?,?,?,NULL,NULL,?)",
                params![device.id, device.name, digest(token.as_bytes()).as_slice(), device.permission.to_string(), profile.to_string(), device.created_at, device.expires_at, iroh_endpoint_id],
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
                    "SELECT id,permission,profile,expires_at,revoked_at FROM paired_devices WHERE token_hash=?",
                    [token_hash.as_slice()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((id, permission, profile, expires_at, revoked_at)) = row else {
                bail!("invalid_device_token")
            };
            if DeviceProfile::from_str(&profile)? != DeviceProfile::Phone || revoked_at.is_some() || parse_timestamp(&expires_at)? <= now {
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

    /// Authenticates only a desktop credential for the peer ALPN transport.
    pub fn authenticate_peer(&self, token: &str) -> Result<AuthenticatedDevice> {
        self.authenticate_peer_at(token, Utc::now())
    }

    fn authenticate_peer_at(&self, token: &str, now: DateTime<Utc>) -> Result<AuthenticatedDevice> {
        if token.len() < 32 || token.len() > 128 {
            bail!("invalid_device_token")
        }
        let token_hash = digest(token.as_bytes());
        let authenticated = self.db.transaction(|tx| {
            let row = tx.query_row("SELECT id,permission,created_at,last_seen_at,expires_at,revoked_at FROM paired_devices WHERE token_hash=? AND profile='desktop'", [token_hash.as_slice()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?))).optional()?;
            let Some((id, permission, created_at, last_seen_at, expires_at, revoked_at)) = row else { return Ok(None) };
            let expired = parse_timestamp(&expires_at)? <= now;
            let unconfirmed = last_seen_at.is_none() && parse_timestamp(&created_at)? + Duration::minutes(DESKTOP_UNCONFIRMED_TTL_MINUTES) <= now;
            if revoked_at.is_some() || expired || unconfirmed {
                if expired || unconfirmed { tx.execute("DELETE FROM paired_devices WHERE id=?", [&id])?; }
                return Ok(None)
            }
            // First authentication is durable immediately; later writes are coalesced.
            if last_seen_at.is_none() {
                tx.execute("UPDATE paired_devices SET last_seen_at=?,expires_at=? WHERE id=? AND revoked_at IS NULL", params![timestamp(now), timestamp(now + Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS)), id])?;
            }
            Ok(Some(AuthenticatedDevice { id, permission: DevicePermission::from_str(&permission)? }))
        })?;
        authenticated.ok_or_else(|| anyhow::anyhow!("invalid_device_token"))
    }

    /// Authenticates only a mobile credential for the mobile TLS ALPN. The
    /// iroh key is connection-proved by the outer transport and must match the
    /// key captured during pairing; TCP-paired credentials remain TCP-only.
    pub fn authenticate_mobile(
        &self,
        token: &str,
        iroh_endpoint_id: Option<&str>,
    ) -> Result<AuthenticatedDevice> {
        self.authenticate_mobile_at(token, iroh_endpoint_id, Utc::now())
    }

    fn authenticate_mobile_at(
        &self,
        token: &str,
        iroh_endpoint_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<AuthenticatedDevice> {
        if token.len() < 32 || token.len() > 128 {
            bail!("invalid_device_token")
        }
        let token_hash = digest(token.as_bytes());
        let authenticated = self.db.transaction(|tx| {
            let row = tx.query_row(
                "SELECT id,permission,created_at,last_seen_at,expires_at,revoked_at,iroh_endpoint_id
                 FROM paired_devices WHERE token_hash=? AND profile='mobile'",
                [token_hash.as_slice()],
                |row| Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?,
                )),
            ).optional()?;
            let Some((id, permission, created_at, last_seen_at, expires_at, revoked_at, stored_iroh)) = row else {
                return Ok(None)
            };
            let expired = parse_timestamp(&expires_at)? <= now;
            let unconfirmed = last_seen_at.is_none()
                && parse_timestamp(&created_at)? + Duration::minutes(DESKTOP_UNCONFIRMED_TTL_MINUTES) <= now;
            if stored_iroh.as_deref() != iroh_endpoint_id || revoked_at.is_some() || expired || unconfirmed {
                if expired || unconfirmed {
                    tx.execute("DELETE FROM paired_devices WHERE id=?", [&id])?;
                }
                return Ok(None)
            }
            if last_seen_at.is_none() {
                tx.execute(
                    "UPDATE paired_devices SET last_seen_at=?,expires_at=? WHERE id=? AND revoked_at IS NULL",
                    params![timestamp(now), timestamp(now + Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS)), id],
                )?;
            }
            Ok(Some(AuthenticatedDevice {
                id,
                permission: DevicePermission::from_str(&permission)?,
            }))
        })?;
        authenticated.ok_or_else(|| anyhow::anyhow!("invalid_device_token"))
    }

    pub fn validate_peer(&self, device_id: &str) -> Result<()> {
        self.validate_peer_at(device_id, Utc::now())
    }

    pub fn validate_mobile(&self, device_id: &str) -> Result<()> {
        self.validate_mobile_at(device_id, Utc::now())
    }

    fn validate_mobile_at(&self, device_id: &str, now: DateTime<Utc>) -> Result<()> {
        let state = self.db.transaction(|tx| {
            let row = tx.query_row(
                "SELECT created_at,last_seen_at,expires_at,revoked_at FROM paired_devices
                 WHERE id=? AND profile='mobile'",
                [device_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
            ).optional()?;
            let Some((created_at, last_seen_at, expires_at, revoked_at)) = row else { return Ok("invalid") };
            let expired = parse_timestamp(&expires_at)? <= now;
            let unconfirmed = last_seen_at.is_none()
                && parse_timestamp(&created_at)? + Duration::minutes(DESKTOP_UNCONFIRMED_TTL_MINUTES) <= now;
            if revoked_at.is_some() {
                return Ok("revoked")
            }
            if expired || unconfirmed {
                tx.execute("DELETE FROM paired_devices WHERE id=?", [device_id])?;
                return Ok(if expired { "expired" } else { "invalid" })
            }
            Ok("valid")
        })?;
        match state {
            "valid" => Ok(()),
            "revoked" => bail!("device_revoked"),
            "expired" => bail!("device_expired"),
            _ => bail!("invalid_device_token"),
        }
    }

    fn validate_peer_at(&self, device_id: &str, now: DateTime<Utc>) -> Result<()> {
        let valid = self.db.transaction(|tx| {
            let row = tx.query_row("SELECT created_at,last_seen_at,expires_at,revoked_at FROM paired_devices WHERE id=? AND profile='desktop'", [device_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))).optional()?;
            let Some((created_at, last_seen_at, expires_at, revoked_at)) = row else { return Ok(false) };
            let expired = parse_timestamp(&expires_at)? <= now;
            let unconfirmed = last_seen_at.is_none() && parse_timestamp(&created_at)? + Duration::minutes(DESKTOP_UNCONFIRMED_TTL_MINUTES) <= now;
            if revoked_at.is_some() || expired || unconfirmed {
                if expired || unconfirmed { tx.execute("DELETE FROM paired_devices WHERE id=?", [device_id])?; }
                return Ok(false)
            }
            Ok(true)
        })?;
        if valid {
            Ok(())
        } else {
            bail!("invalid_device_token")
        }
    }

    /// Extends the 30-day desktop idle expiry, at most once per five minutes.
    pub fn peer_activity(&self, device_id: &str) -> Result<()> {
        self.peer_activity_at(device_id, Utc::now())
    }

    fn peer_activity_at(&self, device_id: &str, now: DateTime<Utc>) -> Result<()> {
        self.db.transaction(|tx| {
            let row = tx.query_row("SELECT last_seen_at,expires_at,revoked_at FROM paired_devices WHERE id=? AND profile='desktop'", [device_id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))).optional()?;
            let Some((last_seen, expires_at, revoked_at)) = row else { bail!("invalid_device_token") };
            if revoked_at.is_some() || parse_timestamp(&expires_at)? <= now { bail!("invalid_device_token") }
            let write = match last_seen { None => true, Some(value) => parse_timestamp(&value)? + Duration::minutes(PEER_ACTIVITY_WRITE_INTERVAL_MINUTES) <= now };
            if write { let changed = tx.execute("UPDATE paired_devices SET last_seen_at=?,expires_at=? WHERE id=? AND profile='desktop' AND revoked_at IS NULL", params![timestamp(now), timestamp(now + Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS)), device_id])?; if changed != 1 { bail!("invalid_device_token") } }
            Ok(())
        })
    }

    /// Extends the mobile credential's 30-day idle expiry, coalescing durable
    /// writes exactly like the desktop peer path.
    pub fn mobile_activity(&self, device_id: &str) -> Result<()> {
        self.mobile_activity_at(device_id, Utc::now())
    }

    fn mobile_activity_at(&self, device_id: &str, now: DateTime<Utc>) -> Result<()> {
        self.db.transaction(|tx| {
            let row = tx.query_row(
                "SELECT last_seen_at,expires_at,revoked_at FROM paired_devices WHERE id=? AND profile='mobile'",
                [device_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
            ).optional()?;
            let Some((last_seen, expires_at, revoked_at)) = row else { bail!("invalid_device_token") };
            if revoked_at.is_some() {
                bail!("device_revoked")
            }
            if parse_timestamp(&expires_at)? <= now {
                bail!("device_expired")
            }
            let write = match last_seen {
                None => true,
                Some(value) => parse_timestamp(&value)? + Duration::minutes(PEER_ACTIVITY_WRITE_INTERVAL_MINUTES) <= now,
            };
            if write {
                let changed = tx.execute(
                    "UPDATE paired_devices SET last_seen_at=?,expires_at=? WHERE id=? AND profile='mobile' AND revoked_at IS NULL",
                    params![timestamp(now), timestamp(now + Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS)), device_id],
                )?;
                if changed != 1 { bail!("invalid_device_token") }
            }
            Ok(())
        })
    }

    pub fn remote_machines_enabled(&self) -> Result<bool> {
        self.db.transaction(|tx| {
            let raw: String =
                tx.query_row("SELECT value FROM settings WHERE singleton=1", [], |row| {
                    row.get(0)
                })?;
            Ok(serde_json::from_str::<Value>(&raw)?
                .get("remoteMachines")
                .and_then(Value::as_object)
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false))
        })
    }

    /// Persist only the connected peer's IP address, never its token or a
    /// caller-provided display address.
    pub fn record_peer_address(&self, device_id: &str, address: &str) -> Result<()> {
        if address.is_empty() || address.len() > 255 {
            bail!("invalid_peer_address")
        }
        self.db.transaction(|tx| {
            let known = tx.query_row("SELECT 1 FROM paired_devices WHERE id=? AND profile IN ('desktop','mobile') AND revoked_at IS NULL", [device_id], |_| Ok(())).optional()?.is_some();
            if !known { bail!("invalid_device_token") }
            tx.execute("UPDATE paired_devices SET last_address=? WHERE id=? AND last_address IS NOT ?", params![address, device_id, address])?;
            Ok(())
        })
    }

    pub fn list(&self) -> Result<Vec<PairedDevice>> {
        self.cleanup_expired_long_lived()?;
        self.db.transaction(|tx| {
            let mut statement = tx.prepare(
                "SELECT id,name,permission,profile,created_at,expires_at,last_seen_at,revoked_at
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
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?;
            rows.map(|row| {
                let (
                    id,
                    name,
                    permission,
                    profile,
                    created_at,
                    expires_at,
                    last_seen_at,
                    revoked_at,
                ) = row?;
                Ok(PairedDevice {
                    connected: None,
                    id,
                    name,
                    permission: DevicePermission::from_str(&permission)?,
                    profile: DeviceProfile::from_str(&profile)?,
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

    pub fn set_permission(
        &self,
        device_id: &str,
        permission: DevicePermission,
        operation_id: &str,
    ) -> Result<PairedDevice> {
        if device_id.is_empty() || operation_id.is_empty() {
            bail!("invalid_device_permission")
        }
        self.db.transaction(|tx| {
            if let Some(prior) = operation_value(tx, operation_id)? {
                return serde_json::from_value(prior)
                    .context("decoding device.permission.set replay");
            }
            let mut device =
                paired_device(tx, device_id)?.ok_or_else(|| anyhow::anyhow!("device_not_found"))?;
            if device.revoked_at.is_some() {
                bail!("device_revoked")
            }
            if device.profile == DeviceProfile::Desktop && permission != DevicePermission::Fullcontrol {
                bail!("invalid_desktop_permission")
            }
            tx.execute(
                "UPDATE paired_devices SET permission=? WHERE id=? AND revoked_at IS NULL",
                params![permission.to_string(), device_id],
            )?;
            if permission == DevicePermission::Readonly {
                // Legacy phone RPCs carry their leases under device:<id>.
                // Mobile groups use their own mobile:<id>:* prefix when their
                // live permission is updated by RemoteAccess.
                tx.execute(
                    "UPDATE leases SET expires_at=? WHERE client_id=?",
                    params![timestamp(Utc::now()), format!("device:{device_id}")],
                )?;
            }
            device.permission = permission;
            let result = serde_json::to_value(&device)?;
            complete_operation(tx, operation_id, "device.permission.set", &result)?;
            emit_device_change(tx, "device.permission.changed")?;
            Ok(device)
        })
    }

    pub fn device(&self, device_id: &str) -> Result<PairedDevice> {
        if device_id.is_empty() {
            bail!("device_not_found")
        }
        self.db.transaction(|tx| {
            paired_device(tx, device_id)?.ok_or_else(|| anyhow::anyhow!("device_not_found"))
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
            device.expires_at = timestamp(
                now + match device.profile {
                    DeviceProfile::Phone => Duration::hours(DEVICE_TOKEN_TTL_HOURS),
                    DeviceProfile::Desktop | DeviceProfile::Mobile => Duration::days(DESKTOP_TOKEN_IDLE_TTL_DAYS),
                },
            );
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

    /// Revokes every paired device, expires its leases and consumes open
    /// pairing offers. Replacing the remote TLS identity invalidates all
    /// pinned certificates, so the reset action forces explicit re-pairing.
    pub fn revoke_all(&self) -> Result<()> {
        let mut replays = self
            .pairing_replays
            .lock()
            .map_err(|_| anyhow::anyhow!("pairing replay lock poisoned"))?;
        self.db.transaction(|tx| {
            let revoked_at = timestamp(Utc::now());
            let revoked = tx.execute(
                "UPDATE paired_devices SET revoked_at=COALESCE(revoked_at,?) WHERE revoked_at IS NULL",
                params![revoked_at],
            )?;
            tx.execute(
                "UPDATE leases SET expires_at=? WHERE client_id LIKE 'device:%'",
                params![revoked_at],
            )?;
            tx.execute(
                "UPDATE device_pairings SET consumed_at=COALESCE(consumed_at,?) WHERE consumed_at IS NULL",
                params![revoked_at],
            )?;
            if revoked > 0 {
                emit_device_change(tx, "device.revoked")?;
            }
            Ok(())
        })?;
        replays.clear();
        Ok(())
    }

    pub fn operation_completed(&self, operation_id: &str) -> Result<bool> {
        if operation_id.is_empty() {
            bail!("invalid operationId")
        }
        self.db.transaction(|tx| operation_exists(tx, operation_id))
    }

    /// Removes expired or never-confirmed desktop/mobile credentials without
    /// touching phone rows, whose existing renewal lifecycle is unchanged.
    pub(crate) fn cleanup_expired_long_lived(&self) -> Result<()> {
        let now = Utc::now();
        self.db.transaction(|tx| {
            tx.execute(
                "DELETE FROM paired_devices WHERE profile IN ('desktop','mobile') AND (expires_at<=? OR (last_seen_at IS NULL AND created_at<=?))",
                params![timestamp(now), timestamp(now - Duration::minutes(DESKTOP_UNCONFIRMED_TTL_MINUTES))],
            )?;
            Ok(())
        })
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
            "SELECT id,name,permission,profile,created_at,expires_at,last_seen_at,revoked_at
             FROM paired_devices WHERE id=?",
            [device_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(id, name, permission, profile, created_at, expires_at, last_seen_at, revoked_at)| {
            Ok(PairedDevice {
                connected: None,
                id,
                name,
                permission: DevicePermission::from_str(&permission)?,
                profile: DeviceProfile::from_str(&profile)?,
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
    fn iroh_admits_a_paired_key_and_unknown_keys_only_while_a_long_lived_offer_is_open() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        assert_eq!(manager.iroh_admission_at("stranger", now).unwrap(), IrohAdmission::Denied);
        // A phone offer never opens the door for an unknown key.
        let phone = manager.create_pairing_at(DevicePermission::Readonly, "iroh-phone", "https://x", "AA", now).unwrap();
        assert_eq!(manager.iroh_admission_at("stranger", now).unwrap(), IrohAdmission::Denied);
        assert!(manager.pair_at_with(&phone.id, &phone.code, "Phone", Some("phone-key"), now).is_err(), "iroh never pairs legacy phones");
        assert!(manager.pair_at(&phone.id, &phone.code, "Phone", now).is_ok(), "the refused attempt left the phone offer usable");
        let desktop = manager
            .create_pairing_profile_at(DevicePermission::Fullcontrol, DeviceProfile::Desktop, "iroh-desktop", "https://x", "AA", None, now)
            .unwrap();
        assert_eq!(manager.iroh_admission_at("office-key", now).unwrap(), IrohAdmission::PairingOnly);
        let expired = now + Duration::minutes(PAIRING_TTL_MINUTES + 1);
        assert_eq!(manager.iroh_admission_at("office-key", expired).unwrap(), IrohAdmission::Denied, "the window closes with the offer");
        let paired = manager.pair_at_with(&desktop.id, &desktop.code, "Office", Some("office-key"), now).unwrap();
        assert_eq!(manager.iroh_admission_at("office-key", now).unwrap(), IrohAdmission::Paired);
        assert_eq!(manager.iroh_admission_at("stranger", now).unwrap(), IrohAdmission::Denied, "the consumed offer admits nobody else");
        manager.revoke(&paired.device.id, "iroh-revoke").unwrap();
        assert_eq!(manager.iroh_admission_at("office-key", now).unwrap(), IrohAdmission::Denied);
    }

    #[test]
    fn desktop_offers_carry_iroh_only_when_given_and_phones_never() {
        let (_directory, manager) = manager();
        manager.db.update_settings(&json!({"remoteMachines":{"enabled":true}}), 0, "iroh-gate").unwrap();
        let iroh = IrohOffer { endpoint_id: "host-key".into(), relay_url: Some("https://relay.example./".into()) };
        let decode = |offer: &PairingOffer| -> Value {
            let encoded = offer.qr_payload.strip_prefix("threadterm://pair?data=").unwrap();
            serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
        };
        let desktop = manager
            .create_pairing_with_profile(DevicePermission::Fullcontrol, DeviceProfile::Desktop, "iroh-v2", "https://x", "AA", Some(iroh.clone()))
            .unwrap();
        assert_eq!(decode(&desktop)["v"], 2);
        assert_eq!(decode(&desktop)["iroh"]["endpointId"], "host-key");
        assert_eq!(desktop.iroh.as_ref(), Some(&iroh));
        let phone = manager
            .create_pairing_with_profile(DevicePermission::Readonly, DeviceProfile::Phone, "iroh-phone-v1", "https://x", "AA", Some(iroh))
            .unwrap();
        assert_eq!(decode(&phone)["v"], 1);
        assert!(decode(&phone).get("iroh").is_none() && phone.iroh.is_none());
        manager.set_enabled(true).unwrap();
        let mobile = manager
            .create_pairing_with_profile(
                DevicePermission::Readonly,
                DeviceProfile::Mobile,
                "iroh-mobile-v2",
                "https://x",
                "AA",
                Some(IrohOffer { endpoint_id: "mobile-host-key".into(), relay_url: None }),
            )
            .unwrap();
        assert_eq!(decode(&mobile)["v"], 2);
        assert_eq!(decode(&mobile)["profile"], "mobile");
        assert_eq!(decode(&mobile)["iroh"]["endpointId"], "mobile-host-key");
        let plain = manager
            .create_pairing_with_profile(DevicePermission::Fullcontrol, DeviceProfile::Desktop, "tcp-v1", "https://x", "AA", None)
            .unwrap();
        assert_eq!(decode(&plain)["v"], 1);
    }

    #[test]
    fn iroh_settings_persist() {
        let (_directory, manager) = manager();
        let preference = manager.remote_access_preference().unwrap();
        assert!(!preference.iroh_enabled, "off by default");
        assert_eq!(preference.iroh_relay_url, None);
        manager.set_iroh(true, Some("https://relay.example./"), "iroh-set").unwrap();
        let preference = manager.remote_access_preference().unwrap();
        assert!(preference.iroh_enabled);
        assert_eq!(preference.iroh_relay_url.as_deref(), Some("https://relay.example./"));
        assert!(manager.operation_completed("iroh-set").unwrap());
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
        assert!(manager.authenticate_mobile_at(&paired.token, None, now).is_err());
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
    fn desktop_credentials_are_peer_only_idle_expiring_and_unconfirmed_rows_are_deleted() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let offer = manager
            .create_pairing_profile_at(
                DevicePermission::Fullcontrol,
                DeviceProfile::Desktop,
                "desktop-pair",
                "https://x",
                "AA",
                None,
                now,
            )
            .unwrap();
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Office PC", now)
            .unwrap();
        assert!(manager.authenticate_at(&paired.token, now).is_err());
        assert!(manager.authenticate_peer_at(&paired.token, now).is_ok());
        assert!(manager
            .validate_peer_at(
                &paired.device.id,
                now + Duration::days(30) - Duration::milliseconds(1)
            )
            .is_ok());
        assert!(manager
            .validate_peer_at(&paired.device.id, now + Duration::days(30))
            .is_err());
        assert!(
            manager
                .db
                .transaction(|tx| Ok(tx
                    .query_row(
                        "SELECT 1 FROM paired_devices WHERE id=?",
                        [&paired.device.id],
                        |_| Ok(())
                    )
                    .optional()?
                    .is_some()))
                .unwrap()
                == false
        );

        // Exercise the deterministic helper for the ten-minute boundary.
        let late_offer = manager
            .create_pairing_profile_at(
                DevicePermission::Readonly,
                DeviceProfile::Desktop,
                "late-pair",
                "https://x",
                "AA",
                None,
                now,
            )
            .unwrap();
        let late = manager
            .pair_at(&late_offer.id, &late_offer.code, "Late", now)
            .unwrap();
        assert!(manager
            .authenticate_peer_at(&late.token, now + Duration::minutes(11))
            .is_err());
        assert!(!manager
            .db
            .transaction(|tx| Ok(tx
                .query_row(
                    "SELECT 1 FROM paired_devices WHERE id=?",
                    [&late.device.id],
                    |_| Ok(())
                )
                .optional()?
                .is_some()))
            .unwrap());
    }

    #[test]
    fn mobile_credentials_are_profile_and_iroh_key_bound_with_idle_expiry() {
        let (_directory, manager) = manager();
        manager.set_enabled(true).unwrap();
        let now = Utc::now();
        let offer = manager
            .create_pairing_profile_at(
                DevicePermission::Readonly,
                DeviceProfile::Mobile,
                "mobile-pair",
                "https://x",
                "AA",
                Some(IrohOffer { endpoint_id: "host-key".into(), relay_url: None }),
                now,
            )
            .unwrap();
        let paired = manager
            .pair_at_with(&offer.id, &offer.code, "iPhone", Some("phone-iroh-key"), now)
            .unwrap();
        assert_eq!(paired.device.profile, DeviceProfile::Mobile);
        assert_eq!(paired.device.permission, DevicePermission::Readonly);
        assert!(manager.authenticate_at(&paired.token, now).is_err());
        assert!(manager.authenticate_peer_at(&paired.token, now).is_err());
        assert!(manager.authenticate_mobile_at(&paired.token, None, now).is_err());
        assert!(manager.authenticate_mobile_at(&paired.token, Some("other-key"), now).is_err());
        assert!(manager.authenticate_mobile_at(&paired.token, Some("phone-iroh-key"), now).is_ok());
        manager.mobile_activity_at(&paired.device.id, now + Duration::minutes(5)).unwrap();
        assert!(manager.validate_mobile_at(
            &paired.device.id,
            now + Duration::days(30) + Duration::minutes(5) - Duration::milliseconds(1),
        ).is_ok());
        assert_eq!(
            manager
                .validate_mobile_at(
                    &paired.device.id,
                    now + Duration::days(30) + Duration::minutes(5),
                )
                .unwrap_err()
                .to_string(),
            "device_expired",
        );

        let tcp_offer = manager
            .create_pairing_profile_at(
                DevicePermission::Fullcontrol,
                DeviceProfile::Mobile,
                "mobile-tcp-pair",
                "https://x",
                "AA",
                None,
                now,
            )
            .unwrap();
        let tcp = manager
            .pair_at(&tcp_offer.id, &tcp_offer.code, "TCP iPhone", now)
            .unwrap();
        assert!(manager.authenticate_mobile_at(&tcp.token, None, now).is_ok());
        assert!(manager.authenticate_mobile_at(&tcp.token, Some("injected-iroh-key"), now).is_err());
        assert!(manager.authenticate_at(&tcp.token, now).is_err());
        assert!(manager.authenticate_peer_at(&tcp.token, now).is_err());
        manager.revoke(&tcp.device.id, "revoke-mobile-tcp").unwrap();
        assert_eq!(
            manager
                .validate_mobile_at(&tcp.device.id, now)
                .unwrap_err()
                .to_string(),
            "device_revoked",
        );
    }

    #[test]
    fn remote_machines_setting_defaults_off_and_requires_enabled_boolean() {
        let (_directory, manager) = manager();
        assert!(!manager.remote_machines_enabled().unwrap());
        manager
            .db
            .update_settings(
                &json!({"remoteMachines":{"enabled":true}}),
                0,
                "enable-remote-machines",
            )
            .unwrap();
        assert!(manager.remote_machines_enabled().unwrap());
        for invalid in [json!({"enabled":"yes"}), json!({}), json!({"enabled":true,"extra":true}), Value::Null] {
            assert!(crate::settings_services::valid_runtime_patch(&json!({"remoteMachines":invalid})).is_err());
        }
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

    #[test]
    fn desktop_offers_require_the_gate_and_desktop_activity_is_idle_based() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        assert!(manager
            .create_pairing_with_profile(
                DevicePermission::Fullcontrol,
                DeviceProfile::Desktop,
                "desktop-disabled",
                "https://x",
                "AA",
                None,
            )
            .is_err());
        assert!(manager
            .create_pairing_with_profile(
                DevicePermission::Readonly,
                DeviceProfile::Desktop,
                "desktop-readonly",
                "https://x",
                "AA",
                None,
            )
            .is_err());
        manager
            .db
            .update_settings(
                &json!({"remoteMachines":{"enabled":true}}),
                0,
                "enable-remote-machines",
            )
            .unwrap();
        let offer = manager
            .create_pairing_with_profile(
                DevicePermission::Fullcontrol,
                DeviceProfile::Desktop,
                "desktop-enabled",
                "https://x",
                "AA",
                None,
            )
            .unwrap();
        let paired = manager
            .pair_at(&offer.id, &offer.code, "Office", now)
            .unwrap();
        assert!(manager.authenticate_at(&paired.token, now).is_err());
        assert!(manager.authenticate_mobile_at(&paired.token, None, now).is_err());
        manager.authenticate_peer_at(&paired.token, now).unwrap();
        let initial_expiry: String = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT expires_at FROM paired_devices WHERE id=?",
                    [&paired.device.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        manager
            .peer_activity_at(&paired.device.id, now + Duration::minutes(1))
            .unwrap();
        let coalesced_expiry: String = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT expires_at FROM paired_devices WHERE id=?",
                    [&paired.device.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(coalesced_expiry, initial_expiry);
        manager
            .peer_activity_at(&paired.device.id, now + Duration::minutes(5))
            .unwrap();
        let extended_expiry: String = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT expires_at FROM paired_devices WHERE id=?",
                    [&paired.device.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            extended_expiry,
            timestamp(now + Duration::minutes(5) + Duration::days(30))
        );
        assert!(manager
            .validate_peer_at(
                &paired.device.id,
                now + Duration::days(30) + Duration::minutes(5)
            )
            .is_err());
    }

    #[test]
    fn desktop_cleanup_does_not_delete_expired_phone_credentials() {
        let (_directory, manager) = manager();
        let now = Utc::now();
        let phone_offer = manager
            .create_pairing_at(DevicePermission::Readonly, "phone", "https://x", "AA", now)
            .unwrap();
        let phone = manager
            .pair_at(&phone_offer.id, &phone_offer.code, "Phone", now)
            .unwrap();
        manager
            .db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE paired_devices SET expires_at=? WHERE id=?",
                    params![timestamp(now - Duration::days(1)), phone.device.id],
                )?;
                Ok(())
            })
            .unwrap();
        manager.cleanup_expired_long_lived().unwrap();
        assert!(manager
            .db
            .transaction(|tx| Ok(tx
                .query_row(
                    "SELECT 1 FROM paired_devices WHERE id=?",
                    [&phone.device.id],
                    |_| Ok(())
                )
                .optional()?
                .is_some()))
            .unwrap());
    }

    #[test]
    fn permission_change_persists_replays_and_rejects_revoked_devices() {
        let (_directory, manager) = manager();
        manager
            .set_remote_access_preference(true, None, None)
            .unwrap();
        let offer = manager
            .create_pairing_with_profile(
                DevicePermission::Fullcontrol,
                DeviceProfile::Mobile,
                "permission-mobile",
                "https://x",
                "AA",
                None,
            )
            .unwrap();
        let paired = manager.pair(&offer.id, &offer.code, "Phone", None).unwrap();
        let leased = manager
            .db
            .create_session(crate::db::CreateSession {
                project_id: None,
                title: Some("Permission lease"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "permission-lease",
            })
            .unwrap();
        let other = manager
            .db
            .create_session(crate::db::CreateSession {
                project_id: None,
                title: Some("Other lease"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "other-permission-lease",
            })
            .unwrap();
        let future = timestamp(Utc::now() + Duration::hours(1));
        manager
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES(?,?,1,?)",
                    params![leased.id, format!("device:{}", paired.device.id), future],
                )?;
                tx.execute(
                    "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES(?,?,1,?)",
                    params![other.id, "device:unaffected", future],
                )?;
                Ok(())
            })
            .unwrap();

        let changed = manager
            .set_permission(
                &paired.device.id,
                DevicePermission::Readonly,
                "permission-readonly",
            )
            .unwrap();
        assert_eq!(changed.permission, DevicePermission::Readonly);
        assert_eq!(
            manager
                .set_permission(
                    &paired.device.id,
                    DevicePermission::Readonly,
                    "permission-readonly",
                )
                .unwrap(),
            changed,
            "the operation result is safe to replay"
        );
        assert_eq!(manager.list().unwrap()[0].permission, DevicePermission::Readonly);
        let target_expiry: String = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT expires_at FROM leases WHERE session_id=?",
                    [&leased.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        let other_expiry: String = manager
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT expires_at FROM leases WHERE session_id=?",
                    [&other.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(parse_timestamp(&target_expiry).unwrap() <= Utc::now());
        assert_eq!(other_expiry, future, "only this device's legacy lease expires");
        manager.revoke(&paired.device.id, "permission-revoke").unwrap();
        assert!(manager
            .set_permission(
                &paired.device.id,
                DevicePermission::Fullcontrol,
                "permission-after-revoke",
            )
            .is_err());
    }
}
