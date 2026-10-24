//! Short transactions and checkpoint cadence for the usage-ledger worker.
use anyhow::Result;
use rusqlite::{Connection, Transaction, TransactionBehavior};

const CHECKPOINT_CADENCE: i64 = 16;

pub(super) fn transaction(conn: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    )?)
}

pub(super) fn yield_to_interactive(_conn: &Connection) {
    std::thread::yield_now();
}

/// Returns `true` when this dedicated writer should checkpoint its WAL.
///
/// The counter is connection-local TEMP state and retains no process-global
/// database-path state.
pub(super) fn initialize_checkpoint_cadence(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_checkpoint_cadence(
            slot INTEGER PRIMARY KEY CHECK(slot=1),committed INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO temp.usage_checkpoint_cadence(slot,committed)
         VALUES(1,0);",
    )?;
    Ok(())
}

pub(super) fn checkpoint_due(conn: &Connection, force: bool) -> Result<bool> {
    if force {
        conn.execute(
            "UPDATE temp.usage_checkpoint_cadence SET committed=0 WHERE slot=1",
            [],
        )?;
        return Ok(true);
    }
    conn.execute(
        "UPDATE temp.usage_checkpoint_cadence SET committed=committed+1 WHERE slot=1",
        [],
    )?;
    let committed = conn.query_row(
        "SELECT committed FROM temp.usage_checkpoint_cadence WHERE slot=1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if committed >= CHECKPOINT_CADENCE {
        conn.execute(
            "UPDATE temp.usage_checkpoint_cadence SET committed=0 WHERE slot=1",
            [],
        )?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_transaction_commits_and_rolls_back_without_global_coordination() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("transactions.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE t(n INTEGER);").unwrap();
        {
            let tx = transaction(&conn).unwrap();
            tx.execute("INSERT INTO t VALUES(1)", []).unwrap();
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let tx = transaction(&conn).unwrap();
        tx.execute("INSERT INTO t VALUES(2)", []).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row("SELECT SUM(n) FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn checkpoint_cadence_is_sixteen_and_force_restarts_it() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("cadence.sqlite")).unwrap();
        initialize_checkpoint_cadence(&conn).unwrap();

        for _ in 0..15 {
            assert!(!checkpoint_due(&conn, false).unwrap());
        }
        assert!(checkpoint_due(&conn, false).unwrap());
        assert!(!checkpoint_due(&conn, false).unwrap());
        assert!(checkpoint_due(&conn, true).unwrap());
        for _ in 0..15 {
            assert!(!checkpoint_due(&conn, false).unwrap());
        }
        assert!(checkpoint_due(&conn, false).unwrap());
    }
}
