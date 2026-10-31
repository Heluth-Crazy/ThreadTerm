//! Durable `${port}` allocation for saved Run commands.
//!
//! The listener is deliberately dropped as soon as it proves a port available:
//! the launched process, not the runtime, owns the port.  Active Run allocations
//! are excluded as well, including the short interval before their child binds.

use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

const ATTEMPTS: usize = 32;

pub(crate) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS quick_launch_ports (
           command_id TEXT NOT NULL, root TEXT NOT NULL, port INTEGER NOT NULL,
           updated_at TEXT NOT NULL, PRIMARY KEY(command_id,root));
         CREATE INDEX IF NOT EXISTS quick_launch_ports_port ON quick_launch_ports(port);",
    )?;
    Ok(())
}

/// Selects a durable port for one command/worktree pair. The previously selected
/// port is reused when it is still bindable and no active run has reserved it.
pub(crate) fn allocate(tx: &Transaction<'_>, command_id: &str, root: &str) -> Result<u16> {
    let preferred: Option<i64> = tx
        .query_row(
            "SELECT port FROM quick_launch_ports WHERE command_id=? AND root=?",
            params![command_id, root],
            |row| row.get(0),
        )
        .optional()?;
    let active: Vec<i64> = tx
        .prepare(
            "SELECT allocated_port FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id \
             WHERE q.project_id=(SELECT project_id FROM quick_launch_commands WHERE id=?) \
             AND q.allocated_port IS NOT NULL AND s.status IN ('starting','running','idle','waiting')",
        )?
        .query_map([command_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let available = |port: u16| !active.contains(&i64::from(port)) && bindable(port);
    let selected = preferred
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| available(*port))
        .or_else(|| (0..ATTEMPTS).find_map(|_| ephemeral().filter(|port| available(*port))))
        .ok_or_else(|| anyhow!("port_unavailable"))?;
    tx.execute(
        "INSERT INTO quick_launch_ports(command_id,root,port,updated_at) VALUES(?,?,?,?) \
         ON CONFLICT(command_id,root) DO UPDATE SET port=excluded.port,updated_at=excluded.updated_at",
        params![command_id, root, selected, Utc::now().to_rfc3339()],
    )?;
    Ok(selected)
}

pub(crate) fn read(tx: &Transaction<'_>, command_id: &str, root: &str) -> Result<Option<u16>> {
    Ok(tx
        .query_row(
            "SELECT port FROM quick_launch_ports WHERE command_id=? AND root=?",
            params![command_id, root],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .and_then(|port| u16::try_from(port).ok()))
}

fn bindable(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn ephemeral() -> Option<u16> {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|address| address.port())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE quick_launch_commands(id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
             CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL);
             CREATE TABLE quick_launch_runs(project_id TEXT NOT NULL,session_id TEXT NOT NULL,allocated_port INTEGER);",
        )
        .unwrap();
        conn.execute("INSERT INTO quick_launch_commands VALUES('a','p'),('b','p')", []).unwrap();
        conn
    }

    #[test]
    fn persists_reuses_and_avoids_an_active_port() {
        let mut conn = database();
        let first = {
            let tx = conn.transaction().unwrap();
            initialize(&tx).unwrap();
            let port = allocate(&tx, "a", "one").unwrap();
            tx.commit().unwrap();
            port
        };
        let reused = {
            let tx = conn.transaction().unwrap();
            let port = allocate(&tx, "a", "one").unwrap();
            tx.commit().unwrap();
            port
        };
        assert_eq!(first, reused);
        conn.execute("INSERT INTO sessions VALUES('live','running')", []).unwrap();
        conn.execute("INSERT INTO quick_launch_runs VALUES('p','live',?)", [i64::from(first)]).unwrap();
        let tx = conn.transaction().unwrap();
        let other_root = allocate(&tx, "b", "two").unwrap();
        assert_ne!(first, other_root);
        let distinct = allocate(&tx, "a", "one").unwrap();
        assert_ne!(first, distinct);
        tx.commit().unwrap();
        let tx = conn.transaction().unwrap();
        assert_eq!(allocate(&tx, "a", "one").unwrap(), distinct);
    }

    #[test]
    fn busy_persisted_port_is_reallocated() {
        let mut conn = database();
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = listener.local_addr().unwrap().port();
        let tx = conn.transaction().unwrap();
        initialize(&tx).unwrap();
        tx.execute(
            "INSERT INTO quick_launch_ports(command_id,root,port,updated_at) VALUES('a','one',?,'now')",
            [i64::from(busy)],
        ).unwrap();
        assert_ne!(allocate(&tx, "a", "one").unwrap(), busy);
        drop(listener);
    }
}
