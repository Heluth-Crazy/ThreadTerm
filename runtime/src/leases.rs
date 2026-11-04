use crate::db::Database;
use anyhow::{bail, Result};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration as StdDuration;

/// Remote devices reach the runtime over HTTP without a lasting connection, so their leases keep plain TTL expiry.
const REMOTE_PRINCIPAL_PREFIX: &str = "device:";

/// Bound for a claimant waiting on another principal's mid-effect fence (for example a blocking ConPTY write).
const CLAIM_FENCE_WAIT: StdDuration = StdDuration::from_secs(2);

#[derive(Default)]
struct Presence {
    connected: HashMap<String, usize>,
    /// Principals without a control connection that may still hold live leases, with when they left.
    departed: HashMap<String, DateTime<Utc>>,
}

/// Lease epochs fence stale clients after reconnect or takeover.
///
/// Lock order: DB connection (via [`Database::transaction`]) → presence.
/// No path holds `presence` while taking the DB connection: [`Self::connect`] /
/// [`ControlPresence::drop`] only touch presence; [`Self::adopt_previous`] finishes
/// its DB transaction before locking presence; claim/renew/release take presence
/// only inside an already-open transaction.
pub struct LeaseManager {
    ttl: Duration,
    presence: Arc<Mutex<Presence>>,
    /// Per-session control fences. Dead `Weak`s are pruned on insert.
    fences: Mutex<HashMap<String, Weak<Fence>>>,
}
impl Default for LeaseManager {
    fn default() -> Self {
        Self {
            ttl: Duration::seconds(30),
            presence: Arc::default(),
            fences: Mutex::new(HashMap::new()),
        }
    }
}

/// One session's control fence. A flag under a mutex rather than the mutex itself, so the guard below can own
/// its fence without borrowing a `MutexGuard`.
#[derive(Default)]
struct Fence {
    held: Mutex<bool>,
    released: Condvar,
}

/// RAII per-session control fence. Different sessions never share a fence. Dropping it, also on unwind, lets a
/// waiting claim/renew/release/input/resize proceed.
pub struct SessionFence {
    fence: Arc<Fence>,
}

impl SessionFence {
    /// Waits until the fence is free, or at most `timeout`; `None` if it was still held then.
    fn acquire(fence: Arc<Fence>, timeout: Option<StdDuration>) -> Option<Self> {
        let held = fence.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut held = match timeout {
            None => fence.released.wait_while(held, |held| *held).unwrap_or_else(|poisoned| poisoned.into_inner()),
            Some(timeout) => {
                fence.released.wait_timeout_while(held, timeout, |held| *held).unwrap_or_else(|poisoned| poisoned.into_inner()).0
            }
        };
        if *held {
            return None;
        }
        *held = true;
        drop(held);
        Some(Self { fence })
    }
}

impl Drop for SessionFence {
    fn drop(&mut self) {
        *self.fence.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
        self.fence.released.notify_one();
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

fn read_lease(tx: &Transaction<'_>, session_id: &str) -> Result<Option<(String, i64, String)>> {
    tx.query_row(
        "SELECT client_id,epoch,expires_at FROM leases WHERE session_id=?",
        [session_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(Into::into)
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

    fn fence_arc(&self, session_id: &str) -> Arc<Fence> {
        let mut fences = self.fences.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        fences.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = fences.get(session_id).and_then(Weak::upgrade) {
            return existing;
        }
        let arc = Arc::new(Fence::default());
        fences.insert(session_id.to_owned(), Arc::downgrade(&arc));
        arc
    }

    /// Acquire the per-session control fence (blocking). Hold across a short DB check and any PTY effect.
    pub fn fence(&self, session_id: &str) -> SessionFence {
        SessionFence::acquire(self.fence_arc(session_id), None).expect("an unbounded fence wait always acquires")
    }

    pub fn claim(&self, db: &Database, session_id: &str, client_id: &str) -> Result<i64> {
        let Some(_fence) = SessionFence::acquire(self.fence_arc(session_id), Some(CLAIM_FENCE_WAIT)) else {
            bail!("lease_held");
        };
        db.transaction(|tx| {
            let prior = read_lease(tx, session_id)?;
            let now = Utc::now();
            let expires_at = (now + self.ttl).to_rfc3339();
            let now_rfc = now.to_rfc3339();
            if let Some((holder, epoch, expires)) = prior {
                let expires = chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc);
                if holder == client_id && expires > now {
                    let updated = tx.execute(
                        "UPDATE leases SET expires_at=? WHERE session_id=? AND client_id=? AND epoch=? AND expires_at>?",
                        params![expires_at, session_id, client_id, epoch, now_rfc],
                    )?;
                    if updated != 1 {
                        bail!("stale_lease");
                    }
                    return Ok(epoch);
                }
                if holder != client_id && expires > now && !self.departed(&holder) {
                    bail!("lease_held");
                }
                let next = epoch + 1;
                let updated = tx.execute(
                    "UPDATE leases SET client_id=?, epoch=?, expires_at=? WHERE session_id=? AND epoch=?",
                    params![client_id, next, expires_at, session_id, epoch],
                )?;
                if updated != 1 {
                    bail!("stale_lease");
                }
                Ok(next)
            } else {
                match tx.execute(
                    "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?,?,1,?)",
                    params![session_id, client_id, expires_at],
                ) {
                    Ok(1) => Ok(1),
                    Ok(_) => bail!("stale_lease"),
                    Err(rusqlite::Error::SqliteFailure(err, _))
                        if err.code == rusqlite::ErrorCode::ConstraintViolation =>
                    {
                        bail!("lease_held")
                    }
                    Err(error) => Err(error.into()),
                }
            }
        })
    }
    /// Explicit user action only. Serialize with in-flight PTY effects before fencing the old owner.
    pub fn take_control(&self, db: &Database, session_id: &str, principal: &str) -> Result<i64> {
        let Some(_fence) = SessionFence::acquire(self.fence_arc(session_id), Some(CLAIM_FENCE_WAIT)) else { bail!("lease_held"); };
        db.transaction(|tx| {
            let next = read_lease(tx, session_id)?.map(|(_, epoch, _)| epoch + 1).unwrap_or(1);
            tx.execute("INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET client_id=excluded.client_id,epoch=excluded.epoch,expires_at=excluded.expires_at",
                params![session_id, principal, next, (Utc::now() + self.ttl).to_rfc3339()])?;
            Ok(next)
        })
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
        let _fence = self.fence(session_id);
        db.transaction(|tx| {
            let Some((holder, current, expires)) = read_lease(tx, session_id)? else {
                bail!("lease_missing")
            };
            let now = Utc::now();
            if holder != principal
                || current != epoch
                || chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc) <= now
            {
                bail!("stale_lease")
            }
            // Preserve the last epoch when releasing so a later claimant cannot
            // receive an epoch that has already been fenced out.
            let now_rfc = now.to_rfc3339();
            let updated = tx.execute(
                "UPDATE leases SET expires_at=? WHERE session_id=? AND client_id=? AND epoch=? AND expires_at>?",
                params![now_rfc, session_id, principal, epoch, now_rfc],
            )?;
            if updated != 1 {
                bail!("stale_lease");
            }
            Ok(())
        })
    }
    pub fn renew(
        &self,
        db: &Database,
        session_id: &str,
        principal: &str,
        epoch: i64,
    ) -> Result<i64> {
        let _fence = self.fence(session_id);
        db.transaction(|tx| {
            let Some((holder, current, expires)) = read_lease(tx, session_id)? else {
                bail!("lease_missing")
            };
            let now = Utc::now();
            if holder != principal
                || current != epoch
                || chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc) <= now
            {
                bail!("stale_lease")
            }
            let now_rfc = now.to_rfc3339();
            let expires_at = (now + self.ttl).to_rfc3339();
            let updated = tx.execute(
                "UPDATE leases SET expires_at=? WHERE session_id=? AND client_id=? AND epoch=? AND expires_at>?",
                params![expires_at, session_id, principal, epoch, now_rfc],
            )?;
            if updated != 1 {
                bail!("stale_lease");
            }
            Ok(epoch)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use std::sync::Barrier;
    use std::thread;
    use std::time::Instant;

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
    fn explicit_terminal_takeover_fences_both_directions_and_old_release() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let _local = leases.connect("local-window");
        let _remote = leases.connect("peer:device:remote-window");
        let local = leases.claim(&db, &ids[0], "local-window").unwrap();
        assert!(leases.claim(&db, &ids[0], "peer:device:remote-window").is_err());
        let remote = leases.take_control(&db, &ids[0], "peer:device:remote-window").unwrap();
        assert!(remote > local);
        assert!(leases.require(&db, &ids[0], "local-window", local).is_err());
        assert!(leases.renew(&db, &ids[0], "local-window", local).is_err());
        let _ = leases.release(&db, &ids[0], "local-window", local);
        assert!(leases.require(&db, &ids[0], "peer:device:remote-window", remote).is_ok());
        let next = leases.take_control(&db, &ids[0], "local-window").unwrap();
        assert!(next > remote);
        assert!(leases.require(&db, &ids[0], "peer:device:remote-window", remote).is_err());
        assert!(leases.require(&db, &ids[0], "local-window", next).is_ok());
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

    #[test]
    fn claim_race_on_a_free_lease_has_exactly_one_winner() {
        let (_root, db, ids) = database(200);
        let db = Arc::new(db);
        let leases = Arc::new(LeaseManager::default());
        for session_id in &ids {
            let barrier = Arc::new(Barrier::new(2));
            let mut handles = Vec::new();
            for client in ["a", "b"] {
                let barrier = Arc::clone(&barrier);
                let leases = Arc::clone(&leases);
                let db = Arc::clone(&db);
                let session_id = session_id.clone();
                handles.push(thread::spawn(move || {
                    barrier.wait();
                    (client, leases.claim(&db, &session_id, client))
                }));
            }
            let results: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            let wins: Vec<_> = results
                .iter()
                .filter_map(|(client, result)| result.as_ref().ok().map(|epoch| (*client, *epoch)))
                .collect();
            let losses: Vec<_> = results
                .iter()
                .filter_map(|(client, result)| {
                    result
                        .as_ref()
                        .err()
                        .map(|error| (*client, error.to_string()))
                })
                .collect();
            assert_eq!(wins.len(), 1, "session {session_id}: {results:?}");
            assert_eq!(losses.len(), 1, "session {session_id}: {results:?}");
            assert_eq!(losses[0].1, "lease_held");
            let (winner, epoch) = wins[0];
            assert_eq!(epoch, 1);
            let stored = db.lease(session_id).unwrap().unwrap();
            assert_eq!(stored.0, winner);
            assert_eq!(stored.1, 1);
        }
    }

    #[test]
    fn claim_race_on_an_expired_lease_advances_epoch_once() {
        let (_root, db, ids) = database(50);
        let db = Arc::new(db);
        let leases = Arc::new(LeaseManager::default());
        let past = (Utc::now() - Duration::seconds(5)).to_rfc3339();
        for session_id in &ids {
            db.put_lease(session_id, "seed", 3, &past).unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let mut handles = Vec::new();
            for client in ["a", "b"] {
                let barrier = Arc::clone(&barrier);
                let leases = Arc::clone(&leases);
                let db = Arc::clone(&db);
                let session_id = session_id.clone();
                handles.push(thread::spawn(move || {
                    barrier.wait();
                    (client, leases.claim(&db, &session_id, client))
                }));
            }
            let results: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            let wins: Vec<_> = results
                .iter()
                .filter_map(|(client, result)| result.as_ref().ok().map(|epoch| (*client, *epoch)))
                .collect();
            let losses: Vec<_> = results
                .iter()
                .filter_map(|(_, result)| result.as_ref().err().map(|error| error.to_string()))
                .collect();
            assert_eq!(wins.len(), 1, "{results:?}");
            assert_eq!(losses, vec!["lease_held".to_owned()]);
            let (winner, epoch) = wins[0];
            assert_eq!(epoch, 4);
            let stored = db.lease(session_id).unwrap().unwrap();
            assert_eq!(stored.0, winner);
            assert_eq!(stored.1, 4);
        }
    }

    #[test]
    fn renew_cannot_overwrite_a_takeover_after_expiry() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let past = (Utc::now() - Duration::seconds(1)).to_rfc3339();
        db.put_lease(&ids[0], "a", 1, &past).unwrap();
        assert_eq!(
            leases.renew(&db, &ids[0], "a", 1).unwrap_err().to_string(),
            "stale_lease"
        );
        assert_eq!(leases.claim(&db, &ids[0], "b").unwrap(), 2);
        assert_eq!(
            leases.renew(&db, &ids[0], "a", 1).unwrap_err().to_string(),
            "stale_lease"
        );
        let (holder, epoch, _) = db.lease(&ids[0]).unwrap().unwrap();
        assert_eq!(holder, "b");
        assert_eq!(epoch, 2);
    }

    #[test]
    fn fence_ordering_times_out_same_session_and_spares_others() {
        let (_root, db, ids) = database(2);
        let db = Arc::new(db);
        let leases = Arc::new(LeaseManager::default());
        let held = leases.fence(&ids[0]);

        let claim_leases = Arc::clone(&leases);
        let claim_db = Arc::clone(&db);
        let claim_session = ids[0].clone();
        let started = Instant::now();
        let claim = thread::spawn(move || claim_leases.claim(&claim_db, &claim_session, "other"));
        let err = claim.join().unwrap().unwrap_err().to_string();
        let waited = started.elapsed();
        assert_eq!(err, "lease_held");
        assert!(
            waited >= StdDuration::from_millis(1500) && waited < StdDuration::from_secs(4),
            "claim fence wait was {waited:?}"
        );

        let other_started = Instant::now();
        assert_eq!(leases.claim(&db, &ids[1], "other").unwrap(), 1);
        assert!(
            other_started.elapsed() < StdDuration::from_millis(200),
            "other session was blocked"
        );

        drop(held);
        assert_eq!(leases.claim(&db, &ids[0], "other").unwrap(), 1);
    }

    #[test]
    fn a_released_fence_wakes_a_waiting_claim_before_its_bound() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let held = leases.fence(&ids[0]);
        thread::scope(|scope| {
            let claim = scope.spawn(|| {
                let started = Instant::now();
                (leases.claim(&db, &ids[0], "other"), started.elapsed())
            });
            thread::sleep(StdDuration::from_millis(150));
            drop(held);
            let (claimed, waited) = claim.join().unwrap();
            assert_eq!(claimed.unwrap(), 1);
            assert!(waited < StdDuration::from_secs(1), "the claim waited out its bound: {waited:?}");
        });
    }

    #[test]
    fn takeover_fences_out_the_prior_holder_require() {
        let (_root, db, ids) = database(1);
        let leases = LeaseManager::default();
        let old = leases.connect("a");
        let epoch = leases.claim(&db, &ids[0], "a").unwrap();
        drop(old);
        let _new = leases.connect("b");
        assert_eq!(leases.claim(&db, &ids[0], "b").unwrap(), epoch + 1);
        let _fence = leases.fence(&ids[0]);
        assert_eq!(
            leases
                .require(&db, &ids[0], "a", epoch)
                .unwrap_err()
                .to_string(),
            "stale_lease"
        );
    }
}
