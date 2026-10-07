use crate::db::Database;
use anyhow::{bail, Result};
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Remote devices reach the runtime over HTTP without a lasting connection, so their leases keep plain TTL expiry.
const REMOTE_PRINCIPAL_PREFIX: &str = "device:";

#[derive(Default)]
struct Presence {
    connected: HashMap<String, usize>,
    /// Principals without a control connection that may still hold live leases, with when they left.
    departed: HashMap<String, DateTime<Utc>>,
}

/// Lease epochs fence stale clients after reconnect or takeover.
pub struct LeaseManager {
    ttl: Duration,
    presence: Arc<Mutex<Presence>>,
}
impl Default for LeaseManager {
    fn default() -> Self {
        Self {
            ttl: Duration::seconds(30),
            presence: Arc::default(),
        }
    }
}

/// Held for the life of one control connection. A restarted desktop gets a new principal, so once the old
/// principal has no connection left its leases stop blocking others instead of lasting out the TTL.
pub struct ControlPresence {
    presence: Arc<Mutex<Presence>>,
    principal: String,
    ttl: Duration,
}
impl Drop for ControlPresence {
    fn drop(&mut self) {
        let mut presence = self.presence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(count) = presence.connected.get_mut(&self.principal) else { return };
        *count -= 1;
        if *count > 0 {
            return;
        }
        presence.connected.remove(&self.principal);
        let now = Utc::now();
        // A departed principal cannot renew, so its leases are expired a TTL later (plus slack for a request
        // that was still in flight); forget it after that.
        let horizon = now - self.ttl * 2;
        presence.departed.retain(|_, left| *left > horizon);
        presence.departed.insert(self.principal.clone(), now);
    }
}

impl LeaseManager {
    pub fn connect(&self, principal: &str) -> ControlPresence {
        let mut presence = self.presence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *presence.connected.entry(principal.to_owned()).or_default() += 1;
        presence.departed.remove(principal);
        ControlPresence { presence: Arc::clone(&self.presence), principal: principal.to_owned(), ttl: self.ttl }
    }
    /// Runs before the first connection: every live lease then belongs to a client of a previous runtime. The
    /// same client reconnecting keeps its lease and epoch; anyone else may take it over.
    pub fn adopt_previous(&self, db: &Database) -> Result<()> {
        let now = Utc::now();
        let holders = db.transaction(|tx| {
            let mut statement = tx.prepare("SELECT client_id, expires_at FROM leases")?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        let mut presence = self.presence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (holder, expires) in holders {
            let live = DateTime::parse_from_rfc3339(&expires).is_ok_and(|expires| expires.with_timezone(&Utc) > now);
            if live && !holder.starts_with(REMOTE_PRINCIPAL_PREFIX) && !presence.connected.contains_key(&holder) {
                presence.departed.insert(holder, now);
            }
        }
        Ok(())
    }
    fn departed(&self, principal: &str) -> bool {
        let presence = self.presence.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        presence.departed.contains_key(principal)
    }
    pub fn claim(&self, db: &Database, session_id: &str, client_id: &str) -> Result<i64> {
        let prior = db.lease(session_id)?;
        let now = Utc::now();
        if let Some((holder, epoch, expires)) = prior {
            let expires = chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc);
            if holder == client_id && expires > now {
                db.put_lease(session_id, client_id, epoch, &(now + self.ttl).to_rfc3339())?;
                return Ok(epoch);
            }
            if holder != client_id && expires > now && !self.departed(&holder) {
                bail!("lease_held")
            }
            let next = epoch + 1;
            db.put_lease(session_id, client_id, next, &(now + self.ttl).to_rfc3339())?;
            Ok(next)
        } else {
            db.put_lease(session_id, client_id, 1, &(now + self.ttl).to_rfc3339())?;
            Ok(1)
        }
    }
    pub fn require(
        &self,
        db: &Database,
        session_id: &str,
        principal: &str,
        epoch: i64,
    ) -> Result<()> {
        let Some((holder, current, expires)) = db.lease(session_id)? else {
            bail!("lease_missing")
        };
        if holder != principal
            || current != epoch
            || chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc) <= Utc::now()
        {
            bail!("stale_lease")
        };
        Ok(())
    }
    pub fn release(
        &self,
        db: &Database,
        session_id: &str,
        principal: &str,
        epoch: i64,
    ) -> Result<()> {
        self.require(db, session_id, principal, epoch)?;
        // Preserve the last epoch when releasing so a later claimant cannot
        // receive an epoch that has already been fenced out.
        db.put_lease(session_id, principal, epoch, &Utc::now().to_rfc3339())?;
        Ok(())
    }
    pub fn renew(
        &self,
        db: &Database,
        session_id: &str,
        principal: &str,
        epoch: i64,
    ) -> Result<i64> {
        self.require(db, session_id, principal, epoch)?;
        db.put_lease(
            session_id,
            principal,
            epoch,
            &(Utc::now() + self.ttl).to_rfc3339(),
        )?;
        Ok(epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;

    fn database(sessions: usize) -> (tempfile::TempDir, Database, Vec<String>) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("leases.sqlite")).unwrap();
        let ids = (0..sessions)
            .map(|index| {
                let operation = format!("lease-session-{index}");
                db.create_session(CreateSession {
                    project_id: None,
                    title: None,
                    provider: "shell",
                    mode: "terminal",
                    native_id: None,
                    operation_id: &operation,
                })
                .unwrap()
                .id
            })
            .collect();
        (root, db, ids)
    }

    #[test]
    fn a_departed_principal_stops_blocking_others_and_is_fenced_out() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let old = leases.connect("old-window");
        let epoch = leases.claim(&db, &ids[0], "old-window").unwrap();
        let _new = leases.connect("new-window");
        assert_eq!(leases.claim(&db, &ids[0], "new-window").unwrap_err().to_string(), "lease_held");
        drop(old);
        assert_eq!(leases.claim(&db, &ids[0], "new-window").unwrap(), epoch + 1);
        assert!(leases.require(&db, &ids[0], "old-window", epoch).is_err());
    }

    #[test]
    fn a_principal_that_reconnects_keeps_its_lease_and_epoch() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let epoch = {
            let _first = leases.connect("window");
            leases.claim(&db, &ids[0], "window").unwrap()
        };
        let _again = leases.connect("window");
        assert_eq!(leases.claim(&db, &ids[0], "window").unwrap(), epoch);
        assert_eq!(leases.claim(&db, &ids[0], "other").unwrap_err().to_string(), "lease_held");
    }

    #[test]
    fn a_principal_stays_present_while_any_of_its_connections_is_open() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let first = leases.connect("window");
        let second = leases.connect("window");
        let epoch = leases.claim(&db, &ids[0], "window").unwrap();
        drop(first);
        assert_eq!(leases.claim(&db, &ids[0], "other").unwrap_err().to_string(), "lease_held");
        drop(second);
        assert_eq!(leases.claim(&db, &ids[0], "other").unwrap(), epoch + 1);
    }

    #[test]
    fn leases_from_a_previous_runtime_are_adopted_except_remote_devices() {
        let (_root, db, ids) = database(3);
        let previous = LeaseManager::default();
        let desktop = previous.claim(&db, &ids[0], "old-desktop").unwrap();
        previous.claim(&db, &ids[1], "device:phone").unwrap();
        let returning = previous.claim(&db, &ids[2], "returning-desktop").unwrap();

        let leases = LeaseManager::default();
        leases.adopt_previous(&db).unwrap();
        let _returning = leases.connect("returning-desktop");
        let _other = leases.connect("new-desktop");
        assert_eq!(leases.claim(&db, &ids[0], "new-desktop").unwrap(), desktop + 1);
        assert_eq!(leases.claim(&db, &ids[1], "new-desktop").unwrap_err().to_string(), "lease_held");
        assert_eq!(leases.claim(&db, &ids[2], "returning-desktop").unwrap(), returning);
        assert_eq!(leases.claim(&db, &ids[2], "new-desktop").unwrap_err().to_string(), "lease_held");
    }
}
