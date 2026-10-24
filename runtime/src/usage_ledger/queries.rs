use super::{
    store,
    time::{self, Granularity},
};
use anyhow::{anyhow, Result};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const BUCKETS: [&str; 7] = [
    "input",
    "cacheRead",
    "cacheWrite5m",
    "cacheWrite1h",
    "cacheWriteUnknown",
    "output",
    "reasoning",
];
const TOKEN_COLUMNS: [&str; 7] = [
    "input_tokens",
    "cache_read_tokens",
    "cache_write5m_tokens",
    "cache_write1h_tokens",
    "cache_write_unknown_tokens",
    "output_tokens",
    "reasoning_tokens",
];
const COVERAGE_COLUMNS: [&str; 7] = [
    "input_reported",
    "cache_read_reported",
    "cache_write5m_reported",
    "cache_write1h_reported",
    "cache_write_unknown_reported",
    "output_reported",
    "reasoning_reported",
];

#[derive(Clone, Default)]
struct Filter {
    terms: Vec<String>,
    values: Vec<SqlValue>,
    from: Option<String>,
    to: Option<String>,
    scope: String,
    provider: Option<String>,
    model: Option<String>,
    project: Option<String>,
    native: Option<String>,
    enabled: Option<Vec<String>>,
    include_outside: bool,
    disabled: Vec<String>,
}

fn mode_policy(f: &Filter) -> (String, Vec<SqlValue>) {
    if !f.include_outside {
        return ("mode=1 AND scope='threadterm'".into(), vec![]);
    }
    let mut conditions = Vec::new();
    let mut args = Vec::new();
    if !f.disabled.is_empty() {
        conditions.push(format!(
            "provider IN ({})",
            vec!["?"; f.disabled.len()].join(",")
        ));
        args.extend(f.disabled.iter().cloned().map(SqlValue::Text));
    }
    if let Some(enabled) = &f.enabled {
        if enabled.is_empty() {
            conditions.push("1".into());
        } else {
            conditions.push(format!(
                "provider NOT IN ({})",
                vec!["?"; enabled.len()].join(",")
            ));
            args.extend(enabled.iter().cloned().map(SqlValue::Text));
        }
    }
    if conditions.is_empty() {
        ("mode=0".into(), args)
    } else {
        (
            format!(
                "mode=CASE WHEN {} THEN 1 ELSE 0 END",
                conditions.join(" OR ")
            ),
            args,
        )
    }
}
fn daily_source(_f: &Filter) -> String {
    "(SELECT *,0 AS mode FROM usage_daily_rollups UNION ALL SELECT *,1 AS mode FROM usage_live_rollups)".into()
}
fn projection_ready(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT value FROM usage_ledger_state WHERE key='query-projection-complete'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .as_deref()
        == Some("1"))
}
fn aggregate_select_without_sessions() -> String {
    let select = aggregate_select();
    select[..select.rfind(",COUNT(DISTINCT").unwrap()].to_owned()
}
fn totals_filter(f: &Filter, extra: i64) -> (String, Vec<SqlValue>) {
    let mut mask = extra;
    for (bit, value) in [(1, &f.provider), (2, &f.model), (4, &f.project)] {
        if value.is_some() {
            mask |= bit;
        }
    }
    if f.scope != "all" || !f.include_outside {
        mask |= 8;
    }
    if !f.disabled.is_empty() || f.enabled.is_some() {
        mask |= 1;
    }
    let mut terms = f.terms.clone();
    let mut args = f.values.clone();
    terms.push("dimensions_mask=?".into());
    args.push(SqlValue::Integer(mask));
    terms.push("requests>0".into());
    (format!(" WHERE {}", terms.join(" AND ")), args)
}
fn slice_filter(f: &Filter, model_group: bool) -> (String, Vec<SqlValue>) {
    let (policy, mut args) = mode_policy(f);
    let mut terms = vec![
        policy,
        format!("model_mask={}", i64::from(f.model.is_some() || model_group)),
    ];
    for (column, value) in [
        ("provider", &f.provider),
        ("native_session_id", &f.native),
        ("model", &f.model),
        ("project_id", &f.project),
    ] {
        if let Some(value) = value {
            terms.push(format!("{column}=?"));
            args.push(SqlValue::Text(value.clone()));
        }
    }
    if f.scope != "all" {
        terms.push("scope=?".into());
        args.push(SqlValue::Text(f.scope.clone()));
    }
    let low = f.from.as_deref().unwrap_or("");
    let high = f.to.as_deref().unwrap_or("9999-12-31");
    terms.push("last_day>=? AND first_day<?".into());
    args.extend([SqlValue::Text(low.into()), SqlValue::Text(high.into())]);
    terms.push("((first_day>=? AND last_day<?) OR EXISTS(SELECT 1 FROM usage_session_prefix p WHERE p.slice_id=s.id AND p.local_day>=? AND p.local_day<? AND p.has_requests=1))".into());
    args.extend([low, high, low, high].map(|s| SqlValue::Text(s.into())));
    (format!(" WHERE {}", terms.join(" AND ")), args)
}
fn distinct_sessions(
    conn: &Connection,
    f: &Filter,
    dimension: Option<&str>,
) -> Result<BTreeMap<String, i64>> {
    let (col, mut index) = match dimension {
        Some("provider") => ("provider", "usage_slices_counts"),
        Some("model") => ("model", "usage_slices_model_counts"),
        Some("project") => ("project_id", "usage_slices_counts"),
        _ => ("''", "usage_slices_counts"),
    };
    let default_dimensions = f.scope == "all"
        && f.provider.is_none()
        && f.model.is_none()
        && f.project.is_none()
        && f.native.is_none()
        && f.enabled.is_none()
        && f.disabled.is_empty()
        && f.include_outside;
    if default_dimensions {
        if dimension.is_none() {
            index = "usage_slices_default_counts";
        } else if dimension == Some("model") {
            index = "usage_slices_default_model_counts";
        }
    }
    let (mut clause, mut args) = slice_filter(f, dimension == Some("model"));
    let full_history = covers_history(conn, f)?;
    if full_history || super::membership::ready(conn) {
        if let Some(at) = clause.rfind(" AND ((first_day>=?") {
            clause.truncate(at);
            args.truncate(args.len() - 4);
        }
    }
    if !full_history && super::membership::ready(conn) {
        let low = f.from.as_deref().unwrap_or("");
        let high = f.to.as_deref().unwrap_or("9999-12-31");
        let ordinal = |day: Option<&str>, fallback| -> Result<i32> {
            Ok(match day {
                Some(day) => NaiveDate::parse_from_str(day, "%Y-%m-%d")?.num_days_from_ce(),
                None => fallback,
            })
        };
        let from_day = ordinal(f.from.as_deref(), i32::MIN)?;
        let to_day = ordinal(f.to.as_deref(), i32::MAX)?;
        let full = format!("s.first_day>='{low}' AND s.last_day<'{high}'");
        let sql = format!("SELECT {col} k,s.session_key,{full} covered,b.base_day,b.bits FROM usage_session_slices s INDEXED BY {index} LEFT JOIN usage_session_day_sets b ON b.slice_id=s.id AND NOT({full}){clause} ORDER BY k,s.session_key");
        let mut st = conn.prepare(&sql)?;
        let mut rows = st.query(params_from_iter(args))?;
        let mut counts = BTreeMap::new();
        let mut previous = None;
        let mut counted = false;
        while let Some(row) = rows.next()? {
            let identity = (row.get::<_, String>(0)?, row.get::<_, i64>(1)?);
            if previous.as_ref() != Some(&identity) {
                previous = Some(identity.clone());
                counted = false;
            }
            if counted {
                continue;
            }
            let present = row.get::<_, bool>(2)?
                || super::membership::bitmap_intersects(
                    row.get(3)?,
                    row.get_ref(4)?.as_blob()?,
                    from_day,
                    to_day,
                );
            if present {
                *counts.entry(identity.0).or_insert(0) += 1;
                counted = true;
            }
        }
        return Ok(counts);
    }
    let group = if dimension.is_none() {
        ""
    } else {
        " GROUP BY k"
    };
    let sql = format!("SELECT {col} k,COUNT(DISTINCT session_key) FROM usage_session_slices s INDEXED BY {index}{clause}{group}");
    let mut st = conn.prepare(&sql)?;
    let result = st
        .query_map(params_from_iter(args), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    Ok(result)
}

fn covers_history(conn: &Connection, f: &Filter) -> Result<bool> {
    let (first,last): (Option<String>,Option<String>) = conn.query_row("SELECT MIN(local_day),MAX(local_day) FROM usage_daily_cube WHERE mode IN(0,1) AND dimensions_mask=0 AND requests>0",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(first
        .as_deref()
        .is_some_and(|day| f.from.as_deref().map_or(true, |low| day >= low))
        && last
            .as_deref()
            .is_some_and(|day| f.to.as_deref().map_or(true, |high| day < high)))
}
impl Filter {
    fn clause(&self) -> String {
        if self.terms.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.terms.join(" AND "))
        }
    }
    fn add(&mut self, column: &str, value: &str) {
        self.terms.push(format!("{column}=?"));
        self.values.push(SqlValue::Text(value.into()));
    }
}
fn filters(params: &Value) -> Result<Filter> {
    let input = params.get("filters").unwrap_or(params);
    let mut f = Filter {
        scope: input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("all")
            .into(),
        include_outside: input
            .get("includeOutside")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        disabled: input
            .get("nativeProvidersDisabled")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        ..Default::default()
    };
    if !matches!(f.scope.as_str(), "all" | "threadterm" | "outside") {
        return Err(anyhow!("invalid_usage_scope"));
    }
    for (key, col) in [
        ("provider", "provider"),
        ("model", "model"),
        ("projectId", "project_id"),
        ("nativeSessionId", "native_session_id"),
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            if value.len() > 1024 {
                return Err(anyhow!("invalid_usage_filter"));
            }
            f.add(col, value);
            match key {
                "provider" => f.provider = Some(value.into()),
                "model" => f.model = Some(value.into()),
                "projectId" => f.project = Some(value.into()),
                _ => f.native = Some(value.into()),
            }
        }
    }
    if f.scope != "all" {
        let scope = f.scope.clone();
        f.add("scope", &scope);
    }
    if !f.include_outside {
        f.terms.push("scope='threadterm'".into());
    }
    if let Some(enabled) = input.get("enabledProviders").and_then(Value::as_array) {
        let names: Vec<String> = enabled
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if names.len() > 128 {
            return Err(anyhow!("invalid_usage_provider_filter"));
        }
        f.enabled = Some(names);
    }
    for (key, op) in [("from", ">="), ("to", "<")] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            let day = as_day(value)?;
            f.terms.push(format!("local_day{op}?"));
            f.values.push(SqlValue::Text(day.clone()));
            if key == "from" {
                f.from = Some(day);
            } else {
                f.to = Some(day);
            }
        }
    }
    if let (Some(a), Some(b)) = (&f.from, &f.to) {
        if a >= b {
            return Err(anyhow!("invalid_usage_range"));
        }
    }
    let (policy, args) = mode_policy(&f);
    f.terms.push(policy);
    f.values.extend(args);
    Ok(f)
}
fn as_day(value: &str) -> Result<String> {
    if value.len() == 10 {
        Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?
            .format("%F")
            .to_string())
    } else {
        time::local_day(value)
    }
}

#[derive(Default, Clone)]
struct Aggregate {
    tokens: [i64; 7],
    reported: [i64; 7],
    requests: i64,
    sessions: i64,
    reported_usd: f64,
    estimated_usd: f64,
    priced_tokens: i64,
    unpriced_tokens: i64,
    reported_requests: i64,
    priced_requests: i64,
    quality: [i64; 3],
    quality_tokens: [i64; 3],
}
impl Aggregate {
    fn total(&self) -> i64 {
        self.tokens[..6].iter().sum()
    }
    fn merge(&mut self, other: &Self) {
        for i in 0..7 {
            self.tokens[i] += other.tokens[i];
            self.reported[i] += other.reported[i];
        }
        self.requests += other.requests;
        self.sessions += other.sessions;
        self.reported_usd += other.reported_usd;
        self.estimated_usd += other.estimated_usd;
        self.priced_tokens += other.priced_tokens;
        self.unpriced_tokens += other.unpriced_tokens;
        self.reported_requests += other.reported_requests;
        self.priced_requests += other.priced_requests;
        for i in 0..3 {
            self.quality[i] += other.quality[i];
            self.quality_tokens[i] += other.quality_tokens[i];
        }
    }
    fn value(&self, active: (i64, bool), pending: bool) -> Value {
        let mut tokens = json!({"total":self.total()});
        let mut coverage = json!({});
        for i in 0..7 {
            tokens[BUCKETS[i]] = if self.requests > 0 && self.reported[i] == 0 {
                Value::Null
            } else {
                json!(self.tokens[i])
            };
            coverage[BUCKETS[i]] =
                json!({"reportedRequests":self.reported[i],"requests":self.requests});
        }
        let ratio = |n: i64| {
            if self.total() > 0 {
                n as f64 / self.total() as f64
            } else {
                0.0
            }
        };
        json!({"tokens":tokens,"bucketCoverage":coverage,"requests":self.requests,"sessions":self.sessions,"activeTimeMs":active.0,"activeTimeEstimated":active.1,
            "pricingPending":pending,"cost":{"reportedUsd":if self.reported_requests>0 || self.requests==0 {json!(self.reported_usd)}else{Value::Null},
            "apiEquivalentUsd":if !pending && (self.priced_requests>0 || self.requests==0) {json!(self.estimated_usd)}else{Value::Null},
            "pricedTokens":if pending{0}else{self.priced_tokens},"unpricedTokens":if pending{self.total()}else{self.unpriced_tokens},
            "reportedRequests":self.reported_requests,"pricedRequests":if pending{0}else{self.priced_requests},
            "coverage":if self.total()==0 {if self.requests==0{1.0}else{0.0}} else if pending{0.0}else{self.priced_tokens as f64/self.total() as f64}},
            "quality":{"exactRequests":self.quality[0],"derivedRequests":self.quality[1],"estimatedRequests":self.quality[2],"exactTokens":self.quality_tokens[0],"derivedTokens":self.quality_tokens[1],"estimatedTokens":self.quality_tokens[2],"exactShare":ratio(self.quality_tokens[0]),"derivedShare":ratio(self.quality_tokens[1]),"estimatedShare":ratio(self.quality_tokens[2])}})
    }
}
fn aggregate_select() -> String {
    let mut cols: Vec<String> = TOKEN_COLUMNS
        .iter()
        .chain(COVERAGE_COLUMNS.iter())
        .map(|c| format!("COALESCE(SUM({c}),0)"))
        .collect();
    cols.extend(
        [
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
        ]
        .iter()
        .map(|c| format!("COALESCE(SUM({c}),0)")),
    );
    cols.push("COUNT(DISTINCT provider||char(31)||native_session_id)".into());
    cols.join(",")
}
fn read_aggregate(r: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<Aggregate> {
    let mut a = Aggregate::default();
    for i in 0..7 {
        a.tokens[i] = r.get(start + i)?;
        a.reported[i] = r.get(start + 7 + i)?;
    }
    a.requests = r.get(start + 14)?;
    a.reported_usd = r.get(start + 15)?;
    a.estimated_usd = r.get(start + 16)?;
    a.priced_tokens = r.get(start + 17)?;
    a.unpriced_tokens = r.get(start + 18)?;
    a.reported_requests = r.get(start + 19)?;
    a.priced_requests = r.get(start + 20)?;
    for i in 0..3 {
        a.quality[i] = r.get(start + 21 + i)?;
        a.quality_tokens[i] = r.get(start + 24 + i)?;
    }
    a.sessions = r.get(start + 27)?;
    Ok(a)
}
fn aggregate(conn: &Connection, f: &Filter) -> Result<Aggregate> {
    if f.native.is_some() || !projection_ready(conn)? {
        return aggregate_rows(conn, f);
    }
    let (clause, args) = totals_filter(f, 0);
    let sql = format!(
        "SELECT {} FROM usage_daily_cube{clause}",
        aggregate_select_without_sessions() + ",0"
    );
    let mut value = conn.query_row(&sql, params_from_iter(args), |r| read_aggregate(r, 0))?;
    value.sessions = distinct_sessions(conn, f, None)?.values().sum();
    Ok(value)
}
fn aggregate_rows(conn: &Connection, f: &Filter) -> Result<Aggregate> {
    let sql = format!(
        "SELECT {} FROM {}{}",
        aggregate_select(),
        daily_source(f),
        f.clause()
    );
    Ok(
        conn.query_row(&sql, params_from_iter(f.values.iter()), |r| {
            read_aggregate(r, 0)
        })?,
    )
}
fn pricing_pending(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM usage_ledger_state WHERE key='pricing-pending'",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .as_deref()
        == Some("1")
}

#[derive(Default, Clone)]
struct Union {
    start: Option<i64>,
    end: i64,
    total: i64,
    estimated: bool,
}
impl Union {
    fn push(&mut self, start: i64, end: i64, estimated: bool) {
        if end <= start {
            return;
        }
        self.estimated |= estimated;
        match self.start {
            None => {
                self.start = Some(start);
                self.end = end;
            }
            Some(_) if start <= self.end => self.end = self.end.max(end),
            Some(a) => {
                self.total += self.end - a;
                self.start = Some(start);
                self.end = end;
            }
        }
    }
    fn value(&self) -> (i64, bool) {
        (
            self.total + self.start.map(|s| self.end - s).unwrap_or(0),
            self.estimated,
        )
    }
}
fn interval_filter(f: &Filter) -> Result<(String, Vec<SqlValue>, i64, i64)> {
    let mut terms = vec!["end_ms>start_ms".to_owned()];
    let mut values = Vec::new();
    for (col, value) in [
        ("provider", &f.provider),
        ("model", &f.model),
        ("project_id", &f.project),
        ("native_session_id", &f.native),
    ] {
        if let Some(v) = value {
            terms.push(format!("{col}=?"));
            values.push(SqlValue::Text(v.clone()));
        }
    }
    if f.scope != "all" {
        terms.push("scope=?".into());
        values.push(SqlValue::Text(f.scope.clone()));
    } else if !f.include_outside {
        terms.push("scope='threadterm'".into());
    }
    let (policy, args) = mode_policy(f);
    terms.push(policy);
    values.extend(args);
    let low = if let Some(day) = &f.from {
        time::timestamp_millis(&time::local_day_range(day)?.0)?
    } else {
        i64::MIN / 2
    };
    let high = if let Some(day) = &f.to {
        time::timestamp_millis(&time::local_day_range(day)?.0)?
    } else {
        i64::MAX / 2
    };
    if f.from.is_some() {
        terms.push("end_ms>?".into());
        values.push(SqlValue::Integer(low));
    }
    if f.to.is_some() {
        terms.push("start_ms<?".into());
        values.push(SqlValue::Integer(high));
    }
    Ok((format!(" WHERE {}", terms.join(" AND ")), values, low, high))
}
fn active(conn: &Connection, f: &Filter) -> Result<(i64, bool)> {
    if cube_available(conn, f)? {
        let (clause, args) = cube_filter(f, 0);
        return Ok(conn.query_row(&format!("SELECT COALESCE(SUM(active_ms),0),COALESCE(MAX(estimated),0) FROM usage_activity_daily{clause}"),params_from_iter(args),|r|Ok((r.get(0)?,r.get(1)?)))?);
    }
    let (clause, values, low, high) = interval_filter(f)?;
    let mut st = conn.prepare_cached(&format!(
        "SELECT start_ms,end_ms,estimated FROM (SELECT *,0 AS mode FROM usage_intervals UNION ALL SELECT *,1 AS mode FROM usage_live_intervals){clause} ORDER BY start_ms,end_ms"
    ))?;
    let mut rows = st.query(params_from_iter(values))?;
    let mut union = Union::default();
    while let Some(r) = rows.next()? {
        union.push(
            r.get::<_, i64>(0)?.max(low),
            r.get::<_, i64>(1)?.min(high),
            r.get::<_, bool>(2)?,
        );
    }
    Ok(union.value())
}

fn cube_available(conn: &Connection, f: &Filter) -> Result<bool> {
    Ok(f.native.is_none()
        && f.enabled.is_none()
        && f.disabled.is_empty()
        && f.include_outside
        && !store::activity_dirty(conn, f.from.as_deref(), f.to.as_deref())?)
}

fn cube_filter(f: &Filter, extra_mask: i64) -> (String, Vec<SqlValue>) {
    let mut mask = extra_mask;
    let mut terms = Vec::new();
    let mut args = Vec::new();
    for (bit, column, value) in [
        (1, "provider", &f.provider),
        (2, "model", &f.model),
        (4, "project_id", &f.project),
    ] {
        if let Some(value) = value {
            mask |= bit;
            terms.push(format!("{column}=?"));
            args.push(SqlValue::Text(value.clone()));
        }
    }
    if f.scope != "all" || !f.include_outside {
        mask |= 8;
        terms.push("scope=?".into());
        args.push(SqlValue::Text(if f.scope != "all" {
            f.scope.clone()
        } else {
            "threadterm".into()
        }));
    }
    for (column, op, value) in [("local_day", ">=", &f.from), ("local_day", "<", &f.to)] {
        if let Some(value) = value {
            terms.push(format!("{column}{op}?"));
            args.push(SqlValue::Text(value.clone()));
        }
    }
    terms.insert(0, "dimensions_mask=?".into());
    args.insert(0, SqlValue::Integer(mask));
    (format!(" WHERE {}", terms.join(" AND ")), args)
}

fn activity_groups(
    conn: &Connection,
    f: &Filter,
    dimension: &str,
    calendar: Option<(Granularity, chrono::Weekday)>,
) -> Result<BTreeMap<(String, String), Union>> {
    if cube_available(conn, f)? {
        let bit = match dimension {
            "provider" => 1,
            "model" => 2,
            "project" => 4,
            _ => return Err(anyhow!("invalid_usage_dimension")),
        };
        let column = match dimension {
            "provider" => "provider",
            "model" => "model",
            _ => "project_id",
        };
        let mut result = BTreeMap::<(String, String), Union>::new();
        for (extra, overall) in [(bit, false), (0, true)] {
            if overall && calendar.is_none() {
                continue;
            }
            let (clause, args) = cube_filter(f, extra);
            let mut st=conn.prepare_cached(&format!("SELECT local_day,{column},active_ms,estimated FROM usage_activity_daily{clause} ORDER BY local_day"))?;
            let mut rows = st.query(params_from_iter(args))?;
            while let Some(row) = rows.next()? {
                let day: String = row.get(0)?;
                let key = if overall { String::new() } else { row.get(1)? };
                let bucket = if let Some((g, week)) = calendar {
                    time::bucket_start(&day, g, week)?
                } else {
                    String::new()
                };
                let value = result.entry((bucket, key)).or_default();
                value.total += row.get::<_, i64>(2)?;
                value.estimated |= row.get::<_, bool>(3)?;
            }
        }
        return Ok(result);
    }
    let column = match dimension {
        "provider" => "provider",
        "model" => "model",
        "project" => "project_id",
        _ => return Err(anyhow!("invalid_usage_dimension")),
    };
    let (clause, values, low, high) = interval_filter(f)?;
    let mut statement=conn.prepare_cached(&format!("SELECT start_ms,end_ms,estimated,{column} FROM (SELECT *,0 AS mode FROM usage_intervals UNION ALL SELECT *,1 AS mode FROM usage_live_intervals){clause} ORDER BY start_ms,end_ms"))?;
    let mut rows = statement.query(params_from_iter(values))?;
    let mut groups = BTreeMap::<(String, String), Union>::new();
    while let Some(row) = rows.next()? {
        let mut start = row.get::<_, i64>(0)?.max(low);
        let end = row.get::<_, i64>(1)?.min(high);
        let estimated: bool = row.get(2)?;
        let key: String = row.get(3)?;
        while start < end {
            let (bucket, piece_end) = if let Some((g, week)) = calendar {
                let timestamp = chrono::DateTime::from_timestamp_millis(start)
                    .ok_or_else(|| anyhow!("invalid_usage_timestamp"))?
                    .to_rfc3339();
                let bucket = time::bucket_start(&time::local_day(&timestamp)?, g, week)?;
                let bound =
                    time::timestamp_millis(&time::local_day_range(&end_of_bucket(&bucket, g)?)?.0)?;
                (bucket, end.min(bound))
            } else {
                (String::new(), end)
            };
            if piece_end <= start {
                return Err(anyhow!("invalid_usage_interval"));
            }
            groups
                .entry((bucket.clone(), key.clone()))
                .or_default()
                .push(start, piece_end, estimated);
            groups
                .entry((bucket, String::new()))
                .or_default()
                .push(start, piece_end, estimated);
            start = piece_end;
        }
    }
    Ok(groups)
}

pub fn query(conn: &Connection, method: &str, params: &Value) -> Result<Value> {
    conn.set_prepared_statement_cache_capacity(128);
    conn.pragma_update(None, "cache_size", -131072)?;
    let f = filters(params)?;
    match method {
        "usage.ledger.summary" => summary(conn, &f),
        "usage.ledger.series" => series(conn, &f, params),
        "usage.ledger.breakdown" => breakdown(conn, &f, params),
        "usage.ledger.sessions" => sessions(conn, &f, params),
        "usage.ledger.session" => session(conn, &f, params),
        _ => Err(anyhow!("unknown_usage_method")),
    }
}
fn summary(conn: &Connection, f: &Filter) -> Result<Value> {
    let mut value = aggregate(conn, f)?.value(active(conn, f)?, pricing_pending(conn));
    value["from"] = json!(f.from);
    value["to"] = json!(f.to);
    value["scope"] = json!(f.scope);
    // A model cannot be attributed to a session that has no model evidence.
    value["sessionsWithoutUsage"] = if f.scope == "outside" || f.model.is_some() {
        json!(0)
    } else {
        let mut sql = String::from(
            "SELECT COUNT(*) FROM sessions s WHERE s.provider NOT IN ('shell','custom')",
        );
        let mut args = Vec::<SqlValue>::new();
        for (column, value) in [("s.provider", &f.provider), ("s.project_id", &f.project)] {
            if let Some(value) = value {
                sql.push_str(&format!(" AND {column}=?"));
                args.push(SqlValue::Text(value.clone()));
            }
        }
        for (op, day) in [(">=", &f.from), ("<", &f.to)] {
            if let Some(day) = day {
                sql.push_str(&format!(" AND date(s.created_at,'localtime'){op}?"));
                args.push(SqlValue::Text(day.clone()));
            }
        }
        if projection_ready(conn)? {
            let (policy, values) = mode_policy(f);
            sql.push_str(&format!(" AND NOT EXISTS(SELECT 1 FROM usage_ledger_sessions u WHERE u.threadterm_session_id=s.id AND EXISTS(SELECT 1 FROM usage_session_slices sl WHERE sl.provider=u.provider AND sl.native_session_id=u.native_session_id AND sl.model_mask=0 AND {policy}))"));
            args.extend(values);
        } else {
            sql.push_str(" AND NOT EXISTS(SELECT 1 FROM usage_ledger_sessions u WHERE u.threadterm_session_id=s.id)");
        }
        json!(conn.query_row(&sql, params_from_iter(args), |r| r.get::<_, i64>(0))?)
    };
    Ok(value)
}
fn end_of_bucket(start: &str, g: Granularity) -> Result<String> {
    let date = NaiveDate::parse_from_str(start, "%Y-%m-%d")?;
    let end = match g {
        Granularity::Day => date + Duration::days(1),
        Granularity::Week => date + Duration::days(7),
        Granularity::Month => if date.month() == 12 {
            NaiveDate::from_ymd_opt(date.year() + 1, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
        }
        .ok_or_else(|| anyhow!("invalid_usage_date"))?,
    };
    Ok(end.format("%F").to_string())
}
fn series(conn: &Connection, f: &Filter, params: &Value) -> Result<Value> {
    let g_name = params
        .get("granularity")
        .and_then(Value::as_str)
        .unwrap_or("day");
    let g = time::parse_granularity(g_name)?;
    let week = time::parse_week_start(params.get("weekStart").and_then(Value::as_str))?;
    let stack = params
        .get("stack")
        .and_then(Value::as_str)
        .unwrap_or("provider");
    if !matches!(stack, "provider" | "tokens") {
        return Err(anyhow!("invalid_usage_stack"));
    }
    let bucket = match g {
        Granularity::Day => "local_day".to_owned(),
        Granularity::Month => "substr(local_day,1,7)||'-01'".into(),
        Granularity::Week => format!(
            "date(local_day,'-'||((CAST(strftime('%w',local_day) AS INTEGER)+7-{})%7)||' days')",
            week.num_days_from_sunday()
        ),
    };
    let fast = f.native.is_none() && projection_ready(conn)?;
    let (table, clause, args, select) = if fast {
        let (c, a) = totals_filter(f, if stack == "tokens" { 0 } else { 1 });
        (
            "usage_daily_cube".to_owned(),
            c,
            a,
            aggregate_select_without_sessions() + ",SUM(sessions)",
        )
    } else {
        (
            daily_source(f),
            f.clause(),
            f.values.clone(),
            aggregate_select(),
        )
    };
    let provider_column = if stack == "tokens" { "''" } else { "provider" };
    let mut st=conn.prepare(&format!("SELECT {bucket} AS bucket,{provider_column} AS provider,{select} FROM {table}{clause} GROUP BY bucket,provider ORDER BY bucket,provider"))?;
    let mut rows = st.query(params_from_iter(args))?;
    let mut map = BTreeMap::<String, (Aggregate, BTreeMap<String, Aggregate>)>::new();
    let mut keys = BTreeSet::new();
    while let Some(r) = rows.next()? {
        let day: String = r.get(0)?;
        let provider: String = r.get(1)?;
        let start = day;
        let a = read_aggregate(r, 2)?;
        let e = map.entry(start).or_default();
        e.0.merge(&a);
        e.1.entry(provider.clone()).or_default().merge(&a);
        keys.insert(provider);
    }
    if fast && !matches!(g, Granularity::Day) && super::membership::ready(conn) {
        let mut periods = Vec::new();
        for start in map.keys() {
            let low = f
                .from
                .as_ref()
                .map_or(start.clone(), |a| a.max(start).clone());
            let end = end_of_bucket(start, g)?;
            let high = f.to.as_ref().map_or(end.clone(), |b| b.min(&end).clone());
            periods.push((
                start.clone(),
                NaiveDate::parse_from_str(&low, "%Y-%m-%d")?.num_days_from_ce(),
                NaiveDate::parse_from_str(&high, "%Y-%m-%d")?.num_days_from_ce(),
            ));
        }
        let (mut clause, mut args) = slice_filter(f, false);
        if let Some(position) = clause.find(" AND ((first_day>=?") {
            clause.truncate(position);
            args.truncate(args.len() - 4);
        }
        let counts = super::membership::count_periods(conn, &clause, &args, &periods)?;
        for (start, (total, providers)) in &mut map {
            total.sessions = if stack == "tokens" {
                counts
                    .iter()
                    .filter(|((bucket, _), _)| bucket == start)
                    .map(|(_, value)| value)
                    .sum()
            } else {
                0
            };
            for (provider, value) in providers {
                value.sessions = *counts.get(&(start.clone(), provider.clone())).unwrap_or(&0);
                if stack != "tokens" {
                    total.sessions += value.sessions;
                }
            }
        }
    } else if fast && !matches!(g, Granularity::Day) {
        for (start, (total, providers)) in &mut map {
            let mut bucket_filter = f.clone();
            bucket_filter.from = Some(
                f.from
                    .as_ref()
                    .map_or(start.clone(), |a| a.max(start).clone()),
            );
            let end = end_of_bucket(start, g)?;
            bucket_filter.to = Some(f.to.as_ref().map_or(end.clone(), |b| b.min(&end).clone()));
            let counts = distinct_sessions(conn, &bucket_filter, Some("provider"))?;
            total.sessions = counts.values().sum();
            for (provider, value) in providers {
                value.sessions = *counts.get(provider).unwrap_or(&0);
            }
        }
    }
    if stack == "tokens" {
        keys = BUCKETS[..6].iter().map(|s| s.to_string()).collect();
    }
    let from = f.from.clone().or_else(|| map.keys().next().cloned());
    let to =
        f.to.clone()
            .or_else(|| map.keys().last().and_then(|s| end_of_bucket(s, g).ok()));
    if let (Some(from), Some(to)) = (&from, &to) {
        let mut day = time::bucket_start(from, g, week)?;
        let mut count = 0;
        while day < *to {
            map.entry(day.clone()).or_default();
            day = end_of_bucket(&day, g)?;
            count += 1;
            if count > 3660 {
                return Err(anyhow!("usage_series_range_too_large"));
            }
        }
    }
    let pending = pricing_pending(conn);
    let activity = activity_groups(conn, f, "provider", Some((g, week)))?;
    let mut points = Vec::new();
    for (start, (a, providers)) in map {
        let end = end_of_bucket(&start, g)?;
        let mut point = a.value(
            activity
                .get(&(start.clone(), String::new()))
                .map(Union::value)
                .unwrap_or((0, false)),
            pending,
        );
        point["start"] = json!(start);
        point["end"] = json!(end);
        let mut values = Vec::new();
        for key in &keys {
            if stack == "provider" {
                let p = providers.get(key).cloned().unwrap_or_default();
                values.push(json!({"key":key,"tokens":p.total(),"costUsd":if pending||p.priced_requests==0{Value::Null}else{json!(p.estimated_usd)},"requests":p.requests,"activeTimeMs":activity.get(&(start.clone(),key.clone())).map(Union::value).unwrap_or((0,false)).0}));
            } else {
                let i = BUCKETS.iter().position(|b| b == key).unwrap();
                values.push(json!({"key":key,"tokens":a.tokens[i],"costUsd":Value::Null,"requests":a.reported[i],"activeTimeMs":0}));
            }
        }
        point["values"] = json!(values);
        points.push(point);
    }
    Ok(json!({"from":f.from,"to":f.to,"granularity":g_name,"stack":stack,"points":points}))
}
fn breakdown(conn: &Connection, f: &Filter, params: &Value) -> Result<Value> {
    let d = params
        .get("dimension")
        .and_then(Value::as_str)
        .unwrap_or("provider");
    let col = match d {
        "provider" => "provider",
        "model" => "model",
        "project" => "project_id",
        _ => return Err(anyhow!("invalid_usage_dimension")),
    };
    let fast = f.native.is_none() && projection_ready(conn)?;
    let (table, clause, args, select) = if fast {
        let (c, a) = totals_filter(
            f,
            match d {
                "provider" => 1,
                "model" => 2,
                _ => 4,
            },
        );
        (
            "usage_daily_cube".to_owned(),
            c,
            a,
            aggregate_select_without_sessions() + ",0",
        )
    } else {
        (
            daily_source(f),
            f.clause(),
            f.values.clone(),
            aggregate_select(),
        )
    };
    let counts = if fast {
        distinct_sessions(conn, f, Some(d))?
    } else {
        BTreeMap::new()
    };
    let mut st=conn.prepare(&format!("SELECT {col},{select},MIN(provider),MAX(provider) FROM {table}{clause} GROUP BY {col} HAVING SUM(requests)>0 ORDER BY SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens) DESC"))?;
    let mut rows = st.query(params_from_iter(args))?;
    let pending = pricing_pending(conn);
    let activity = activity_groups(conn, f, d, None)?;
    let mut items = Vec::new();
    while let Some(r) = rows.next()? {
        let key: String = r.get(0)?;
        let mut a = read_aggregate(r, 1)?;
        if fast {
            a.sessions = *counts.get(&key).unwrap_or(&0);
        }
        let mut value = a.value(
            activity
                .get(&(String::new(), key.clone()))
                .map(Union::value)
                .unwrap_or((0, false)),
            pending,
        );
        let grok_unknown = if d != "model" || !key.is_empty() {
            false
        } else if f.provider.as_deref() == Some("grok") {
            true
        } else if f.provider.is_some() {
            false
        } else if fast {
            let mut unknown = f.clone();
            unknown.model = Some(String::new());
            unknown.add("model", "");
            let (clause, args) = totals_filter(&unknown, 1);
            let (low, high) = conn.query_row(
                &format!("SELECT MIN(provider),MAX(provider) FROM usage_daily_cube{clause}"),
                params_from_iter(args),
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            )?;
            low.as_deref() == Some("grok") && high.as_deref() == Some("grok")
        } else {
            let low = r.get::<_, Option<String>>(29)?;
            let high = r.get::<_, Option<String>>(30)?;
            low.as_deref() == Some("grok") && high.as_deref() == Some("grok")
        };
        let label = if d == "project" {
            conn.query_row("SELECT name FROM projects WHERE id=?", [&key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .unwrap_or_else(|| "Other folders".into())
        } else if key.is_empty() {
            if grok_unknown || f.provider.as_deref() == Some("grok") {
                "Grok — model not reported".into()
            } else {
                "Unknown model".into()
            }
        } else {
            key.clone()
        };
        value["key"] = json!(key);
        value["label"] = json!(label);
        if d == "project" && key.is_empty() {
            value["labelKey"] = json!("otherFolders");
        }
        if d == "model" && key.is_empty() {
            value["labelKey"] = json!(if grok_unknown || f.provider.as_deref() == Some("grok") {
                "grokModelNotReported"
            } else {
                "unknownModel"
            });
        }
        items.push(value);
    }
    Ok(json!({"dimension":d,"items":items}))
}
fn session_info(
    conn: &Connection,
    provider: &str,
    native: &str,
    mut value: Value,
) -> Result<Value> {
    let info:Option<(String,String,String,Option<String>,String,Option<String>,bool,i64,String,String,String)> = conn.prepare_cached("SELECT threadterm_session_id,project_id,project_name,cwd,scope,parent_native_session_id,subagent,subagent_count,models,first_occurred_at,last_occurred_at FROM usage_ledger_sessions WHERE provider=? AND native_session_id=?")?.query_row(params![provider,native],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional()?;
    value["provider"] = json!(provider);
    value["nativeSessionId"] = json!(native);
    if let Some((tt, pid, pname, cwd, scope, parent, subagent, count, models, first, last)) = info {
        value["threadtermSessionId"] = if tt.is_empty() {
            Value::Null
        } else {
            json!(tt)
        };
        value["projectId"] = if pid.is_empty() {
            Value::Null
        } else {
            json!(pid)
        };
        value["projectName"] = if pname.is_empty() {
            Value::Null
        } else {
            json!(pname)
        };
        value["cwd"] = json!(cwd);
        value["scope"] = json!(scope);
        value["parentNativeSessionId"] = json!(parent);
        value["subagent"] = json!(subagent);
        value["subagentCount"] = json!(count);
        if value.get("models").is_none() {
            value["models"] = serde_json::from_str(&models)?;
        }
        if value.get("firstOccurredAt").is_none() {
            value["firstOccurredAt"] = json!(first);
        }
        if value.get("lastOccurredAt").is_none() {
            value["lastOccurredAt"] = json!(last);
        }
    }
    Ok(value)
}
fn sessions(conn: &Connection, f: &Filter, params: &Value) -> Result<Value> {
    if !projection_ready(conn)? {
        return sessions_rows(conn, f, params);
    }
    let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let offset = params.get("offset").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=200).contains(&limit) || offset < 0 {
        return Err(anyhow!("invalid_usage_page"));
    }
    let sort = match params
        .get("sort")
        .and_then(Value::as_str)
        .unwrap_or("tokens")
    {
        "tokens" => "tokens",
        "cost" => "cost",
        "recent" => "last_at",
        "activeTime" => "active_ms",
        _ => return Err(anyhow!("invalid_usage_sort")),
    };
    let order = match params
        .get("order")
        .and_then(Value::as_str)
        .unwrap_or("desc")
    {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(anyhow!("invalid_usage_order")),
    };
    let profile = std::time::Instant::now();
    let (mut clause, mut args) = slice_filter(f, false);
    if let Some(search) = params
        .get("search")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if search.len() > 256 {
            return Err(anyhow!("invalid_usage_search"));
        }
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        clause.push_str(" AND (provider,native_session_id) IN(SELECT provider,native_session_id FROM usage_ledger_sessions WHERE provider LIKE ? ESCAPE '\\' OR native_session_id LIKE ? ESCAPE '\\' OR models LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\' OR threadterm_session_id IN(SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\'))");
        args.extend((0..6).map(|_| SqlValue::Text(pattern.clone())));
    }
    let low = f.from.as_deref().unwrap_or("");
    let high = f.to.as_deref().unwrap_or("9999-12-31");
    let full = format!("s.first_day>='{low}' AND s.last_day<'{high}'");
    let field = match sort {
        "tokens" => "tokens",
        "cost" => "cost",
        "last_at" => "last_at",
        _ => "active_ms",
    };
    let at_high=format!("(SELECT {field} FROM usage_session_prefix WHERE slice_id=s.id AND local_day<'{high}' ORDER BY local_day DESC LIMIT 1)");
    let at_low=format!("COALESCE((SELECT {field} FROM usage_session_prefix WHERE slice_id=s.id AND local_day<'{low}' ORDER BY local_day DESC LIMIT 1),0)");
    let scalar = if sort == "last_at" {
        format!("MAX(CASE WHEN {full} THEN s.last_at ELSE {at_high} END)")
    } else if sort == "active_ms" {
        "0".into()
    } else {
        format!("SUM(CASE WHEN {full} THEN s.{field} ELSE {at_high}-{at_low} END)")
    };
    // Only the requested sort coordinate is evaluated for the candidates. Rich
    // aggregates and interval unions are loaded for the selected page below.
    let ranged=format!("SELECT s.provider,s.native_session_id,{scalar} sort_value FROM usage_session_slices s INDEXED BY usage_slices_sort{clause} GROUP BY s.session_key");
    let (page, count) = if matches!(sort, "tokens" | "cost") && super::session_ranges::ready(conn) {
        let mut compact_clause = clause.clone();
        let mut compact_args = args.clone();
        if let Some(at) = compact_clause.rfind(" AND ((first_day>=?") {
            compact_clause.truncate(at);
            compact_args.truncate(
                compact_args.len()
                    - 4
                    - if params
                        .get("search")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                    {
                        6
                    } else {
                        0
                    },
            );
        }
        if let Some(at) = clause.find(" AND (provider,native_session_id) IN(") {
            compact_clause.push_str(&clause[at..]);
            compact_args.extend(args[args.len() - 6..].iter().cloned());
        }
        let field = if sort == "cost" { "costs" } else { "tokens" };
        let all_full = covers_history(conn, f)?;
        let range_table = if f.model.is_none() && super::session_ranges::default_ready(conn) {
            "usage_session_default_sort_ranges_packed"
        } else {
            "usage_session_sort_ranges"
        };
        let (join, blobs) = if all_full {
            (String::new(), "X'',X'',X''".to_owned())
        } else {
            (
                format!(" JOIN {range_table} r ON r.slice_id=s.id"),
                format!("r.days,r.{field},r.requests"),
            )
        };
        let sql = if all_full {
            format!("SELECT s.session_key,s.provider,s.native_session_id,s.first_day,s.last_day,s.{sort},{blobs} FROM usage_session_slices s INDEXED BY usage_slices_sort{join}{compact_clause}")
        } else {
            // Read compact arrays in slice order to avoid random page churn.
            format!("WITH candidates AS MATERIALIZED(SELECT s.id,s.session_key,s.provider,s.native_session_id,s.first_day,s.last_day,s.{sort} FROM usage_session_slices s INDEXED BY usage_slices_sort{compact_clause} ORDER BY s.id LIMIT -1) SELECT s.session_key,s.provider,s.native_session_id,s.first_day,s.last_day,s.{sort},X'',X'',X'' FROM candidates s WHERE {full} UNION ALL SELECT s.session_key,s.provider,s.native_session_id,s.first_day,s.last_day,s.{sort},{blobs} FROM candidates s CROSS JOIN {range_table} r ON r.slice_id=s.id WHERE NOT({full})")
        };
        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(compact_args))?;
        let bounds = super::session_ranges::RangeBounds::parse(f.from.as_deref(), f.to.as_deref())?;
        let mut candidates = BTreeMap::<i64, (String, String, i64, f64)>::new();
        while let Some(row) = rows.next()? {
            let first: String = row.get(3)?;
            let last: String = row.get(4)?;
            let fully_covered = first.as_str() >= low && last.as_str() < high;
            let (token_value, cost_value) = if fully_covered {
                if sort == "cost" {
                    (0, row.get::<_, f64>(5)?)
                } else {
                    (row.get::<_, i64>(5)?, 0.0)
                }
            } else {
                let days = row.get_ref(6)?.as_blob()?;
                let requests = row.get_ref(8)?.as_blob()?;
                if bounds.requests(days, requests)? == 0 {
                    continue;
                }
                if sort == "cost" {
                    (0, bounds.cost(days, row.get_ref(7)?.as_blob()?)?)
                } else {
                    (bounds.tokens(days, row.get_ref(7)?.as_blob()?)?, 0.0)
                }
            };
            let key = row.get::<_, i64>(0)?;
            if let Some(candidate) = candidates.get_mut(&key) {
                candidate.2 = candidate
                    .2
                    .checked_add(token_value)
                    .ok_or_else(|| anyhow!("usage_tokens_overflow"))?;
                candidate.3 += cost_value;
            } else {
                candidates.insert(key, (row.get(1)?, row.get(2)?, token_value, cost_value));
            }
        }
        let count = candidates.len() as i64;
        let mut candidates = candidates.into_values().collect::<Vec<_>>();
        candidates.sort_unstable_by(|a, b| {
            let value = if sort == "cost" {
                a.3.total_cmp(&b.3)
            } else {
                a.2.cmp(&b.2)
            };
            let value = if order == "DESC" {
                value.reverse()
            } else {
                value
            };
            value
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| a.1.cmp(&b.1))
        });
        let page = candidates
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .map(|(p, n, _, _)| (p, n, count))
            .collect::<Vec<_>>();
        (page, count)
    } else {
        let original_args = args.clone();
        let sql = if sort == "active_ms" {
            let (interval_clause, mut interval_args, low, high) = interval_filter(f)?;
            interval_args.extend(args);
            args = interval_args;
            format!("WITH clipped AS(SELECT provider,native_session_id,MAX(start_ms,{low}) start,MIN(end_ms,{high}) end FROM (SELECT *,0 AS mode FROM usage_intervals UNION ALL SELECT *,1 AS mode FROM usage_live_intervals){interval_clause}), ordered AS(SELECT *,MAX(end) OVER(PARTITION BY provider,native_session_id ORDER BY start,end ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior FROM clipped), activity AS(SELECT provider,native_session_id,SUM(MAX(0,end-MAX(start,COALESCE(prior,start)))) active_ms FROM ordered GROUP BY provider,native_session_id) SELECT b.provider,b.native_session_id,COUNT(*) OVER() total FROM({ranged}) b LEFT JOIN activity a USING(provider,native_session_id) ORDER BY COALESCE(a.active_ms,0) {order},b.provider,b.native_session_id LIMIT ? OFFSET ?")
        } else {
            format!("SELECT provider,native_session_id,COUNT(*) OVER() total FROM({ranged}) ORDER BY sort_value {order},provider,native_session_id LIMIT ? OFFSET ?")
        };
        args.extend([SqlValue::Integer(limit), SqlValue::Integer(offset)]);
        let mut st = conn.prepare(&sql)?;
        let page = st
            .query_map(params_from_iter(args), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let count = if let Some(row) = page.first() {
            row.2
        } else {
            conn.query_row(
                &format!("SELECT COUNT(DISTINCT session_key) FROM usage_session_slices s{clause}"),
                params_from_iter(original_args),
                |r| r.get::<_, i64>(0),
            )?
        };
        (page, count)
    };
    #[cfg(test)]
    if std::env::var_os("UA1R_PROFILE").is_some() {
        println!("PROFILE sessions_sort_us={}", profile.elapsed().as_micros());
    }
    if page.is_empty() {
        return Ok(json!({"total":count,"offset":offset,"limit":limit,"items":[]}));
    }
    let pending = pricing_pending(conn);
    let values = page
        .iter()
        .enumerate()
        .map(|(index, _)| format!("({index},?,?)"))
        .collect::<Vec<_>>()
        .join(",");
    let page_cte = format!("page(ordinal,provider,native_session_id) AS(VALUES{values})");
    let page_args = page
        .iter()
        .flat_map(|(provider, native, _)| {
            [
                SqlValue::Text(provider.clone()),
                SqlValue::Text(native.clone()),
            ]
        })
        .collect::<Vec<_>>();
    let clause = qualify_usage_clause(&f.clause());
    let selected = [0,1].map(|mode| {
        let table = if mode==0 { "usage_daily_rollups" } else { "usage_live_rollups" };
        format!("SELECT p.ordinal,r.* FROM page p CROSS JOIN(SELECT *,{mode} mode FROM {table}) r ON r.provider=p.provider AND r.native_session_id=p.native_session_id{clause}")
    }).join(" UNION ALL ");
    let sql = format!("WITH {page_cte},selected AS({selected}) SELECT ordinal,{},1,MIN(first_occurred_at),MAX(last_occurred_at),json_group_array(DISTINCT NULLIF(model,'')) FROM selected GROUP BY ordinal",aggregate_select_without_sessions());
    let mut aggregate_args = page_args.clone();
    aggregate_args.extend(f.values.clone());
    aggregate_args.extend(f.values.clone());
    let mut statement = conn.prepare(&sql)?;
    let mut aggregates = statement
        .query_map(params_from_iter(aggregate_args), |r| {
            Ok((
                r.get::<_, usize>(0)?,
                (
                    read_aggregate(r, 1)?,
                    r.get::<_, String>(29)?,
                    r.get::<_, String>(30)?,
                    r.get::<_, String>(31)?,
                ),
            ))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    drop(statement);
    let (interval_clause, interval_args, low_ms, high_ms) = interval_filter(f)?;
    let interval_clause = qualify_usage_clause(&interval_clause);
    let clipped = [0,1].map(|mode| {
        let table = if mode==0 { "usage_intervals" } else { "usage_live_intervals" };
        format!("SELECT p.ordinal,MAX(r.start_ms,{low_ms}) start,MIN(r.end_ms,{high_ms}) end,r.estimated FROM page p CROSS JOIN(SELECT *,{mode} mode FROM {table}) r ON r.provider=p.provider AND r.native_session_id=p.native_session_id{interval_clause}")
    }).join(" UNION ALL ");
    let sql = format!("WITH {page_cte},clipped AS({clipped}),ordered AS(SELECT *,MAX(end) OVER(PARTITION BY ordinal ORDER BY start,end ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior FROM clipped) SELECT ordinal,SUM(MAX(0,end-MAX(start,COALESCE(prior,start)))),MAX(estimated) FROM ordered GROUP BY ordinal");
    let mut active_args = page_args;
    active_args.extend(interval_args.clone());
    active_args.extend(interval_args);
    let mut statement = conn.prepare(&sql)?;
    let activity = statement
        .query_map(params_from_iter(active_args), |r| {
            Ok((
                r.get::<_, usize>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, bool>(2)?),
            ))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    drop(statement);
    let mut items = Vec::new();
    for (ordinal, (provider, native, _)) in page.into_iter().enumerate() {
        let (aggregate, first, last, models) = aggregates
            .remove(&ordinal)
            .ok_or_else(|| anyhow!("usage_projection_inconsistent"))?;
        let mut value = aggregate.value(
            activity.get(&ordinal).copied().unwrap_or((0, false)),
            pending,
        );
        let models: Vec<Option<String>> = serde_json::from_str(&models)?;
        value["firstOccurredAt"] = json!(first);
        value["lastOccurredAt"] = json!(last);
        value["models"] = json!(models.into_iter().flatten().collect::<Vec<_>>());
        items.push(session_info(conn, &provider, &native, value)?);
    }
    #[cfg(test)]
    if std::env::var_os("UA1R_PROFILE").is_some() {
        println!(
            "PROFILE sessions_total_us={}",
            profile.elapsed().as_micros()
        );
    }
    Ok(json!({"total":count,"offset":offset,"limit":limit,"items":items}))
}

fn qualify_usage_clause(clause: &str) -> String {
    let mut result = String::with_capacity(clause.len() + 32);
    let mut at = 0;
    while at < clause.len() {
        let byte = clause.as_bytes()[at];
        if byte.is_ascii_alphanumeric() || byte == b'_' {
            let start = at;
            while at < clause.len()
                && (clause.as_bytes()[at].is_ascii_alphanumeric() || clause.as_bytes()[at] == b'_')
            {
                at += 1;
            }
            let token = &clause[start..at];
            if matches!(
                token,
                "native_session_id"
                    | "project_id"
                    | "local_day"
                    | "provider"
                    | "model"
                    | "scope"
                    | "mode"
            ) {
                result.push_str("r.");
            }
            result.push_str(token);
        } else {
            let ch = clause[at..].chars().next().expect("valid SQL text");
            result.push(ch);
            at += ch.len_utf8();
        }
    }
    result
}

fn sessions_rows(conn: &Connection, f: &Filter, params: &Value) -> Result<Value> {
    let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let offset = params.get("offset").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=200).contains(&limit) || offset < 0 {
        return Err(anyhow!("invalid_usage_page"));
    }
    let sort = match params
        .get("sort")
        .and_then(Value::as_str)
        .unwrap_or("tokens")
    {
        "tokens" => "tokens",
        "cost" => "cost",
        "recent" => "last_at",
        "activeTime" => "active_ms",
        _ => return Err(anyhow!("invalid_usage_sort")),
    };
    let order = match params
        .get("order")
        .and_then(Value::as_str)
        .unwrap_or("desc")
    {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(anyhow!("invalid_usage_order")),
    };
    let mut local = f.clone();
    if let Some(search) = params
        .get("search")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if search.len() > 256 {
            return Err(anyhow!("invalid_usage_search"));
        }
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        local.terms.push("(provider,native_session_id) IN (SELECT provider,native_session_id FROM usage_ledger_sessions WHERE provider LIKE ? ESCAPE '\\' OR native_session_id LIKE ? ESCAPE '\\' OR models LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\' OR threadterm_session_id IN (SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\'))".into());
        for _ in 0..6 {
            local.values.push(SqlValue::Text(pattern.clone()));
        }
    }
    let base=format!("SELECT provider,native_session_id,SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens) tokens,SUM(estimated_cost) cost,MAX(last_occurred_at) last_at,MIN(first_occurred_at) first_at,json_group_array(DISTINCT model) models,{} FROM {}{} GROUP BY provider,native_session_id",aggregate_select(),daily_source(&local),local.clause());
    let count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM ({base})"),
        params_from_iter(local.values.iter()),
        |r| r.get(0),
    )?;
    let (sql, mut args) = if sort == "active_ms" {
        let (clause, mut args, low, high) = interval_filter(f)?;
        // Running prior maximum handles nesting and overlapping model intervals.
        let sql=format!("WITH clipped AS (SELECT provider,native_session_id,MAX(start_ms,{low}) start,MIN(end_ms,{high}) end FROM (SELECT *,0 AS mode FROM usage_intervals UNION ALL SELECT *,1 AS mode FROM usage_live_intervals){clause}), ordered AS (SELECT *,MAX(end) OVER(PARTITION BY provider,native_session_id ORDER BY start,end ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior FROM clipped), activity AS (SELECT provider,native_session_id,SUM(MAX(0,end-MAX(start,COALESCE(prior,start)))) active_ms FROM ordered GROUP BY provider,native_session_id) SELECT b.*,COALESCE(a.active_ms,0) active_ms FROM ({base}) b LEFT JOIN activity a USING(provider,native_session_id) ORDER BY active_ms {order},provider,native_session_id LIMIT ? OFFSET ?");
        args.extend(local.values.clone());
        (sql, args)
    } else {
        (format!("SELECT b.*,0 active_ms FROM ({base}) b ORDER BY {sort} {order},provider,native_session_id LIMIT ? OFFSET ?"),local.values.clone())
    };
    args.push(SqlValue::Integer(limit));
    args.push(SqlValue::Integer(offset));
    let mut st = conn.prepare(&sql)?;
    let mut rows = st.query(params_from_iter(args))?;
    let mut items = Vec::new();
    let pending = pricing_pending(conn);
    while let Some(r) = rows.next()? {
        let provider: String = r.get(0)?;
        let native: String = r.get(1)?;
        let a = read_aggregate(r, 7)?;
        let mut sf = f.clone();
        sf.provider = Some(provider.clone());
        sf.native = Some(native.clone());
        let mut value = a.value(active(conn, &sf)?, pending);
        let models: Vec<String> = serde_json::from_str(&r.get::<_, String>(6)?)?;
        value["models"] = json!(models
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>());
        value["firstOccurredAt"] = json!(r.get::<_, String>(5)?);
        value["lastOccurredAt"] = json!(r.get::<_, String>(4)?);
        items.push(session_info(conn, &provider, &native, value)?);
    }
    Ok(json!({"total":count,"offset":offset,"limit":limit,"items":items}))
}
fn session(conn: &Connection, f: &Filter, params: &Value) -> Result<Value> {
    let provider = params
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("usage_provider_required"))?;
    let native = params
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("usage_native_session_required"))?;
    let mut sf = f.clone();
    sf.provider = Some(provider.into());
    sf.native = Some(native.into());
    sf.add("provider", provider);
    sf.add("native_session_id", native);
    let mut result = sessions(conn, &sf, &json!({"limit":1}))?["items"]
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);
    if result.is_null() {
        return Ok(result);
    }
    result["days"]=series(conn,&sf,&json!({"granularity":"day","stack":"provider","weekStart":params.get("weekStart").and_then(Value::as_str).unwrap_or("auto")}))?["points"].clone();
    let mut statement=conn.prepare("SELECT native_session_id FROM usage_ledger_sessions WHERE provider=? AND parent_native_session_id=? AND subagent=1 ORDER BY first_occurred_at")?;
    let children: Vec<String> = statement
        .query_map(params![provider, native], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut subagents = Vec::new();
    for child in children.into_iter().take(200) {
        let mut cf = f.clone();
        // A direct session request can carry the parent's native filter. A
        // child needs the same range/scope filters but its own native identity.
        if let Some(position) = cf
            .terms
            .iter()
            .position(|term| term == "native_session_id=?")
        {
            cf.terms.remove(position);
            cf.values.remove(position);
        }
        cf.provider = Some(provider.into());
        cf.native = Some(child.clone());
        cf.add("provider", provider);
        cf.add("native_session_id", &child);
        let value = aggregate(conn, &cf)?.value(active(conn, &cf)?, pricing_pending(conn));
        subagents.push(session_info(conn, provider, &child, value)?);
    }
    result["subagents"] = json!(subagents);
    Ok(result)
}
