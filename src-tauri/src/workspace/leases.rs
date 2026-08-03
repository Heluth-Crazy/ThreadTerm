//! Runtime-only edit leases. Never restored as held after process restart.

use super::types::{EditorLeaseSnapshot, LEASE_DISCONNECT_GRACE_MS};
use std::collections::HashMap;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

/// Deterministic clock for unit tests.
#[cfg(test)]
#[derive(Default)]
pub struct TestClock {
    now_ms: AtomicU64,
}

#[cfg(test)]
impl TestClock {
    pub fn new(start_ms: u64) -> Self {
        Self {
            now_ms: AtomicU64::new(start_ms),
        }
    }

    pub fn advance(&self, delta_ms: u64) {
        self.now_ms.fetch_add(delta_ms, Ordering::SeqCst);
    }

    #[allow(dead_code)]
    pub fn set(&self, now_ms: u64) {
        self.now_ms.store(now_ms, Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone)]
pub struct LeaseEntry {
    pub holder_surface_id: String,
    pub revision: u64,
    pub acquired_at_unix_ms: u64,
    pub renewed_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Default)]
pub struct LeaseTable {
    /// key = workspace_id + "\0" + tab_id
    entries: HashMap<String, LeaseEntry>,
}

fn lease_key(workspace_id: &str, tab_id: &str) -> String {
    format!("{workspace_id}\0{tab_id}")
}

impl LeaseTable {
    pub fn snapshot_all(&self, now_ms: u64) -> Vec<EditorLeaseSnapshot> {
        self.entries
            .iter()
            .filter(|(_, entry)| {
                entry
                    .expires_at_unix_ms
                    .map(|exp| exp > now_ms)
                    .unwrap_or(true)
            })
            .map(|(key, entry)| {
                let mut parts = key.splitn(2, '\0');
                let workspace_id = parts.next().unwrap_or_default().to_string();
                let tab_id = parts.next().unwrap_or_default().to_string();
                EditorLeaseSnapshot {
                    workspace_id,
                    tab_id,
                    holder_surface_id: entry.holder_surface_id.clone(),
                    revision: entry.revision,
                    acquired_at_unix_ms: entry.acquired_at_unix_ms,
                    renewed_at_unix_ms: entry.renewed_at_unix_ms,
                    expires_at_unix_ms: entry.expires_at_unix_ms,
                }
            })
            .collect()
    }

    pub fn active_count(&self, now_ms: u64) -> u64 {
        self.entries
            .values()
            .filter(|entry| {
                entry
                    .expires_at_unix_ms
                    .map(|exp| exp > now_ms)
                    .unwrap_or(true)
            })
            .count() as u64
    }

    pub fn purge_expired(&mut self, now_ms: u64) {
        self.entries.retain(|_, entry| {
            entry
                .expires_at_unix_ms
                .map(|exp| exp > now_ms)
                .unwrap_or(true)
        });
    }

    pub fn get(&self, workspace_id: &str, tab_id: &str, now_ms: u64) -> Option<&LeaseEntry> {
        let key = lease_key(workspace_id, tab_id);
        self.entries.get(&key).filter(|entry| {
            entry
                .expires_at_unix_ms
                .map(|exp| exp > now_ms)
                .unwrap_or(true)
        })
    }

    pub fn acquire(
        &mut self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        revision: u64,
        now_ms: u64,
    ) -> Result<LeaseEntry, Option<LeaseEntry>> {
        self.purge_expired(now_ms);
        let key = lease_key(workspace_id, tab_id);
        if let Some(existing) = self.entries.get(&key) {
            if existing.holder_surface_id == holder_surface_id {
                let mut updated = existing.clone();
                updated.renewed_at_unix_ms = now_ms;
                updated.expires_at_unix_ms = None;
                updated.revision = revision;
                self.entries.insert(key, updated.clone());
                return Ok(updated);
            }
            return Err(Some(existing.clone()));
        }
        let entry = LeaseEntry {
            holder_surface_id: holder_surface_id.to_string(),
            revision,
            acquired_at_unix_ms: now_ms,
            renewed_at_unix_ms: now_ms,
            expires_at_unix_ms: None,
        };
        self.entries.insert(key, entry.clone());
        Ok(entry)
    }

    pub fn renew(
        &mut self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        now_ms: u64,
    ) -> Result<LeaseEntry, Option<LeaseEntry>> {
        self.purge_expired(now_ms);
        let key = lease_key(workspace_id, tab_id);
        match self.entries.get_mut(&key) {
            Some(entry) if entry.holder_surface_id == holder_surface_id => {
                entry.renewed_at_unix_ms = now_ms;
                entry.expires_at_unix_ms = None;
                Ok(entry.clone())
            }
            Some(entry) => Err(Some(entry.clone())),
            None => Err(None),
        }
    }

    pub fn release(
        &mut self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        now_ms: u64,
    ) -> bool {
        self.purge_expired(now_ms);
        let key = lease_key(workspace_id, tab_id);
        match self.entries.get(&key) {
            Some(entry) if entry.holder_surface_id == holder_surface_id => {
                self.entries.remove(&key);
                true
            }
            _ => false,
        }
    }

    pub fn takeover(
        &mut self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        revision: u64,
        now_ms: u64,
    ) -> LeaseEntry {
        self.purge_expired(now_ms);
        let key = lease_key(workspace_id, tab_id);
        let entry = LeaseEntry {
            holder_surface_id: holder_surface_id.to_string(),
            revision,
            acquired_at_unix_ms: now_ms,
            renewed_at_unix_ms: now_ms,
            expires_at_unix_ms: None,
        };
        self.entries.insert(key, entry.clone());
        entry
    }

    /// Unexpected disconnect: keep the lease for 30 seconds.
    pub fn schedule_disconnect_grace(
        &mut self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        now_ms: u64,
    ) -> Option<LeaseEntry> {
        self.purge_expired(now_ms);
        let key = lease_key(workspace_id, tab_id);
        match self.entries.get_mut(&key) {
            Some(entry) if entry.holder_surface_id == holder_surface_id => {
                entry.expires_at_unix_ms = Some(now_ms.saturating_add(LEASE_DISCONNECT_GRACE_MS));
                Some(entry.clone())
            }
            _ => None,
        }
    }

    /// Immediate revoke (graceful close / device revocation).
    pub fn revoke_holder(&mut self, holder_surface_id: &str) -> Vec<(String, String)> {
        let mut removed = Vec::new();
        self.entries.retain(|key, entry| {
            if entry.holder_surface_id == holder_surface_id {
                let mut parts = key.splitn(2, '\0');
                let workspace_id = parts.next().unwrap_or_default().to_string();
                let tab_id = parts.next().unwrap_or_default().to_string();
                removed.push((workspace_id, tab_id));
                false
            } else {
                true
            }
        });
        removed
    }

    pub fn is_holder(
        &self,
        workspace_id: &str,
        tab_id: &str,
        holder_surface_id: &str,
        now_ms: u64,
    ) -> bool {
        self.get(workspace_id, tab_id, now_ms)
            .map(|entry| entry.holder_surface_id == holder_surface_id)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_renew_takeover_and_grace_expiry() {
        let clock = TestClock::new(1_000);
        let mut table = LeaseTable::default();
        let now = clock.now_ms();
        let first = table.acquire("ws", "tab", "desktop:main", 1, now).unwrap();
        assert_eq!(first.holder_surface_id, "desktop:main");

        assert!(table
            .acquire("ws", "tab", "mobile:1", 1, now)
            .err()
            .flatten()
            .is_some());

        table
            .renew("ws", "tab", "desktop:main", clock.now_ms())
            .unwrap();
        let taken = table.takeover("ws", "tab", "mobile:1", 2, clock.now_ms());
        assert_eq!(taken.holder_surface_id, "mobile:1");
        assert!(!table.is_holder("ws", "tab", "desktop:main", clock.now_ms()));

        table.schedule_disconnect_grace("ws", "tab", "mobile:1", clock.now_ms());
        clock.advance(LEASE_DISCONNECT_GRACE_MS - 1);
        assert!(table.is_holder("ws", "tab", "mobile:1", clock.now_ms()));
        clock.advance(2);
        assert!(!table.is_holder("ws", "tab", "mobile:1", clock.now_ms()));
    }

    #[test]
    fn graceful_release_is_immediate() {
        let mut table = LeaseTable::default();
        table.acquire("ws", "tab", "s1", 1, 10).unwrap();
        assert!(table.release("ws", "tab", "s1", 11));
        assert!(table.get("ws", "tab", 11).is_none());
    }
}
