//! Incremental query projections. Each replacement is bounded to one native session.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};

pub const METRICS: [&str; 27] = [
    "input_tokens",
    "cache_read_tokens",
    "cache_write5m_tokens",
    "cache_write1h_tokens",
    "cache_write_unknown_tokens",
    "output_tokens",
    "reasoning_tokens",
    "input_reported",
    "cache_read_reported",
    "cache_write5m_reported",
    "cache_write1h_reported",
    "cache_write_unknown_reported",
    "output_reported",
    "reasoning_reported",
    "requests",
    "reported_cost",
    "estimated_cost",
    "priced_tokens",
    "unpriced_tokens",
    "reported_requests",
    "priced_requests",
    "exact_requests",
    "derived_requests",
    "estimated_requests",
    "exact_tokens",
    "derived_tokens",
    "estimated_tokens",
];

pub fn initialize(conn: &Connection) -> Result<()> {
    let metrics = METRICS
        .iter()
        .map(|c| {
            format!(
                "{c} {} NOT NULL",
                if c.ends_with("cost") {
                    "REAL"
                } else {
                    "INTEGER"
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS usage_query_sessions(provider TEXT NOT NULL,native_session_id TEXT NOT NULL,PRIMARY KEY(provider,native_session_id)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS usage_dimension_masks(mask INTEGER PRIMARY KEY);
         INSERT OR IGNORE INTO usage_dimension_masks VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15);
         CREATE TABLE IF NOT EXISTS usage_daily_cube(
            dimensions_mask INTEGER NOT NULL,local_day TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
            project_id TEXT NOT NULL,scope TEXT NOT NULL,mode INTEGER NOT NULL,{metrics},sessions INTEGER NOT NULL,
            PRIMARY KEY(mode,dimensions_mask,provider,model,project_id,scope,local_day)) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS usage_daily_cube_range ON usage_daily_cube(mode,dimensions_mask,local_day,provider,model,project_id,scope);
         CREATE TABLE IF NOT EXISTS usage_session_keys(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,native_session_id TEXT NOT NULL,UNIQUE(provider,native_session_id));
         CREATE TABLE IF NOT EXISTS usage_session_slices(
            id INTEGER PRIMARY KEY,session_key INTEGER NOT NULL,mode INTEGER NOT NULL,provider TEXT NOT NULL,native_session_id TEXT NOT NULL,
            model_mask INTEGER NOT NULL,model TEXT NOT NULL,project_id TEXT NOT NULL,scope TEXT NOT NULL,
            first_day TEXT NOT NULL,last_day TEXT NOT NULL,tokens INTEGER NOT NULL,cost REAL NOT NULL,
            requests INTEGER NOT NULL,active_ms INTEGER NOT NULL,estimated INTEGER NOT NULL,
            first_at TEXT NOT NULL,last_at TEXT NOT NULL,
            UNIQUE(mode,provider,native_session_id,model_mask,model,project_id,scope));
         CREATE INDEX IF NOT EXISTS usage_slices_lookup ON usage_session_slices(mode,model_mask,model,provider,project_id,scope,first_day,last_day,native_session_id);
         CREATE INDEX IF NOT EXISTS usage_slices_counts ON usage_session_slices(mode,model_mask,model,provider,project_id,scope,first_day,last_day,session_key);
         CREATE INDEX IF NOT EXISTS usage_slices_sort ON usage_session_slices(mode,model_mask,model,provider,project_id,scope,first_day,last_day,session_key,native_session_id,tokens,cost,last_at);
         CREATE INDEX IF NOT EXISTS usage_slices_model_counts ON usage_session_slices(mode,model_mask,model,session_key,provider,project_id,scope,first_day,last_day);
         CREATE INDEX IF NOT EXISTS usage_slices_default_counts ON usage_session_slices(mode,model_mask,session_key,first_day,last_day);
         CREATE INDEX IF NOT EXISTS usage_slices_default_model_counts ON usage_session_slices(mode,model_mask,model,session_key,first_day,last_day);
         CREATE INDEX IF NOT EXISTS usage_slices_session ON usage_session_slices(provider,native_session_id,mode);
         CREATE TABLE IF NOT EXISTS usage_session_prefix(
            slice_id INTEGER NOT NULL,local_day TEXT NOT NULL,tokens INTEGER NOT NULL,cost REAL NOT NULL,
            requests INTEGER NOT NULL,active_ms INTEGER NOT NULL,estimated INTEGER NOT NULL,
            first_at TEXT NOT NULL,last_at TEXT NOT NULL,has_requests INTEGER NOT NULL,
            PRIMARY KEY(slice_id,local_day)) WITHOUT ROWID;"
    ))?;
    conn.execute("INSERT OR IGNORE INTO usage_ledger_state(key,value) SELECT 'query-projection-complete','1' WHERE NOT EXISTS(SELECT 1 FROM usage_facts LIMIT 1)",[])?;
    Ok(())
}

pub fn snapshot(conn: &Connection, provider: &str, native: &str) -> Result<()> {
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS usage_previous_rollups AS SELECT *,0 AS mode FROM usage_daily_rollups WHERE 0; DELETE FROM temp.usage_previous_rollups;")?;
    if conn
        .query_row(
            "SELECT 1 FROM usage_query_sessions WHERE provider=? AND native_session_id=?",
            params![provider, native],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        conn.execute("INSERT INTO temp.usage_previous_rollups SELECT *,0 FROM usage_daily_rollups WHERE provider=? AND native_session_id=?",params![provider,native])?;
        conn.execute("INSERT INTO temp.usage_previous_rollups SELECT *,1 FROM usage_live_rollups WHERE provider=? AND native_session_id=?",params![provider,native])?;
    }
    Ok(())
}

pub fn replace(conn: &Connection, provider: &str, native: &str) -> Result<()> {
    cube_delta(conn, "temp.usage_previous_rollups", -1, None)?;
    cube_delta(conn, "usage_daily_rollups", 1, Some((provider, native, 0)))?;
    cube_delta(conn, "usage_live_rollups", 1, Some((provider, native, 1)))?;
    refresh_slices(conn, provider, native)?;
    conn.execute(
        "INSERT OR IGNORE INTO usage_query_sessions VALUES(?,?)",
        params![provider, native],
    )?;
    Ok(())
}

/// Snapshots and replaces only the session-days named by the transaction-local
/// incremental change set. The full-session repair path continues to use
/// `snapshot`/`replace` above.
pub(super) fn snapshot_incremental(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_incremental_previous_rollups
            AS SELECT *,0 AS mode FROM usage_daily_rollups WHERE 0;
         DELETE FROM temp.usage_incremental_previous_rollups;
         INSERT INTO temp.usage_incremental_previous_rollups
            SELECT r.*,0 FROM temp.usage_incremental_days d
            CROSS JOIN usage_daily_rollups r INDEXED BY usage_rollups_session
            WHERE r.provider=d.provider
              AND r.native_session_id=d.native_session_id
              AND r.local_day=d.local_day;",
    )?;
    Ok(())
}

pub(super) fn replace_incremental(conn: &Connection) -> Result<()> {
    cube_delta(conn, "temp.usage_incremental_previous_rollups", -1, None)?;
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_incremental_new_rollups
            AS SELECT *,0 AS mode FROM usage_daily_rollups WHERE 0;
         DELETE FROM temp.usage_incremental_new_rollups;
         INSERT INTO temp.usage_incremental_new_rollups
            SELECT r.*,0 FROM temp.usage_incremental_days d
            CROSS JOIN usage_daily_rollups r INDEXED BY usage_rollups_session
            WHERE r.provider=d.provider
              AND r.native_session_id=d.native_session_id
              AND r.local_day=d.local_day;",
    )?;
    cube_delta(conn, "temp.usage_incremental_new_rollups", 1, None)?;
    refresh_incremental_slices(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO usage_query_sessions(provider,native_session_id)
         SELECT DISTINCT provider,native_session_id
         FROM temp.usage_incremental_days",
        [],
    )?;
    Ok(())
}

fn refresh_incremental_slices(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO usage_session_keys(provider,native_session_id)
         SELECT DISTINCT provider,native_session_id
         FROM temp.usage_incremental_days",
        [],
    )?;
    let mut groups = BTreeSet::new();
    let mut statement = conn.prepare(
        "SELECT provider,native_session_id,model,project_id,scope FROM (
            SELECT r.provider,r.native_session_id,r.model,r.project_id,r.scope
            FROM temp.usage_incremental_days d
            CROSS JOIN usage_daily_rollups r INDEXED BY usage_rollups_session
            WHERE r.provider=d.provider
              AND r.native_session_id=d.native_session_id
              AND r.local_day=d.local_day
            UNION
            SELECT i.provider,i.native_session_id,i.model,i.project_id,i.scope
            FROM temp.usage_incremental_days d
            CROSS JOIN usage_intervals i INDEXED BY usage_intervals_session_day
            WHERE i.provider=d.provider
              AND i.native_session_id=d.native_session_id
              AND i.local_day=d.local_day
         ) ORDER BY provider,native_session_id,model,project_id,scope",
    )?;
    for row in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })? {
        groups.insert(row?);
    }
    drop(statement);
    let mut slices = BTreeSet::new();
    for (provider, native, model, project, scope) in groups {
        slices.insert((
            provider.clone(),
            native.clone(),
            0_i64,
            String::new(),
            project.clone(),
            scope.clone(),
        ));
        slices.insert((provider, native, 1_i64, model, project, scope));
    }
    for (provider, native, model_mask, model, project, scope) in slices {
        refresh_incremental_slice(
            conn, &provider, &native, model_mask, &model, &project, &scope,
        )?;
    }
    Ok(())
}

fn refresh_incremental_slice(
    conn: &Connection,
    provider: &str,
    native: &str,
    model_mask: i64,
    model: &str,
    project: &str,
    scope: &str,
) -> Result<()> {
    let model_predicate = if model_mask == 0 {
        ""
    } else {
        " AND r.model=?"
    };
    let interval_min_model_predicate = if model_mask == 0 {
        ""
    } else {
        " AND i.model=?"
    };
    let min_sql = format!(
        "SELECT MIN(local_day) FROM (
            SELECT r.local_day FROM temp.usage_incremental_days d
            CROSS JOIN usage_daily_rollups r INDEXED BY usage_rollups_session
            WHERE r.provider=d.provider
              AND r.native_session_id=d.native_session_id
              AND r.local_day=d.local_day
              AND r.provider=? AND r.native_session_id=?
              AND r.project_id=? AND r.scope=?{model_predicate}
            UNION ALL
            SELECT i.local_day FROM temp.usage_incremental_days d
            CROSS JOIN usage_intervals i INDEXED BY usage_intervals_session_day
            WHERE i.provider=d.provider
              AND i.native_session_id=d.native_session_id
              AND i.local_day=d.local_day
              AND i.provider=? AND i.native_session_id=?
              AND i.project_id=? AND i.scope=?{interval_min_model_predicate}
         )"
    );
    let mut min_args = vec![
        provider.to_owned(),
        native.to_owned(),
        project.to_owned(),
        scope.to_owned(),
    ];
    if model_mask != 0 {
        min_args.push(model.to_owned());
    }
    min_args.extend([
        provider.to_owned(),
        native.to_owned(),
        project.to_owned(),
        scope.to_owned(),
    ]);
    if model_mask != 0 {
        min_args.push(model.to_owned());
    }
    let min_day: Option<String> = conn
        .prepare_cached(&min_sql)?
        .query_row(rusqlite::params_from_iter(min_args), |row| row.get(0))?;
    let Some(min_day) = min_day else {
        return Ok(());
    };

    conn.prepare_cached(
        "INSERT OR IGNORE INTO usage_session_slices(
            session_key,mode,provider,native_session_id,model_mask,model,
            project_id,scope,first_day,last_day,tokens,cost,requests,active_ms,
            estimated,first_at,last_at)
         VALUES((SELECT id FROM usage_session_keys
                 WHERE provider=? AND native_session_id=?),0,?,?,?,?,?,?,?,?,
                0,0,0,0,0,'','')",
    )?
    .execute(params![
        provider, native, provider, native, model_mask, model, project, scope, min_day, min_day
    ])?;
    let slice_id: i64 = conn
        .prepare_cached(
            "SELECT id FROM usage_session_slices
         WHERE mode=0 AND provider=? AND native_session_id=?
           AND model_mask=? AND model=? AND project_id=? AND scope=?",
        )?
        .query_row(
            params![provider, native, model_mask, model, project, scope],
            |row| row.get(0),
        )?;

    let seed = conn
        .prepare_cached(
            "SELECT tokens,cost,requests,active_ms,estimated,last_at
             FROM usage_session_prefix
             WHERE slice_id=? AND local_day<?
             ORDER BY local_day DESC LIMIT 1",
        )?
        .query_row(params![slice_id, min_day], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .optional()?
        .unwrap_or_default();
    conn.execute(
        "DELETE FROM usage_session_prefix WHERE slice_id=? AND local_day>=?",
        params![slice_id, min_day],
    )?;

    let daily_sql = format!(
        "SELECT r.local_day,
                SUM(r.input_tokens+r.cache_read_tokens+r.cache_write5m_tokens+
                    r.cache_write1h_tokens+r.cache_write_unknown_tokens+r.output_tokens),
                SUM(r.estimated_cost),SUM(r.requests),
                MIN(r.first_occurred_at),MAX(r.last_occurred_at)
         FROM usage_daily_rollups r
         WHERE r.provider=? AND r.native_session_id=? AND r.project_id=?
           AND r.scope=? AND r.local_day>=?{model_predicate}
         GROUP BY r.local_day ORDER BY r.local_day"
    );
    let mut args = vec![
        provider.to_owned(),
        native.to_owned(),
        project.to_owned(),
        scope.to_owned(),
        min_day.clone(),
    ];
    if model_mask != 0 {
        args.push(model.to_owned());
    }
    let mut days = BTreeMap::<String, (i64, f64, i64, i64, bool, String, String)>::new();
    let mut daily = conn.prepare(&daily_sql)?;
    let mut rows = daily.query(rusqlite::params_from_iter(args))?;
    while let Some(row) = rows.next()? {
        days.insert(
            row.get(0)?,
            (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                0,
                false,
                row.get(4)?,
                row.get(5)?,
            ),
        );
    }
    drop(rows);
    drop(daily);

    let interval_model_predicate = if model_mask == 0 { "" } else { " AND model=?" };
    let interval_sql = format!(
        "SELECT local_day,start_ms,end_ms,estimated FROM usage_intervals
         WHERE provider=? AND native_session_id=? AND project_id=? AND scope=?
           AND local_day>=?{interval_model_predicate}
         ORDER BY local_day,start_ms,end_ms"
    );
    let mut args = vec![
        provider.to_owned(),
        native.to_owned(),
        project.to_owned(),
        scope.to_owned(),
        min_day.clone(),
    ];
    if model_mask != 0 {
        args.push(model.to_owned());
    }
    let mut intervals = conn.prepare(&interval_sql)?;
    let mut rows = intervals.query(rusqlite::params_from_iter(args))?;
    let mut interval_day = String::new();
    let mut last_end = i64::MIN;
    while let Some(row) = rows.next()? {
        let day: String = row.get(0)?;
        let start: i64 = row.get(1)?;
        let end: i64 = row.get(2)?;
        if day != interval_day {
            interval_day = day.clone();
            last_end = i64::MIN;
        }
        let value = days.entry(day).or_default();
        value.3 += (end - start.max(last_end)).max(0);
        value.4 |= row.get::<_, bool>(3)?;
        last_end = last_end.max(end);
    }
    drop(rows);
    drop(intervals);

    let mut tokens = seed.0;
    let mut cost = seed.1;
    let mut requests = seed.2;
    let mut active = seed.3;
    let mut estimated = seed.4;
    let mut last_at = seed.5;
    let mut insert =
        conn.prepare_cached("INSERT INTO usage_session_prefix VALUES(?,?,?,?,?,?,?,?,?,?)")?;
    for (day, (day_tokens, day_cost, day_requests, day_active, day_estimated, first, last)) in days
    {
        tokens += day_tokens;
        cost += day_cost;
        requests += day_requests;
        active += day_active;
        estimated += i64::from(day_estimated);
        if !last.is_empty() {
            last_at = last;
        }
        insert.execute(params![
            slice_id,
            day,
            tokens,
            cost,
            requests,
            active,
            estimated,
            first,
            last_at,
            i64::from(day_requests > 0)
        ])?;
    }
    drop(insert);
    conn.prepare_cached(
        "UPDATE usage_session_slices SET
            first_day=(SELECT MIN(local_day) FROM usage_session_prefix WHERE slice_id=?),
            last_day=(SELECT MAX(local_day) FROM usage_session_prefix WHERE slice_id=?),
            tokens=?,cost=?,requests=?,active_ms=?,estimated=?,
            first_at=COALESCE(NULLIF(first_at,''),(SELECT MIN(NULLIF(first_at,''))
                FROM usage_session_prefix WHERE slice_id=?)),last_at=?
         WHERE id=?",
    )?
    .execute(params![
        slice_id,
        slice_id,
        tokens,
        cost,
        requests,
        active,
        i64::from(estimated > 0),
        slice_id,
        last_at,
        slice_id
    ])?;
    let mut request_statement = conn.prepare_cached(
        "SELECT local_day FROM usage_session_prefix
         WHERE slice_id=? AND has_requests=1 ORDER BY local_day",
    )?;
    let request_days = request_statement
        .query_map([slice_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(request_statement);
    super::membership::write_slice(conn, slice_id, &request_days)?;
    super::session_ranges::refresh(conn, slice_id)?;
    Ok(())
}

fn cube_delta(
    conn: &Connection,
    table: &str,
    sign: i64,
    coordinate: Option<(&str, &str, i64)>,
) -> Result<()> {
    let names = METRICS.join(",");
    let values = METRICS
        .iter()
        .map(|c| format!("{sign}*SUM(r.{c})"))
        .collect::<Vec<_>>()
        .join(",");
    let updates = METRICS
        .iter()
        .map(|c| format!("{c}={c}+excluded.{c}"))
        .collect::<Vec<_>>()
        .join(",");
    let (predicate, mode) = if coordinate.is_some() {
        ("r.provider=? AND r.native_session_id=?", "?")
    } else {
        ("1", "r.mode")
    };
    let sql=format!("INSERT INTO usage_daily_cube(dimensions_mask,local_day,provider,model,project_id,scope,mode,{names},sessions)
        SELECT mask,local_day,CASE WHEN mask&1!=0 THEN r.provider ELSE '' END,
        CASE WHEN mask&2!=0 THEN r.model ELSE '' END,CASE WHEN mask&4!=0 THEN r.project_id ELSE '' END,
        CASE WHEN mask&8!=0 THEN r.scope ELSE '' END,{mode},{values},{sign}
        FROM {table} r CROSS JOIN usage_dimension_masks WHERE {predicate}
        GROUP BY 1,2,3,4,5,6,7
        ON CONFLICT DO UPDATE SET {updates},sessions=sessions+excluded.sessions");
    if let Some((provider, native, mode)) = coordinate {
        conn.prepare_cached(&sql)?
            .execute(params![mode, provider, native])?;
    } else {
        conn.prepare_cached(&sql)?.execute([])?;
    }
    Ok(())
}

fn refresh_slices(conn: &Connection, provider: &str, native: &str) -> Result<()> {
    super::membership::remove_session(conn, provider, native)?;
    super::session_ranges::remove_session(conn, provider, native)?;
    conn.execute("DELETE FROM usage_session_prefix WHERE slice_id IN(SELECT id FROM usage_session_slices WHERE provider=? AND native_session_id=?)",params![provider,native])?;
    conn.execute(
        "DELETE FROM usage_session_slices WHERE provider=? AND native_session_id=?",
        params![provider, native],
    )?;
    conn.prepare_cached(
        "INSERT OR IGNORE INTO usage_session_keys(provider,native_session_id) VALUES(?,?)",
    )?
    .execute(params![provider, native])?;
    for (mode, table) in [(0, "usage_daily_rollups"), (1, "usage_live_rollups")] {
        for mask in 0..=1 {
            let model = if mask == 0 { "''" } else { "model" };
            conn.execute(&format!("INSERT INTO usage_session_slices(session_key,mode,provider,native_session_id,model_mask,model,project_id,scope,first_day,last_day,tokens,cost,requests,active_ms,estimated,first_at,last_at)
                SELECT (SELECT id FROM usage_session_keys k WHERE k.provider=r.provider AND k.native_session_id=r.native_session_id),?,provider,native_session_id,?,{model},project_id,scope,MIN(local_day),MAX(local_day),
                SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens),SUM(estimated_cost),SUM(requests),0,0,MIN(first_occurred_at),MAX(last_occurred_at)
                FROM {table} r WHERE provider=? AND native_session_id=? GROUP BY provider,native_session_id,{model},project_id,scope"),params![mode,mask,provider,native])?;
            let mut statement=conn.prepare("SELECT id,model,project_id,scope FROM usage_session_slices WHERE mode=? AND provider=? AND native_session_id=? AND model_mask=?")?;
            let slices = statement
                .query_map(params![mode, provider, native, mask], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for (id, model, project, scope) in slices {
                let model_filter = if mask == 0 { "" } else { " AND model=?" };
                let sql=format!("SELECT local_day,SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens),SUM(estimated_cost),SUM(requests),MIN(first_occurred_at),MAX(last_occurred_at) FROM {table} WHERE provider=? AND native_session_id=? AND project_id=? AND scope=?{model_filter} GROUP BY local_day ORDER BY local_day");
                let mut st = conn.prepare(&sql)?;
                let mut args = vec![
                    provider.to_owned(),
                    native.to_owned(),
                    project.clone(),
                    scope.clone(),
                ];
                if mask != 0 {
                    args.push(model.clone());
                }
                let mut rows = st.query(rusqlite::params_from_iter(args))?;
                let mut days =
                    BTreeMap::<String, (i64, f64, i64, i64, bool, String, String)>::new();
                while let Some(r) = rows.next()? {
                    days.insert(
                        r.get(0)?,
                        (
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            0,
                            false,
                            r.get(4)?,
                            r.get(5)?,
                        ),
                    );
                }
                drop(rows);
                drop(st);
                let intervals = if mode == 0 {
                    "usage_intervals"
                } else {
                    "usage_live_intervals"
                };
                let sql=format!("SELECT local_day,start_ms,end_ms,estimated FROM {intervals} WHERE provider=? AND native_session_id=? AND project_id=? AND scope=?{model_filter} ORDER BY local_day,start_ms,end_ms");
                let mut st = conn.prepare_cached(&sql)?;
                let mut args = vec![
                    provider.to_owned(),
                    native.to_owned(),
                    project.clone(),
                    scope.clone(),
                ];
                if mask != 0 {
                    args.push(model.clone());
                }
                let mut rows = st.query(rusqlite::params_from_iter(args))?;
                let mut day = String::new();
                let mut last_end = i64::MIN;
                while let Some(r) = rows.next()? {
                    let key: String = r.get(0)?;
                    let start: i64 = r.get(1)?;
                    let end: i64 = r.get(2)?;
                    if day != key {
                        day = key.clone();
                        last_end = i64::MIN;
                    }
                    let value = days.entry(key).or_default();
                    value.3 += (end - start.max(last_end)).max(0);
                    value.4 |= r.get::<_, bool>(3)?;
                    last_end = last_end.max(end);
                }
                drop(rows);
                drop(st);
                let request_days = days
                    .iter()
                    .filter(|(_, value)| value.2 > 0)
                    .map(|(day, _)| day.clone())
                    .collect::<Vec<_>>();
                super::membership::write_slice(conn, id, &request_days)?;
                let mut tokens = 0_i64;
                let mut cost = 0.0;
                let mut requests = 0_i64;
                let mut active = 0_i64;
                let mut estimated = 0_i64;
                let mut last = String::new();
                let mut insert = conn.prepare_cached(
                    "INSERT INTO usage_session_prefix VALUES(?,?,?,?,?,?,?,?,?,?)",
                )?;
                for (day, (t, c, r, a, e, first, last_at)) in days {
                    tokens += t;
                    cost += c;
                    requests += r;
                    active += a;
                    estimated += i64::from(e);
                    if !last_at.is_empty() {
                        last = last_at;
                    }
                    insert.execute(params![
                        id,
                        day,
                        tokens,
                        cost,
                        requests,
                        active,
                        estimated,
                        first,
                        last,
                        i64::from(r > 0)
                    ])?;
                }
                conn.prepare_cached(
                    "UPDATE usage_session_slices SET active_ms=?,estimated=? WHERE id=?",
                )?
                .execute(params![active, estimated > 0, id])?;
                super::session_ranges::refresh(conn, id)?;
            }
        }
    }
    Ok(())
}

pub fn rebuild(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    let mut completed = 0_u64;
    let force = cfg!(test) && std::env::var_os("UA1R_FORCE_QUERY_REBUILD").is_some();
    let mut cursor = (String::new(), String::new());
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let next=conn.query_row("SELECT s.provider,s.native_session_id FROM usage_fact_observations s WHERE (s.provider,s.native_session_id)>(?,?) AND (?=1 OR NOT EXISTS(SELECT 1 FROM usage_query_sessions q WHERE q.provider=s.provider AND q.native_session_id=s.native_session_id)) GROUP BY s.provider,s.native_session_id ORDER BY s.provider,s.native_session_id LIMIT 1",params![cursor.0,cursor.1,force],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        let Some((provider, native)) = next else {
            write_completion_state(conn, "1")?;
            return Ok(true);
        };
        if completed == 0 {
            write_completion_state(conn, "0")?;
        }
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        #[cfg(test)]
        let transaction_started = std::time::Instant::now();
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        snapshot(&tx, &provider, &native)?;
        #[cfg(test)]
        let snapshot_us = stage_started.elapsed().as_micros();
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        super::live_fallback::refresh(&tx, &provider, &native)?;
        #[cfg(test)]
        let live_us = stage_started.elapsed().as_micros();
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        super::store::refresh_session_metadata(&tx, &provider, &native)?;
        #[cfg(test)]
        let metadata_us = stage_started.elapsed().as_micros();
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        replace(&tx, &provider, &native)?;
        #[cfg(test)]
        let materialized_us = stage_started.elapsed().as_micros();
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        tx.commit()?;
        #[cfg(test)]
        {
            let commit_us = stage_started.elapsed().as_micros();
            let transaction_us = transaction_started.elapsed().as_micros();
            if transaction_us >= 50_000 && std::env::var_os("UA1R_PROFILE").is_some() {
                println!(
                    "PROFILE slow_projection_tx_us={transaction_us} snapshot_us={snapshot_us} \
                     live_us={live_us} metadata_us={metadata_us} \
                     materialized_us={materialized_us} commit_us={commit_us}"
                );
            }
        }
        super::store::record_write_duration(write_start);
        super::store::checkpoint_index_connection(conn)?;
        cursor = (provider, native);
        completed += 1;
        #[cfg(test)]
        if completed % 1000 == 0 {
            println!("PASS query_projection_progress sessions={completed}");
        }
    }
}

fn write_completion_state(conn: &Connection, value: &str) -> Result<()> {
    let write_start = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    tx.execute(
        "INSERT INTO usage_ledger_state(key,value)
         VALUES('query-projection-complete',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [value],
    )?;
    tx.commit()?;
    super::store::record_write_duration(write_start);
    super::store::checkpoint_index_connection(conn)
}
