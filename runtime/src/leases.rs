use crate::db::Database;
use anyhow::{bail, Result};
use chrono::{Duration, Utc};

/// Lease epochs fence stale clients after reconnect or takeover.
pub struct LeaseManager {
    ttl: Duration,
}
impl Default for LeaseManager {
    fn default() -> Self {
        Self {
            ttl: Duration::seconds(30),
        }
    }
}
impl LeaseManager {
    pub fn claim(&self, db: &Database, session_id: &str, client_id: &str) -> Result<i64> {
        let prior = db.lease(session_id)?;
        let now = Utc::now();
        if let Some((holder, epoch, expires)) = prior {
            let expires = chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc);
            if holder == client_id && expires > now {
                db.put_lease(session_id, client_id, epoch, &(now + self.ttl).to_rfc3339())?;
                return Ok(epoch);
            }
            if holder != client_id && expires > now {
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
