use anyhow::{anyhow, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use super::{
    facts::{Buckets, Fact},
    prices, time,
};

const PRICE_OVERRIDES_KEY: &str = "pricing-overrides-json";

/// Rollups sourced from ThreadTerm live observations only. They are kept
/// separately so disabling native history never makes in-ThreadTerm usage
/// disappear merely because a native observation won reconciliation.
pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_live_rollups AS
             SELECT * FROM usage_daily_rollups WHERE 0;
         CREATE INDEX IF NOT EXISTS usage_live_rollups_session
             ON usage_live_rollups(provider,native_session_id,local_day);
         CREATE INDEX IF NOT EXISTS usage_live_rollups_day
             ON usage_live_rollups(local_day,provider,model,project_id);
         CREATE TABLE IF NOT EXISTS usage_live_intervals AS
             SELECT * FROM usage_intervals WHERE 0;
         CREATE INDEX IF NOT EXISTS usage_live_intervals_session
             ON usage_live_intervals(provider,native_session_id,start_ms);
         CREATE INDEX IF NOT EXISTS usage_live_intervals_day
             ON usage_live_intervals(local_day,start_ms,end_ms);",
    )?;
    Ok(())
}

/// Refresh the fallback rows for one materialized native coordinate. The
/// caller already owns the short fact-write transaction.
pub fn refresh(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    refresh_live_estimates(conn, provider, native_session_id)?;
    conn.prepare_cached("DELETE FROM usage_live_rollups WHERE provider=? AND native_session_id=?")?
        .execute(params![provider, native_session_id])?;
    conn.prepare_cached(
        "WITH live AS (
            SELECT fact_key,
                MAX(provider) AS provider, MAX(model) AS model,
                MAX(occurred_at) AS occurred_at, MAX(native_session_id) AS native_session_id,
                MAX(input_tokens) AS input_tokens,
                MAX(cache_read_tokens) AS cache_read_tokens,
                MAX(cache_write5m_tokens) AS cache_write5m_tokens,
                MAX(cache_write1h_tokens) AS cache_write1h_tokens,
                CASE WHEN MAX(cache_write_unknown_tokens) IS NOT NULL
                          AND (MAX(cache_write5m_tokens) IS NOT NULL OR MAX(cache_write1h_tokens) IS NOT NULL)
                     THEN MAX(MAX(cache_write_unknown_tokens)-COALESCE(MAX(cache_write5m_tokens),0)-COALESCE(MAX(cache_write1h_tokens),0),0)
                     ELSE MAX(cache_write_unknown_tokens) END AS cache_write_unknown_tokens,
                MAX(output_tokens) AS output_tokens, MAX(reasoning_tokens) AS reasoning_tokens,
                CASE WHEN SUM(quality='exact')>0 THEN 'exact'
                     WHEN SUM(quality='derived')>0 THEN 'derived'
                     ELSE 'estimated' END AS quality, MAX(reported_cost) AS reported_cost,
                MAX(estimated_cost) AS estimated_cost
            FROM usage_fact_observations observation
            WHERE observation.provider=? AND observation.native_session_id=?
              AND observation.source LIKE 'live:%'
              AND NOT (
                observation.source LIKE 'live:legacy:%'
                AND EXISTS (
                    SELECT 1 FROM usage_fact_observations newer
                    WHERE newer.threadterm_session_id=observation.threadterm_session_id
                      AND observation.turn_id IS NOT NULL
                      AND newer.turn_id=observation.turn_id
                      AND newer.source LIKE 'live:%'
                      AND newer.source NOT LIKE 'live:legacy:%'
                )
              )
            GROUP BY fact_key
        )
        INSERT INTO usage_live_rollups(
            local_day,provider,model,project_id,native_session_id,
            threadterm_session_id,scope,input_tokens,cache_read_tokens,
            cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,
            output_tokens,reasoning_tokens,input_reported,cache_read_reported,
            cache_write5m_reported,cache_write1h_reported,
            cache_write_unknown_reported,output_reported,reasoning_reported,
            reported_cost,estimated_cost,priced_tokens,unpriced_tokens,requests,
            reported_requests,priced_requests,exact_requests,derived_requests,
            estimated_requests,exact_tokens,derived_tokens,estimated_tokens,
            first_occurred_at,last_occurred_at)
        SELECT f.local_day,f.provider,COALESCE(live.model,''),f.project_id,
            f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope,
            SUM(COALESCE(live.input_tokens,0)),SUM(COALESCE(live.cache_read_tokens,0)),
            SUM(COALESCE(live.cache_write5m_tokens,0)),SUM(COALESCE(live.cache_write1h_tokens,0)),
            SUM(COALESCE(live.cache_write_unknown_tokens,0)),SUM(COALESCE(live.output_tokens,0)),
            SUM(COALESCE(live.reasoning_tokens,0)),SUM(live.input_tokens IS NOT NULL),
            SUM(live.cache_read_tokens IS NOT NULL),SUM(live.cache_write5m_tokens IS NOT NULL),
            SUM(live.cache_write1h_tokens IS NOT NULL),SUM(live.cache_write_unknown_tokens IS NOT NULL),
            SUM(live.output_tokens IS NOT NULL),SUM(live.reasoning_tokens IS NOT NULL),
            SUM(COALESCE(live.reported_cost,0)),SUM(COALESCE(live.estimated_cost,0)),
            SUM(CASE WHEN live.estimated_cost IS NOT NULL THEN
                COALESCE(live.input_tokens,0)+COALESCE(live.cache_read_tokens,0)+
                COALESCE(live.cache_write5m_tokens,0)+COALESCE(live.cache_write1h_tokens,0)+
                COALESCE(live.cache_write_unknown_tokens,0)+COALESCE(live.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN live.estimated_cost IS NULL THEN
                COALESCE(live.input_tokens,0)+COALESCE(live.cache_read_tokens,0)+
                COALESCE(live.cache_write5m_tokens,0)+COALESCE(live.cache_write1h_tokens,0)+
                COALESCE(live.cache_write_unknown_tokens,0)+COALESCE(live.output_tokens,0) ELSE 0 END),
            COUNT(*),SUM(live.reported_cost IS NOT NULL),SUM(live.estimated_cost IS NOT NULL),
            SUM(live.quality='exact'),SUM(live.quality='derived'),SUM(live.quality='estimated'),
            SUM(CASE WHEN live.quality='exact' THEN
                COALESCE(live.input_tokens,0)+COALESCE(live.cache_read_tokens,0)+
                COALESCE(live.cache_write5m_tokens,0)+COALESCE(live.cache_write1h_tokens,0)+
                COALESCE(live.cache_write_unknown_tokens,0)+COALESCE(live.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN live.quality='derived' THEN
                COALESCE(live.input_tokens,0)+COALESCE(live.cache_read_tokens,0)+
                COALESCE(live.cache_write5m_tokens,0)+COALESCE(live.cache_write1h_tokens,0)+
                COALESCE(live.cache_write_unknown_tokens,0)+COALESCE(live.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN live.quality='estimated' THEN
                COALESCE(live.input_tokens,0)+COALESCE(live.cache_read_tokens,0)+
                COALESCE(live.cache_write5m_tokens,0)+COALESCE(live.cache_write1h_tokens,0)+
                COALESCE(live.cache_write_unknown_tokens,0)+COALESCE(live.output_tokens,0) ELSE 0 END),
            MIN(f.occurred_at),MAX(f.occurred_at)
        FROM live
        JOIN usage_facts f ON f.fact_key=live.fact_key
        WHERE f.provider=? AND f.native_session_id=? AND f.scope='threadterm'
        GROUP BY f.local_day,f.provider,COALESCE(live.model,''),f.project_id,
                 f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope",
    )?
    .execute(params![provider, native_session_id, provider, native_session_id])?;
    refresh_intervals(conn, provider, native_session_id)?;
    Ok(())
}

fn refresh_live_estimates(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    let overrides = conn
        .query_row(
            "SELECT value FROM usage_ledger_state WHERE key=?",
            [PRICE_OVERRIDES_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    let mut facts = conn.prepare_cached(
        "SELECT fact_key,MAX(provider),MAX(model),MAX(occurred_at),MAX(native_session_id),
                MAX(parent_native_session_id),MAX(subagent),MAX(input_tokens),
                MAX(cache_read_tokens),MAX(cache_write5m_tokens),MAX(cache_write1h_tokens),
                MAX(cache_write_unknown_tokens),MAX(output_tokens),MAX(reasoning_tokens),
                CASE WHEN SUM(quality='exact')>0 THEN 'exact'
                     WHEN SUM(quality='derived')>0 THEN 'derived' ELSE 'estimated' END,
                MAX(reported_cost),MAX(cwd),MAX(threadterm_session_id),MAX(turn_id),
                MIN(started_at),MAX(ended_at)
         FROM usage_fact_observations observation
         WHERE observation.provider=? AND observation.native_session_id=?
           AND observation.source LIKE 'live:%'
           AND NOT (
             observation.source LIKE 'live:legacy:%'
             AND EXISTS (
                SELECT 1 FROM usage_fact_observations newer
                WHERE newer.threadterm_session_id=observation.threadterm_session_id
                  AND observation.turn_id IS NOT NULL AND newer.turn_id=observation.turn_id
                  AND newer.source LIKE 'live:%' AND newer.source NOT LIKE 'live:legacy:%'
             )
           )
         GROUP BY fact_key",
    )?;
    let live = facts
        .query_map(params![provider, native_session_id], |row| {
            Ok(Fact {
                key: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                occurred_at: row.get(3)?,
                native_session_id: row.get(4)?,
                parent_native_session_id: row.get(5)?,
                subagent: row.get::<_, i64>(6)? != 0,
                buckets: Buckets {
                    input: row.get(7)?,
                    cache_read: row.get(8)?,
                    cache_write5m: row.get(9)?,
                    cache_write1h: row.get(10)?,
                    cache_write_unknown: row.get(11)?,
                    output: row.get(12)?,
                    reasoning: row.get(13)?,
                },
                quality: row.get(14)?,
                reported_cost: row.get(15)?,
                cwd: row.get(16)?,
                source: "live:reprice".into(),
                parser_version: 1,
                threadterm_session_id: row.get(17)?,
                turn_id: row.get(18)?,
                started_at: row.get(19)?,
                ended_at: row.get(20)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(facts);
    let mut update = conn.prepare_cached(
        "UPDATE usage_fact_observations SET estimated_cost=?
         WHERE provider=? AND native_session_id=? AND fact_key=? AND source LIKE 'live:%'",
    )?;
    for mut fact in live {
        if let Some(total) = fact.buckets.cache_write_unknown {
            if fact.buckets.cache_write5m.is_some() || fact.buckets.cache_write1h.is_some() {
                fact.buckets.cache_write_unknown = Some(
                    total
                        .saturating_sub(fact.buckets.cache_write5m.unwrap_or(0))
                        .saturating_sub(fact.buckets.cache_write1h.unwrap_or(0))
                        .max(0),
                );
            }
        }
        update.execute(params![
            prices::estimate(&fact, &overrides),
            provider,
            native_session_id,
            fact.key,
        ])?;
    }
    Ok(())
}

fn refresh_intervals(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    conn.prepare_cached(
        "DELETE FROM usage_live_intervals WHERE provider=? AND native_session_id=?",
    )?
    .execute(params![provider, native_session_id])?;
    let mut statement = conn.prepare_cached(
        "SELECT MAX(COALESCE(f.model,'')),MAX(f.project_id),
                COALESCE(observation.threadterm_session_id,''),
                MIN(observation.started_at),MAX(observation.ended_at)
         FROM usage_fact_observations observation
         JOIN usage_facts f ON f.fact_key=observation.fact_key
         WHERE observation.provider=? AND observation.native_session_id=?
           AND observation.source LIKE 'live:%'
           AND observation.source NOT LIKE 'live:legacy:%'
           AND observation.threadterm_session_id IS NOT NULL
           AND observation.started_at IS NOT NULL AND observation.ended_at IS NOT NULL
           AND f.scope='threadterm'
         GROUP BY observation.provider,observation.native_session_id,
                  observation.threadterm_session_id,
                  COALESCE(observation.turn_id,observation.fact_key)",
    )?;
    let turns = statement
        .query_map(params![provider, native_session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut insert = conn.prepare_cached(
        "INSERT INTO usage_live_intervals(
            provider,native_session_id,model,project_id,threadterm_session_id,
            scope,local_day,start_ms,end_ms,estimated)
         VALUES(?,?,?,?,?,'threadterm',?,?,?,0)",
    )?;
    for (model, project_id, threadterm_session_id, start, end) in turns {
        insert_interval(
            &mut insert,
            provider,
            native_session_id,
            &model,
            &project_id,
            &threadterm_session_id,
            time::timestamp_millis(&start)?,
            time::timestamp_millis(&end)?,
        )?;
    }
    Ok(())
}

fn insert_interval(
    insert: &mut rusqlite::CachedStatement<'_>,
    provider: &str,
    native_session_id: &str,
    model: &str,
    project_id: &str,
    threadterm_session_id: &str,
    mut start_ms: i64,
    end_ms: i64,
) -> Result<()> {
    if end_ms <= start_ms {
        return Ok(());
    }
    while end_ms > start_ms {
        let timestamp = DateTime::<Utc>::from_timestamp_millis(start_ms)
            .ok_or_else(|| anyhow!("invalid_usage_timestamp"))?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let local_day = time::local_day(&timestamp)?;
        let (_, day_end) = time::local_day_range(&local_day)?;
        let day_end_ms = time::timestamp_millis(&day_end)?;
        let part_end = end_ms.min(day_end_ms);
        if part_end <= start_ms {
            return Err(anyhow!("invalid_usage_day_boundary"));
        }
        insert.execute(params![
            provider,
            native_session_id,
            model,
            project_id,
            threadterm_session_id,
            local_day,
            start_ms,
            part_end,
        ])?;
        start_ms = part_end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_ledger::{facts::Fact, store};

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live-fallback.sqlite");
        let _database = crate::db::Database::open(&path).unwrap();
        let conn = Connection::open(path).unwrap();
        store::initialize(&conn).unwrap();
        initialize(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only)
             VALUES('tt',NULL,NULL,'fixture','fixture','chat','idle','0','1','native',0,0)",
            [],
        )
        .unwrap();
        (dir, conn)
    }

    fn fact(key: &str, source: &str, input: i64) -> Fact {
        let mut value = Fact::new("fixture", "native", key, "2026-01-01T00:00:00Z");
        value.source = source.into();
        value.threadterm_session_id = Some("tt".into());
        value.turn_id = Some("turn".into());
        value.buckets.input = Some(input);
        value
    }

    #[test]
    fn live_rollup_uses_live_observation_when_native_same_key_is_larger() {
        let (_dir, conn) = db();
        store::upsert_fact(&conn, &fact("shared", "live:tt:call", 4)).unwrap();
        store::upsert_fact(&conn, &fact("shared", "native:file@1", 10)).unwrap();
        let mut unrelated = Fact::new("other", "elsewhere", "other", "2026-01-01T00:00:00Z");
        unrelated.source = "live:other:call".into();
        unrelated.buckets.input = Some(99);
        store::upsert_fact(&conn, &unrelated).unwrap();
        refresh(&conn, "fixture", "native").unwrap();
        assert_eq!(
            conn.query_row("SELECT input_tokens FROM usage_live_rollups", [], |row| row
                .get::<_, i64>(0),)
                .unwrap(),
            4
        );
    }

    #[test]
    fn newer_live_turn_suppresses_legacy_live_row() {
        let (_dir, conn) = db();
        store::upsert_fact(&conn, &fact("legacy", "live:legacy:tt", 2)).unwrap();
        store::upsert_fact(&conn, &fact("current", "live:tt:call", 5)).unwrap();
        refresh(&conn, "fixture", "native").unwrap();
        let (requests, tokens): (i64, i64) = conn
            .query_row(
                "SELECT requests,input_tokens FROM usage_live_rollups",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((requests, tokens), (1, 5));
    }

    #[test]
    fn native_covered_threadterm_live_turn_keeps_its_active_interval() {
        let (_dir, conn) = db();
        let mut live = fact("timed", "live:tt:call", 4);
        live.started_at = Some("2026-01-01T00:00:00.000Z".into());
        live.ended_at = Some("2026-01-01T00:00:02.000Z".into());
        store::upsert_fact(&conn, &live).unwrap();
        store::upsert_fact(&conn, &fact("timed", "native:file@1", 10)).unwrap();
        store::cover_session(&conn, "fixture", "native", "native:file@").unwrap();
        refresh(&conn, "fixture", "native").unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT SUM(end_ms-start_ms) FROM usage_live_intervals",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2_000
        );
    }

    #[test]
    fn timed_live_request_without_turn_id_keeps_its_active_interval() {
        let (_dir, conn) = db();
        let mut live = fact("request-timed", "live:tt:call", 4);
        live.turn_id = None;
        live.started_at = Some("2026-01-01T00:00:00.000Z".into());
        live.ended_at = Some("2026-01-01T00:00:01.500Z".into());
        store::upsert_fact(&conn, &live).unwrap();
        refresh(&conn, "fixture", "native").unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT SUM(end_ms-start_ms) FROM usage_live_intervals",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1_500
        );
    }

    #[test]
    fn override_prices_live_buckets_when_native_same_key_is_larger() {
        let (_dir, conn) = db();
        let mut live = fact("priced-shared", "live:tt:call", 4);
        live.model = Some("live-model".into());
        store::upsert_fact(&conn, &live).unwrap();
        let mut native = fact("priced-shared", "native:file@1", 10);
        native.model = Some("live-model".into());
        store::upsert_fact(&conn, &native).unwrap();
        conn.execute(
            "INSERT INTO usage_ledger_state(key,value) VALUES(?,?)",
            params![
                PRICE_OVERRIDES_KEY,
                r#"{"fixture/live-model":{"input":10}}"#
            ],
        )
        .unwrap();
        refresh(&conn, "fixture", "native").unwrap();
        assert_eq!(
            conn.query_row("SELECT estimated_cost FROM usage_live_rollups", [], |row| {
                row.get::<_, f64>(0)
            },)
                .unwrap(),
            0.000_04
        );
    }
}
