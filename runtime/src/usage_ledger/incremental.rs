//! Transaction-local change tracking for bounded usage projection updates.
//!
//! The canonical observation merge remains the source of truth.  This module
//! snapshots only the canonical rows named by an ingestion batch, then derives
//! the sessions and local days whose effective projections can have changed.

use super::facts::Fact;
use anyhow::Result;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeSet;

#[cfg(test)]
use std::{collections::BTreeMap, sync::Mutex, sync::OnceLock};

#[cfg(test)]
static REJECTION_PROFILE: OnceLock<Mutex<BTreeMap<&'static str, u64>>> = OnceLock::new();

#[cfg(test)]
fn profile_rejection(reason: &'static str) {
    if std::env::var_os("UA1R_PROFILE").is_none() {
        return;
    }
    let mut counts = REJECTION_PROFILE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let count = counts.entry(reason).or_default();
    if *count == 0 {
        println!("PROFILE repair_reason={reason}");
    }
    *count += 1;
}

#[cfg(test)]
pub(super) fn rejection_profile_take() -> serde_json::Value {
    let mut counts = REJECTION_PROFILE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    serde_json::to_value(std::mem::take(&mut *counts)).unwrap_or_default()
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct CoordinateDay {
    pub provider: String,
    pub native_session_id: String,
    pub local_day: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CoordinateWindow {
    pub provider: String,
    pub native_session_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NativeChangeKind {
    AppendOnly,
    HistoricalOnly,
    Repair,
}

/// Native readers persist sortable UTC timestamps in this fixed-width form.
/// Semantic validity is checked by `time::local_day` before materialization;
/// this allocation-free predicate protects the range-seek representation.
pub(super) fn has_canonical_timestamp_format(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]
            .into_iter()
            .all(|index| bytes[index].is_ascii_digit())
}

pub(super) fn begin(conn: &Connection, facts: &[Fact]) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_incremental_keys(
            fact_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_incremental_old_facts
            AS SELECT * FROM usage_facts WHERE 0;
         CREATE TEMP TABLE IF NOT EXISTS usage_incremental_changed(
            fact_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_incremental_old_native(
            fact_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_incremental_merge_keys(
            fact_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_incremental_days(
            provider TEXT NOT NULL,native_session_id TEXT NOT NULL,
            local_day TEXT NOT NULL,
            PRIMARY KEY(provider,native_session_id,local_day)
         ) WITHOUT ROWID;
         DELETE FROM temp.usage_incremental_keys;
         DELETE FROM temp.usage_incremental_old_facts;
         DELETE FROM temp.usage_incremental_changed;
         DELETE FROM temp.usage_incremental_old_native;
         DELETE FROM temp.usage_incremental_merge_keys;
         DELETE FROM temp.usage_incremental_days;",
    )?;
    let mut insert = conn
        .prepare_cached("INSERT OR IGNORE INTO temp.usage_incremental_keys(fact_key) VALUES(?)")?;
    for fact in facts {
        insert.execute([&fact.key])?;
    }
    drop(insert);
    conn.execute(
        "INSERT INTO temp.usage_incremental_old_facts
         SELECT f.* FROM temp.usage_incremental_keys k
         CROSS JOIN usage_facts f
         WHERE f.fact_key=k.fact_key",
        [],
    )?;
    conn.execute_batch(
        "INSERT OR IGNORE INTO temp.usage_incremental_old_native(fact_key)
            SELECT k.fact_key FROM temp.usage_incremental_keys k
            CROSS JOIN usage_fact_observations o INDEXED BY usage_observations_key
            WHERE o.fact_key=k.fact_key AND o.source LIKE 'native:%';
         INSERT OR IGNORE INTO temp.usage_incremental_merge_keys(fact_key)
            SELECT fact_key FROM temp.usage_incremental_old_facts;
         INSERT OR IGNORE INTO temp.usage_incremental_merge_keys(fact_key)
            SELECT k.fact_key FROM temp.usage_incremental_keys k
            CROSS JOIN usage_fact_observations o INDEXED BY usage_observations_key
            WHERE o.fact_key=k.fact_key;
         INSERT OR IGNORE INTO temp.usage_incremental_merge_keys(fact_key)
            SELECT k.fact_key FROM temp.usage_incremental_keys k
            CROSS JOIN usage_superseded_facts s
            WHERE s.fact_key=k.fact_key;",
    )?;
    Ok(())
}

/// True only for the first observation ever seen for a canonical key. The
/// caller separately rejects repeated occurrences of one key within a batch.
pub(super) fn direct_candidate(conn: &Connection, fact_key: &str, source: &str) -> Result<bool> {
    if conn
        .query_row(
            "SELECT 1 FROM temp.usage_incremental_merge_keys WHERE fact_key=?",
            [fact_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(false);
    }
    let mut statement = conn.prepare_cached(
        "SELECT source FROM usage_fact_observations INDEXED BY usage_observations_key
         WHERE fact_key=? LIMIT 2",
    )?;
    let observed = statement
        .query_map([fact_key], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(observed.len() == 1 && observed[0] == source)
}

/// Compares the complete canonical row so authority, attribution and pricing
/// changes are included while an identical archive copy remains a no-op.
pub(super) fn finish(conn: &Connection) -> Result<Vec<CoordinateDay>> {
    conn.execute_batch(
        "UPDATE temp.usage_incremental_old_facts AS old
         SET source=(SELECT f.source FROM usage_facts f
                     WHERE f.fact_key=old.fact_key),
             parser_version=(SELECT f.parser_version FROM usage_facts f
                             WHERE f.fact_key=old.fact_key)
         WHERE EXISTS(
             SELECT 1 FROM usage_facts f WHERE f.fact_key=old.fact_key
               AND CASE
                   WHEN old.source LIKE 'native:%' THEN 0
                   WHEN old.source LIKE 'live:legacy:%' THEN 1 ELSE 2 END
                 = CASE
                   WHEN f.source LIKE 'native:%' THEN 0
                   WHEN f.source LIKE 'live:legacy:%' THEN 1 ELSE 2 END
         );
         INSERT OR IGNORE INTO temp.usage_incremental_changed(fact_key)
         SELECT fact_key FROM (
            SELECT * FROM temp.usage_incremental_old_facts
            EXCEPT
            SELECT f.* FROM temp.usage_incremental_keys k
            CROSS JOIN usage_facts f WHERE f.fact_key=k.fact_key
         );
         INSERT OR IGNORE INTO temp.usage_incremental_changed(fact_key)
         SELECT fact_key FROM (
            SELECT f.* FROM temp.usage_incremental_keys k
            CROSS JOIN usage_facts f WHERE f.fact_key=k.fact_key
            EXCEPT
            SELECT * FROM temp.usage_incremental_old_facts
         );
         INSERT OR IGNORE INTO temp.usage_incremental_days
            SELECT o.provider,o.native_session_id,o.local_day
            FROM temp.usage_incremental_old_facts o
            JOIN temp.usage_incremental_changed c USING(fact_key);
         INSERT OR IGNORE INTO temp.usage_incremental_days
            SELECT f.provider,f.native_session_id,f.local_day
            FROM temp.usage_incremental_changed c
            CROSS JOIN usage_facts f WHERE f.fact_key=c.fact_key;",
    )?;
    let mut statement = conn.prepare(
        "SELECT provider,native_session_id,local_day
         FROM temp.usage_incremental_days
         ORDER BY provider,native_session_id,local_day",
    )?;
    let result = statement
        .query_map([], |row| {
            Ok(CoordinateDay {
                provider: row.get(0)?,
                native_session_id: row.get(1)?,
                local_day: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}

pub(super) fn changed_coordinates(conn: &Connection) -> Result<BTreeSet<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT provider,native_session_id FROM (
            SELECT o.provider,o.native_session_id
            FROM temp.usage_incremental_old_facts o
            JOIN temp.usage_incremental_changed c USING(fact_key)
            UNION
            SELECT f.provider,f.native_session_id
            FROM temp.usage_incremental_changed c
            CROSS JOIN usage_facts f WHERE f.fact_key=c.fact_key
         ) ORDER BY provider,native_session_id",
    )?;
    let result = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

/// Classifies the transaction-local canonical changes. Stable metric updates
/// and tail appends use the append path. A batch made solely of previously
/// unseen native canonical rows may rebuild the few local days around a
/// historical insertion. Ownership moves and structural edits still require a
/// full-session repair.
pub(super) fn classify_native(conn: &Connection) -> Result<NativeChangeKind> {
    let changed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM temp.usage_incremental_changed",
        [],
        |row| row.get(0),
    )?;
    if changed == 0 {
        return Ok(NativeChangeKind::AppendOnly);
    }
    let rejection = conn
        .query_row(
            "SELECT reason FROM (
                SELECT CASE
                    WHEN f.fact_key IS NULL THEN 'missing'
                    WHEN NOT EXISTS(
                        SELECT 1 FROM usage_fact_observations n
                        WHERE n.fact_key=c.fact_key AND n.source LIKE 'native:%'
                    ) THEN 'nonNative'
                    WHEN o.fact_key IS NOT NULL AND NOT EXISTS(
                        SELECT 1 FROM temp.usage_incremental_old_native n
                        WHERE n.fact_key=c.fact_key
                    ) THEN 'newlyNative'
                    WHEN o.fact_key IS NOT NULL AND o.provider IS NOT f.provider THEN 'structural.provider'
                    WHEN o.fact_key IS NOT NULL AND o.model IS NOT f.model THEN 'structural.model'
                    WHEN o.fact_key IS NOT NULL AND o.occurred_at IS NOT f.occurred_at THEN 'structural.occurredAt'
                    WHEN o.fact_key IS NOT NULL AND o.local_day IS NOT f.local_day THEN 'structural.localDay'
                    WHEN o.fact_key IS NOT NULL AND o.native_session_id IS NOT f.native_session_id THEN 'structural.nativeSession'
                    WHEN o.fact_key IS NOT NULL AND o.parent_native_session_id IS NOT f.parent_native_session_id THEN 'structural.parentSession'
                    WHEN o.fact_key IS NOT NULL AND o.subagent IS NOT f.subagent THEN 'structural.subagent'
                    WHEN o.fact_key IS NOT NULL AND o.cwd IS NOT f.cwd THEN 'structural.cwd'
                    WHEN o.fact_key IS NOT NULL AND o.source IS NOT f.source THEN 'structural.source'
                    WHEN o.fact_key IS NOT NULL AND o.threadterm_session_id IS NOT f.threadterm_session_id THEN 'structural.threadtermSession'
                    WHEN o.fact_key IS NOT NULL AND o.turn_id IS NOT f.turn_id THEN 'structural.turn'
                    WHEN o.fact_key IS NOT NULL AND o.started_at IS NOT f.started_at THEN 'structural.startedAt'
                    WHEN o.fact_key IS NOT NULL AND o.ended_at IS NOT f.ended_at THEN 'structural.endedAt'
                    WHEN o.fact_key IS NOT NULL AND o.project_id IS NOT f.project_id THEN 'structural.project'
                    WHEN o.fact_key IS NOT NULL AND o.scope IS NOT f.scope THEN 'structural.scope'
                    END AS reason
                FROM temp.usage_incremental_changed c
                LEFT JOIN usage_facts f ON f.fact_key=c.fact_key
                LEFT JOIN temp.usage_incremental_old_facts o USING(fact_key)
             ) WHERE reason IS NOT NULL LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(reason) = rejection {
        #[cfg(test)]
        profile_rejection(match reason.as_str() {
            "missing" => "missing",
            "nonNative" => "nonNative",
            "newlyNative" => "newlyNative",
            "structural.provider" => "structural.provider",
            "structural.model" => "structural.model",
            "structural.occurredAt" => "structural.occurredAt",
            "structural.localDay" => "structural.localDay",
            "structural.nativeSession" => "structural.nativeSession",
            "structural.parentSession" => "structural.parentSession",
            "structural.subagent" => "structural.subagent",
            "structural.cwd" => "structural.cwd",
            "structural.source" => "structural.source",
            "structural.threadtermSession" => "structural.threadtermSession",
            "structural.turn" => "structural.turn",
            "structural.startedAt" => "structural.startedAt",
            "structural.endedAt" => "structural.endedAt",
            "structural.project" => "structural.project",
            "structural.scope" => "structural.scope",
            _ => "unknown",
        });
        #[cfg(not(test))]
        let _ = reason;
        return Ok(NativeChangeKind::Repair);
    }

    // Timestamp range seeks are safe only for the normalized UTC form emitted
    // by native readers. Existing stable rows do not need interval work, but a
    // first-seen noncanonical key must use the format-independent full repair.
    if !changed_native_timestamps_are_canonical(conn)? {
        #[cfg(test)]
        profile_rejection("nonCanonicalTimestamp");
        return Ok(NativeChangeKind::Repair);
    }

    // Use the session index for two narrow boundary seeks per changed
    // coordinate. A grouped MAX over the prior history here makes repeated
    // append batches quadratic for long transcripts.
    let mut historical = false;
    for (provider, native_session_id) in changed_coordinates(conn)? {
        let incoming = conn
            .query_row(
                "SELECT f.occurred_at FROM temp.usage_incremental_changed c
             CROSS JOIN usage_facts f
             WHERE f.fact_key=c.fact_key
               AND f.provider=? AND f.native_session_id=?
               AND NOT EXISTS(SELECT 1 FROM temp.usage_incremental_old_facts o
                              WHERE o.fact_key=c.fact_key)
             ORDER BY f.occurred_at,f.fact_key LIMIT 1",
                params![provider, native_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let prior = conn
            .query_row(
                "SELECT f.occurred_at FROM usage_facts f
                 WHERE f.provider=? AND f.native_session_id=?
                   AND NOT EXISTS(
                       SELECT 1 FROM temp.usage_incremental_changed c
                       WHERE c.fact_key=f.fact_key
                         AND NOT EXISTS(
                             SELECT 1 FROM temp.usage_incremental_old_facts o
                             WHERE o.fact_key=c.fact_key))
                   AND EXISTS(SELECT 1 FROM usage_fact_observations n
                              WHERE n.fact_key=f.fact_key
                                AND n.source LIKE 'native:%')
                 ORDER BY f.occurred_at DESC,f.fact_key DESC LIMIT 1",
                params![provider, native_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            let projected = conn
                .query_row(
                    "SELECT 1 FROM usage_query_sessions
                     WHERE provider=? AND native_session_id=?",
                    params![provider, native_session_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !projected || incoming.as_ref().is_some_and(|incoming| incoming < &prior) {
                if !projected {
                    #[cfg(test)]
                    profile_rejection("unprojected");
                    return Ok(NativeChangeKind::Repair);
                }
                historical = true;
            }
        }
    }
    if !historical {
        return Ok(NativeChangeKind::AppendOnly);
    }

    // The bounded historical repair is deliberately narrower than the append
    // path: every changed row must be a brand-new canonical native key. This
    // excludes removals, observation-owner moves, and mixed structural edits.
    let unsafe_historical = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM temp.usage_incremental_changed c
            LEFT JOIN usage_facts f USING(fact_key)
            LEFT JOIN temp.usage_incremental_old_facts o USING(fact_key)
            LEFT JOIN temp.usage_incremental_merge_keys m USING(fact_key)
            WHERE f.fact_key IS NULL OR o.fact_key IS NOT NULL
               OR m.fact_key IS NOT NULL
               OR NOT EXISTS(
                    SELECT 1 FROM usage_fact_observations n
                    WHERE n.fact_key=c.fact_key AND n.source LIKE 'native:%'))",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if unsafe_historical {
        #[cfg(test)]
        profile_rejection("historicalUnsafe");
        Ok(NativeChangeKind::Repair)
    } else {
        Ok(NativeChangeKind::HistoricalOnly)
    }
}

pub(super) fn changed_native_timestamps_are_canonical(conn: &Connection) -> Result<bool> {
    let mut timestamp_statement = conn.prepare(
        "SELECT f.occurred_at
         FROM temp.usage_incremental_changed c
         CROSS JOIN usage_facts f
         WHERE f.fact_key=c.fact_key
           AND EXISTS(SELECT 1 FROM usage_fact_observations n
                      WHERE n.fact_key=c.fact_key AND n.source LIKE 'native:%')",
    )?;
    let mut timestamps = timestamp_statement.query([])?;
    while let Some(row) = timestamps.next()? {
        let value = row.get::<_, String>(0)?;
        if !has_canonical_timestamp_format(&value) {
            return Ok(false);
        }
    }
    drop(timestamps);
    drop(timestamp_statement);
    Ok(true)
}

pub(super) fn append_only_native(conn: &Connection) -> Result<bool> {
    Ok(classify_native(conn)? == NativeChangeKind::AppendOnly)
}

/// Adds the neighboring local calendar days which can contain an inferred
/// edge to or from a historical fact. Native edges are strictly shorter than
/// five minutes, while a local day is at least 23 hours, so no farther day can
/// be affected, including across DST transitions.
pub(super) fn expand_historical_days(conn: &Connection) -> Result<Vec<CoordinateDay>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT f.provider,f.native_session_id,f.local_day
         FROM temp.usage_incremental_changed c
         CROSS JOIN usage_facts f
         WHERE f.fact_key=c.fact_key
           AND NOT EXISTS(SELECT 1 FROM temp.usage_incremental_old_facts o
                          WHERE o.fact_key=c.fact_key)
         ORDER BY f.provider,f.native_session_id,f.local_day",
    )?;
    let changed = statement
        .query_map([], |row| {
            Ok(CoordinateDay {
                provider: row.get(0)?,
                native_session_id: row.get(1)?,
                local_day: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    let mut expanded = BTreeSet::new();
    for coordinate in changed {
        let day = NaiveDate::parse_from_str(&coordinate.local_day, "%Y-%m-%d")?;
        for adjacent in [day.pred_opt(), Some(day), day.succ_opt()]
            .into_iter()
            .flatten()
        {
            expanded.insert(CoordinateDay {
                provider: coordinate.provider.clone(),
                native_session_id: coordinate.native_session_id.clone(),
                local_day: adjacent.format("%Y-%m-%d").to_string(),
            });
        }
    }
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO temp.usage_incremental_days(
            provider,native_session_id,local_day) VALUES(?,?,?)",
    )?;
    for day in &expanded {
        insert.execute(params![day.provider, day.native_session_id, day.local_day])?;
    }
    drop(insert);
    Ok(expanded.into_iter().collect())
}

/// Returns merged strict-influence windows for first-seen historical points.
/// A native edge exists only below five minutes, so facts outside these
/// windows cannot gain, lose, or change an inferred interval.
pub(super) fn historical_native_windows(
    conn: &Connection,
    radius_ms: i64,
) -> Result<Option<Vec<CoordinateWindow>>> {
    let mut statement = conn.prepare(
        "SELECT f.provider,f.native_session_id,f.occurred_at
         FROM temp.usage_incremental_changed c
         CROSS JOIN usage_facts f
         WHERE f.fact_key=c.fact_key
           AND NOT EXISTS(SELECT 1 FROM temp.usage_incremental_old_facts o
                          WHERE o.fact_key=c.fact_key)
         ORDER BY f.provider,f.native_session_id,f.occurred_at,f.fact_key",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut windows: Vec<CoordinateWindow> = Vec::new();
    for (provider, native_session_id, occurred_at) in rows {
        let timestamp = super::time::timestamp_millis(&occurred_at)?;
        let Some(start_ms) = timestamp.checked_sub(radius_ms) else {
            return Ok(None);
        };
        let Some(end_ms) = timestamp.checked_add(radius_ms) else {
            return Ok(None);
        };
        if let Some(previous) = windows.last_mut().filter(|previous| {
            previous.provider == provider
                && previous.native_session_id == native_session_id
                && start_ms <= previous.end_ms
        }) {
            previous.end_ms = previous.end_ms.max(end_ms);
        } else {
            windows.push(CoordinateWindow {
                provider,
                native_session_id,
                start_ms,
                end_ms,
            });
        }
    }
    Ok(Some(windows))
}

pub(super) fn changed_native_facts(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<Vec<(String, String, String, String, String, String)>> {
    let mut statement = conn.prepare(
        "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                COALESCE(f.threadterm_session_id,''),f.scope
         FROM temp.usage_incremental_changed c CROSS JOIN usage_facts f
         WHERE f.fact_key=c.fact_key
           AND f.provider=? AND f.native_session_id=?
           AND NOT EXISTS(SELECT 1 FROM temp.usage_incremental_old_facts o
                          WHERE o.fact_key=c.fact_key)
         ORDER BY f.occurred_at,f.fact_key",
    )?;
    let result = statement
        .query_map(params![provider, native_session_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

pub(super) fn prior_native_timestamp(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<Option<i64>> {
    let timestamp = conn
        .query_row(
            "SELECT f.occurred_at FROM usage_facts f
             LEFT JOIN temp.usage_incremental_changed c
               ON c.fact_key=f.fact_key AND NOT EXISTS(
                  SELECT 1 FROM temp.usage_incremental_old_facts o
                  WHERE o.fact_key=c.fact_key)
             WHERE f.provider=? AND f.native_session_id=?
               AND c.fact_key IS NULL
               AND EXISTS(SELECT 1 FROM usage_fact_observations n
                          WHERE n.fact_key=f.fact_key AND n.source LIKE 'native:%')
             ORDER BY f.occurred_at DESC,f.fact_key DESC LIMIT 1",
            params![provider, native_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    timestamp
        .map(|value| super::time::timestamp_millis(&value))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::has_canonical_timestamp_format;

    #[test]
    fn canonical_timestamp_format_is_fixed_width_utc_millis() {
        assert!(has_canonical_timestamp_format("2026-01-02T03:04:05.006Z"));
        assert!(has_canonical_timestamp_format("2016-12-31T23:59:60.000Z"));
        assert!(!has_canonical_timestamp_format(
            "2026-01-02T03:04:05.006-05:00"
        ));
        assert!(!has_canonical_timestamp_format("2026-01-02T03:04:05Z"));
        assert!(!has_canonical_timestamp_format(
            "２０２６-01-02T03:04:05.006Z"
        ));
    }
}
