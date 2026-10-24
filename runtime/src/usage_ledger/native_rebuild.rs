use super::store::{self, RefreshContext};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

const NATIVE_SOURCE_START: &str = "native:";
const NATIVE_SOURCE_END: &str = "native;";
const FACT_KEYS_PER_TRANSACTION: usize = 64;

type Coordinate = (String, String);

/// Removes native scanner state in bounded transactions while preserving live facts.
///
/// Returning `false` means cancellation was observed between committed batches. Every
/// committed batch is independently consistent, so a later call can safely resume.
pub fn rebuild(conn: &Connection, cancel: &AtomicBool) -> Result<bool> {
    let mut cursor = (String::new(), String::new());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }

        let Some(coordinate) = next_coordinate(conn, &cursor)? else {
            return Ok(true);
        };

        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }

            let observation_keys = native_observation_keys(conn, &coordinate)?;
            if !observation_keys.is_empty() {
                remove_observation_batch(conn, &coordinate, &observation_keys)?;
                continue;
            }

            let superseded_keys = superseded_keys(conn, &coordinate)?;
            if !superseded_keys.is_empty() {
                remove_superseded_batch(conn, &coordinate, &superseded_keys)?;
                continue;
            }

            clear_coverage_only(conn, &coordinate)?;
            break;
        }

        cursor = coordinate;
    }
}

fn next_coordinate(conn: &Connection, after: &Coordinate) -> Result<Option<Coordinate>> {
    let observation = conn
        .query_row(
            "SELECT provider, native_session_id
             FROM usage_fact_observations
             WHERE (provider, native_session_id) > (?1, ?2)
               AND source >= ?3 AND source < ?4
             ORDER BY provider, native_session_id
             LIMIT 1",
            params![after.0, after.1, NATIVE_SOURCE_START, NATIVE_SOURCE_END,],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let coverage = conn
        .query_row(
            "SELECT provider, native_session_id
             FROM usage_native_coverage
             WHERE (provider, native_session_id) > (?1, ?2)
               AND source >= ?3 AND source < ?4
             ORDER BY provider, native_session_id
             LIMIT 1",
            params![after.0, after.1, NATIVE_SOURCE_START, NATIVE_SOURCE_END,],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let superseded = conn
        .query_row(
            "SELECT provider, native_session_id
             FROM usage_superseded_facts
             WHERE provider IS NOT NULL AND native_session_id IS NOT NULL
               AND provider <> '' AND native_session_id <> ''
               AND (provider, native_session_id) > (?1, ?2)
             ORDER BY provider, native_session_id
             LIMIT 1",
            params![after.0, after.1],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    Ok([observation, coverage, superseded]
        .into_iter()
        .flatten()
        .min())
}

fn native_observation_keys(conn: &Connection, coordinate: &Coordinate) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT fact_key
         FROM usage_fact_observations
         WHERE provider = ?1
           AND native_session_id = ?2
           AND source >= ?3
           AND source < ?4
         ORDER BY fact_key
         LIMIT ?5",
    )?;
    let rows = statement.query_map(
        params![
            coordinate.0,
            coordinate.1,
            NATIVE_SOURCE_START,
            NATIVE_SOURCE_END,
            FACT_KEYS_PER_TRANSACTION as i64,
        ],
        |row| row.get(0),
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn superseded_keys(conn: &Connection, coordinate: &Coordinate) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT fact_key
         FROM usage_superseded_facts
         WHERE provider = ?1 AND native_session_id = ?2
         ORDER BY fact_key
         LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![coordinate.0, coordinate.1, FACT_KEYS_PER_TRANSACTION as i64,],
        |row| row.get(0),
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn remove_observation_batch(
    conn: &Connection,
    target: &Coordinate,
    fact_keys: &[String],
) -> Result<()> {
    debug_assert!(fact_keys.len() <= FACT_KEYS_PER_TRANSACTION);
    let started_at = Instant::now();
    let transaction = super::write_priority::transaction(conn)?;
    let mut context = RefreshContext::load(&transaction)?;
    let mut sessions = BTreeSet::from([target.clone()]);
    let mut parents = BTreeSet::new();

    for fact_key in fact_keys {
        collect_materialized_state(&transaction, fact_key, &mut sessions, &mut parents)?;
    }

    {
        let mut delete = transaction.prepare_cached(
            "DELETE FROM usage_fact_observations
             WHERE provider = ?1
               AND native_session_id = ?2
               AND source >= ?3
               AND source < ?4
               AND fact_key = ?5",
        )?;
        for fact_key in fact_keys {
            delete.execute(params![
                target.0,
                target.1,
                NATIVE_SOURCE_START,
                NATIVE_SOURCE_END,
                fact_key,
            ])?;
        }
    }

    for fact_key in fact_keys {
        store::refresh_fact(&transaction, fact_key, &mut context)?;
        collect_materialized_state(&transaction, fact_key, &mut sessions, &mut parents)?;
    }

    if !native_observations_remain(&transaction, target)? {
        clear_native_coverage(&transaction, target)?;
    }

    refresh_affected_sessions(&transaction, &sessions, &parents)?;
    transaction.commit()?;
    store::record_write_duration(started_at);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn remove_superseded_batch(
    conn: &Connection,
    target: &Coordinate,
    fact_keys: &[String],
) -> Result<()> {
    debug_assert!(fact_keys.len() <= FACT_KEYS_PER_TRANSACTION);
    let started_at = Instant::now();
    let transaction = super::write_priority::transaction(conn)?;
    let mut context = RefreshContext::load(&transaction)?;
    let mut sessions = BTreeSet::from([target.clone()]);
    let mut parents = BTreeSet::new();

    // Observation batches for this coordinate are exhausted before this phase.
    // Removing coverage first lets any surviving live observations become authoritative.
    clear_native_coverage(&transaction, target)?;

    for fact_key in fact_keys {
        collect_materialized_state(&transaction, fact_key, &mut sessions, &mut parents)?;
    }

    {
        let mut delete = transaction.prepare_cached(
            "DELETE FROM usage_superseded_facts
             WHERE provider = ?1 AND native_session_id = ?2 AND fact_key = ?3",
        )?;
        for fact_key in fact_keys {
            delete.execute(params![target.0, target.1, fact_key])?;
        }
    }

    for fact_key in fact_keys {
        store::refresh_fact(&transaction, fact_key, &mut context)?;
        collect_materialized_state(&transaction, fact_key, &mut sessions, &mut parents)?;
    }

    refresh_affected_sessions(&transaction, &sessions, &parents)?;
    transaction.commit()?;
    store::record_write_duration(started_at);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn clear_coverage_only(conn: &Connection, target: &Coordinate) -> Result<()> {
    let started_at = Instant::now();
    let transaction = super::write_priority::transaction(conn)?;
    clear_native_coverage(&transaction, target)?;
    store::refresh_session_rollups(&transaction, &target.0, &target.1)?;
    transaction.commit()?;
    store::record_write_duration(started_at);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn native_observations_remain(conn: &Connection, target: &Coordinate) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM usage_fact_observations
             WHERE provider = ?1
               AND native_session_id = ?2
               AND source >= ?3
               AND source < ?4
         )",
        params![target.0, target.1, NATIVE_SOURCE_START, NATIVE_SOURCE_END,],
        |row| row.get(0),
    )?)
}

fn clear_native_coverage(conn: &Connection, target: &Coordinate) -> Result<()> {
    conn.execute(
        "DELETE FROM usage_native_coverage
         WHERE provider = ?1
           AND native_session_id = ?2
           AND source >= ?3
           AND source < ?4",
        params![target.0, target.1, NATIVE_SOURCE_START, NATIVE_SOURCE_END,],
    )?;
    Ok(())
}

fn collect_materialized_state(
    conn: &Connection,
    fact_key: &str,
    sessions: &mut BTreeSet<Coordinate>,
    parents: &mut BTreeSet<Coordinate>,
) -> Result<()> {
    if let Some(coordinate) = store::materialized_coordinate(conn, fact_key)? {
        sessions.insert(coordinate);
    }

    let parent = conn
        .query_row(
            "SELECT provider, parent_native_session_id
             FROM usage_facts
             WHERE fact_key = ?1 AND parent_native_session_id IS NOT NULL",
            [fact_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some(parent) = parent {
        parents.insert(parent);
    }
    Ok(())
}

fn refresh_affected_sessions(
    conn: &Connection,
    sessions: &BTreeSet<Coordinate>,
    parents: &BTreeSet<Coordinate>,
) -> Result<()> {
    for (provider, native_session_id) in sessions {
        store::refresh_session_rollups(conn, provider, native_session_id)?;
    }
    for (provider, native_session_id) in parents {
        if !sessions.contains(&(provider.clone(), native_session_id.clone())) {
            store::refresh_session_metadata(conn, provider, native_session_id)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_ledger::facts::Fact;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects(
                id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
             );
             CREATE TABLE sessions(
                id TEXT PRIMARY KEY,project_id TEXT,worktree_path TEXT,title TEXT,provider TEXT,
                mode TEXT,status TEXT,created_at TEXT,updated_at TEXT,native_id TEXT,
                exit_code INTEGER,followed INTEGER,read_only INTEGER
             );
             CREATE TABLE usage_records(
                id TEXT PRIMARY KEY,session_id TEXT,provider TEXT,recorded_at TEXT,
                input_tokens INTEGER,output_tokens INTEGER,estimated_cost REAL,
                currency TEXT,model TEXT
             );",
        )
        .unwrap();
        store::initialize(&conn).unwrap();
        conn
    }

    fn fact(session: &str, key: &str, source: &str, input: i64) -> Fact {
        let mut fact = Fact::new("fixture", session, key, "2026-01-01T00:00:00.000Z");
        fact.source = source.into();
        fact.model = Some("fixture-model".into());
        fact.buckets.input = Some(input);
        fact
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn batches_large_coordinate_and_cancelled_resume_preserves_live() {
        let conn = db();
        let mut facts = (0..205)
            .map(|index| {
                fact(
                    "archive-session",
                    &format!("request-{index:03}"),
                    "native:archive@1",
                    100 + index,
                )
            })
            .collect::<Vec<_>>();
        facts.push(fact("archive-session", "request-000", "live:terminal", 7));
        store::upsert_facts(&conn, &facts).unwrap();
        store::cover_session(&conn, "fixture", "archive-session", "native:archive@1").unwrap();

        let coordinate = ("fixture".to_owned(), "archive-session".to_owned());
        let first_page = native_observation_keys(&conn, &coordinate).unwrap();
        assert_eq!(first_page.len(), FACT_KEYS_PER_TRANSACTION);
        remove_observation_batch(&conn, &coordinate, &first_page).unwrap();
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(DISTINCT fact_key) FROM usage_fact_observations
                 WHERE source >= 'native:' AND source < 'native;'",
            ),
            141
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM usage_native_coverage"),
            1
        );

        let cancel = AtomicBool::new(true);
        assert!(!rebuild(&conn, &cancel).unwrap());
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(DISTINCT fact_key) FROM usage_fact_observations
                 WHERE source >= 'native:' AND source < 'native;'",
            ),
            141
        );

        cancel.store(false, Ordering::Relaxed);
        assert!(rebuild(&conn, &cancel).unwrap());
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM usage_fact_observations
                 WHERE source >= 'native:' AND source < 'native;'",
            ),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM usage_native_coverage"),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM usage_fact_observations WHERE source='live:terminal'",
            ),
            1
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM usage_facts"), 1);
        let retained = conn
            .query_row(
                "SELECT source,input_tokens,native_session_id
                 FROM usage_facts WHERE fact_key='fixture:request-000'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            retained,
            ("live:terminal".into(), 7, "archive-session".into())
        );
    }

    #[test]
    fn removing_one_archive_copy_moves_shared_key_owner() {
        let conn = db();
        store::upsert_facts(
            &conn,
            &[
                fact("archive-a", "shared", "native:a@1", 11),
                fact("archive-b", "shared", "native:b@1", 13),
            ],
        )
        .unwrap();
        store::cover_session(&conn, "fixture", "archive-a", "native:a@1").unwrap();
        store::cover_session(&conn, "fixture", "archive-b", "native:b@1").unwrap();

        assert_eq!(
            store::materialized_coordinate(&conn, "fixture:shared").unwrap(),
            Some(("fixture".into(), "archive-a".into()))
        );
        let archive_a = ("fixture".to_owned(), "archive-a".to_owned());
        let keys = native_observation_keys(&conn, &archive_a).unwrap();
        assert_eq!(keys, vec!["fixture:shared"]);
        remove_observation_batch(&conn, &archive_a, &keys).unwrap();

        assert_eq!(
            store::materialized_coordinate(&conn, "fixture:shared").unwrap(),
            Some(("fixture".into(), "archive-b".into()))
        );
        assert_eq!(
            conn.query_row(
                "SELECT input_tokens FROM usage_facts WHERE fact_key='fixture:shared'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            13
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM usage_fact_observations
                 WHERE native_session_id='archive-a'",
            ),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM usage_fact_observations
                 WHERE native_session_id='archive-b'",
            ),
            1
        );

        assert!(rebuild(&conn, &AtomicBool::new(false)).unwrap());
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM usage_fact_observations"),
            0
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM usage_facts"), 0);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM usage_native_coverage"),
            0
        );
    }
}
