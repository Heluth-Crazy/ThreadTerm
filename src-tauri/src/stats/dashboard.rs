//! Source-aware statistics queries.
//!
//! The legacy aggregator remains the compatibility path for card badges. This
//! module implements the richer cc-switch-style view: proxy and session-log
//! rows are reconciled, success/cache metrics are derived consistently, and
//! trends, breakdowns, and request logs are returned from one snapshot.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Local, Utc};
use rusqlite::{params, Connection};

use crate::stats::pricing::{self, ModelCosts};
use crate::stats::types::{
    StatsBreakdown, StatsDashboard, StatsDashboardFilters, StatsOverview, StatsRequestLog,
    StatsTrendPoint, UsageSummary,
};

const CROSS_SOURCE_DEDUP_WINDOW_SECS: i64 = 10 * 60;
const DEFAULT_REQUEST_LIMIT: usize = 100;
const MAX_REQUEST_LIMIT: usize = 500;

#[derive(Clone, Debug)]
struct StoredRecord {
    request_id: String,
    provider: String,
    app_type: String,
    model: String,
    request_model: String,
    pricing_model: String,
    input_semantics: String,
    usage: UsageSummary,
    stored_cost_usd: f64,
    status_code: Option<i64>,
    error: Option<String>,
    latency_ms: Option<u64>,
    first_token_ms: Option<u64>,
    duration_ms: Option<u64>,
    streaming: bool,
    session_id: Option<String>,
    project_path: Option<String>,
    created_at: i64,
    data_source: String,
    pricing_status: String,
}

impl StoredRecord {
    fn is_proxy(&self) -> bool {
        self.data_source.eq_ignore_ascii_case("proxy")
    }

    fn is_session_log(&self) -> bool {
        !self.is_proxy()
    }

    fn success(&self) -> bool {
        match self.status_code {
            Some(status) if self.is_proxy() => (200..=299).contains(&status),
            Some(status) => (200..=299).contains(&status),
            None => self.is_session_log(),
        }
    }

    fn normalized_usage(&self) -> UsageSummary {
        if self.input_semantics.eq_ignore_ascii_case("includes_cache") {
            UsageSummary {
                input: self.usage.input.saturating_sub(self.usage.cache_read),
                ..self.usage
            }
        } else {
            self.usage
        }
    }

    fn normalized_model(&self) -> String {
        let candidate = if self.pricing_model.trim().is_empty() {
            if self.model.trim().is_empty() {
                "unknown"
            } else {
                self.model.as_str()
            }
        } else {
            self.pricing_model.as_str()
        };
        pricing::canonical_model(candidate)
    }

    fn normalized_provider(&self) -> String {
        match self.provider.to_ascii_lowercase().as_str() {
            "anthropic" => "claude".to_string(),
            "openai" => "codex".to_string(),
            "xai" => "grok".to_string(),
            provider => provider.to_string(),
        }
    }

    fn normalized_app_type(&self) -> String {
        let app_type = self.app_type.trim().to_ascii_lowercase();
        if app_type.is_empty() || app_type == "cli" {
            self.normalized_provider()
        } else {
            app_type
        }
    }

    fn display_model(&self) -> String {
        if !self.request_model.trim().is_empty() {
            return self.request_model.clone();
        }
        if !self.model.trim().is_empty() {
            return self.model.clone();
        }
        "unknown".to_string()
    }

    fn cost_usd(&self, overrides: &HashMap<String, ModelCosts>) -> f64 {
        let usage = self.normalized_usage();
        let model = if self.pricing_model.trim().is_empty() {
            &self.model
        } else {
            &self.pricing_model
        };
        let costs = pricing::lookup_with_overrides(model, overrides);
        if costs.is_some() {
            pricing::cost_breakdown_with_rates(costs, &usage).total
        } else {
            self.stored_cost_usd
        }
    }

    fn pricing_status(&self, overrides: &HashMap<String, ModelCosts>) -> String {
        let model = if self.pricing_model.trim().is_empty() {
            &self.model
        } else {
            &self.pricing_model
        };
        let canonical = pricing::canonical_model(model);
        if overrides.contains_key(&canonical) {
            "custom".to_string()
        } else if pricing::lookup(&canonical).is_some() {
            "builtin".to_string()
        } else if self.pricing_status.eq_ignore_ascii_case("reported") || self.stored_cost_usd > 0.0
        {
            "reported".to_string()
        } else {
            "unpriced".to_string()
        }
    }
}

#[derive(Default)]
struct Accumulator {
    usage: UsageSummary,
    cost_usd: f64,
    calls: u64,
    success_calls: u64,
    failure_calls: u64,
    unpriced_calls: u64,
}

impl Accumulator {
    fn add(&mut self, record: &StoredRecord, overrides: &HashMap<String, ModelCosts>) {
        let usage = record.normalized_usage();
        self.usage.add(&usage);
        self.cost_usd += record.cost_usd(overrides);
        self.calls += 1;
        if record.pricing_status(overrides) == "unpriced" {
            self.unpriced_calls += 1;
        }
        if record.success() {
            self.success_calls += 1;
        } else {
            self.failure_calls += 1;
        }
    }

    fn real_total_tokens(&self) -> u64 {
        self.usage.total()
    }

    fn cache_hit_rate(&self) -> f64 {
        let denominator = self
            .usage
            .input
            .saturating_add(self.usage.cache_creation)
            .saturating_add(self.usage.cache_read);
        if denominator == 0 {
            0.0
        } else {
            self.usage.cache_read as f64 / denominator as f64
        }
    }
}

/// Read and reconcile usage rows for the requested time window.
pub fn dashboard_from_db(
    conn: &Connection,
    scope: &str,
    lo_ms: Option<u64>,
    hi_ms: Option<u64>,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> rusqlite::Result<StatsDashboard> {
    dashboard_from_db_with_filters(
        conn,
        scope,
        lo_ms,
        hi_ms,
        limit,
        cursor,
        &StatsDashboardFilters::default(),
    )
}

const UNASSIGNED_PROJECT_FILTER: &str = "__unassigned__";

/// Source-aware dashboard query with optional app/model/status/source/project
/// filters.
/// Filtering happens before cross-source reconciliation so a filtered view
/// cannot accidentally suppress a row that is outside the requested source.
pub fn dashboard_from_db_with_filters(
    conn: &Connection,
    scope: &str,
    lo_ms: Option<u64>,
    hi_ms: Option<u64>,
    limit: Option<usize>,
    cursor: Option<&str>,
    filters: &StatsDashboardFilters,
) -> rusqlite::Result<StatsDashboard> {
    let lo = lo_ms.map(|ms| (ms / 1000) as i64).unwrap_or(0);
    let hi = hi_ms.map(|ms| (ms / 1000) as i64).unwrap_or(i64::MAX);
    let limit = limit
        .unwrap_or(DEFAULT_REQUEST_LIMIT)
        .clamp(1, MAX_REQUEST_LIMIT);
    let cursor_position = cursor.and_then(parse_cursor);
    let overrides = load_pricing_overrides(conn)?;
    // Load the complete filtered source set before reconciling. The detail
    // cursor must never change overview/trend/breakdown totals; applying it in
    // SQL would also allow a session row to escape a proxy/session match at a
    // page boundary.
    let mut records = load_records(conn, scope, lo, hi, None)?;
    records.retain(|record| matches_filters(record, filters));
    let records = reconcile_cross_source(records.as_mut_slice());

    let mut overview_acc = Accumulator::default();
    let mut by_provider: HashMap<String, Accumulator> = HashMap::new();
    let mut by_model: HashMap<String, Accumulator> = HashMap::new();
    let mut trends: HashMap<i64, Accumulator> = HashMap::new();
    let mut sessions = HashSet::new();
    let mut proxy_count = 0u64;
    let mut session_log_count = 0u64;

    for record in &records {
        overview_acc.add(record, &overrides);
        let provider = if record.provider.trim().is_empty() {
            "unknown".to_string()
        } else {
            record.normalized_provider()
        };
        by_provider
            .entry(provider)
            .or_default()
            .add(record, &overrides);
        by_model
            .entry(record.normalized_model())
            .or_default()
            .add(record, &overrides);

        let period_start = local_day_start_secs(record.created_at);
        trends
            .entry(period_start)
            .or_default()
            .add(record, &overrides);
        if let Some(session_id) = record.session_id.as_deref() {
            if !session_id.trim().is_empty() {
                sessions.insert(session_id.to_string());
            }
        }
        if record.is_proxy() {
            proxy_count += 1;
        } else {
            session_log_count += 1;
        }
    }

    let mut request_logs = records
        .iter()
        .filter(|record| {
            cursor_position
                .as_ref()
                .map(|(created_at, request_id)| {
                    record.created_at < *created_at
                        || (record.created_at == *created_at
                            && record.request_id.as_str() < request_id.as_str())
                })
                .unwrap_or(true)
        })
        .map(|record| to_request_log(record, &overrides))
        .collect::<Vec<_>>();
    let next_cursor = if request_logs.len() > limit {
        request_logs.truncate(limit);
        request_logs
            .last()
            .map(|row| format!("{}:{}", row.created_at, row.request_id))
    } else {
        None
    };

    let total_calls = overview_acc.calls;
    let overview = StatsOverview {
        request_count: total_calls,
        success_count: overview_acc.success_calls,
        failure_count: overview_acc.failure_calls,
        total_tokens: overview_acc.real_total_tokens(),
        real_total_tokens: overview_acc.real_total_tokens(),
        input_tokens: overview_acc.usage.input,
        output_tokens: overview_acc.usage.output,
        cache_creation_tokens: overview_acc.usage.cache_creation,
        cache_read_tokens: overview_acc.usage.cache_read,
        cache_hit_rate: overview_acc.cache_hit_rate(),
        success_rate: ratio(overview_acc.success_calls, total_calls),
        total_cost_usd: overview_acc.cost_usd,
        unpriced_request_count: overview_acc.unpriced_calls,
        session_count: sessions.len() as u64,
        proxy_request_count: proxy_count,
        session_log_request_count: session_log_count,
    };

    Ok(StatsDashboard {
        overview,
        trends: sorted_trends(trends),
        by_provider: sorted_breakdowns(by_provider, &overrides),
        by_model: sorted_breakdowns(by_model, &overrides),
        request_logs,
        next_cursor,
        pricing_version: pricing::BUILTIN_PRICING_VERSION.to_string(),
    })
}

fn matches_filters(record: &StoredRecord, filters: &StatsDashboardFilters) -> bool {
    if let Some(app_type) = filters
        .app_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
    {
        if record.normalized_app_type() != app_type.to_ascii_lowercase() {
            return false;
        }
    }

    if let Some(model) = filters
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
    {
        if record.normalized_model() != pricing::canonical_model(model) {
            return false;
        }
    }

    if let Some(status) = filters
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
    {
        let wanted_success = match status.to_ascii_lowercase().as_str() {
            "success" | "succeeded" => true,
            "failure" | "failed" | "error" => false,
            _ => return false,
        };
        if record.success() != wanted_success {
            return false;
        }
    }

    if let Some(source) = filters
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
    {
        let wanted_proxy = match source.to_ascii_lowercase().as_str() {
            "proxy" => true,
            "session_log" | "session-log" | "session" | "direct" => false,
            _ => return false,
        };
        if record.is_proxy() != wanted_proxy {
            return false;
        }
    }

    if let Some(project_path) = filters
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
    {
        if project_path.eq_ignore_ascii_case(UNASSIGNED_PROJECT_FILTER) {
            if record
                .project_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
            {
                return false;
            }
        } else {
            let wanted = normalize_project_path(project_path);
            if wanted.is_empty()
                || record
                    .project_path
                    .as_deref()
                    .map(normalize_project_path)
                    .as_deref()
                    != Some(wanted.as_str())
            {
                return false;
            }
        }
    }

    true
}

/// Project paths come from several providers and may use different slash or
/// casing conventions on Windows. Keep the stored value untouched for
/// display, but compare a stable form for filtering and reconciliation.
fn normalize_project_path(path: &str) -> String {
    let mut normalized = if cfg!(target_os = "windows") {
        path.trim().replace('/', "\\").to_ascii_lowercase()
    } else {
        path.trim().replace('\\', "/")
    };
    let minimum_length = if cfg!(target_os = "windows") { 3 } else { 1 };
    while normalized.len() > minimum_length && normalized.ends_with(['/', '\\']) {
        normalized.pop();
    }
    normalized
}

/// Parse the current composite cursor and the legacy timestamp-only cursor.
/// Request IDs are allowed to contain `:`, so only the first separator is
/// significant.
fn parse_cursor(value: &str) -> Option<(i64, String)> {
    if let Some((created_at, request_id)) = value.split_once(':') {
        return Some((created_at.parse().ok()?, request_id.to_string()));
    }
    value
        .parse()
        .ok()
        .map(|created_at| (created_at, String::new()))
}

fn load_records(
    conn: &Connection,
    scope: &str,
    lo: i64,
    hi: i64,
    cursor: Option<i64>,
) -> rusqlite::Result<Vec<StoredRecord>> {
    let scope_filter = matches!(scope, "claude" | "codex" | "opencode" | "gemini" | "grok");
    let cursor_filter = cursor.is_some();
    let mut sql = String::from(
        "SELECT request_id, provider, app_type, model, request_model, pricing_model,
                input_semantics, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, total_cost_usd, status_code, error, latency_ms,
                first_token_ms, duration_ms, streaming, session_id, project_path,
                created_at, data_source, pricing_status
         FROM usage_records
         WHERE created_at >= ?1 AND created_at <= ?2",
    );
    if scope_filter {
        sql.push_str(
            " AND (lower(provider) = lower(?3)
                OR (?3 = 'claude' AND lower(provider) = 'anthropic')
                OR (?3 = 'codex' AND lower(provider) = 'openai')
                OR (?3 = 'grok' AND lower(provider) = 'xai'))",
        );
    }
    if cursor_filter {
        sql.push_str(if scope_filter {
            " AND created_at < ?4"
        } else {
            " AND created_at < ?3"
        });
    }
    sql.push_str(" ORDER BY created_at DESC, request_id DESC");

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = if scope_filter {
        if let Some(cursor) = cursor {
            stmt.query(params![lo, hi, scope, cursor])?
        } else {
            stmt.query(params![lo, hi, scope])?
        }
    } else if let Some(cursor) = cursor {
        stmt.query(params![lo, hi, cursor])?
    } else {
        stmt.query(params![lo, hi])?
    };

    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let input: i64 = row.get(7)?;
        let output: i64 = row.get(8)?;
        let cache_read: i64 = row.get(9)?;
        let cache_creation: i64 = row.get(10)?;
        records.push(StoredRecord {
            request_id: row.get(0)?,
            provider: row.get(1)?,
            app_type: row.get(2)?,
            model: row.get(3)?,
            request_model: row.get(4)?,
            pricing_model: row.get(5)?,
            input_semantics: row.get(6)?,
            usage: UsageSummary {
                input: non_negative(input),
                output: non_negative(output),
                cache_read: non_negative(cache_read),
                cache_creation: non_negative(cache_creation),
            },
            stored_cost_usd: row.get(11)?,
            status_code: row.get(12)?,
            error: row.get(13)?,
            latency_ms: non_negative_opt(row.get(14)?),
            first_token_ms: non_negative_opt(row.get(15)?),
            duration_ms: non_negative_opt(row.get(16)?),
            streaming: row.get::<_, i64>(17)? != 0,
            session_id: row.get(18)?,
            project_path: row.get(19)?,
            created_at: row.get(20)?,
            data_source: row.get(21)?,
            pricing_status: row.get(22)?,
        });
    }
    Ok(records)
}

fn load_pricing_overrides(conn: &Connection) -> rusqlite::Result<HashMap<String, ModelCosts>> {
    let mut stmt = conn.prepare(
        "SELECT model, input_per_mtok, output_per_mtok,
                cache_write_per_mtok, cache_read_per_mtok
         FROM stats_pricing WHERE enabled = 1",
    )?;
    let mut rows = stmt.query([])?;
    let mut overrides = HashMap::new();
    while let Some(row) = rows.next()? {
        let model: String = row.get(0)?;
        overrides.insert(
            pricing::canonical_model(&model),
            ModelCosts {
                input: row.get::<_, f64>(1)? / 1e6,
                output: row.get::<_, f64>(2)? / 1e6,
                cache_write: row.get::<_, f64>(3)? / 1e6,
                cache_read: row.get::<_, f64>(4)? / 1e6,
            },
        );
    }
    Ok(overrides)
}

fn reconcile_cross_source(records: &mut [StoredRecord]) -> Vec<StoredRecord> {
    let proxy_rows = records
        .iter()
        .filter(|record| record.is_proxy() && record.success())
        .cloned()
        .collect::<Vec<_>>();
    records
        .iter()
        .filter(|record| {
            if !record.is_session_log() {
                return true;
            }
            !proxy_rows
                .iter()
                .any(|proxy| matches_cross_source(proxy, record))
        })
        .cloned()
        .collect()
}

fn matches_cross_source(proxy: &StoredRecord, session: &StoredRecord) -> bool {
    if proxy.normalized_provider() != session.normalized_provider()
        || proxy.normalized_app_type() != session.normalized_app_type()
        || proxy.normalized_model() != session.normalized_model()
    {
        return false;
    }
    if let (Some(proxy_path), Some(session_path)) = (
        proxy
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty()),
        session
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty()),
    ) {
        if normalize_project_path(proxy_path) != normalize_project_path(session_path) {
            return false;
        }
    }
    let proxy_usage = proxy.normalized_usage();
    let session_usage = session.normalized_usage();
    proxy_usage.input == session_usage.input
        && proxy_usage.output == session_usage.output
        && proxy_usage.cache_creation == session_usage.cache_creation
        && proxy_usage.cache_read == session_usage.cache_read
        && (proxy.created_at - session.created_at).abs() <= CROSS_SOURCE_DEDUP_WINDOW_SECS
}

fn to_request_log(
    record: &StoredRecord,
    overrides: &HashMap<String, ModelCosts>,
) -> StatsRequestLog {
    let usage = record.normalized_usage();
    StatsRequestLog {
        request_id: record.request_id.clone(),
        provider: record.normalized_provider(),
        app_type: record.normalized_app_type(),
        model: record.display_model(),
        request_model: record.request_model.clone(),
        pricing_model: if record.pricing_model.is_empty() {
            record.model.clone()
        } else {
            record.pricing_model.clone()
        },
        total_tokens: usage.total(),
        real_total_tokens: usage.total(),
        cost_usd: record.cost_usd(overrides),
        pricing_status: record.pricing_status(overrides),
        usage,
        status_code: record.status_code,
        success: record.success(),
        error: record.error.clone(),
        latency_ms: record.latency_ms,
        first_token_ms: record.first_token_ms,
        duration_ms: record.duration_ms,
        streaming: record.streaming,
        session_id: record.session_id.clone(),
        project_path: record.project_path.clone(),
        data_source: record.data_source.clone(),
        created_at: record.created_at,
    }
}

fn sorted_breakdowns(
    map: HashMap<String, Accumulator>,
    overrides: &HashMap<String, ModelCosts>,
) -> Vec<StatsBreakdown> {
    let mut values = map
        .into_iter()
        .map(|(key, bucket)| StatsBreakdown {
            label: key.clone(),
            provider: key.clone(),
            usage: bucket.usage,
            total_tokens: bucket.usage.total(),
            real_total_tokens: bucket.real_total_tokens(),
            cost_usd: bucket.cost_usd,
            calls: bucket.calls,
            success_calls: bucket.success_calls,
            failure_calls: bucket.failure_calls,
            unpriced_calls: bucket.unpriced_calls,
            cache_hit_rate: bucket.cache_hit_rate(),
            key,
        })
        .collect::<Vec<_>>();
    let _ = overrides;
    values.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.total_tokens.cmp(&a.total_tokens))
    });
    values
}

fn sorted_trends(map: HashMap<i64, Accumulator>) -> Vec<StatsTrendPoint> {
    let mut values = map
        .into_iter()
        .map(|(period_start, bucket)| StatsTrendPoint {
            period_start,
            request_count: bucket.calls,
            success_count: bucket.success_calls,
            total_tokens: bucket.usage.total(),
            real_total_tokens: bucket.real_total_tokens(),
            cost_usd: bucket.cost_usd,
        })
        .collect::<Vec<_>>();
    values.sort_by_key(|point| point.period_start);
    values
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn local_day_start_secs(timestamp_secs: i64) -> i64 {
    DateTime::<Utc>::from_timestamp(timestamp_secs, 0)
        .and_then(|timestamp| {
            timestamp
                .with_timezone(&Local)
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|midnight| midnight.and_local_timezone(Local).single())
        })
        .map(|midnight| midnight.timestamp())
        .unwrap_or_else(|| timestamp_secs.div_euclid(86_400) * 86_400)
}

fn non_negative(value: i64) -> u64 {
    value.max(0) as u64
}

fn non_negative_opt(value: Option<i64>) -> Option<u64> {
    value.map(non_negative)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE usage_records (
                request_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0,
                session_id TEXT,
                project_path TEXT,
                created_at INTEGER NOT NULL,
                data_source TEXT NOT NULL DEFAULT 'session_log',
                app_type TEXT NOT NULL DEFAULT 'cli',
                request_model TEXT NOT NULL DEFAULT '',
                pricing_model TEXT NOT NULL DEFAULT '',
                input_semantics TEXT NOT NULL DEFAULT 'uncached',
                status_code INTEGER,
                error TEXT,
                latency_ms INTEGER,
                first_token_ms INTEGER,
                duration_ms INTEGER,
                streaming INTEGER NOT NULL DEFAULT 0,
                pricing_status TEXT NOT NULL DEFAULT 'estimated'
            );
            CREATE TABLE stats_pricing (
                model TEXT PRIMARY KEY,
                input_per_mtok REAL NOT NULL,
                output_per_mtok REAL NOT NULL,
                cache_write_per_mtok REAL NOT NULL DEFAULT 0,
                cache_read_per_mtok REAL NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
    }

    #[test]
    fn successful_proxy_row_replaces_matching_session_row() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        let insert = "INSERT INTO usage_records
            (request_id, provider, model, input_tokens, output_tokens,
             cache_read_tokens, created_at, data_source, status_code)
            VALUES (?1, 'claude', 'claude-opus-4-8', 90, 10, 20, 1000, ?2, ?3)";
        conn.execute(
            insert,
            params!["session-1", "session_log", Option::<i64>::None],
        )
        .unwrap();
        conn.execute(insert, params!["proxy-1", "proxy", 200i64])
            .unwrap();

        let dashboard = dashboard_from_db(&conn, "all", None, None, None, None).unwrap();
        assert_eq!(dashboard.overview.request_count, 1);
        assert_eq!(dashboard.overview.proxy_request_count, 1);
        assert_eq!(dashboard.overview.success_count, 1);
    }

    #[test]
    fn failed_proxy_does_not_hide_session_usage() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, model, input_tokens, output_tokens,
              created_at, data_source, status_code)
             VALUES ('proxy-1', 'codex', 'gpt-5.2-codex', 100, 10, 1000, 'proxy', 500)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, model, input_tokens, output_tokens,
              created_at, data_source)
             VALUES ('session-1', 'codex', 'gpt-5.2-codex', 100, 10, 1001, 'session_log')",
            [],
        )
        .unwrap();
        let dashboard = dashboard_from_db(&conn, "all", None, None, None, None).unwrap();
        assert_eq!(dashboard.overview.request_count, 2);
        assert_eq!(dashboard.overview.failure_count, 1);
    }

    #[test]
    fn unknown_models_are_visible_as_unpriced_and_provider_aliases_filter() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, model, input_tokens, created_at, data_source)
             VALUES ('session-1', 'anthropic', 'future-model', 42, 1000, 'session_log')",
            [],
        )
        .unwrap();

        let all = dashboard_from_db(&conn, "all", None, None, None, None).unwrap();
        assert_eq!(all.overview.unpriced_request_count, 1);
        assert_eq!(all.request_logs[0].pricing_status, "unpriced");

        let claude = dashboard_from_db(&conn, "claude", None, None, None, None).unwrap();
        assert_eq!(claude.overview.request_count, 1);
        assert_eq!(claude.request_logs[0].provider, "claude");
    }

    #[test]
    fn detail_pagination_does_not_change_aggregate_totals() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        for (id, created_at, input) in [("older", 1000, 10), ("newer", 1000, 20)] {
            conn.execute(
                "INSERT INTO usage_records
                 (request_id, provider, model, input_tokens, created_at, data_source)
                 VALUES (?1, 'claude', 'claude-opus-4-8', ?2, ?3, 'session_log')",
                params![id, input, created_at],
            )
            .unwrap();
        }

        let first_page = dashboard_from_db(&conn, "all", None, None, Some(1), None).unwrap();
        assert_eq!(first_page.overview.request_count, 2);
        assert_eq!(first_page.overview.input_tokens, 30);
        assert_eq!(first_page.request_logs.len(), 1);
        let cursor = first_page.next_cursor.as_deref().expect("next cursor");

        let second_page =
            dashboard_from_db(&conn, "all", None, None, Some(1), Some(cursor)).unwrap();
        assert_eq!(second_page.overview.request_count, 2);
        assert_eq!(second_page.overview.input_tokens, 30);
        assert_eq!(second_page.request_logs.len(), 1);
        assert!(second_page.next_cursor.is_none());
    }

    #[test]
    fn combined_dashboard_filters_apply_before_reconciliation() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, app_type, model, input_tokens, created_at, data_source)
             VALUES ('session-1', 'claude', 'claude', 'claude-opus-4-8', 10, 1000, 'session_log')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, app_type, model, input_tokens, created_at,
              data_source, status_code)
             VALUES ('proxy-1', 'codex', 'codex', 'gpt-5.2-codex', 20, 1001, 'proxy', 502)",
            [],
        )
        .unwrap();

        let filters = StatsDashboardFilters {
            app_type: Some("codex".to_string()),
            model: Some("gpt-5.2-codex".to_string()),
            status: Some("failure".to_string()),
            source: Some("proxy".to_string()),
            project_path: None,
        };
        let dashboard =
            dashboard_from_db_with_filters(&conn, "all", None, None, None, None, &filters).unwrap();
        assert_eq!(dashboard.overview.request_count, 1);
        assert_eq!(dashboard.overview.failure_count, 1);
        assert_eq!(dashboard.request_logs[0].request_id, "proxy-1");
    }

    #[test]
    fn project_filter_preserves_historical_paths_and_is_case_insensitive_on_windows() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        let first_project_path = if cfg!(target_os = "windows") {
            "D:/Repo/One/"
        } else {
            "/repo/one/"
        };
        let project_filter = if cfg!(target_os = "windows") {
            "d:\\REPO\\ONE"
        } else {
            "/repo/one"
        };
        for (request_id, project_path, input) in [
            ("one", Some(first_project_path), 10),
            ("two", Some("D:\\repo\\two"), 20),
            ("unknown", None, 30),
        ] {
            conn.execute(
                "INSERT INTO usage_records
                 (request_id, provider, model, input_tokens, project_path, created_at, data_source)
                 VALUES (?1, 'claude', 'claude-opus-4-8', ?2, ?3, 1000, 'session_log')",
                params![request_id, input, project_path],
            )
            .unwrap();
        }

        let filters = StatsDashboardFilters {
            project_path: Some(project_filter.to_string()),
            ..Default::default()
        };
        let dashboard =
            dashboard_from_db_with_filters(&conn, "all", None, None, None, None, &filters).unwrap();
        assert_eq!(dashboard.overview.request_count, 1);
        assert_eq!(dashboard.request_logs[0].request_id, "one");
        assert_eq!(
            dashboard.request_logs[0].project_path.as_deref(),
            Some(first_project_path)
        );
    }

    #[test]
    fn unassigned_project_filter_keeps_legacy_rows_without_paths() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, model, input_tokens, created_at, data_source)
             VALUES ('legacy', 'claude', 'claude-opus-4-8', 10, 1000, 'session_log')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_records
             (request_id, provider, model, input_tokens, project_path, created_at, data_source)
             VALUES ('known', 'claude', 'claude-opus-4-8', 20, '/repo', 1001, 'session_log')",
            [],
        )
        .unwrap();

        let filters = StatsDashboardFilters {
            project_path: Some(UNASSIGNED_PROJECT_FILTER.to_string()),
            ..Default::default()
        };
        let dashboard =
            dashboard_from_db_with_filters(&conn, "all", None, None, None, None, &filters).unwrap();
        assert_eq!(dashboard.overview.request_count, 1);
        assert_eq!(dashboard.request_logs[0].request_id, "legacy");
    }
}
