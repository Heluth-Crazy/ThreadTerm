use super::{
    facts::{Buckets, Fact},
    prices, time,
};
use anyhow::{anyhow, Result};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};

const WRITE_BATCH: usize = 512;
const NATIVE_ACTIVE_GAP_MS: i64 = 300_000;
const PRICE_OVERRIDES_KEY: &str = "pricing-overrides-json";
const PRICE_REVISION_KEY: &str = "pricing-revision";
const PRICE_PENDING_KEY: &str = "pricing-pending-revision";
const PRICE_PENDING_COMPAT_KEY: &str = "pricing-pending";
const NATIVE_TIMESTAMP_ORDER_KEY: &str = "native-timestamp-order-verified";
static WRITE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static WRITE_MAX_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static INGEST_PROFILE_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
#[cfg(test)]
static PROFILE_FAST_BATCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_REPAIR_BATCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_UNCHANGED_BATCHES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_BEGIN_CONTEXT_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_WRITE_REFRESH_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FINISH_CLASSIFIER_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_INTERVALS_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_DIRTY_ROLLUP_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_CUBE_SLICES_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_METADATA_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_REPAIR_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_SNAPSHOT_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_ROLLUPS_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_INTERVALS_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_LIVE_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_METADATA_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
static PROFILE_FULL_MATERIALIZED_US: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
fn ingestion_profile_enabled() -> bool {
    *INGEST_PROFILE_ENABLED.get_or_init(|| std::env::var_os("UA1R_PROFILE").is_some())
}

#[cfg(test)]
fn ingestion_profile_add(counter: &std::sync::atomic::AtomicU64, started: std::time::Instant) {
    if ingestion_profile_enabled() {
        counter.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
}

/// Returns and resets content-free ingestion stage counters used by the
/// synthetic ledger benchmark.
#[cfg(test)]
pub fn ingestion_profile_take() -> Value {
    fn take(counter: &std::sync::atomic::AtomicU64) -> u64 {
        counter.swap(0, Ordering::Relaxed)
    }
    serde_json::json!({
        "fastBatches": take(&PROFILE_FAST_BATCHES),
        "repairBatches": take(&PROFILE_REPAIR_BATCHES),
        "unchangedBatches": take(&PROFILE_UNCHANGED_BATCHES),
        "beginContextMicros": take(&PROFILE_BEGIN_CONTEXT_US),
        "writeObservationRefreshFactMicros": take(&PROFILE_WRITE_REFRESH_US),
        "finishClassifierMicros": take(&PROFILE_FINISH_CLASSIFIER_US),
        "intervalsMicros": take(&PROFILE_INTERVALS_US),
        "dirtyRollupMicros": take(&PROFILE_DIRTY_ROLLUP_US),
        "cubeSlicesMicros": take(&PROFILE_CUBE_SLICES_US),
        "metadataMicros": take(&PROFILE_METADATA_US),
        "fullRepairMicros": take(&PROFILE_FULL_REPAIR_US),
        "fullSnapshotMicros": take(&PROFILE_FULL_SNAPSHOT_US),
        "fullRollupsMicros": take(&PROFILE_FULL_ROLLUPS_US),
        "fullIntervalsMicros": take(&PROFILE_FULL_INTERVALS_US),
        "fullLiveMicros": take(&PROFILE_FULL_LIVE_US),
        "fullMetadataMicros": take(&PROFILE_FULL_METADATA_US),
        "fullMaterializedMicros": take(&PROFILE_FULL_MATERIALIZED_US),
        "repairReasons": super::incremental::rejection_profile_take(),
    })
}
#[track_caller]
pub fn record_write_duration(start: std::time::Instant) {
    WRITE_COUNT.fetch_add(1, Ordering::Relaxed);
    let elapsed = start.elapsed().as_micros() as u64;
    let previous = WRITE_MAX_US.fetch_max(elapsed, Ordering::Relaxed);
    #[cfg(test)]
    if elapsed > previous && elapsed > 50_000 {
        let caller = std::panic::Location::caller();
        println!(
            "PROFILE longest_write_us={elapsed} origin={}:{}",
            caller.file(),
            caller.line()
        );
    }
}
pub fn reset_write_metrics() {
    WRITE_COUNT.store(0, Ordering::Relaxed);
    WRITE_MAX_US.store(0, Ordering::Relaxed);
}
pub fn write_metrics() -> (u64, u64) {
    (
        WRITE_COUNT.load(Ordering::Relaxed),
        WRITE_MAX_US.load(Ordering::Relaxed),
    )
}
pub const ACTIVITY_PROVIDER_MASK: i64 = 1;
pub const ACTIVITY_MODEL_MASK: i64 = 2;
pub const ACTIVITY_PROJECT_MASK: i64 = 4;
pub const ACTIVITY_SCOPE_MASK: i64 = 8;

pub(super) const EFFECTIVE_FACT: &str = "(
    EXISTS (
        SELECT 1 FROM usage_fact_observations native
        WHERE native.fact_key=f.fact_key AND native.source LIKE 'native:%'
    ) OR NOT EXISTS (
        SELECT 1 FROM usage_native_coverage coverage
        WHERE coverage.provider=f.provider
          AND coverage.native_session_id=f.native_session_id
    )
) AND NOT (
    f.source LIKE 'live:legacy:%'
    AND EXISTS (
        SELECT 1 FROM usage_facts newer
        WHERE newer.threadterm_session_id=f.threadterm_session_id
          AND f.turn_id IS NOT NULL AND newer.turn_id=f.turn_id
          AND newer.source LIKE 'live:%'
          AND newer.source NOT LIKE 'live:legacy:%'
    )
)";

/// Creates only additive ledger schema. History import and repricing are
/// explicit worker operations so opening ThreadTerm never scans old usage.
pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_ledger_state (
            key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_native_coverage (
            provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
            source TEXT NOT NULL, covered_at TEXT NOT NULL,
            PRIMARY KEY(provider,native_session_id,source)
        );
        CREATE TABLE IF NOT EXISTS usage_fact_observations (
            source TEXT NOT NULL, fact_key TEXT NOT NULL, provider TEXT NOT NULL,
            model TEXT, occurred_at TEXT NOT NULL, native_session_id TEXT NOT NULL,
            parent_native_session_id TEXT, subagent INTEGER NOT NULL,
            input_tokens INTEGER, cache_read_tokens INTEGER,
            cache_write5m_tokens INTEGER, cache_write1h_tokens INTEGER,
            cache_write_unknown_tokens INTEGER, output_tokens INTEGER,
            reasoning_tokens INTEGER, quality TEXT NOT NULL,
            reported_cost REAL, estimated_cost REAL, cwd TEXT,
            parser_version INTEGER NOT NULL, threadterm_session_id TEXT,
            turn_id TEXT, started_at TEXT, ended_at TEXT,
            PRIMARY KEY(source,fact_key)
        );
        CREATE TABLE IF NOT EXISTS usage_superseded_facts (
            fact_key TEXT PRIMARY KEY, superseded_by TEXT,
            provider TEXT, native_session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS usage_facts (
            fact_key TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT,
            occurred_at TEXT NOT NULL, local_day TEXT NOT NULL,
            native_session_id TEXT NOT NULL, parent_native_session_id TEXT,
            subagent INTEGER NOT NULL, input_tokens INTEGER,
            cache_read_tokens INTEGER, cache_write5m_tokens INTEGER,
            cache_write1h_tokens INTEGER, cache_write_unknown_tokens INTEGER,
            output_tokens INTEGER, reasoning_tokens INTEGER,
            quality TEXT NOT NULL, reported_cost REAL, estimated_cost REAL,
            cwd TEXT, source TEXT NOT NULL, parser_version INTEGER NOT NULL,
            threadterm_session_id TEXT, turn_id TEXT, started_at TEXT,
            ended_at TEXT, project_id TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL DEFAULT 'outside'
        );
        CREATE TABLE IF NOT EXISTS usage_daily_rollups (
            local_day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
            project_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
            threadterm_session_id TEXT NOT NULL, scope TEXT NOT NULL,
            input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
            cache_write5m_tokens INTEGER NOT NULL,
            cache_write1h_tokens INTEGER NOT NULL,
            cache_write_unknown_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
            input_reported INTEGER NOT NULL, cache_read_reported INTEGER NOT NULL,
            cache_write5m_reported INTEGER NOT NULL,
            cache_write1h_reported INTEGER NOT NULL,
            cache_write_unknown_reported INTEGER NOT NULL,
            output_reported INTEGER NOT NULL, reasoning_reported INTEGER NOT NULL,
            reported_cost REAL NOT NULL, estimated_cost REAL NOT NULL,
            priced_tokens INTEGER NOT NULL, unpriced_tokens INTEGER NOT NULL,
            requests INTEGER NOT NULL, reported_requests INTEGER NOT NULL,
            priced_requests INTEGER NOT NULL, exact_requests INTEGER NOT NULL,
            derived_requests INTEGER NOT NULL, estimated_requests INTEGER NOT NULL,
            exact_tokens INTEGER NOT NULL, derived_tokens INTEGER NOT NULL,
            estimated_tokens INTEGER NOT NULL, first_occurred_at TEXT NOT NULL,
            last_occurred_at TEXT NOT NULL,
            PRIMARY KEY(local_day,provider,model,project_id,native_session_id,
                        threadterm_session_id,scope)
        );
        CREATE TABLE IF NOT EXISTS usage_intervals (
            provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
            model TEXT NOT NULL, project_id TEXT NOT NULL,
            threadterm_session_id TEXT NOT NULL, scope TEXT NOT NULL,
            local_day TEXT NOT NULL,
            start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
            estimated INTEGER NOT NULL,
            PRIMARY KEY(provider,native_session_id,model,project_id,
                        threadterm_session_id,scope,start_ms,end_ms,estimated)
        );
        CREATE TABLE IF NOT EXISTS usage_activity_daily (
            local_day TEXT NOT NULL, dimensions_mask INTEGER NOT NULL,
            provider TEXT NOT NULL, model TEXT NOT NULL,
            project_id TEXT NOT NULL, scope TEXT NOT NULL,
            active_ms INTEGER NOT NULL, estimated INTEGER NOT NULL,
            PRIMARY KEY(local_day,dimensions_mask,provider,model,project_id,scope)
        );
        CREATE TABLE IF NOT EXISTS usage_activity_dirty (
            local_day TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS usage_ledger_sessions (
            provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
            threadterm_session_id TEXT NOT NULL, project_id TEXT NOT NULL,
            project_name TEXT NOT NULL, cwd TEXT, scope TEXT NOT NULL,
            parent_native_session_id TEXT, subagent INTEGER NOT NULL,
            first_occurred_at TEXT NOT NULL, last_occurred_at TEXT NOT NULL,
            models TEXT NOT NULL, requests INTEGER NOT NULL,
            tokens INTEGER NOT NULL, subagent_count INTEGER NOT NULL,
            PRIMARY KEY(provider,native_session_id)
        );",
    )?;

    ensure_column(
        conn,
        "usage_fact_observations",
        "cache_write_unknown_tokens",
        "INTEGER",
    )?;
    ensure_column(conn, "usage_facts", "cache_write_unknown_tokens", "INTEGER")?;
    ensure_column(
        conn,
        "usage_facts",
        "project_id",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        conn,
        "usage_facts",
        "scope",
        "TEXT NOT NULL DEFAULT 'outside'",
    )?;
    ensure_column(conn, "usage_superseded_facts", "provider", "TEXT")?;
    ensure_column(conn, "usage_superseded_facts", "native_session_id", "TEXT")?;
    ensure_column(
        conn,
        "usage_intervals",
        "local_day",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    for (name, definition) in [
        ("cache_write_unknown_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("input_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("cache_read_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("cache_write5m_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("cache_write1h_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("cache_write_unknown_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("output_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("reasoning_reported", "INTEGER NOT NULL DEFAULT 0"),
        ("reported_requests", "INTEGER NOT NULL DEFAULT 0"),
        ("priced_requests", "INTEGER NOT NULL DEFAULT 0"),
        ("exact_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("derived_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("estimated_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_column(conn, "usage_daily_rollups", name, definition)?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS usage_observations_key ON usage_fact_observations(fact_key);
         CREATE INDEX IF NOT EXISTS usage_observations_session ON usage_fact_observations(provider,native_session_id,fact_key);
         CREATE INDEX IF NOT EXISTS usage_observations_threadterm_native ON usage_fact_observations(threadterm_session_id,native_session_id,fact_key);
         CREATE INDEX IF NOT EXISTS usage_observations_turn ON usage_fact_observations(threadterm_session_id,turn_id,source,fact_key);
         CREATE INDEX IF NOT EXISTS usage_superseded_coordinate ON usage_superseded_facts(provider,native_session_id,fact_key);
         CREATE INDEX IF NOT EXISTS usage_coverage_source ON usage_native_coverage(source,provider,native_session_id);
         CREATE INDEX IF NOT EXISTS usage_facts_session ON usage_facts(provider,native_session_id,occurred_at,fact_key);
         CREATE INDEX IF NOT EXISTS usage_facts_session_day ON usage_facts(provider,native_session_id,local_day,fact_key);
         CREATE INDEX IF NOT EXISTS usage_facts_time ON usage_facts(occurred_at);
         CREATE INDEX IF NOT EXISTS usage_facts_parent ON usage_facts(provider,parent_native_session_id,subagent,native_session_id);
         CREATE INDEX IF NOT EXISTS usage_facts_threadterm_source ON usage_facts(threadterm_session_id,source);
         CREATE INDEX IF NOT EXISTS usage_facts_turn ON usage_facts(threadterm_session_id,turn_id,source);
         CREATE INDEX IF NOT EXISTS usage_rollups_range ON usage_daily_rollups(local_day,scope,provider,model);
         CREATE INDEX IF NOT EXISTS usage_rollups_session ON usage_daily_rollups(provider,native_session_id,local_day);
         CREATE INDEX IF NOT EXISTS usage_intervals_session ON usage_intervals(provider,native_session_id,start_ms);
         CREATE INDEX IF NOT EXISTS usage_intervals_session_day ON usage_intervals(provider,native_session_id,local_day,start_ms,end_ms);
         CREATE INDEX IF NOT EXISTS usage_intervals_range ON usage_intervals(start_ms,end_ms);
         CREATE INDEX IF NOT EXISTS usage_intervals_day ON usage_intervals(local_day,start_ms,end_ms);
         CREATE INDEX IF NOT EXISTS usage_activity_range ON usage_activity_daily(dimensions_mask,local_day,scope,provider,model,project_id);
         CREATE INDEX IF NOT EXISTS usage_activity_dimensions ON usage_activity_daily(dimensions_mask,provider,model,project_id,scope,local_day);
         CREATE INDEX IF NOT EXISTS usage_ledger_sessions_threadterm ON usage_ledger_sessions(threadterm_session_id);
         CREATE INDEX IF NOT EXISTS usage_ledger_sessions_scope ON usage_ledger_sessions(scope,provider,last_occurred_at);",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO usage_ledger_state(key,value)
         SELECT ?, '1' WHERE NOT EXISTS(SELECT 1 FROM usage_facts LIMIT 1)",
        [NATIVE_TIMESTAMP_ORDER_KEY],
    )?;
    conn.set_prepared_statement_cache_capacity(128);
    super::live_fallback::initialize(conn)?;
    super::materialized::initialize(conn)?;
    super::session_ranges::initialize(conn)?;
    super::membership::initialize(conn)?;
    Ok(())
}

/// Builds the additive query projection on the explicit worker, one session per commit.
pub fn rebuild_query_cache(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    configure_index_connection(conn)?;
    if cancelled.load(Ordering::Relaxed) {
        return Ok(false);
    }
    let force_projection = cfg!(test) && std::env::var_os("UA1R_FORCE_QUERY_REBUILD").is_some();
    let projection_marked =
        !force_projection && state(conn, "query-projection-complete")?.as_deref() == Some("1");
    // A completed nonempty projection must have at least one session row. This
    // constant-time guard preserves repair of an invalid/stale marker without
    // enumerating millions of observations on every normal startup.
    let projection_ready = projection_marked
        && conn.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM usage_fact_observations LIMIT 1)
                    OR EXISTS(SELECT 1 FROM usage_query_sessions LIMIT 1)",
            [],
            |row| row.get::<_, bool>(0),
        )?;
    if !projection_ready && !super::materialized::rebuild(conn, cancelled)? {
        return Ok(false);
    }
    if !super::membership::ready(conn) && !super::membership::rebuild(conn, cancelled)? {
        return Ok(false);
    }
    if !super::session_ranges::ready(conn) && !super::session_ranges::rebuild(conn, cancelled)? {
        return Ok(false);
    }
    force_checkpoint_index_connection(conn)?;
    Ok(true)
}

/// This dedicated worker writes rebuildable projections and native observations.
/// Live Chat and settings keep the canonical connection's durability policy.
pub fn configure_index_connection(conn: &Connection) -> Result<()> {
    conn.set_prepared_statement_cache_capacity(128);
    conn.execute_batch(
        "PRAGMA main.cache_size=-131072; PRAGMA main.synchronous=NORMAL; PRAGMA main.wal_autocheckpoint=0;",
    )?;
    // Changing temp_store destroys existing TEMP objects, including repair fences.
    let temp_objects = conn.query_row("SELECT COUNT(*) FROM sqlite_temp_master", [], |r| {
        r.get::<_, i64>(0)
    })?;
    if temp_objects == 0
        && conn.pragma_query_value(None, "temp_store", |r| r.get::<_, i64>(0))? != 2
    {
        conn.pragma_update(None, "temp_store", 2)?;
    }
    super::write_priority::initialize_checkpoint_cadence(conn)?;
    Ok(())
}

/// Passive checkpoints run every sixteen commits after the worker releases its
/// write transaction. Rebuildable-index I/O must not extend the writer's commit
/// critical section.
pub fn checkpoint_index_connection(conn: &Connection) -> Result<()> {
    checkpoint_index_connection_inner(conn, false)
}

/// Flushes the final rebuild batch instead of waiting for the normal cadence.
pub fn force_checkpoint_index_connection(conn: &Connection) -> Result<()> {
    checkpoint_index_connection_inner(conn, true)
}

fn checkpoint_index_connection_inner(conn: &Connection, force: bool) -> Result<()> {
    if conn.is_autocommit()
        && conn.pragma_query_value(None, "wal_autocheckpoint", |r| r.get::<_, i64>(0))? == 0
        && super::write_priority::checkpoint_due(conn, force)?
    {
        super::write_priority::yield_to_interactive(conn);
        // The schema qualifier matters: an unqualified wal_checkpoint reaches
        // every attached database, including the read-only ThreadTerm one.
        if let Err(error) = conn.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |_| Ok(())) {
            match &error {
                rusqlite::Error::SqliteFailure(detail, _)
                    if matches!(
                        detail.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) => {}
                _ => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == column) {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

#[derive(Clone)]
struct ProjectRoot {
    id: String,
    comparable_path: String,
}

#[derive(Clone, Default)]
struct Attribution {
    threadterm_session_id: String,
    project_id: String,
    cwd: Option<String>,
    scope: String,
}

pub(super) struct RefreshContext {
    overrides: Value,
    projects: Vec<ProjectRoot>,
    attributions: BTreeMap<(String, String, Option<String>, Option<String>), Attribution>,
}

impl RefreshContext {
    pub(super) fn load(conn: &Connection) -> Result<Self> {
        Ok(Self {
            overrides: current_overrides(conn)?,
            projects: load_project_roots(conn)?,
            attributions: BTreeMap::new(),
        })
    }

    fn attribution(&mut self, conn: &Connection, fact: &Fact) -> Result<Attribution> {
        let cache_key = (
            fact.provider.clone(),
            fact.native_session_id.clone(),
            fact.threadterm_session_id.clone(),
            fact.cwd.clone(),
        );
        if let Some(value) = self.attributions.get(&cache_key) {
            return Ok(value.clone());
        }
        let mut session = fact
            .threadterm_session_id
            .as_deref()
            .and_then(|id| session_by_id(conn, id).ok().flatten());
        if session.is_none() {
            session = conn
                .query_row(
                    "SELECT id,project_id,worktree_path FROM sessions
                     WHERE provider=? AND native_id=?
                     ORDER BY updated_at DESC,id LIMIT 1",
                    params![fact.provider, fact.native_session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
        }
        let (threadterm_session_id, session_project, session_cwd) = session.unwrap_or_default();
        let cwd = fact.cwd.clone().or(session_cwd);
        let matched_project = session_project
            .as_deref()
            .and_then(|id| self.projects.iter().find(|project| project.id == id))
            .or_else(|| project_for_path(&self.projects, cwd.as_deref().unwrap_or_default()));
        let value = Attribution {
            scope: if threadterm_session_id.is_empty() {
                "outside".into()
            } else {
                "threadterm".into()
            },
            threadterm_session_id,
            project_id: matched_project
                .map(|project| project.id.clone())
                .unwrap_or_default(),
            cwd,
        };
        self.attributions.insert(cache_key, value.clone());
        Ok(value)
    }
}

fn session_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<(String, Option<String>, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT id,project_id,worktree_path FROM sessions WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_project_roots(conn: &Connection) -> Result<Vec<ProjectRoot>> {
    let mut roots = Vec::new();
    {
        let mut statement = conn.prepare("SELECT id,path FROM projects")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, path) = row?;
            roots.push(ProjectRoot {
                id,
                comparable_path: comparable_path(&path),
            });
        }
    }
    if table_exists(conn, "worktrees")? {
        let mut statement = conn.prepare("SELECT project_id,path FROM worktrees")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, path) = row?;
            roots.push(ProjectRoot {
                id,
                comparable_path: comparable_path(&path),
            });
        }
    }
    roots.sort_by(|left, right| right.comparable_path.len().cmp(&left.comparable_path.len()));
    Ok(roots)
}

fn project_for_path<'a>(projects: &'a [ProjectRoot], path: &str) -> Option<&'a ProjectRoot> {
    let candidate = comparable_path(path);
    projects.iter().find(|project| {
        let root = project.comparable_path.as_str();
        !root.is_empty()
            && (candidate == root
                || (candidate.starts_with(root)
                    && candidate.as_bytes().get(root.len()) == Some(&b'/')))
    })
}

fn comparable_path(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    let upper = value.to_ascii_uppercase();
    if upper.starts_with("//?/UNC/") {
        value = format!("//{}", &value[8..]);
    } else if upper.starts_with("//?/") {
        value = value[4..].to_owned();
    }
    while value.contains("//") && !value.starts_with("//") {
        value = value.replace("//", "/");
    }
    if value.starts_with("//") {
        value = format!("//{}", value[2..].replace("//", "/"));
    }
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    let windows =
        value.starts_with("//") || value.as_bytes().get(1) == Some(&b':') || path.contains('\\');
    if windows {
        value.make_ascii_lowercase();
    }
    value
}

pub fn upsert_fact(conn: &Connection, fact: &Fact) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        upsert_facts_inner(&tx, std::slice::from_ref(fact))?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        upsert_facts_inner(conn, std::slice::from_ref(fact))?;
    }
    Ok(())
}

pub fn upsert_facts(conn: &Connection, facts: &[Fact]) -> Result<()> {
    if facts.is_empty() {
        return Ok(());
    }
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        upsert_facts_inner(&tx, facts)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        upsert_facts_inner(conn, facts)?;
    }
    Ok(())
}

pub fn upsert_fact_tx(conn: &rusqlite::Transaction<'_>, fact: &Fact) -> Result<()> {
    upsert_facts_inner(conn, std::slice::from_ref(fact))
}

fn upsert_facts_inner(conn: &Connection, facts: &[Fact]) -> Result<()> {
    #[cfg(test)]
    let begin_started = std::time::Instant::now();
    super::incremental::begin(conn, facts)?;
    let mut context = RefreshContext::load(conn)?;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_BEGIN_CONTEXT_US, begin_started);
    let mut parents = BTreeSet::new();
    let live_batch = facts.iter().any(|fact| fact.source.starts_with("live:"));
    let mut live_sessions = BTreeSet::new();
    let mut batch_keys = BTreeSet::new();
    #[cfg(test)]
    let write_started = std::time::Instant::now();
    for fact in facts {
        if live_batch {
            if let Some(coordinate) = materialized_coordinate(conn, &fact.key)? {
                live_sessions.insert(coordinate);
            }
        }
        write_observation(conn, fact, &context.overrides)?;
        let first_in_batch = batch_keys.insert(fact.key.clone());
        if first_in_batch && super::incremental::direct_candidate(conn, &fact.key, &fact.source)? {
            materialize_canonical_fact(conn, fact.clone(), &mut context)?;
        } else {
            refresh_fact(conn, &fact.key, &mut context)?;
        }
        if live_batch {
            live_sessions.insert((fact.provider.clone(), fact.native_session_id.clone()));
            if let Some(coordinate) = materialized_coordinate(conn, &fact.key)? {
                live_sessions.insert(coordinate);
            }
        }
        if let Some(parent) = fact.parent_native_session_id.as_deref() {
            parents.insert((fact.provider.clone(), parent.to_owned()));
        }
    }
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_WRITE_REFRESH_US, write_started);
    #[cfg(test)]
    let finish_started = std::time::Instant::now();
    let dirty_days = super::incremental::finish(conn)?;
    if live_batch {
        #[cfg(test)]
        {
            ingestion_profile_add(&PROFILE_FINISH_CLASSIFIER_US, finish_started);
            if ingestion_profile_enabled() {
                PROFILE_REPAIR_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
        }
        #[cfg(test)]
        let repair_started = std::time::Instant::now();
        for (provider, session) in &live_sessions {
            refresh_session_rollups(conn, provider, session)?;
        }
        for (provider, parent) in parents {
            if !live_sessions.contains(&(provider.clone(), parent.clone())) {
                refresh_session_metadata(conn, &provider, &parent)?;
            }
        }
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_FULL_REPAIR_US, repair_started);
        return Ok(());
    }
    if dirty_days.is_empty() {
        #[cfg(test)]
        {
            ingestion_profile_add(&PROFILE_FINISH_CLASSIFIER_US, finish_started);
            if ingestion_profile_enabled() {
                PROFILE_UNCHANGED_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
        }
        return Ok(());
    }
    let changed_timestamps_are_canonical =
        super::incremental::changed_native_timestamps_are_canonical(conn)?;
    if !changed_timestamps_are_canonical {
        conn.execute(
            "DELETE FROM usage_ledger_state WHERE key=?",
            [NATIVE_TIMESTAMP_ORDER_KEY],
        )?;
    }
    let timestamp_order_verified = changed_timestamps_are_canonical
        && state(conn, NATIVE_TIMESTAMP_ORDER_KEY)?.as_deref() == Some("1");
    let sessions = super::incremental::changed_coordinates(conn)?;
    let mut change_kind = super::incremental::classify_native(conn)?;
    let mut historical_windows = Vec::new();
    let mut historical_days = Vec::new();
    if change_kind != super::incremental::NativeChangeKind::Repair && !timestamp_order_verified {
        change_kind = super::incremental::NativeChangeKind::Repair;
    } else if change_kind == super::incremental::NativeChangeKind::HistoricalOnly {
        match super::incremental::historical_native_windows(conn, NATIVE_ACTIVE_GAP_MS)? {
            Some(windows) => historical_windows = windows,
            None => {
                historical_days = super::incremental::expand_historical_days(conn)?;
                if !historical_native_timestamps_are_canonical(conn, &historical_days)? {
                    change_kind = super::incremental::NativeChangeKind::Repair;
                }
            }
        }
    }
    let incremental = change_kind != super::incremental::NativeChangeKind::Repair;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FINISH_CLASSIFIER_US, finish_started);
    if incremental {
        #[cfg(test)]
        if ingestion_profile_enabled() {
            PROFILE_FAST_BATCHES.fetch_add(1, Ordering::Relaxed);
        }
        #[cfg(test)]
        let intervals_started = std::time::Instant::now();
        if change_kind == super::incremental::NativeChangeKind::HistoricalOnly {
            if historical_windows.is_empty() {
                refresh_historical_native_intervals(conn, &historical_days)?;
            } else {
                refresh_historical_native_windows(conn, &historical_windows)?;
            }
        } else {
            for (provider, session) in &sessions {
                append_native_intervals(conn, provider, session)?;
            }
        }
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_INTERVALS_US, intervals_started);
        #[cfg(test)]
        let rollup_started = std::time::Instant::now();
        super::materialized::snapshot_incremental(conn)?;
        refresh_incremental_rollups(conn)?;
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_DIRTY_ROLLUP_US, rollup_started);
        #[cfg(test)]
        let cube_started = std::time::Instant::now();
        super::materialized::replace_incremental(conn)?;
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_CUBE_SLICES_US, cube_started);
        #[cfg(test)]
        let metadata_started = std::time::Instant::now();
        for (provider, session) in &sessions {
            refresh_appended_session_metadata(conn, provider, session)?;
        }
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_METADATA_US, metadata_started);
    } else {
        #[cfg(test)]
        if ingestion_profile_enabled() {
            PROFILE_REPAIR_BATCHES.fetch_add(1, Ordering::Relaxed);
        }
        #[cfg(test)]
        let repair_started = std::time::Instant::now();
        for (provider, session) in &sessions {
            refresh_session_rollups(conn, provider, session)?;
        }
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_FULL_REPAIR_US, repair_started);
    }
    #[cfg(test)]
    let metadata_started = std::time::Instant::now();
    for (provider, parent) in parents {
        if !sessions.contains(&(provider.clone(), parent.clone())) {
            if incremental {
                refresh_parent_subagent_count(conn, &provider, &parent)?;
            } else {
                refresh_session_metadata(conn, &provider, &parent)?;
            }
        }
    }
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_METADATA_US, metadata_started);
    Ok(())
}

fn append_native_intervals(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    let mut previous_ms =
        super::incremental::prior_native_timestamp(conn, provider, native_session_id)?;
    for (occurred_at, _key, model, project_id, threadterm_session_id, scope) in
        super::incremental::changed_native_facts(conn, provider, native_session_id)?
    {
        let current_ms = time::timestamp_millis(&occurred_at)?;
        if let Some(previous) = previous_ms {
            let gap = current_ms - previous;
            if gap > 0 && gap < NATIVE_ACTIVE_GAP_MS {
                let interval = MaterializedInterval {
                    model,
                    project_id,
                    threadterm_session_id,
                    scope,
                    start_ms: previous,
                    end_ms: current_ms,
                    estimated: true,
                };
                append_materialized_interval(conn, provider, native_session_id, &interval)?;
                for local_day in local_days_for_interval(previous, current_ms)? {
                    conn.prepare_cached(
                        "INSERT OR IGNORE INTO temp.usage_incremental_days(
                            provider,native_session_id,local_day) VALUES(?,?,?)",
                    )?
                    .execute(params![
                        provider,
                        native_session_id,
                        local_day
                    ])?;
                    conn.prepare_cached(
                        "INSERT OR IGNORE INTO usage_activity_dirty(local_day) VALUES(?)",
                    )?
                    .execute([local_day])?;
                }
            }
        }
        previous_ms = Some(current_ms);
    }
    Ok(())
}

#[derive(Clone)]
struct NativeIntervalPoint {
    occurred_at: String,
    fact_key: String,
    occurred_ms: i64,
    model: String,
    project_id: String,
    threadterm_session_id: String,
    scope: String,
}

#[derive(Clone)]
struct StoredNativeInterval {
    model: String,
    project_id: String,
    threadterm_session_id: String,
    scope: String,
    local_day: String,
    start_ms: i64,
    end_ms: i64,
}

/// Repairs only the strict five-minute influence windows around first-seen
/// historical native points. Windows are disjoint and sorted per coordinate.
fn refresh_historical_native_windows(
    conn: &Connection,
    windows: &[super::incremental::CoordinateWindow],
) -> Result<()> {
    for window in windows {
        for local_day in local_days_for_interval(window.start_ms, window.end_ms)? {
            conn.prepare_cached(
                "INSERT OR IGNORE INTO temp.usage_incremental_days(
                    provider,native_session_id,local_day) VALUES(?,?,?)",
            )?
            .execute(params![
                window.provider,
                window.native_session_id,
                local_day
            ])?;
            conn.prepare_cached("INSERT OR IGNORE INTO usage_activity_dirty(local_day) VALUES(?)")?
                .execute([local_day])?;
        }
        trim_native_interval_window(conn, window)?;
        rebuild_native_interval_window(conn, window)?;
    }
    Ok(())
}

fn trim_native_interval_window(
    conn: &Connection,
    window: &super::incremental::CoordinateWindow,
) -> Result<()> {
    // At most one valid native interval can cross the left boundary. Seek it
    // directly rather than filtering every interval earlier in the session.
    let crossing = conn
        .prepare(
            "SELECT model,project_id,threadterm_session_id,scope,local_day,
                    start_ms,end_ms
             FROM usage_intervals INDEXED BY usage_intervals_session
             WHERE provider=? AND native_session_id=? AND estimated=1
               AND start_ms<?
             ORDER BY start_ms DESC,end_ms DESC,model,project_id,
                      threadterm_session_id,scope,local_day
             LIMIT 1",
        )?
        .query_row(
            params![window.provider, window.native_session_id, window.start_ms],
            |row| {
                Ok(StoredNativeInterval {
                    model: row.get(0)?,
                    project_id: row.get(1)?,
                    threadterm_session_id: row.get(2)?,
                    scope: row.get(3)?,
                    local_day: row.get(4)?,
                    start_ms: row.get(5)?,
                    end_ms: row.get(6)?,
                })
            },
        )
        .optional()?;
    if let Some(interval) = crossing.filter(|interval| interval.end_ms > window.start_ms) {
        trim_stored_native_interval(conn, window, interval)?;
    }

    let mut cursor = (
        window.start_ms,
        i64::MIN,
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
    );
    loop {
        let mut statement = conn.prepare(
            "SELECT model,project_id,threadterm_session_id,scope,local_day,
                    start_ms,end_ms
             FROM usage_intervals INDEXED BY usage_intervals_session
             WHERE provider=? AND native_session_id=? AND estimated=1
               AND start_ms>=? AND start_ms<?
               AND (start_ms,end_ms,model,project_id,threadterm_session_id,
                    scope,local_day)>(?,?,?,?,?,?,?)
             ORDER BY start_ms,end_ms,model,project_id,threadterm_session_id,
                      scope,local_day
             LIMIT ?",
        )?;
        let page = statement
            .query_map(
                params![
                    window.provider,
                    window.native_session_id,
                    window.start_ms,
                    window.end_ms,
                    cursor.0,
                    cursor.1,
                    cursor.2,
                    cursor.3,
                    cursor.4,
                    cursor.5,
                    cursor.6,
                    WRITE_BATCH as i64,
                ],
                |row| {
                    Ok(StoredNativeInterval {
                        model: row.get(0)?,
                        project_id: row.get(1)?,
                        threadterm_session_id: row.get(2)?,
                        scope: row.get(3)?,
                        local_day: row.get(4)?,
                        start_ms: row.get(5)?,
                        end_ms: row.get(6)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        for interval in page {
            cursor = (
                interval.start_ms,
                interval.end_ms,
                interval.model.clone(),
                interval.project_id.clone(),
                interval.threadterm_session_id.clone(),
                interval.scope.clone(),
                interval.local_day.clone(),
            );
            trim_stored_native_interval(conn, window, interval)?;
        }
        if page_len < WRITE_BATCH {
            break;
        }
    }
    Ok(())
}

fn trim_stored_native_interval(
    conn: &Connection,
    window: &super::incremental::CoordinateWindow,
    interval: StoredNativeInterval,
) -> Result<()> {
    conn.prepare_cached(
        "DELETE FROM usage_intervals
         WHERE provider=? AND native_session_id=? AND model=?
           AND project_id=? AND threadterm_session_id=? AND scope=?
           AND local_day=? AND start_ms=? AND end_ms=? AND estimated=1",
    )?
    .execute(params![
        window.provider,
        window.native_session_id,
        interval.model,
        interval.project_id,
        interval.threadterm_session_id,
        interval.scope,
        interval.local_day,
        interval.start_ms,
        interval.end_ms,
    ])?;
    if interval.start_ms < window.start_ms {
        insert_stored_native_interval(
            conn,
            &window.provider,
            &window.native_session_id,
            &StoredNativeInterval {
                end_ms: window.start_ms,
                ..interval.clone()
            },
        )?;
    }
    if interval.end_ms > window.end_ms {
        insert_stored_native_interval(
            conn,
            &window.provider,
            &window.native_session_id,
            &StoredNativeInterval {
                start_ms: window.end_ms,
                ..interval
            },
        )?;
    }
    Ok(())
}

fn insert_stored_native_interval(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    interval: &StoredNativeInterval,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR IGNORE INTO usage_intervals(
            provider,native_session_id,model,project_id,threadterm_session_id,
            scope,local_day,start_ms,end_ms,estimated)
         VALUES(?,?,?,?,?,?,?,?,?,1)",
    )?
    .execute(params![
        provider,
        native_session_id,
        interval.model,
        interval.project_id,
        interval.threadterm_session_id,
        interval.scope,
        interval.local_day,
        interval.start_ms,
        interval.end_ms,
    ])?;
    Ok(())
}

fn rebuild_native_interval_window(
    conn: &Connection,
    window: &super::incremental::CoordinateWindow,
) -> Result<()> {
    let low_at = canonical_timestamp(window.start_ms)?;
    let high_at = canonical_timestamp(window.end_ms)?;
    let mut previous = native_interval_neighbor(
        conn,
        &window.provider,
        &window.native_session_id,
        &low_at,
        true,
    )?;
    let successor = native_interval_neighbor(
        conn,
        &window.provider,
        &window.native_session_id,
        &high_at,
        false,
    )?;
    let mut pending = None;
    let mut cursor_at = String::new();
    let mut cursor_key = String::new();
    loop {
        let page = native_interval_window_page(
            conn,
            &window.provider,
            &window.native_session_id,
            &low_at,
            &high_at,
            &cursor_at,
            &cursor_key,
        )?;
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        for current in page {
            if let Some(prior) = previous.as_ref() {
                accumulate_native_window_edge(
                    conn,
                    &window.provider,
                    &window.native_session_id,
                    window.start_ms,
                    window.end_ms,
                    prior,
                    &current,
                    &mut pending,
                )?;
            }
            cursor_at = current.occurred_at.clone();
            cursor_key = current.fact_key.clone();
            previous = Some(current);
        }
        if page_len < WRITE_BATCH {
            break;
        }
    }
    if let (Some(previous), Some(successor)) = (previous.as_ref(), successor.as_ref()) {
        accumulate_native_window_edge(
            conn,
            &window.provider,
            &window.native_session_id,
            window.start_ms,
            window.end_ms,
            previous,
            successor,
            &mut pending,
        )?;
    }
    if let Some(interval) = pending {
        insert_coalesced_native_interval(
            conn,
            &window.provider,
            &window.native_session_id,
            &interval,
        )?;
    }
    Ok(())
}

/// The indexed time windows below depend on the canonical UTC representation
/// emitted by every native reader. Guard all affected and boundary days so a
/// legacy/noncanonical row takes the established full-session repair path.
fn historical_native_timestamps_are_canonical(
    conn: &Connection,
    days: &[super::incremental::CoordinateDay],
) -> Result<bool> {
    let mut coordinates = BTreeMap::<(String, String), BTreeSet<NaiveDate>>::new();
    for coordinate in days {
        let day = NaiveDate::parse_from_str(&coordinate.local_day, "%Y-%m-%d")?;
        let entry = coordinates
            .entry((
                coordinate.provider.clone(),
                coordinate.native_session_id.clone(),
            ))
            .or_default();
        entry.insert(day);
        if let Some(previous) = day.pred_opt() {
            entry.insert(previous);
        }
        if let Some(next) = day.succ_opt() {
            entry.insert(next);
        }
    }
    let sql = format!(
        "SELECT f.occurred_at
         FROM usage_facts f INDEXED BY usage_facts_session_day
         WHERE f.provider=? AND f.native_session_id=? AND f.local_day=?
           AND {EFFECTIVE_FACT}
           AND EXISTS(SELECT 1 FROM usage_fact_observations native
                      WHERE native.fact_key=f.fact_key
                        AND native.source LIKE 'native:%')"
    );
    let mut statement = conn.prepare(&sql)?;
    for ((provider, native_session_id), local_days) in coordinates {
        for local_day in local_days {
            let formatted = local_day.format("%Y-%m-%d").to_string();
            let mut rows = statement.query(params![provider, native_session_id, formatted])?;
            while let Some(row) = rows.next()? {
                if !super::incremental::has_canonical_timestamp_format(&row.get::<_, String>(0)?) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

/// Rebuilds only native inferred interval fragments on the local days that can
/// be affected by newly discovered historical facts. Exact live intervals use
/// `estimated=0` and are intentionally left untouched.
fn refresh_historical_native_intervals(
    conn: &Connection,
    days: &[super::incremental::CoordinateDay],
) -> Result<()> {
    for day in days {
        refresh_historical_native_interval_day(
            conn,
            &day.provider,
            &day.native_session_id,
            &day.local_day,
        )?;
    }
    Ok(())
}

fn refresh_historical_native_interval_day(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    local_day: &str,
) -> Result<()> {
    let day = NaiveDate::parse_from_str(local_day, "%Y-%m-%d")?;
    let (day_start, day_end) = local_day_bounds_millis(local_day)?;
    let day_start_at = canonical_timestamp(day_start)?;
    let day_end_at = canonical_timestamp(day_end)?;
    let previous = if let Some(previous_day) = day.pred_opt() {
        let (previous_start, _) =
            local_day_bounds_millis(&previous_day.format("%Y-%m-%d").to_string())?;
        native_interval_boundary(
            conn,
            provider,
            native_session_id,
            &canonical_timestamp(previous_start)?,
            &day_start_at,
            true,
        )?
    } else {
        None
    };
    let successor = if let Some(next_day) = day.succ_opt() {
        let (_, next_end) = local_day_bounds_millis(&next_day.format("%Y-%m-%d").to_string())?;
        native_interval_boundary(
            conn,
            provider,
            native_session_id,
            &day_end_at,
            &canonical_timestamp(next_end)?,
            false,
        )?
    } else {
        None
    };

    conn.prepare_cached(
        "DELETE FROM usage_intervals
         WHERE provider=? AND native_session_id=?
           AND local_day=? AND estimated=1",
    )?
    .execute(params![provider, native_session_id, local_day])?;

    let mut previous = previous;
    let mut pending = None;
    let mut cursor_at = String::new();
    let mut cursor_key = String::new();
    loop {
        let page = native_interval_page(
            conn,
            provider,
            native_session_id,
            local_day,
            &day_start_at,
            &day_end_at,
            &cursor_at,
            &cursor_key,
        )?;
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        for current in page {
            if let Some(prior) = previous.as_ref() {
                accumulate_native_day_edge(
                    conn,
                    provider,
                    native_session_id,
                    local_day,
                    day_start,
                    day_end,
                    prior,
                    &current,
                    &mut pending,
                )?;
            }
            cursor_at = current.occurred_at.clone();
            cursor_key = current.fact_key.clone();
            previous = Some(current);
        }
        if page_len < WRITE_BATCH {
            break;
        }
    }
    if let (Some(previous), Some(successor)) = (previous.as_ref(), successor.as_ref()) {
        accumulate_native_day_edge(
            conn,
            provider,
            native_session_id,
            local_day,
            day_start,
            day_end,
            previous,
            successor,
            &mut pending,
        )?;
    }
    if let Some(interval) = pending {
        insert_native_day_interval(conn, provider, native_session_id, local_day, &interval)?;
    }
    conn.prepare_cached("INSERT OR IGNORE INTO usage_activity_dirty(local_day) VALUES(?)")?
        .execute([local_day])?;
    Ok(())
}

fn canonical_timestamp(millis: i64) -> Result<String> {
    Ok(DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or_else(|| anyhow!("invalid_usage_timestamp"))?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn native_interval_neighbor(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    boundary_at: &str,
    previous: bool,
) -> Result<Option<NativeIntervalPoint>> {
    let (comparison, order) = if previous {
        ("<", "DESC")
    } else {
        (">=", "ASC")
    };
    let sql = format!(
        "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                COALESCE(f.threadterm_session_id,''),f.scope
         FROM usage_facts f INDEXED BY usage_facts_session
         WHERE f.provider=? AND f.native_session_id=?
           AND f.occurred_at{comparison}?
           AND {EFFECTIVE_FACT}
           AND EXISTS(SELECT 1 FROM usage_fact_observations native
                      WHERE native.fact_key=f.fact_key
                        AND native.source LIKE 'native:%')
         ORDER BY f.occurred_at {order},f.fact_key {order} LIMIT 1"
    );
    conn.prepare(&sql)?
        .query_row(
            params![provider, native_session_id, boundary_at],
            native_interval_point,
        )
        .optional()
        .map_err(Into::into)
}

fn native_interval_window_page(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    low_at: &str,
    high_at: &str,
    cursor_at: &str,
    cursor_key: &str,
) -> Result<Vec<NativeIntervalPoint>> {
    let sql = format!(
        "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                COALESCE(f.threadterm_session_id,''),f.scope
         FROM usage_facts f INDEXED BY usage_facts_session
         WHERE f.provider=? AND f.native_session_id=?
           AND f.occurred_at>=? AND f.occurred_at<?
           AND (f.occurred_at>? OR (f.occurred_at=? AND f.fact_key>?))
           AND {EFFECTIVE_FACT}
           AND EXISTS(SELECT 1 FROM usage_fact_observations native
                      WHERE native.fact_key=f.fact_key
                        AND native.source LIKE 'native:%')
         ORDER BY f.occurred_at,f.fact_key LIMIT {WRITE_BATCH}"
    );
    let mut statement = conn.prepare(&sql)?;
    let result = statement
        .query_map(
            params![
                provider,
                native_session_id,
                low_at,
                high_at,
                cursor_at,
                cursor_at,
                cursor_key
            ],
            native_interval_point,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn accumulate_native_window_edge(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    low_ms: i64,
    high_ms: i64,
    previous: &NativeIntervalPoint,
    current: &NativeIntervalPoint,
    pending: &mut Option<MaterializedInterval>,
) -> Result<()> {
    let gap = current.occurred_ms - previous.occurred_ms;
    if gap <= 0 || gap >= NATIVE_ACTIVE_GAP_MS {
        if let Some(interval) = pending.take() {
            insert_coalesced_native_interval(conn, provider, native_session_id, &interval)?;
        }
        return Ok(());
    }
    let start_ms = previous.occurred_ms.max(low_ms);
    let end_ms = current.occurred_ms.min(high_ms);
    if end_ms <= start_ms {
        return Ok(());
    }
    let next = MaterializedInterval {
        model: current.model.clone(),
        project_id: current.project_id.clone(),
        threadterm_session_id: current.threadterm_session_id.clone(),
        scope: current.scope.clone(),
        start_ms,
        end_ms,
        estimated: true,
    };
    if let Some(active) = pending.as_mut() {
        if active.model == next.model
            && active.project_id == next.project_id
            && active.threadterm_session_id == next.threadterm_session_id
            && active.scope == next.scope
            && next.start_ms <= active.end_ms
        {
            active.end_ms = active.end_ms.max(next.end_ms);
        } else {
            let completed = std::mem::replace(active, next);
            insert_coalesced_native_interval(conn, provider, native_session_id, &completed)?;
        }
    } else {
        *pending = Some(next);
    }
    Ok(())
}

fn insert_coalesced_native_interval(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    interval: &MaterializedInterval,
) -> Result<()> {
    let mut start_ms = interval.start_ms;
    while interval.end_ms > start_ms {
        let local_day = local_day_for_millis(start_ms)?;
        let (_, day_end_ms) = local_day_bounds_millis(&local_day)?;
        let end_ms = interval.end_ms.min(day_end_ms);
        coalesce_native_day_fragment(
            conn,
            provider,
            native_session_id,
            &StoredNativeInterval {
                model: interval.model.clone(),
                project_id: interval.project_id.clone(),
                threadterm_session_id: interval.threadterm_session_id.clone(),
                scope: interval.scope.clone(),
                local_day,
                start_ms,
                end_ms,
            },
        )?;
        start_ms = end_ms;
    }
    Ok(())
}

fn coalesce_native_day_fragment(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    fragment: &StoredNativeInterval,
) -> Result<()> {
    let mut merged = fragment.clone();
    let left = conn
        .prepare_cached(
            "SELECT model,project_id,threadterm_session_id,scope,start_ms,end_ms
             FROM usage_intervals INDEXED BY usage_intervals_session_day
             WHERE provider=? AND native_session_id=? AND local_day=?
               AND start_ms<? AND estimated=1
             ORDER BY start_ms DESC LIMIT 1",
        )?
        .query_row(
            params![
                provider,
                native_session_id,
                merged.local_day,
                merged.start_ms,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    if let Some((_, _, _, _, start_ms, end_ms)) = left.filter(
        |(model, project_id, threadterm_session_id, scope, _, end_ms)| {
            model == &merged.model
                && project_id == &merged.project_id
                && threadterm_session_id == &merged.threadterm_session_id
                && scope == &merged.scope
                && *end_ms == merged.start_ms
        },
    ) {
        delete_native_day_fragment(conn, provider, native_session_id, &merged, start_ms, end_ms)?;
        merged.start_ms = start_ms;
    }
    let right = conn
        .prepare_cached(
            "SELECT start_ms,end_ms FROM usage_intervals
             WHERE provider=? AND native_session_id=? AND model=?
               AND project_id=? AND threadterm_session_id=? AND scope=?
               AND local_day=? AND start_ms=? AND estimated=1
             ORDER BY end_ms DESC LIMIT 1",
        )?
        .query_row(
            params![
                provider,
                native_session_id,
                merged.model,
                merged.project_id,
                merged.threadterm_session_id,
                merged.scope,
                merged.local_day,
                merged.end_ms,
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    if let Some((start_ms, end_ms)) = right {
        delete_native_day_fragment(conn, provider, native_session_id, &merged, start_ms, end_ms)?;
        merged.end_ms = end_ms;
    }
    insert_stored_native_interval(conn, provider, native_session_id, &merged)
}

fn delete_native_day_fragment(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    dimensions: &StoredNativeInterval,
    start_ms: i64,
    end_ms: i64,
) -> Result<()> {
    conn.prepare_cached(
        "DELETE FROM usage_intervals
         WHERE provider=? AND native_session_id=? AND model=?
           AND project_id=? AND threadterm_session_id=? AND scope=?
           AND local_day=? AND start_ms=? AND end_ms=? AND estimated=1",
    )?
    .execute(params![
        provider,
        native_session_id,
        dimensions.model,
        dimensions.project_id,
        dimensions.threadterm_session_id,
        dimensions.scope,
        dimensions.local_day,
        start_ms,
        end_ms,
    ])?;
    Ok(())
}

fn native_interval_boundary(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    from_at: &str,
    to_at: &str,
    reverse: bool,
) -> Result<Option<NativeIntervalPoint>> {
    let order = if reverse { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                COALESCE(f.threadterm_session_id,''),f.scope
         FROM usage_facts f INDEXED BY usage_facts_session
         WHERE f.provider=? AND f.native_session_id=?
           AND f.occurred_at>=? AND f.occurred_at<?
           AND {EFFECTIVE_FACT}
           AND EXISTS(SELECT 1 FROM usage_fact_observations native
                      WHERE native.fact_key=f.fact_key
                        AND native.source LIKE 'native:%')
         ORDER BY f.occurred_at {order},f.fact_key {order} LIMIT 1"
    );
    conn.prepare(&sql)?
        .query_row(
            params![provider, native_session_id, from_at, to_at],
            native_interval_point,
        )
        .optional()
        .map_err(Into::into)
}

fn native_interval_page(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    local_day: &str,
    from_at: &str,
    to_at: &str,
    cursor_at: &str,
    cursor_key: &str,
) -> Result<Vec<NativeIntervalPoint>> {
    let sql = format!(
        "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                COALESCE(f.threadterm_session_id,''),f.scope
         FROM usage_facts f INDEXED BY usage_facts_session
         WHERE f.provider=? AND f.native_session_id=? AND f.local_day=?
           AND f.occurred_at>=? AND f.occurred_at<?
           AND (f.occurred_at>? OR (f.occurred_at=? AND f.fact_key>?))
           AND {EFFECTIVE_FACT}
           AND EXISTS(SELECT 1 FROM usage_fact_observations native
                      WHERE native.fact_key=f.fact_key
                        AND native.source LIKE 'native:%')
         ORDER BY f.occurred_at,f.fact_key LIMIT {WRITE_BATCH}"
    );
    let mut statement = conn.prepare(&sql)?;
    let result = statement
        .query_map(
            params![
                provider,
                native_session_id,
                local_day,
                from_at,
                to_at,
                cursor_at,
                cursor_at,
                cursor_key
            ],
            native_interval_point,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}

fn native_interval_point(row: &Row<'_>) -> rusqlite::Result<NativeIntervalPoint> {
    let occurred_at = row.get::<_, String>(0)?;
    let occurred_ms = time::timestamp_millis(&occurred_at).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
    })?;
    Ok(NativeIntervalPoint {
        occurred_at,
        fact_key: row.get(1)?,
        occurred_ms,
        model: row.get(2)?,
        project_id: row.get(3)?,
        threadterm_session_id: row.get(4)?,
        scope: row.get(5)?,
    })
}

#[allow(clippy::too_many_arguments)]
fn accumulate_native_day_edge(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    local_day: &str,
    day_start: i64,
    day_end: i64,
    previous: &NativeIntervalPoint,
    current: &NativeIntervalPoint,
    pending: &mut Option<MaterializedInterval>,
) -> Result<()> {
    let gap = current.occurred_ms - previous.occurred_ms;
    if gap <= 0 || gap >= NATIVE_ACTIVE_GAP_MS {
        if let Some(interval) = pending.take() {
            insert_native_day_interval(conn, provider, native_session_id, local_day, &interval)?;
        }
        return Ok(());
    }
    let start_ms = previous.occurred_ms.max(day_start);
    let end_ms = current.occurred_ms.min(day_end);
    if end_ms <= start_ms {
        return Ok(());
    }
    let next = MaterializedInterval {
        model: current.model.clone(),
        project_id: current.project_id.clone(),
        threadterm_session_id: current.threadterm_session_id.clone(),
        scope: current.scope.clone(),
        start_ms,
        end_ms,
        estimated: true,
    };
    if let Some(active) = pending.as_mut() {
        if active.model == next.model
            && active.project_id == next.project_id
            && active.threadterm_session_id == next.threadterm_session_id
            && active.scope == next.scope
            && next.start_ms <= active.end_ms
        {
            active.end_ms = active.end_ms.max(next.end_ms);
        } else {
            let completed = std::mem::replace(active, next);
            insert_native_day_interval(conn, provider, native_session_id, local_day, &completed)?;
        }
    } else {
        *pending = Some(next);
    }
    Ok(())
}

fn insert_native_day_interval(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    local_day: &str,
    interval: &MaterializedInterval,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR IGNORE INTO usage_intervals(
            provider,native_session_id,model,project_id,threadterm_session_id,
            scope,local_day,start_ms,end_ms,estimated)
         VALUES(?,?,?,?,?,?,?,?,?,1)",
    )?
    .execute(params![
        provider,
        native_session_id,
        interval.model,
        interval.project_id,
        interval.threadterm_session_id,
        interval.scope,
        local_day,
        interval.start_ms,
        interval.end_ms,
    ])?;
    Ok(())
}

/// Appends a native edge while retaining the full rebuild's compact interval
/// representation. Only the current native tail is inspected; equal-dimension
/// adjacent fragments are extended in place, including across ingest batches.
fn append_materialized_interval(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    interval: &MaterializedInterval,
) -> Result<()> {
    let mut start_ms = interval.start_ms;
    while interval.end_ms > start_ms {
        let local_day = local_day_for_millis(start_ms)?;
        let (_, day_end_ms) = local_day_bounds_millis(&local_day)?;
        let end_ms = interval.end_ms.min(day_end_ms);
        if end_ms <= start_ms {
            return Err(anyhow!("invalid_usage_day_boundary"));
        }
        let tail = conn
            .prepare_cached(
                "SELECT model,project_id,threadterm_session_id,scope,local_day,
                        start_ms,end_ms
                 FROM usage_intervals
                 WHERE provider=? AND native_session_id=? AND estimated=1
                 ORDER BY start_ms DESC LIMIT 1",
            )?
            .query_row(params![provider, native_session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .optional()?;
        if let Some((model, project, threadterm, scope, day, tail_start, tail_end)) =
            tail.filter(|tail| {
                tail.0 == interval.model
                    && tail.1 == interval.project_id
                    && tail.2 == interval.threadterm_session_id
                    && tail.3 == interval.scope
                    && tail.4 == local_day
                    && tail.6 == start_ms
            })
        {
            conn.prepare_cached(
                "UPDATE usage_intervals SET end_ms=?
                 WHERE provider=? AND native_session_id=? AND model=?
                   AND project_id=? AND threadterm_session_id=? AND scope=?
                   AND local_day=? AND start_ms=? AND end_ms=? AND estimated=1",
            )?
            .execute(params![
                end_ms,
                provider,
                native_session_id,
                model,
                project,
                threadterm,
                scope,
                day,
                tail_start,
                tail_end
            ])?;
        } else {
            conn.prepare_cached(
                "INSERT OR IGNORE INTO usage_intervals(
                    provider,native_session_id,model,project_id,
                    threadterm_session_id,scope,local_day,start_ms,end_ms,estimated)
                 VALUES(?,?,?,?,?,?,?,?,?,1)",
            )?
            .execute(params![
                provider,
                native_session_id,
                interval.model,
                interval.project_id,
                interval.threadterm_session_id,
                interval.scope,
                local_day,
                start_ms,
                end_ms
            ])?;
        }
        start_ms = end_ms;
    }
    Ok(())
}

fn refresh_incremental_rollups(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM usage_daily_rollups
         WHERE (provider,native_session_id,local_day) IN (
            SELECT provider,native_session_id,local_day
            FROM temp.usage_incremental_days)",
        [],
    )?;
    conn.prepare_cached(&format!(
        "INSERT INTO usage_daily_rollups(
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
         SELECT f.local_day,f.provider,COALESCE(f.model,''),f.project_id,
            f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope,
            SUM(COALESCE(f.input_tokens,0)),SUM(COALESCE(f.cache_read_tokens,0)),
            SUM(COALESCE(f.cache_write5m_tokens,0)),SUM(COALESCE(f.cache_write1h_tokens,0)),
            SUM(COALESCE(f.cache_write_unknown_tokens,0)),SUM(COALESCE(f.output_tokens,0)),
            SUM(COALESCE(f.reasoning_tokens,0)),SUM(f.input_tokens IS NOT NULL),
            SUM(f.cache_read_tokens IS NOT NULL),SUM(f.cache_write5m_tokens IS NOT NULL),
            SUM(f.cache_write1h_tokens IS NOT NULL),SUM(f.cache_write_unknown_tokens IS NOT NULL),
            SUM(f.output_tokens IS NOT NULL),SUM(f.reasoning_tokens IS NOT NULL),
            SUM(COALESCE(f.reported_cost,0)),SUM(COALESCE(f.estimated_cost,0)),
            SUM(CASE WHEN f.estimated_cost IS NOT NULL THEN
                COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN f.estimated_cost IS NULL THEN
                COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
            COUNT(*),SUM(f.reported_cost IS NOT NULL),SUM(f.estimated_cost IS NOT NULL),
            SUM(f.quality='exact'),SUM(f.quality='derived'),SUM(f.quality='estimated'),
            SUM(CASE WHEN f.quality='exact' THEN
                COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN f.quality='derived' THEN
                COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
            SUM(CASE WHEN f.quality='estimated' THEN
                COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
            MIN(f.occurred_at),MAX(f.occurred_at)
         FROM temp.usage_incremental_days d
         CROSS JOIN usage_facts f INDEXED BY usage_facts_session_day
         WHERE f.provider=d.provider AND f.native_session_id=d.native_session_id
           AND f.local_day=d.local_day AND {EFFECTIVE_FACT}
         GROUP BY f.local_day,f.provider,COALESCE(f.model,''),f.project_id,
                  f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope"
    ))?
    .execute([])?;
    Ok(())
}

pub(super) fn materialized_coordinate(
    conn: &Connection,
    key: &str,
) -> Result<Option<(String, String)>> {
    Ok(conn
        .prepare_cached("SELECT provider,native_session_id FROM usage_facts WHERE fact_key=?")?
        .query_row([key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?)
}

fn nullable_max(column: &str) -> String {
    format!(
        "CASE WHEN excluded.{column} IS NULL THEN {column}
              WHEN {column} IS NULL THEN excluded.{column}
              ELSE MAX({column},excluded.{column}) END"
    )
}

fn write_observation(conn: &Connection, fact: &Fact, overrides: &Value) -> Result<()> {
    let update = format!(
        "provider=excluded.provider,model=COALESCE(excluded.model,model),
         occurred_at=MAX(occurred_at,excluded.occurred_at),
         native_session_id=excluded.native_session_id,
         parent_native_session_id=COALESCE(excluded.parent_native_session_id,parent_native_session_id),
         subagent=MAX(subagent,excluded.subagent),input_tokens={},cache_read_tokens={},
         cache_write5m_tokens={},cache_write1h_tokens={},cache_write_unknown_tokens={},
         output_tokens={},reasoning_tokens={},
         quality=CASE WHEN quality='exact' OR excluded.quality='exact' THEN 'exact'
                      WHEN quality='derived' OR excluded.quality='derived' THEN 'derived'
                      ELSE 'estimated' END,
         reported_cost={},estimated_cost={},cwd=COALESCE(excluded.cwd,cwd),
         parser_version=MAX(parser_version,excluded.parser_version),
         threadterm_session_id=COALESCE(excluded.threadterm_session_id,threadterm_session_id),
         turn_id=COALESCE(excluded.turn_id,turn_id),
         started_at=CASE WHEN excluded.started_at IS NULL THEN started_at
                         WHEN started_at IS NULL THEN excluded.started_at
                         ELSE MIN(started_at,excluded.started_at) END,
         ended_at=CASE WHEN excluded.ended_at IS NULL THEN ended_at
                       WHEN ended_at IS NULL THEN excluded.ended_at
                       ELSE MAX(ended_at,excluded.ended_at) END",
        nullable_max("input_tokens"),
        nullable_max("cache_read_tokens"),
        nullable_max("cache_write5m_tokens"),
        nullable_max("cache_write1h_tokens"),
        nullable_max("cache_write_unknown_tokens"),
        nullable_max("output_tokens"),
        nullable_max("reasoning_tokens"),
        nullable_max("reported_cost"),
        nullable_max("estimated_cost"),
    );
    conn.prepare_cached(&format!(
        "INSERT INTO usage_fact_observations(
                source,fact_key,provider,model,occurred_at,native_session_id,
                parent_native_session_id,subagent,input_tokens,cache_read_tokens,
                cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,
                output_tokens,reasoning_tokens,quality,reported_cost,estimated_cost,
                cwd,parser_version,threadterm_session_id,turn_id,started_at,ended_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(source,fact_key) DO UPDATE SET {update}"
    ))?
    .execute(params![
        fact.source,
        fact.key,
        fact.provider,
        fact.model,
        fact.occurred_at,
        fact.native_session_id,
        fact.parent_native_session_id,
        fact.subagent as i64,
        fact.buckets.input,
        fact.buckets.cache_read,
        fact.buckets.cache_write5m,
        fact.buckets.cache_write1h,
        fact.buckets.cache_write_unknown,
        fact.buckets.output,
        fact.buckets.reasoning,
        fact.quality,
        fact.reported_cost,
        prices::estimate(fact, overrides),
        fact.cwd,
        fact.parser_version as i64,
        fact.threadterm_session_id,
        fact.turn_id,
        fact.started_at,
        fact.ended_at,
    ])?;
    Ok(())
}

struct MergedFact {
    count: i64,
    fact: Fact,
}

fn merged_fact(row: &Row<'_>, key: &str) -> rusqlite::Result<MergedFact> {
    Ok(MergedFact {
        count: row.get(0)?,
        fact: Fact {
            key: key.to_owned(),
            provider: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            model: row.get(2)?,
            occurred_at: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            native_session_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            parent_native_session_id: row.get(5)?,
            subagent: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
            buckets: Buckets {
                input: row.get(7)?,
                cache_read: row.get(8)?,
                cache_write5m: row.get(9)?,
                cache_write1h: row.get(10)?,
                cache_write_unknown: row.get(11)?,
                output: row.get(12)?,
                reasoning: row.get(13)?,
            },
            quality: row
                .get::<_, Option<String>>(14)?
                .unwrap_or_else(|| "estimated".into()),
            reported_cost: row.get(15)?,
            cwd: row.get(16)?,
            source: row.get::<_, Option<String>>(17)?.unwrap_or_default(),
            parser_version: row.get::<_, Option<i64>>(18)?.unwrap_or(1) as u32,
            threadterm_session_id: row.get(19)?,
            turn_id: row.get(20)?,
            started_at: row.get(21)?,
            ended_at: row.get(22)?,
        },
    })
}

fn materialize_canonical_fact(
    conn: &Connection,
    mut fact: Fact,
    context: &mut RefreshContext,
) -> Result<()> {
    if fact.quality != "exact" && fact.quality != "derived" {
        fact.quality = "estimated".into();
    }
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
    let attribution = context.attribution(conn, &fact)?;
    let local_day = time::local_day(&fact.occurred_at)?;
    let estimated_cost = prices::estimate(&fact, &context.overrides);
    conn.prepare_cached(
        "INSERT INTO usage_facts(
            fact_key,provider,model,occurred_at,local_day,native_session_id,
            parent_native_session_id,subagent,input_tokens,cache_read_tokens,
            cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,
            output_tokens,reasoning_tokens,quality,reported_cost,estimated_cost,cwd,
            source,parser_version,threadterm_session_id,turn_id,started_at,ended_at,
            project_id,scope)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(fact_key) DO UPDATE SET
            provider=excluded.provider,model=excluded.model,occurred_at=excluded.occurred_at,
            local_day=excluded.local_day,native_session_id=excluded.native_session_id,
            parent_native_session_id=excluded.parent_native_session_id,
            subagent=excluded.subagent,input_tokens=excluded.input_tokens,
            cache_read_tokens=excluded.cache_read_tokens,
            cache_write5m_tokens=excluded.cache_write5m_tokens,
            cache_write1h_tokens=excluded.cache_write1h_tokens,
            cache_write_unknown_tokens=excluded.cache_write_unknown_tokens,
            output_tokens=excluded.output_tokens,reasoning_tokens=excluded.reasoning_tokens,
            quality=excluded.quality,reported_cost=excluded.reported_cost,
            estimated_cost=excluded.estimated_cost,cwd=excluded.cwd,source=excluded.source,
            parser_version=excluded.parser_version,
            threadterm_session_id=excluded.threadterm_session_id,turn_id=excluded.turn_id,
            started_at=excluded.started_at,ended_at=excluded.ended_at,
            project_id=excluded.project_id,scope=excluded.scope",
    )?
    .execute(params![
        fact.key,
        fact.provider,
        fact.model,
        fact.occurred_at,
        local_day,
        fact.native_session_id,
        fact.parent_native_session_id,
        fact.subagent as i64,
        fact.buckets.input,
        fact.buckets.cache_read,
        fact.buckets.cache_write5m,
        fact.buckets.cache_write1h,
        fact.buckets.cache_write_unknown,
        fact.buckets.output,
        fact.buckets.reasoning,
        fact.quality,
        fact.reported_cost,
        estimated_cost,
        attribution.cwd,
        fact.source,
        fact.parser_version as i64,
        (!attribution.threadterm_session_id.is_empty())
            .then_some(attribution.threadterm_session_id),
        fact.turn_id,
        fact.started_at,
        fact.ended_at,
        attribution.project_id,
        attribution.scope,
    ])?;
    Ok(())
}

pub(super) fn refresh_fact(
    conn: &Connection,
    key: &str,
    context: &mut RefreshContext,
) -> Result<()> {
    if conn
        .prepare_cached("SELECT 1 FROM usage_superseded_facts WHERE fact_key=?")?
        .query_row([key], |_| Ok(()))
        .optional()?
        .is_some()
    {
        conn.prepare_cached("DELETE FROM usage_facts WHERE fact_key=?")?
            .execute([key])?;
        return Ok(());
    }
    let mut merged = conn
        .prepare_cached(
            "SELECT COUNT(*),MAX(provider),MAX(model),MAX(occurred_at),
                MAX(native_session_id),MAX(parent_native_session_id),MAX(subagent),
                MAX(input_tokens),MAX(cache_read_tokens),MAX(cache_write5m_tokens),
                MAX(cache_write1h_tokens),MAX(cache_write_unknown_tokens),
                MAX(output_tokens),MAX(reasoning_tokens),
                CASE WHEN SUM(quality='exact')>0 THEN 'exact'
                     WHEN SUM(quality='derived')>0 THEN 'derived'
                     ELSE 'estimated' END,
                MAX(reported_cost),MAX(cwd),
                COALESCE(MIN(CASE WHEN source LIKE 'native:%' THEN source END),MIN(source)),
                MAX(parser_version),MAX(threadterm_session_id),MAX(turn_id),
                MIN(started_at),MAX(ended_at)
         FROM usage_fact_observations WHERE fact_key=?",
        )?
        .query_row([key], |row| merged_fact(row, key))?;
    if merged.count == 0 {
        conn.prepare_cached("DELETE FROM usage_facts WHERE fact_key=?")?
            .execute([key])?;
        return Ok(());
    }
    // A copied fork prefix can expose one global request key under several
    // session ids. Attribute it to the original owner: an observed parent id,
    // then a root observation, then a stable source/timestamp fallback.
    let owner = conn
        .prepare_cached(
            "SELECT provider,model,occurred_at,native_session_id,
                parent_native_session_id,subagent,cwd,threadterm_session_id
         FROM usage_fact_observations owner
         WHERE owner.fact_key=?
         ORDER BY CASE
             WHEN EXISTS (
                 SELECT 1 FROM usage_fact_observations child
                 WHERE child.fact_key=owner.fact_key
                   AND child.parent_native_session_id=owner.native_session_id
             ) THEN 0
             WHEN owner.parent_native_session_id IS NULL
                  OR owner.parent_native_session_id='' THEN 1
             ELSE 2 END,
             owner.occurred_at,owner.source
         LIMIT 1",
        )?
        .query_row([key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)? != 0,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
    merged.fact.provider = owner.0;
    if owner.1.is_some() {
        merged.fact.model = owner.1;
    }
    merged.fact.occurred_at = owner.2;
    merged.fact.native_session_id = owner.3;
    merged.fact.parent_native_session_id = owner.4;
    merged.fact.subagent = owner.5;
    merged.fact.cwd = owner.6;
    merged.fact.threadterm_session_id = owner.7;
    materialize_canonical_fact(conn, merged.fact, context)
}

pub fn finish_live_turn(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
    ended_at: &str,
) -> Result<()> {
    if conn.is_autocommit() {
        let tx = super::write_priority::transaction(conn)?;
        finish_live_turn_inner(&tx, session_id, turn_id, ended_at)?;
        tx.commit()?;
    } else {
        finish_live_turn_inner(conn, session_id, turn_id, ended_at)?;
    }
    Ok(())
}

/// Moves early live facts from the ThreadTerm-id fallback coordinate to the
/// provider's native session id once that identity becomes available. Previously
/// known native identities remain historical facts across fresh-session recovery.
pub fn bind_live_native(
    conn: &Connection,
    threadterm_session_id: &str,
    native_session_id: &str,
) -> Result<()> {
    if conn.is_autocommit() {
        let tx = super::write_priority::transaction(conn)?;
        bind_live_native_inner(&tx, threadterm_session_id, native_session_id)?;
        tx.commit()?;
    } else {
        bind_live_native_inner(conn, threadterm_session_id, native_session_id)?;
    }
    Ok(())
}

fn bind_live_native_inner(
    conn: &Connection,
    threadterm_session_id: &str,
    native_session_id: &str,
) -> Result<()> {
    let changed = conn
        .prepare_cached(
            "SELECT 1 FROM usage_fact_observations
             WHERE threadterm_session_id=? AND source LIKE 'live:%'
               AND native_session_id=? LIMIT 1",
        )?
        .query_row(
            params![threadterm_session_id, threadterm_session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !changed {
        return Ok(());
    }
    let mut statement = conn.prepare(
        "SELECT DISTINCT provider,native_session_id
         FROM usage_fact_observations
         WHERE threadterm_session_id=? AND source LIKE 'live:%'
           AND native_session_id=?",
    )?;
    let old_sessions = statement
        .query_map(
            params![threadterm_session_id, threadterm_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    drop(statement);
    conn.prepare_cached(
        "UPDATE usage_fact_observations SET native_session_id=?
         WHERE threadterm_session_id=? AND source LIKE 'live:%'
           AND native_session_id=?",
    )?
    .execute(params![
        native_session_id,
        threadterm_session_id,
        threadterm_session_id
    ])?;
    let mut context = RefreshContext::load(conn)?;
    let mut sessions = old_sessions;
    let mut cursor = String::new();
    loop {
        let mut statement = conn.prepare(
            "SELECT DISTINCT fact_key,provider FROM usage_fact_observations
             WHERE threadterm_session_id=? AND source LIKE 'live:%'
               AND native_session_id=? AND fact_key>?
             ORDER BY fact_key LIMIT ?",
        )?;
        let page = statement
            .query_map(
                params![
                    threadterm_session_id,
                    native_session_id,
                    cursor,
                    WRITE_BATCH as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        for (key, provider) in &page {
            if let Some(coordinate) = materialized_coordinate(conn, key)? {
                sessions.insert(coordinate);
            }
            refresh_fact(conn, key, &mut context)?;
            if let Some(coordinate) = materialized_coordinate(conn, key)? {
                sessions.insert(coordinate);
            }
            sessions.insert((provider.clone(), native_session_id.to_owned()));
        }
        cursor = page.last().map(|value| value.0.clone()).unwrap_or_default();
        if page.len() < WRITE_BATCH {
            break;
        }
    }
    let mut activity_days = BTreeSet::new();
    for (provider, native) in &sessions {
        activity_days.extend(session_interval_days(conn, provider, native)?);
    }
    for (provider, native) in &sessions {
        refresh_session_rollups(conn, provider, native)?;
    }
    for (provider, native) in &sessions {
        activity_days.extend(session_interval_days(conn, provider, native)?);
    }
    for local_day in activity_days {
        rebuild_activity_day(conn, &local_day)?;
    }
    Ok(())
}

fn session_interval_days(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<BTreeSet<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT local_day FROM usage_intervals
         WHERE provider=? AND native_session_id=?",
    )?;
    let days = statement
        .query_map(params![provider, native_session_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(days)
}

fn finish_live_turn_inner(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
    ended_at: &str,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT fact_key,provider,native_session_id,started_at,ended_at
         FROM usage_fact_observations
         WHERE threadterm_session_id=? AND turn_id=? AND source LIKE 'live:%'",
    )?;
    let affected = statement
        .query_map(params![session_id, turn_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    conn.prepare_cached(
        "UPDATE usage_fact_observations
         SET ended_at=CASE WHEN ended_at IS NULL THEN ? ELSE MAX(ended_at,?) END
         WHERE threadterm_session_id=? AND turn_id=? AND source LIKE 'live:%'",
    )?
    .execute(params![ended_at, ended_at, session_id, turn_id])?;
    let mut context = RefreshContext::load(conn)?;
    let mut sessions = BTreeSet::new();
    let mut activity_days = BTreeSet::new();
    for (key, provider, native_session, started_at, previous_end) in affected {
        if let Some(started_at) = started_at {
            let end_ms = previous_end
                .as_deref()
                .map(time::timestamp_millis)
                .transpose()?
                .unwrap_or(i64::MIN)
                .max(time::timestamp_millis(ended_at)?);
            activity_days.extend(local_days_for_interval(
                time::timestamp_millis(&started_at)?,
                end_ms,
            )?);
        }
        if let Some(coordinate) = materialized_coordinate(conn, &key)? {
            sessions.insert(coordinate);
        }
        refresh_fact(conn, &key, &mut context)?;
        sessions.insert((provider, native_session));
        if let Some(coordinate) = materialized_coordinate(conn, &key)? {
            sessions.insert(coordinate);
        }
    }
    for (provider, session) in sessions {
        refresh_session_rollups(conn, &provider, &session)?;
    }
    for local_day in activity_days {
        rebuild_activity_day(conn, &local_day)?;
    }
    Ok(())
}

pub fn remove_source(conn: &Connection, source_prefix: &str) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        remove_source_inner(&tx, source_prefix)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        remove_source_inner(conn, source_prefix)?;
    }
    Ok(())
}

fn remove_source_inner(conn: &Connection, source_prefix: &str) -> Result<()> {
    let mut upper = source_prefix.to_owned();
    loop {
        let ch = upper
            .pop()
            .ok_or_else(|| anyhow!("usage_source_prefix_unbounded"))?;
        if ch < '\u{10ffff}' {
            let next = if ch as u32 + 1 == 0xd800 {
                0xe000
            } else {
                ch as u32 + 1
            };
            upper.push(
                char::from_u32(next).ok_or_else(|| anyhow!("usage_source_prefix_unbounded"))?,
            );
            break;
        }
    }
    let has_source_rows = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM usage_fact_observations
            WHERE source>=?1 AND source<?2 LIMIT 1)
          OR EXISTS(
            SELECT 1 FROM usage_native_coverage
            WHERE source>=?1 AND source<?2 LIMIT 1)",
        params![source_prefix, upper],
        |row| row.get::<_, bool>(0),
    )?;
    if !has_source_rows {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_source_keys (
            fact_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_source_sessions (
            provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
            PRIMARY KEY(provider,native_session_id)
         ) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS usage_source_parents (
            provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
            PRIMARY KEY(provider,native_session_id)
         ) WITHOUT ROWID;
         DELETE FROM temp.usage_source_keys;
         DELETE FROM temp.usage_source_sessions;
         DELETE FROM temp.usage_source_parents;",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_keys(fact_key)
         SELECT fact_key FROM usage_fact_observations
         WHERE source>=? AND source<?",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_sessions(provider,native_session_id)
         SELECT provider,native_session_id FROM usage_fact_observations
         WHERE source>=? AND source<?",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_sessions(provider,native_session_id)
         SELECT provider,native_session_id FROM usage_native_coverage
         WHERE source>=? AND source<?",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_sessions(provider,native_session_id)
         SELECT f.provider,f.native_session_id FROM temp.usage_source_keys keys
         CROSS JOIN usage_facts f WHERE f.fact_key=keys.fact_key",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_parents(provider,native_session_id)
         SELECT provider,parent_native_session_id FROM usage_fact_observations
         WHERE source>=? AND source<?
           AND parent_native_session_id IS NOT NULL
           AND parent_native_session_id<>''",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "DELETE FROM usage_fact_observations WHERE source>=? AND source<?",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "DELETE FROM usage_native_coverage WHERE source>=? AND source<?",
        [source_prefix, upper.as_str()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO temp.usage_source_keys(fact_key)
         SELECT superseded.fact_key FROM temp.usage_source_sessions affected
         CROSS JOIN usage_superseded_facts superseded
            INDEXED BY usage_superseded_coordinate
         WHERE superseded.provider=affected.provider
           AND superseded.native_session_id=affected.native_session_id",
        [],
    )?;
    conn.execute(
        "DELETE FROM usage_superseded_facts
         WHERE (provider,native_session_id) IN (
            SELECT provider,native_session_id
            FROM temp.usage_source_sessions)",
        [],
    )?;
    let mut context = RefreshContext::load(conn)?;
    let mut key_cursor = String::new();
    loop {
        let mut statement = conn.prepare(
            "SELECT fact_key FROM temp.usage_source_keys
             WHERE fact_key>? ORDER BY fact_key LIMIT ?",
        )?;
        let page = statement
            .query_map(params![key_cursor, WRITE_BATCH as i64], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        for key in &page {
            refresh_fact(conn, key, &mut context)?;
            if let Some((provider, native_session_id)) = materialized_coordinate(conn, key)? {
                conn.execute(
                    "INSERT OR IGNORE INTO temp.usage_source_sessions(
                        provider,native_session_id) VALUES(?,?)",
                    params![provider, native_session_id],
                )?;
            }
            conn.execute(
                "INSERT OR IGNORE INTO temp.usage_source_parents(provider,native_session_id)
                 SELECT provider,parent_native_session_id FROM usage_facts
                 WHERE fact_key=? AND parent_native_session_id IS NOT NULL
                   AND parent_native_session_id<>''",
                [key],
            )?;
        }
        key_cursor = page.last().cloned().unwrap_or_default();
        if page.len() < WRITE_BATCH {
            break;
        }
    }
    let mut provider_cursor = String::new();
    let mut session_cursor = String::new();
    loop {
        let coordinate = conn
            .query_row(
                "SELECT provider,native_session_id FROM temp.usage_source_sessions
                 WHERE (provider,native_session_id)>(?,?)
                 ORDER BY provider,native_session_id LIMIT 1",
                params![provider_cursor, session_cursor],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((provider, session)) = coordinate else {
            break;
        };
        refresh_session_rollups(conn, &provider, &session)?;
        provider_cursor = provider;
        session_cursor = session;
    }
    provider_cursor.clear();
    session_cursor.clear();
    loop {
        let coordinate = conn
            .query_row(
                "SELECT provider,native_session_id FROM temp.usage_source_parents
                 WHERE (provider,native_session_id)>(?,?)
                 ORDER BY provider,native_session_id LIMIT 1",
                params![provider_cursor, session_cursor],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((provider, parent)) = coordinate else {
            break;
        };
        refresh_session_metadata(conn, &provider, &parent)?;
        provider_cursor = provider;
        session_cursor = parent;
    }
    conn.execute_batch(
        "DELETE FROM temp.usage_source_keys;
         DELETE FROM temp.usage_source_sessions;
         DELETE FROM temp.usage_source_parents;",
    )?;
    Ok(())
}

pub fn rebuild_native(conn: &Connection) -> Result<()> {
    rebuild_native_cancellable(conn, &AtomicBool::new(false))?;
    Ok(())
}
pub fn rebuild_native_cancellable(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    super::native_rebuild::rebuild(conn, cancelled)
}

pub fn remove_fact_keys(conn: &Connection, keys: &[String]) -> Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    if conn.is_autocommit() {
        let tx = super::write_priority::transaction(conn)?;
        remove_fact_keys_inner(&tx, keys)?;
        tx.commit()?;
    } else {
        remove_fact_keys_inner(conn, keys)?;
    }
    Ok(())
}

fn remove_fact_keys_inner(conn: &Connection, keys: &[String]) -> Result<()> {
    let mut sessions = BTreeSet::new();
    let mut parents = BTreeSet::new();
    for key in keys {
        if let Some((provider, parent)) = conn
            .query_row(
                "SELECT provider,parent_native_session_id FROM usage_facts
                 WHERE fact_key=? AND parent_native_session_id IS NOT NULL",
                [key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            parents.insert((provider, parent));
        }
        if let Some(coordinate) = materialized_coordinate(conn, key)? {
            sessions.insert(coordinate);
        }
        let coordinate = conn
            .query_row(
                "SELECT provider,native_session_id FROM usage_fact_observations
                 WHERE fact_key=? LIMIT 1",
                [key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((provider, session)) = coordinate.as_ref() {
            sessions.insert((provider.clone(), session.clone()));
        }
        conn.execute(
            "INSERT INTO usage_superseded_facts(fact_key,provider,native_session_id)
             VALUES(?,?,?) ON CONFLICT(fact_key) DO UPDATE SET
             provider=excluded.provider,native_session_id=excluded.native_session_id",
            params![
                key,
                coordinate.as_ref().map(|value| value.0.as_str()),
                coordinate.as_ref().map(|value| value.1.as_str()),
            ],
        )?;
        conn.execute("DELETE FROM usage_facts WHERE fact_key=?", [key])?;
    }
    for (provider, session) in sessions {
        refresh_session_rollups(conn, &provider, &session)?;
    }
    for (provider, parent) in parents {
        refresh_session_metadata(conn, &provider, &parent)?;
    }
    Ok(())
}

pub fn cover_session(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    source: &str,
) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        cover_session_inner(&tx, provider, native_session_id, source)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        cover_session_inner(conn, provider, native_session_id, source)?;
    }
    Ok(())
}

fn cover_session_inner(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    source: &str,
) -> Result<()> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO usage_native_coverage(
            provider,native_session_id,source,covered_at)
         VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![provider, native_session_id, source],
    )?;
    // Coverage changes the effective set only on the first source for this
    // coordinate and only when live-only canonical facts are present. Native
    // first scans otherwise paid a second full-session rebuild per file.
    let changes_effective_set = changed > 0
        && conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM usage_native_coverage
                 WHERE provider=? AND native_session_id=?)=1
                AND EXISTS(
                    SELECT 1 FROM usage_facts f
                    WHERE f.provider=? AND f.native_session_id=?
                      AND NOT EXISTS(
                          SELECT 1 FROM usage_fact_observations n
                          WHERE n.fact_key=f.fact_key
                            AND n.source LIKE 'native:%'))",
            params![provider, native_session_id, provider, native_session_id],
            |row| row.get::<_, bool>(0),
        )?;
    if changes_effective_set {
        refresh_session_rollups(conn, provider, native_session_id)?;
    }
    Ok(())
}

/// Rebuilds rollups, intervals, and session metadata for one native session.
/// Benchmarks and repair workers may call it after bulk seeding.
pub fn rebuild_session(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    refresh_session_rollups(conn, provider, native_session_id)
}

/// Refresh cached ownership only when explicit refresh observes changed app metadata.
pub fn refresh_attributions(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    let mut hash = Sha256::new();
    for sql in [
        "SELECT id,provider,COALESCE(native_id,''),COALESCE(project_id,''),COALESCE(worktree_path,'') FROM sessions ORDER BY id",
        "SELECT id,name,path FROM projects ORDER BY id",
    ] {
        let mut statement=conn.prepare(sql)?;
        let count=statement.column_count();
        let mut rows=statement.query([])?;
        while let Some(row)=rows.next()? {
            if cancelled.load(Ordering::Relaxed) { return Ok(false); }
            for index in 0..count {
                let value:String=row.get(index)?;
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
        }
    }
    let revision = format!("{:x}", hash.finalize());
    if state(conn, "attribution-revision")?.as_deref() == Some(&revision) {
        return Ok(true);
    }
    let mut cursor = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let mut statement=conn.prepare("SELECT fact_key,provider,native_session_id,cwd,CASE WHEN source LIKE 'live:%' THEN threadterm_session_id END FROM usage_facts WHERE fact_key>? ORDER BY fact_key LIMIT 512")?;
        let page = statement
            .query_map([&cursor], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        let mut context = RefreshContext::load(&tx)?;
        for (key, provider, native, cwd, tt) in &page {
            let mut fact = Fact::new(provider, native, key, "2000-01-01T00:00:00Z");
            fact.cwd = cwd.clone();
            fact.threadterm_session_id = tt.clone();
            let attribution = context.attribution(&tx, &fact)?;
            tx.execute("UPDATE usage_facts SET threadterm_session_id=?,project_id=?,scope=? WHERE fact_key=?",params![(!attribution.threadterm_session_id.is_empty()).then_some(attribution.threadterm_session_id),attribution.project_id,attribution.scope,key])?;
        }
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
        cursor = page.last().unwrap().0.clone();
    }
    if !rebuild_all_rollups(conn, cancelled)? {
        return Ok(false);
    }
    let write_start = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    set_state(&tx, "attribution-revision", &revision)?;
    tx.commit()?;
    record_write_duration(write_start);
    checkpoint_index_connection(conn)?;
    Ok(true)
}

/// Rebuilds all materialized query tables after a raw bulk seed or repair.
/// Each native session is committed independently by the caller's connection;
/// cancellation leaves already rebuilt sessions valid and returns `false`.
pub fn rebuild_all_rollups(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    let mut cursor_provider = String::new();
    let mut cursor_session = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let coordinate = conn
            .query_row(
                "SELECT provider,native_session_id FROM usage_facts
                 WHERE (provider,native_session_id)>(?,?)
                 GROUP BY provider,native_session_id
                 ORDER BY provider,native_session_id LIMIT 1",
                params![cursor_provider, cursor_session],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((provider, session)) = coordinate else {
            break;
        };
        refresh_session_rollups(conn, &provider, &session)?;
        cursor_provider = provider;
        cursor_session = session;
    }
    rebuild_dirty_activity(conn, cancelled)
}

pub(super) fn refresh_session_rollups(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        refresh_session_rollups_inner(&tx, provider, native_session_id, true)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        refresh_session_rollups_inner(conn, provider, native_session_id, true)?;
    }
    Ok(())
}

fn refresh_session_pricing(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        refresh_session_rollups_inner(&tx, provider, native_session_id, false)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        refresh_session_rollups_inner(conn, provider, native_session_id, false)?;
    }
    Ok(())
}

fn refresh_session_rollups_inner(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    refresh_activity: bool,
) -> Result<()> {
    #[cfg(test)]
    let stage_started = std::time::Instant::now();
    super::materialized::snapshot(conn, provider, native_session_id)?;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FULL_SNAPSHOT_US, stage_started);
    #[cfg(test)]
    let stage_started = std::time::Instant::now();
    conn.prepare_cached(
        "DELETE FROM usage_daily_rollups WHERE provider=? AND native_session_id=?",
    )?
    .execute(params![provider, native_session_id])?;
    conn.prepare_cached(&format!(
            "INSERT INTO usage_daily_rollups(
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
             SELECT f.local_day,f.provider,COALESCE(f.model,''),f.project_id,
                f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope,
                SUM(COALESCE(f.input_tokens,0)),SUM(COALESCE(f.cache_read_tokens,0)),
                SUM(COALESCE(f.cache_write5m_tokens,0)),SUM(COALESCE(f.cache_write1h_tokens,0)),
                SUM(COALESCE(f.cache_write_unknown_tokens,0)),SUM(COALESCE(f.output_tokens,0)),
                SUM(COALESCE(f.reasoning_tokens,0)),SUM(f.input_tokens IS NOT NULL),
                SUM(f.cache_read_tokens IS NOT NULL),SUM(f.cache_write5m_tokens IS NOT NULL),
                SUM(f.cache_write1h_tokens IS NOT NULL),SUM(f.cache_write_unknown_tokens IS NOT NULL),
                SUM(f.output_tokens IS NOT NULL),SUM(f.reasoning_tokens IS NOT NULL),
                SUM(COALESCE(f.reported_cost,0)),SUM(COALESCE(f.estimated_cost,0)),
                SUM(CASE WHEN f.estimated_cost IS NOT NULL THEN
                    COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                    COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                    COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
                SUM(CASE WHEN f.estimated_cost IS NULL THEN
                    COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                    COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                    COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
                COUNT(*),SUM(f.reported_cost IS NOT NULL),SUM(f.estimated_cost IS NOT NULL),
                SUM(f.quality='exact'),SUM(f.quality='derived'),SUM(f.quality='estimated'),
                SUM(CASE WHEN f.quality='exact' THEN
                    COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                    COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                    COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
                SUM(CASE WHEN f.quality='derived' THEN
                    COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                    COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                    COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
                SUM(CASE WHEN f.quality='estimated' THEN
                    COALESCE(f.input_tokens,0)+COALESCE(f.cache_read_tokens,0)+
                    COALESCE(f.cache_write5m_tokens,0)+COALESCE(f.cache_write1h_tokens,0)+
                    COALESCE(f.cache_write_unknown_tokens,0)+COALESCE(f.output_tokens,0) ELSE 0 END),
                MIN(f.occurred_at),MAX(f.occurred_at)
             FROM usage_facts f
             WHERE f.provider=? AND f.native_session_id=? AND {EFFECTIVE_FACT}
             GROUP BY f.local_day,f.provider,COALESCE(f.model,''),f.project_id,
                      f.native_session_id,COALESCE(f.threadterm_session_id,''),f.scope"
        ))?.execute(
        params![provider, native_session_id],
    )?;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FULL_ROLLUPS_US, stage_started);
    if refresh_activity {
        #[cfg(test)]
        let stage_started = std::time::Instant::now();
        refresh_intervals(conn, provider, native_session_id)?;
        #[cfg(test)]
        ingestion_profile_add(&PROFILE_FULL_INTERVALS_US, stage_started);
    }
    #[cfg(test)]
    let stage_started = std::time::Instant::now();
    super::live_fallback::refresh(conn, provider, native_session_id)?;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FULL_LIVE_US, stage_started);
    #[cfg(test)]
    let stage_started = std::time::Instant::now();
    refresh_session_metadata(conn, provider, native_session_id)?;
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FULL_METADATA_US, stage_started);
    #[cfg(test)]
    let stage_started = std::time::Instant::now();
    let result = super::materialized::replace(conn, provider, native_session_id);
    #[cfg(test)]
    ingestion_profile_add(&PROFILE_FULL_MATERIALIZED_US, stage_started);
    result
}

#[derive(Clone, PartialEq, Eq)]
struct MaterializedInterval {
    model: String,
    project_id: String,
    threadterm_session_id: String,
    scope: String,
    start_ms: i64,
    end_ms: i64,
    estimated: bool,
}

fn insert_interval(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    interval: &MaterializedInterval,
) -> Result<()> {
    let mut start_ms = interval.start_ms;
    while interval.end_ms > start_ms {
        let local_day = local_day_for_millis(start_ms)?;
        let (_, day_end_ms) = local_day_bounds_millis(&local_day)?;
        let end_ms = interval.end_ms.min(day_end_ms);
        if end_ms <= start_ms {
            return Err(anyhow!("invalid_usage_day_boundary"));
        }
        conn.prepare_cached(
            "INSERT OR IGNORE INTO usage_intervals(
                provider,native_session_id,model,project_id,threadterm_session_id,
                scope,local_day,start_ms,end_ms,estimated) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )?
        .execute(params![
            provider,
            native_session_id,
            interval.model,
            interval.project_id,
            interval.threadterm_session_id,
            interval.scope,
            local_day,
            start_ms,
            end_ms,
            interval.estimated as i64,
        ])?;
        start_ms = end_ms;
    }
    Ok(())
}

fn refresh_intervals(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    snapshot_session_intervals(conn, provider, native_session_id)?;
    conn.prepare_cached("DELETE FROM usage_intervals WHERE provider=? AND native_session_id=?")?
        .execute(params![provider, native_session_id])?;
    refresh_live_intervals(conn, provider, native_session_id)?;
    refresh_native_intervals(conn, provider, native_session_id)?;
    mark_changed_interval_days(conn, provider, native_session_id)?;
    conn.prepare_cached("DELETE FROM temp.usage_old_intervals")?
        .execute([])?;
    Ok(())
}

fn local_day_for_millis(millis: i64) -> Result<String> {
    let timestamp = DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or_else(|| anyhow!("invalid_usage_timestamp"))?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    time::local_day(&timestamp)
}

fn local_day_bounds_millis(day: &str) -> Result<(i64, i64)> {
    let (start, end) = time::local_day_range(day)?;
    Ok((
        time::timestamp_millis(&start)?,
        time::timestamp_millis(&end)?,
    ))
}

fn local_days_for_interval(start_ms: i64, end_ms: i64) -> Result<BTreeSet<String>> {
    let mut days = BTreeSet::new();
    if end_ms <= start_ms {
        return Ok(days);
    }
    let first = NaiveDate::parse_from_str(&local_day_for_millis(start_ms)?, "%Y-%m-%d")?;
    let last = NaiveDate::parse_from_str(&local_day_for_millis(end_ms - 1)?, "%Y-%m-%d")?;
    let mut day = first;
    while day <= last {
        days.insert(day.format("%Y-%m-%d").to_string());
        day = day
            .succ_opt()
            .ok_or_else(|| anyhow!("invalid_usage_day_range"))?;
    }
    Ok(days)
}

fn snapshot_session_intervals(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS usage_old_intervals (
            model TEXT NOT NULL, project_id TEXT NOT NULL,
            threadterm_session_id TEXT NOT NULL, scope TEXT NOT NULL,
            local_day TEXT NOT NULL, start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL, estimated INTEGER NOT NULL,
            PRIMARY KEY(model,project_id,threadterm_session_id,scope,
                        local_day,start_ms,end_ms,estimated)
        ) WITHOUT ROWID;
        DELETE FROM temp.usage_old_intervals;",
    )?;
    conn.prepare_cached(
        "INSERT INTO temp.usage_old_intervals(
            model,project_id,threadterm_session_id,scope,local_day,
            start_ms,end_ms,estimated)
         SELECT model,project_id,threadterm_session_id,scope,local_day,
                start_ms,end_ms,estimated
         FROM usage_intervals WHERE provider=? AND native_session_id=?",
    )?
    .execute(params![provider, native_session_id])?;
    Ok(())
}

fn mark_changed_interval_days(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    const COLUMNS: &str =
        "model,project_id,threadterm_session_id,scope,local_day,start_ms,end_ms,estimated";
    conn.prepare_cached(&format!(
        "INSERT OR IGNORE INTO usage_activity_dirty(local_day)
             SELECT local_day FROM (
                SELECT {COLUMNS} FROM temp.usage_old_intervals
                EXCEPT
                SELECT {COLUMNS} FROM usage_intervals
                 WHERE provider=? AND native_session_id=?
             )"
    ))?
    .execute(params![provider, native_session_id])?;
    conn.prepare_cached(&format!(
        "INSERT OR IGNORE INTO usage_activity_dirty(local_day)
             SELECT local_day FROM (
                SELECT {COLUMNS} FROM usage_intervals
                 WHERE provider=? AND native_session_id=?
                EXCEPT
                SELECT {COLUMNS} FROM temp.usage_old_intervals
             )"
    ))?
    .execute(params![provider, native_session_id])?;
    Ok(())
}

fn refresh_live_intervals(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    let mut cursor_turn = String::new();
    let mut cursor_at = String::new();
    let mut cursor_key = String::new();
    let mut pending: Option<(String, MaterializedInterval)> = None;
    loop {
        let sql = format!(
            "SELECT COALESCE(f.turn_id,f.fact_key),f.occurred_at,f.fact_key,COALESCE(f.model,''),
                    f.project_id,COALESCE(f.threadterm_session_id,''),f.scope,
                    f.started_at,f.ended_at
             FROM usage_facts f
             WHERE f.provider=? AND f.native_session_id=? AND {EFFECTIVE_FACT}
               AND NOT EXISTS (SELECT 1 FROM usage_fact_observations native
                   WHERE native.fact_key=f.fact_key AND native.source LIKE 'native:%')
               AND f.started_at IS NOT NULL AND f.ended_at IS NOT NULL
               AND (COALESCE(f.turn_id,f.fact_key)>?
                    OR (COALESCE(f.turn_id,f.fact_key)=? AND
                       (f.occurred_at>? OR (f.occurred_at=? AND f.fact_key>?))))
             ORDER BY COALESCE(f.turn_id,f.fact_key),f.occurred_at,f.fact_key
             LIMIT {WRITE_BATCH}"
        );
        let mut statement = conn.prepare(&sql)?;
        let page = statement
            .query_map(
                params![
                    provider,
                    native_session_id,
                    cursor_turn,
                    cursor_turn,
                    cursor_at,
                    cursor_at,
                    cursor_key
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        for (turn, occurred_at, key, model, project_id, threadterm_session_id, scope, start, end) in
            page
        {
            let start_ms = time::timestamp_millis(&start)?;
            let end_ms = time::timestamp_millis(&end)?;
            if let Some((pending_turn, interval)) = pending.as_mut() {
                if *pending_turn == turn {
                    interval.start_ms = interval.start_ms.min(start_ms);
                    interval.end_ms = interval.end_ms.max(end_ms);
                    interval.model = model;
                    interval.project_id = project_id;
                    interval.threadterm_session_id = threadterm_session_id;
                    interval.scope = scope;
                } else {
                    insert_interval(conn, provider, native_session_id, interval)?;
                    *pending_turn = turn.clone();
                    *interval = MaterializedInterval {
                        model,
                        project_id,
                        threadterm_session_id,
                        scope,
                        start_ms,
                        end_ms,
                        estimated: false,
                    };
                }
            } else {
                pending = Some((
                    turn.clone(),
                    MaterializedInterval {
                        model,
                        project_id,
                        threadterm_session_id,
                        scope,
                        start_ms,
                        end_ms,
                        estimated: false,
                    },
                ));
            }
            cursor_turn = turn;
            cursor_at = occurred_at;
            cursor_key = key;
        }
    }
    if let Some((_, interval)) = pending {
        insert_interval(conn, provider, native_session_id, &interval)?;
    }
    Ok(())
}

fn refresh_native_intervals(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    let mut cursor_at = String::new();
    let mut cursor_key = String::new();
    let mut previous_ms = None;
    let mut pending: Option<MaterializedInterval> = None;
    loop {
        let sql = format!(
            "SELECT f.occurred_at,f.fact_key,COALESCE(f.model,''),f.project_id,
                    COALESCE(f.threadterm_session_id,''),f.scope
             FROM usage_facts f
             WHERE f.provider=? AND f.native_session_id=? AND {EFFECTIVE_FACT}
               AND EXISTS (SELECT 1 FROM usage_fact_observations native
                   WHERE native.fact_key=f.fact_key AND native.source LIKE 'native:%')
               AND (f.occurred_at>? OR (f.occurred_at=? AND f.fact_key>?))
             ORDER BY f.occurred_at,f.fact_key LIMIT {WRITE_BATCH}"
        );
        let mut statement = conn.prepare(&sql)?;
        let page = statement
            .query_map(
                params![
                    provider,
                    native_session_id,
                    cursor_at,
                    cursor_at,
                    cursor_key
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if page.is_empty() {
            break;
        }
        for (occurred_at, key, model, project_id, threadterm_session_id, scope) in page {
            let current_ms = time::timestamp_millis(&occurred_at)?;
            if let Some(previous) = previous_ms {
                let gap = current_ms - previous;
                if gap > 0 && gap < NATIVE_ACTIVE_GAP_MS {
                    let next = MaterializedInterval {
                        model,
                        project_id,
                        threadterm_session_id,
                        scope,
                        start_ms: previous,
                        end_ms: current_ms,
                        estimated: true,
                    };
                    if let Some(active) = pending.as_mut() {
                        if active.model == next.model
                            && active.project_id == next.project_id
                            && active.threadterm_session_id == next.threadterm_session_id
                            && active.scope == next.scope
                            && next.start_ms <= active.end_ms
                        {
                            active.end_ms = active.end_ms.max(next.end_ms);
                        } else {
                            insert_interval(conn, provider, native_session_id, active)?;
                            *active = next;
                        }
                    } else {
                        pending = Some(next);
                    }
                } else if let Some(active) = pending.take() {
                    insert_interval(conn, provider, native_session_id, &active)?;
                }
            }
            previous_ms = Some(current_ms);
            cursor_at = occurred_at;
            cursor_key = key;
        }
    }
    if let Some(interval) = pending {
        insert_interval(conn, provider, native_session_id, &interval)?;
    }
    Ok(())
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct ActivityKey {
    dimensions_mask: i64,
    provider: String,
    model: String,
    project_id: String,
    scope: String,
}

struct ActivityUnion {
    start_ms: i64,
    end_ms: i64,
    completed_ms: i64,
    estimated: bool,
}

impl ActivityUnion {
    fn new(start_ms: i64, end_ms: i64, estimated: bool) -> Self {
        Self {
            start_ms,
            end_ms,
            completed_ms: 0,
            estimated,
        }
    }

    fn add(&mut self, start_ms: i64, end_ms: i64, estimated: bool) {
        self.estimated |= estimated;
        if start_ms <= self.end_ms {
            self.end_ms = self.end_ms.max(end_ms);
        } else {
            self.completed_ms += self.end_ms - self.start_ms;
            self.start_ms = start_ms;
            self.end_ms = end_ms;
        }
    }

    fn total_ms(&self) -> i64 {
        self.completed_ms + self.end_ms - self.start_ms
    }
}

fn activity_key(
    dimensions_mask: i64,
    provider: &str,
    model: &str,
    project_id: &str,
    scope: &str,
) -> ActivityKey {
    ActivityKey {
        dimensions_mask,
        provider: if dimensions_mask & ACTIVITY_PROVIDER_MASK != 0 {
            provider.to_owned()
        } else {
            String::new()
        },
        model: if dimensions_mask & ACTIVITY_MODEL_MASK != 0 {
            model.to_owned()
        } else {
            String::new()
        },
        project_id: if dimensions_mask & ACTIVITY_PROJECT_MASK != 0 {
            project_id.to_owned()
        } else {
            String::new()
        },
        scope: if dimensions_mask & ACTIVITY_SCOPE_MASK != 0 {
            scope.to_owned()
        } else {
            String::new()
        },
    }
}

fn rebuild_activity_day(conn: &Connection, local_day: &str) -> Result<()> {
    if conn.is_autocommit() {
        let write_start = std::time::Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        rebuild_activity_day_inner(&tx, local_day)?;
        tx.commit()?;
        record_write_duration(write_start);
        checkpoint_index_connection(conn)?;
    } else {
        rebuild_activity_day_inner(conn, local_day)?;
    }
    Ok(())
}

fn rebuild_activity_day_inner(conn: &Connection, local_day: &str) -> Result<()> {
    let mut unions = BTreeMap::<ActivityKey, ActivityUnion>::new();
    let mut statement = conn.prepare(
        "SELECT provider,model,project_id,scope,start_ms,end_ms,estimated
         FROM usage_intervals WHERE local_day=? ORDER BY start_ms,end_ms",
    )?;
    let mut rows = statement.query([local_day])?;
    while let Some(row) = rows.next()? {
        let provider = row.get::<_, String>(0)?;
        let model = row.get::<_, String>(1)?;
        let project_id = row.get::<_, String>(2)?;
        let scope = row.get::<_, String>(3)?;
        let start_ms = row.get::<_, i64>(4)?;
        let end_ms = row.get::<_, i64>(5)?;
        let estimated = row.get::<_, i64>(6)? != 0;
        for dimensions_mask in 0_i64..16 {
            let key = activity_key(dimensions_mask, &provider, &model, &project_id, &scope);
            unions
                .entry(key)
                .and_modify(|union| union.add(start_ms, end_ms, estimated))
                .or_insert_with(|| ActivityUnion::new(start_ms, end_ms, estimated));
        }
    }
    drop(rows);
    drop(statement);
    conn.execute(
        "DELETE FROM usage_activity_daily WHERE local_day=?",
        [local_day],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO usage_activity_daily(
            local_day,dimensions_mask,provider,model,project_id,scope,
            active_ms,estimated) VALUES(?,?,?,?,?,?,?,?)",
    )?;
    for (key, union) in unions {
        insert.execute(params![
            local_day,
            key.dimensions_mask,
            key.provider,
            key.model,
            key.project_id,
            key.scope,
            union.total_ms(),
            union.estimated as i64,
        ])?;
    }
    drop(insert);
    conn.execute(
        "DELETE FROM usage_activity_dirty WHERE local_day=?",
        [local_day],
    )?;
    Ok(())
}

/// Rebuilds exact daily active-time unions for days changed by ingestion.
/// Each day commits independently so cancellation leaves completed days valid.
pub fn rebuild_dirty_activity(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let local_day = conn
            .query_row(
                "SELECT local_day FROM usage_activity_dirty ORDER BY local_day LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(local_day) = local_day else {
            return Ok(true);
        };
        rebuild_activity_day(conn, &local_day)?;
    }
}

/// Reports whether active-time materialization is pending in a selected
/// half-open local-day range. `None` leaves that range edge unbounded.
pub fn activity_dirty(
    conn: &Connection,
    from_day: Option<&str>,
    to_day: Option<&str>,
) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM usage_activity_dirty
             WHERE (? IS NULL OR local_day>=?) AND (? IS NULL OR local_day<?)
             LIMIT 1",
            params![from_day, from_day, to_day, to_day],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub(super) fn refresh_session_metadata(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    refresh_session_metadata_inner(conn, provider, native_session_id, false)
}

fn refresh_appended_session_metadata(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    refresh_session_metadata_inner(conn, provider, native_session_id, true)
}

fn refresh_session_metadata_inner(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
    incremental: bool,
) -> Result<()> {
    let normal = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM usage_daily_rollups WHERE provider=? AND native_session_id=?)",
        params![provider, native_session_id],
        |r| r.get::<_, bool>(0),
    )?;
    let table = if normal {
        "usage_daily_rollups"
    } else {
        "usage_live_rollups"
    };
    let summary = conn
        .prepare_cached(&format!(
            "SELECT COALESCE(MAX(NULLIF(threadterm_session_id,'')),''),
                COALESCE(MAX(NULLIF(project_id,'')),''),
                CASE WHEN SUM(scope='threadterm')>0 THEN 'threadterm' ELSE 'outside' END,
                SUM(requests),
                SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+
                    cache_write1h_tokens+cache_write_unknown_tokens+output_tokens),
                MIN(first_occurred_at),MAX(last_occurred_at)
         FROM {table} WHERE provider=? AND native_session_id=?"
        ))?
        .query_row(params![provider, native_session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
    let Some(requests) = summary.3 else {
        conn.prepare_cached(
            "DELETE FROM usage_ledger_sessions WHERE provider=? AND native_session_id=?",
        )?
        .execute(params![provider, native_session_id])?;
        return Ok(());
    };
    let mut model_statement = conn.prepare(&format!("SELECT DISTINCT model FROM {table} WHERE provider=? AND native_session_id=? ORDER BY model"))?;
    let models = model_statement
        .query_map(params![provider, native_session_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(model_statement);
    let predicate = if normal { EFFECTIVE_FACT } else { "1" };
    let detail_sql = if incremental {
        format!(
            "SELECT MAX(f.cwd),MAX(f.parent_native_session_id),MAX(f.subagent)
             FROM (
                SELECT cwd,parent_native_session_id,subagent
                FROM usage_ledger_sessions
                WHERE provider=?1 AND native_session_id=?2
                UNION ALL
                SELECT f.cwd,f.parent_native_session_id,f.subagent
                FROM temp.usage_incremental_changed c
                CROSS JOIN usage_facts f
                WHERE f.fact_key=c.fact_key
                  AND f.provider=?1 AND f.native_session_id=?2 AND {predicate}
             ) f"
        )
    } else {
        format!(
            "SELECT MAX(f.cwd),MAX(f.parent_native_session_id),MAX(f.subagent)
             FROM usage_facts f WHERE f.provider=? AND f.native_session_id=? AND {predicate}"
        )
    };
    let (cwd, parent, subagent): (Option<String>, Option<String>, i64) = conn
        .prepare_cached(&detail_sql)?
        .query_row(params![provider, native_session_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })?;
    let project_name = if summary.1.is_empty() {
        String::new()
    } else {
        conn.prepare_cached("SELECT name FROM projects WHERE id=?")?
            .query_row([&summary.1], |row| row.get(0))
            .optional()?
            .unwrap_or_default()
    };
    let existing_subagent_count: Option<i64> = incremental
        .then(|| {
            conn.prepare_cached(
                "SELECT subagent_count FROM usage_ledger_sessions
                 WHERE provider=? AND native_session_id=?",
            )?
            .query_row(params![provider, native_session_id], |row| row.get(0))
            .optional()
            .map_err(anyhow::Error::from)
        })
        .transpose()?
        .flatten();
    let subagent_count = if let Some(count) = existing_subagent_count {
        count
    } else {
        count_subagent_sessions(conn, provider, native_session_id)?
    };
    conn.prepare_cached(
        "INSERT INTO usage_ledger_sessions(
            provider,native_session_id,threadterm_session_id,project_id,
            project_name,cwd,scope,parent_native_session_id,subagent,
            first_occurred_at,last_occurred_at,models,requests,tokens,subagent_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider,native_session_id) DO UPDATE SET
            threadterm_session_id=excluded.threadterm_session_id,
            project_id=excluded.project_id,project_name=excluded.project_name,
            cwd=excluded.cwd,scope=excluded.scope,
            parent_native_session_id=excluded.parent_native_session_id,
            subagent=excluded.subagent,first_occurred_at=excluded.first_occurred_at,
            last_occurred_at=excluded.last_occurred_at,models=excluded.models,
            requests=excluded.requests,tokens=excluded.tokens,
            subagent_count=excluded.subagent_count",
    )?
    .execute(params![
        provider,
        native_session_id,
        summary.0,
        summary.1,
        project_name,
        cwd,
        summary.2,
        parent,
        subagent,
        summary.5.unwrap_or_default(),
        summary.6.unwrap_or_default(),
        serde_json::to_string(&models)?,
        requests,
        summary.4.unwrap_or(0),
        subagent_count,
    ])?;
    Ok(())
}

fn count_subagent_sessions(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<i64> {
    let child_sql = format!(
        "SELECT COUNT(DISTINCT f.native_session_id) FROM usage_facts f
         WHERE f.provider=? AND f.parent_native_session_id=? AND f.subagent=1
           AND {EFFECTIVE_FACT}"
    );
    Ok(conn
        .prepare_cached(&child_sql)?
        .query_row(params![provider, native_session_id], |row| row.get(0))?)
}

fn refresh_parent_subagent_count(
    conn: &Connection,
    provider: &str,
    native_session_id: &str,
) -> Result<()> {
    let count = count_subagent_sessions(conn, provider, native_session_id)?;
    let updated = conn
        .prepare_cached(
            "UPDATE usage_ledger_sessions SET subagent_count=?
             WHERE provider=? AND native_session_id=?",
        )?
        .execute(params![count, provider, native_session_id])?;
    if updated == 0 {
        refresh_session_metadata(conn, provider, native_session_id)?;
    }
    Ok(())
}

fn current_overrides(conn: &Connection) -> Result<Value> {
    let raw = state(conn, PRICE_OVERRIDES_KEY)?;
    Ok(raw
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| serde_json::json!({})))
}

fn state(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM usage_ledger_state WHERE key=?",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

fn set_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO usage_ledger_state(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn price_revision(overrides: &Value) -> Result<(String, String)> {
    let json = serde_json::to_string(overrides)?;
    let mut hash = Sha256::new();
    hash.update(prices::catalog_revision().as_bytes());
    hash.update(json.as_bytes());
    Ok((hex::encode(hash.finalize()), json))
}

pub fn pricing_state(conn: &Connection) -> Result<(Option<String>, Option<String>)> {
    Ok((
        state(conn, PRICE_REVISION_KEY)?,
        state(conn, PRICE_PENDING_KEY)?,
    ))
}

/// Mark changed effective rates before queuing a worker, including while a
/// history scan is still running. Queries must not display stale estimates.
pub fn request_reprice(conn: &Connection, overrides: &Value) -> Result<bool> {
    let (revision, _) = price_revision(overrides)?;
    if state(conn, PRICE_REVISION_KEY)?.as_deref() == Some(&revision)
        && state(conn, PRICE_PENDING_KEY)?.is_none()
    {
        return Ok(false);
    }
    set_state(conn, PRICE_PENDING_KEY, &revision)?;
    set_state(conn, PRICE_PENDING_COMPAT_KEY, "1")?;
    Ok(true)
}

pub fn reprice_all(conn: &Connection, overrides: &Value, cancelled: &AtomicBool) -> Result<bool> {
    let (revision, overrides_json) = price_revision(overrides)?;
    if state(conn, PRICE_REVISION_KEY)?.as_deref() == Some(&revision)
        && state(conn, PRICE_PENDING_KEY)?.is_none()
    {
        return Ok(true);
    }
    let write_start = std::time::Instant::now();
    let state_tx = super::write_priority::transaction(conn)?;
    set_state(&state_tx, PRICE_OVERRIDES_KEY, &overrides_json)?;
    set_state(&state_tx, PRICE_PENDING_KEY, &revision)?;
    set_state(&state_tx, PRICE_PENDING_COMPAT_KEY, "1")?;
    state_tx.commit()?;
    record_write_duration(write_start);
    checkpoint_index_connection(conn)?;
    let mut cursor_provider = String::new();
    let mut cursor_session = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let coordinate = conn
            .query_row(
                "SELECT provider,native_session_id FROM usage_facts
                 WHERE (provider,native_session_id)>(?,?)
                 GROUP BY provider,native_session_id
                 ORDER BY provider,native_session_id LIMIT 1",
                params![cursor_provider, cursor_session],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((provider, session)) = coordinate else {
            break;
        };
        let mut fact_cursor = String::new();
        loop {
            let write_start = std::time::Instant::now();
            let tx = super::write_priority::transaction(conn)?;
            let mut statement = tx.prepare(
                "SELECT fact_key,provider,model,occurred_at,native_session_id,
                        parent_native_session_id,subagent,input_tokens,cache_read_tokens,
                        cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,
                        output_tokens,reasoning_tokens,quality,reported_cost,cwd,source,
                        parser_version,threadterm_session_id,turn_id,started_at,ended_at
                 FROM usage_facts
                 WHERE provider=? AND native_session_id=? AND fact_key>?
                 ORDER BY fact_key LIMIT ?",
            )?;
            let page = statement
                .query_map(
                    params![provider, session, fact_cursor, WRITE_BATCH as i64],
                    |row| {
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
                            source: row.get(17)?,
                            parser_version: row.get::<_, i64>(18)? as u32,
                            threadterm_session_id: row.get(19)?,
                            turn_id: row.get(20)?,
                            started_at: row.get(21)?,
                            ended_at: row.get(22)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            if page.is_empty() {
                tx.commit()?;
                record_write_duration(write_start);
                checkpoint_index_connection(conn)?;
                break;
            }
            for fact in &page {
                tx.execute(
                    "UPDATE usage_facts SET estimated_cost=? WHERE fact_key=?",
                    params![prices::estimate(fact, overrides), fact.key],
                )?;
            }
            tx.commit()?;
            record_write_duration(write_start);
            checkpoint_index_connection(conn)?;
            fact_cursor = page.last().map(|fact| fact.key.clone()).unwrap_or_default();
            if page.len() < WRITE_BATCH {
                break;
            }
            if cancelled.load(Ordering::Relaxed) {
                return Ok(false);
            }
        }
        refresh_session_pricing(conn, &provider, &session)?;
        cursor_provider = provider;
        cursor_session = session;
    }
    let write_start = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    set_state(&tx, PRICE_REVISION_KEY, &revision)?;
    tx.execute(
        "DELETE FROM usage_ledger_state WHERE key IN (?,?)",
        params![PRICE_PENDING_KEY, PRICE_PENDING_COMPAT_KEY],
    )?;
    tx.commit()?;
    record_write_duration(write_start);
    checkpoint_index_connection(conn)?;
    Ok(true)
}

pub fn import_legacy(conn: &Connection) -> Result<()> {
    let cancelled = AtomicBool::new(false);
    import_legacy_cancellable(conn, &cancelled).map(|_| ())
}

pub fn import_legacy_cancellable(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    if state(conn, "legacy-v2")?.is_some() {
        return Ok(true);
    }
    let mut session_cursor = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let session_id = conn
            .query_row(
                "SELECT session_id FROM usage_records WHERE session_id>?
                 GROUP BY session_id ORDER BY session_id LIMIT 1",
                [&session_cursor],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            break;
        };
        let native_id = conn
            .query_row(
                "SELECT native_id FROM sessions WHERE id=?",
                [&session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .unwrap_or_else(|| session_id.clone());
        let mut row_cursor = String::new();
        let mut coordinates = BTreeSet::new();
        let mut session_cancelled = false;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                session_cancelled = true;
                break;
            }
            let mut statement = conn.prepare(
                "SELECT id,provider,recorded_at,input_tokens,output_tokens,
                        estimated_cost,model FROM usage_records
                 WHERE session_id=? AND id>? ORDER BY id LIMIT ?",
            )?;
            let page = statement
                .query_map(params![session_id, row_cursor, WRITE_BATCH as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<f64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            if page.is_empty() {
                break;
            }
            let write_start = std::time::Instant::now();
            let tx = super::write_priority::transaction(conn)?;
            let mut context = RefreshContext::load(&tx)?;
            for (id, provider, occurred_at, input, output, old_estimate, model) in &page {
                let mut fact =
                    Fact::new(provider, &native_id, &format!("legacy:{id}"), occurred_at);
                fact.source = format!("live:legacy:{session_id}");
                fact.threadterm_session_id = Some(session_id.clone());
                fact.turn_id = id
                    .strip_prefix(&format!("{session_id}:"))
                    .and_then(|value| value.strip_suffix(":usage"))
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                fact.model = model.clone();
                fact.buckets.input = *input;
                fact.buckets.output = *output;
                fact.quality = "estimated".into();
                write_observation(&tx, &fact, &context.overrides)?;
                refresh_fact(&tx, &fact.key, &mut context)?;
                if let Some(cost) = old_estimate.filter(|cost| cost.is_finite() && *cost >= 0.0) {
                    tx.execute(
                        "UPDATE usage_fact_observations SET estimated_cost=? WHERE source=? AND fact_key=?",
                        params![cost, fact.source, fact.key],
                    )?;
                    tx.execute(
                        "UPDATE usage_facts SET estimated_cost=? WHERE fact_key=?",
                        params![cost, fact.key],
                    )?;
                }
                coordinates.insert((provider.clone(), native_id.clone()));
            }
            tx.commit()?;
            record_write_duration(write_start);
            checkpoint_index_connection(conn)?;
            row_cursor = page.last().map(|row| row.0.clone()).unwrap_or_default();
            if page.len() < WRITE_BATCH {
                break;
            }
            if cancelled.load(Ordering::Relaxed) {
                session_cancelled = true;
                break;
            }
        }
        for (provider, native) in coordinates {
            refresh_session_rollups(conn, &provider, &native)?;
        }
        if session_cancelled {
            return Ok(false);
        }
        session_cursor = session_id;
    }
    let write_start = std::time::Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    set_state(&tx, "legacy-v2", "1")?;
    tx.commit()?;
    record_write_duration(write_start);
    checkpoint_index_connection(conn)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main.sqlite");
        let control = Connection::open(&main).unwrap();
        control
            .execute_batch(
                "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
                 CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,worktree_path TEXT,title TEXT,provider TEXT,mode TEXT,status TEXT,created_at TEXT,updated_at TEXT,native_id TEXT,exit_code INTEGER,followed INTEGER,read_only INTEGER);
                 CREATE TABLE usage_records(id TEXT PRIMARY KEY,session_id TEXT,provider TEXT,recorded_at TEXT,input_tokens INTEGER,output_tokens INTEGER,estimated_cost REAL,currency TEXT,model TEXT);",
            )
            .unwrap();
        drop(control);
        let conn = crate::usage_ledger::ledger_db::test_connection(&main).unwrap();
        (dir, conn)
    }

    fn fact(key: &str, input: i64, output: i64) -> Fact {
        let mut fact = Fact::new("fixture", "native", key, "2026-01-01T00:00:00.000Z");
        fact.source = "native:file@1".into();
        fact.model = Some("fixture-manual".into());
        fact.buckets.input = Some(input);
        fact.buckets.output = Some(output);
        fact
    }

    #[test]
    fn index_worker_uses_the_bounded_128_mib_page_cache() {
        let (_dir, conn) = db();
        configure_index_connection(&conn).unwrap();
        let pages_kib: i64 = conn
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .unwrap();
        assert_eq!(pages_kib, -131_072);
    }

    #[test]
    fn same_source_snapshots_merge_max_and_reprice_combined_buckets() {
        let (_dir, conn) = db();
        reprice_all(
            &conn,
            &serde_json::json!({"fixture/fixture-manual":{"input":1.0,"output":2.0}}),
            &AtomicBool::new(false),
        )
        .unwrap();
        upsert_fact(&conn, &fact("request", 3, 4)).unwrap();
        upsert_fact(&conn, &fact("request", 5, 2)).unwrap();
        let merged: (i64, i64, f64) = conn
            .query_row(
                "SELECT input_tokens,output_tokens,estimated_cost FROM usage_facts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((merged.0, merged.1), (5, 4));
        assert!((merged.2 - 0.000013).abs() < f64::EPSILON);
    }

    #[test]
    fn new_key_direct_materialization_matches_forced_observation_merge() {
        let (_direct_dir, direct) = db();
        let (_merged_dir, merged) = db();
        for conn in [&direct, &merged] {
            crate::usage_ledger::ledger_db::fixture_main(conn).execute(
                "INSERT INTO projects VALUES('project','Project','D:/workspace','0')",
                [],
            )
            .unwrap();
            set_state(
                conn,
                PRICE_OVERRIDES_KEY,
                &serde_json::json!({
                    "fixture/fixture-manual": {
                        "input": 1.0,
                        "cacheWrite5m": 2.0,
                        "cacheWrite1h": 3.0,
                        "output": 4.0
                    }
                })
                .to_string(),
            )
            .unwrap();
        }
        let mut value = fact("direct-equivalence", 7, 5);
        value.cwd = Some("D:/workspace/repo".into());
        value.buckets.cache_write_unknown = Some(11);
        value.buckets.cache_write5m = Some(3);
        value.buckets.cache_write1h = Some(2);
        value.buckets.reasoning = Some(4);
        value.quality = "unknown-reader-quality".into();
        value.parent_native_session_id = Some("parent".into());
        value.turn_id = Some("turn".into());

        upsert_fact(&direct, &value).unwrap();
        let context = RefreshContext::load(&merged).unwrap();
        write_observation(&merged, &value, &context.overrides).unwrap();
        assert_eq!(
            merged
                .query_row("SELECT COUNT(*) FROM usage_facts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        upsert_fact(&merged, &value).unwrap();

        let canonical = |conn: &Connection| {
            conn.query_row(
                "SELECT provider,model,local_day,native_session_id,
                        input_tokens,cache_write5m_tokens,cache_write1h_tokens,
                        cache_write_unknown_tokens,output_tokens,reasoning_tokens,
                        estimated_cost,cwd,project_id,scope,source
                 FROM usage_facts WHERE fact_key=?",
                [&value.key],
                |row| {
                    Ok((
                        (
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, Option<i64>>(5)?,
                            row.get::<_, Option<i64>>(6)?,
                            row.get::<_, Option<i64>>(7)?,
                        ),
                        (
                            row.get::<_, Option<i64>>(8)?,
                            row.get::<_, Option<i64>>(9)?,
                            row.get::<_, Option<f64>>(10)?,
                            row.get::<_, Option<String>>(11)?,
                            row.get::<_, String>(12)?,
                            row.get::<_, String>(13)?,
                            row.get::<_, String>(14)?,
                        ),
                    ))
                },
            )
            .unwrap()
        };
        assert_eq!(canonical(&direct), canonical(&merged));
        assert_eq!((canonical(&direct).0).7, Some(6));
        for conn in [&direct, &merged] {
            assert_eq!(
                conn.query_row("SELECT quality FROM usage_facts", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
                "estimated"
            );
        }
        let rollup = |conn: &Connection| {
            conn.query_row(
                "SELECT requests,input_tokens,cache_write5m_tokens,
                        cache_write1h_tokens,cache_write_unknown_tokens,
                        output_tokens,reasoning_tokens,estimated_cost,project_id,scope
                 FROM usage_daily_rollups",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, f64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .unwrap()
        };
        assert_eq!(rollup(&direct), rollup(&merged));
    }

    #[test]
    fn duplicate_native_ids_do_not_duplicate_rollups() {
        let (_dir, conn) = db();
        for (id, updated) in [("older", "1"), ("newer", "2")] {
            crate::usage_ledger::ledger_db::fixture_main(&conn)
                .execute(
                    "INSERT INTO sessions VALUES(?,NULL,NULL,'title','fixture','chat','idle','0',?,'native',NULL,0,0)",
                    params![id, updated],
                )
                .unwrap();
        }
        upsert_fact(&conn, &fact("one", 1, 2)).unwrap();
        let value: (i64, i64, String) = conn
            .query_row(
                "SELECT SUM(requests),COUNT(*),MAX(threadterm_session_id) FROM usage_daily_rollups",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(value, (1, 1, "newer".into()));
    }

    #[test]
    fn session_metadata_counts_only_children_marked_as_subagents() {
        let (_dir, conn) = db();
        let mut parent = fact("parent", 1, 1);
        parent.native_session_id = "root".into();
        parent.source = "native:root@parent".into();

        let mut fork = fact("fork", 1, 1);
        fork.native_session_id = "fork".into();
        fork.parent_native_session_id = Some("root".into());
        fork.source = "native:fork@request".into();

        let mut agent = fact("agent", 1, 1);
        agent.native_session_id = "root:agent:worker".into();
        agent.parent_native_session_id = Some("root".into());
        agent.subagent = true;
        agent.source = "native:agent@request".into();

        upsert_facts(&conn, &[parent, fork, agent]).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT subagent_count FROM usage_ledger_sessions
                 WHERE provider='fixture' AND native_session_id='root'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn copied_prefix_keeps_original_owner_and_merges_larger_snapshot() {
        let (_dir, conn) = db();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute(
            "INSERT INTO sessions VALUES('child-tt',NULL,NULL,'title','fixture','chat','idle','0','1','child',NULL,0,0)",
            [],
        )
        .unwrap();
        let mut original = fact("shared", 4, 2);
        original.native_session_id = "original".into();
        original.source = "native:original@1".into();
        let mut copied = original.clone();
        copied.native_session_id = "child".into();
        copied.parent_native_session_id = Some("original".into());
        copied.threadterm_session_id = Some("child-tt".into());
        copied.source = "native:child@1".into();
        copied.buckets.input = Some(9);
        upsert_facts(&conn, &[original, copied]).unwrap();
        let owner: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT native_session_id,threadterm_session_id,input_tokens,scope FROM usage_facts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(owner, ("original".into(), None, 9, "outside".into()));
        assert_eq!(
            conn.query_row("SELECT SUM(requests) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn removing_the_owner_moves_one_rollup_to_the_remaining_copy() {
        let (_dir, conn) = db();
        let mut original = fact("shared", 4, 2);
        original.native_session_id = "original".into();
        original.source = "native:original@1".into();
        let mut copied = original.clone();
        copied.native_session_id = "child".into();
        copied.parent_native_session_id = Some("original".into());
        copied.source = "native:child@1".into();
        upsert_facts(&conn, &[original, copied]).unwrap();
        remove_source(&conn, "native:original@").unwrap();
        let rollup: (String, i64) = conn
            .query_row(
                "SELECT native_session_id,SUM(requests) FROM usage_daily_rollups",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rollup, ("child".into(), 1));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_ledger_sessions WHERE native_session_id='original'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn native_active_gap_is_strict_and_compressed() {
        let (_dir, conn) = db();
        let mut facts = Vec::new();
        for (key, at) in [
            ("a", "2026-01-01T12:00:00.000Z"),
            ("b", "2026-01-01T12:04:59.999Z"),
            ("c", "2026-01-01T12:09:59.999Z"),
        ] {
            let mut value = fact(key, 1, 1);
            value.occurred_at = at.into();
            value.source = format!("native:file@{key}");
            facts.push(value);
        }
        upsert_facts(&conn, &facts).unwrap();
        let intervals: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),SUM(end_ms-start_ms) FROM usage_intervals",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(intervals, (1, 299_999));
    }

    #[test]
    fn appended_batches_match_full_repair_and_archive_duplicates_are_noops() {
        let (_dir, conn) = db();
        let mut originals = Vec::new();
        for batch in 0..40 {
            let mut page = Vec::new();
            for offset in 0..3 {
                let minute = batch * 3 + offset;
                let mut value = fact(&format!("append-{minute}"), 1, 1);
                value.occurred_at = format!(
                    "2026-01-01T{:02}:{:02}:00.000Z",
                    12 + minute / 60,
                    minute % 60
                );
                value.source = format!("native:stream@{minute}");
                page.push(value.clone());
                originals.push(value);
            }
            upsert_facts(&conn, &page).unwrap();
        }

        let projection = |conn: &Connection| -> (i64, i64, i64, i64, i64, i64) {
            let daily = conn
                .query_row(
                    "SELECT SUM(requests),SUM(input_tokens+output_tokens)
                     FROM usage_daily_rollups",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap();
            let cube = conn
                .query_row(
                    "SELECT requests,sessions FROM usage_daily_cube
                     WHERE mode=0 AND dimensions_mask=0",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap();
            let prefix = conn
                .query_row(
                    "SELECT p.requests,p.active_ms FROM usage_session_prefix p
                     JOIN usage_session_slices s ON s.id=p.slice_id
                     WHERE s.mode=0 AND s.model_mask=0
                     ORDER BY p.local_day DESC LIMIT 1",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap();
            (daily.0, daily.1, cube.0, cube.1, prefix.0, prefix.1)
        };

        let appended = projection(&conn);
        assert_eq!(appended, (120, 240, 120, 1, 120, 7_140_000));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_intervals", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );

        for page in originals.chunks(3) {
            let archives = page
                .iter()
                .cloned()
                .map(|mut value| {
                    value.source = format!("native:archive@{}", value.key);
                    value
                })
                .collect::<Vec<_>>();
            upsert_facts(&conn, &archives).unwrap();
        }
        assert_eq!(projection(&conn), appended);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_intervals", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );

        // A new key at the current tail timestamp has no interval edge. Its
        // lexical order therefore cannot make the batch historical.
        let mut equal_tail = fact("000-equal-tail", 1, 1);
        equal_tail.occurred_at = originals.last().unwrap().occurred_at.clone();
        equal_tail.source = "native:stream@equal-tail".into();
        upsert_fact(&conn, &equal_tail).unwrap();
        assert!(super::super::incremental::append_only_native(&conn).unwrap());

        let mut future = fact("future", 1, 1);
        future.occurred_at = "2026-01-01T14:00:00.000Z".into();
        future.source = "native:stream@future".into();
        upsert_fact(&conn, &future).unwrap();
        assert!(super::super::incremental::append_only_native(&conn).unwrap());
        assert_eq!(projection(&conn), (122, 244, 122, 1, 122, 7_200_000));

        // Metric improvements on a structurally stable native fact only dirty
        // its day; they do not require rebuilding the session's full history.
        let mut improved = originals[0].clone();
        improved.buckets.input = Some(9);
        upsert_fact(&conn, &improved).unwrap();
        assert!(super::super::incremental::append_only_native(&conn).unwrap());
        let incrementally_updated = projection(&conn);
        assert_eq!(incrementally_updated, (122, 252, 122, 1, 122, 7_200_000));
        let metadata = |conn: &Connection| {
            conn.query_row(
                "SELECT requests,tokens,first_occurred_at,last_occurred_at,models,cwd
                 FROM usage_ledger_sessions
                 WHERE provider='fixture' AND native_session_id='native'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .unwrap()
        };
        let incremental_metadata = metadata(&conn);
        assert_eq!(incremental_metadata.0, 122);
        assert_eq!(incremental_metadata.1, 252);
        rebuild_session(&conn, "fixture", "native").unwrap();
        assert_eq!(projection(&conn), incrementally_updated);
        assert_eq!(metadata(&conn), incremental_metadata);

        let mut historical = fact("historical", 1, 1);
        historical.occurred_at = "2026-01-01T11:59:00.000Z".into();
        historical.source = "native:stream@historical".into();
        upsert_fact(&conn, &historical).unwrap();
        let repaired_for_order = projection(&conn);
        assert_eq!(repaired_for_order, (123, 254, 123, 1, 123, 7_260_000));
        rebuild_session(&conn, "fixture", "native").unwrap();
        assert_eq!(projection(&conn), repaired_for_order);

        // Repeated historical micro-batches cut through the same long,
        // coalesced native chain. Alternating successor dimensions exercise
        // both preserved window boundaries and re-coalescing on each pass.
        for index in 0..8 {
            let mut inserted = fact(&format!("mid-chain-{index}"), 1, 1);
            inserted.occurred_at = format!("2026-01-01T12:{:02}:30.000Z", 20 + index);
            inserted.model = Some(
                if index % 2 == 0 {
                    "alternate"
                } else {
                    "fixture-manual"
                }
                .into(),
            );
            inserted.source = format!("native:stream@mid-chain-{index}");
            upsert_fact(&conn, &inserted).unwrap();
        }
        let interval_projection = |connection: &Connection| {
            let mut statement = connection
                .prepare(
                    "SELECT model,project_id,scope,local_day,start_ms,end_ms
                     FROM usage_intervals WHERE estimated=1
                     ORDER BY local_day,start_ms,end_ms,model,project_id,scope",
                )
                .unwrap();
            let result = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            result
        };
        let bounded_windows = interval_projection(&conn);
        rebuild_session(&conn, "fixture", "native").unwrap();
        assert_eq!(interval_projection(&conn), bounded_windows);
    }

    #[test]
    fn bounded_historical_intervals_match_full_repair_at_day_boundaries() {
        let (_dir, conn) = db();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute_batch(
            "INSERT INTO projects VALUES
                ('one','One','D:/workspace/one','0'),
                ('two','Two','D:/workspace/two','0');",
        )
        .unwrap();
        let (day_start_text, day_end_text) = time::local_day_range("2026-03-08").unwrap();
        let day_start = time::timestamp_millis(&day_start_text).unwrap();
        let day_end = time::timestamp_millis(&day_end_text).unwrap();
        let timestamp = |millis: i64| {
            DateTime::<Utc>::from_timestamp_millis(millis)
                .unwrap()
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        };
        let native = |key: &str, millis: i64, model: &str, cwd: &str| {
            let mut value = fact(key, 1, 1);
            value.occurred_at = timestamp(millis);
            value.model = Some(model.into());
            value.cwd = Some(cwd.into());
            value.threadterm_session_id = Some("threadterm".into());
            value.source = format!("native:history@{key}");
            value
        };

        // The initial projection has inferred intervals on both sides of the
        // local-day boundary, a strict five-minute gap, and one exact live
        // interval which the historical repair must preserve.
        let initial = vec![
            native(
                "previous",
                day_start - 120_000,
                "previous",
                "D:/workspace/one",
            ),
            native(
                "successor",
                day_start + 120_000,
                "successor",
                "D:/workspace/one",
            ),
            native(
                "gap-left",
                day_start + 600_000,
                "gap-left",
                "D:/workspace/one",
            ),
            native(
                "gap-right",
                day_start + 900_000,
                "gap-right",
                "D:/workspace/two",
            ),
            native(
                "after-gap",
                day_start + 1_140_000,
                "after-gap",
                "D:/workspace/two",
            ),
            native(
                "end-left",
                day_end - 120_000,
                "end-left",
                "D:/workspace/one",
            ),
            native(
                "end-right",
                day_end + 120_000,
                "end-right",
                "D:/workspace/one",
            ),
        ];
        upsert_facts(&conn, &initial).unwrap();
        let mut live = fact("live-exact", 0, 0);
        live.occurred_at = timestamp(day_start + 480_000);
        live.model = Some("live-model".into());
        live.cwd = Some("D:/workspace/two".into());
        live.threadterm_session_id = Some("threadterm".into());
        live.turn_id = Some("live-turn".into());
        live.started_at = Some(timestamp(day_start + 360_000));
        live.ended_at = Some(timestamp(day_start + 540_000));
        live.source = "live:test".into();
        upsert_fact(&conn, &live).unwrap();

        // Both rows arrive after the session tail was projected. One lands at
        // the first local midnight and changes the preceding day's fragment;
        // the other is lexically first at an existing timestamp. A third row
        // changes the edge across the following local midnight.
        let historical = vec![
            native("midnight", day_start, "midnight", "D:/workspace/two"),
            native(
                "000-same-time",
                day_start + 120_000,
                "same-time",
                "D:/workspace/two",
            ),
            native(
                "next-midnight",
                day_end,
                "next-midnight",
                "D:/workspace/two",
            ),
        ];
        upsert_facts(&conn, &historical).unwrap();
        assert_eq!(
            super::super::incremental::classify_native(&conn).unwrap(),
            super::super::incremental::NativeChangeKind::HistoricalOnly
        );

        let intervals = |connection: &Connection| {
            let mut statement = connection
                .prepare(
                    "SELECT model,project_id,threadterm_session_id,scope,local_day,
                            start_ms,end_ms,estimated
                     FROM usage_intervals
                     ORDER BY local_day,start_ms,end_ms,estimated,model,project_id",
                )
                .unwrap();
            let result = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            result
        };
        let projection = |connection: &Connection| {
            let daily = connection
                .query_row(
                    "SELECT SUM(requests),SUM(input_tokens+output_tokens)
                     FROM usage_daily_rollups",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap();
            let cube = connection
                .query_row(
                    "SELECT SUM(requests),SUM(sessions) FROM usage_daily_cube
                     WHERE mode=0 AND dimensions_mask=0",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap();
            let slices = connection
                .query_row(
                    "SELECT SUM(tokens),SUM(requests),SUM(active_ms)
                     FROM usage_session_slices WHERE mode=0 AND model_mask=0",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .unwrap();
            let metadata = connection
                .query_row(
                    "SELECT requests,tokens,first_occurred_at,last_occurred_at
                     FROM usage_ledger_sessions
                     WHERE provider='fixture' AND native_session_id='native'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .unwrap();
            (daily, cube, slices, metadata)
        };

        let bounded_intervals = intervals(&conn);
        assert!(bounded_intervals.iter().any(|row| row.7 == 0));
        assert!(bounded_intervals.iter().any(|row| row.0 == "same-time"));
        assert!(!bounded_intervals.iter().any(|row| row.0 == "gap-right"));
        let bounded_projection = projection(&conn);
        assert!(rebuild_dirty_activity(&conn, &AtomicBool::new(false)).unwrap());
        let bounded_activity: Vec<(String, i64, String, String, String, String, i64, i64)> = conn
            .prepare(
                "SELECT local_day,dimensions_mask,provider,model,project_id,scope,
                        active_ms,estimated
                 FROM usage_activity_daily
                 ORDER BY local_day,dimensions_mask,provider,model,project_id,scope",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        rebuild_session(&conn, "fixture", "native").unwrap();
        assert!(rebuild_dirty_activity(&conn, &AtomicBool::new(false)).unwrap());
        assert_eq!(intervals(&conn), bounded_intervals);
        assert_eq!(projection(&conn), bounded_projection);
        let repaired_activity = conn
            .prepare(
                "SELECT local_day,dimensions_mask,provider,model,project_id,scope,
                        active_ms,estimated
                 FROM usage_activity_daily
                 ORDER BY local_day,dimensions_mask,provider,model,project_id,scope",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(repaired_activity, bounded_activity);

        let mut noncanonical = fact("offset-timestamp", 1, 1);
        noncanonical.occurred_at = "2026-03-08T01:30:00-05:00".into();
        noncanonical.source = "native:history@offset".into();
        upsert_fact(&conn, &noncanonical).unwrap();
        assert_eq!(
            super::super::incremental::classify_native(&conn).unwrap(),
            super::super::incremental::NativeChangeKind::Repair
        );
        assert_eq!(state(&conn, NATIVE_TIMESTAMP_ORDER_KEY).unwrap(), None);

        // Once a populated/legacy coordinate contains a noncanonical native
        // timestamp, a later canonical historical insert must retain the full
        // repair path. The durable marker prevents lexical window seeks from
        // silently omitting that older representation.
        let mut after_legacy = fact("after-legacy", 1, 1);
        after_legacy.occurred_at = "2026-03-08T01:00:00.000Z".into();
        after_legacy.source = "native:history@after-legacy".into();
        upsert_fact(&conn, &after_legacy).unwrap();
        let legacy_intervals = intervals(&conn);
        let legacy_projection = projection(&conn);
        rebuild_session(&conn, "fixture", "native").unwrap();
        assert_eq!(intervals(&conn), legacy_intervals);
        assert_eq!(projection(&conn), legacy_projection);
    }

    #[test]
    fn daily_activity_cube_unions_overlapping_sessions_for_each_projection() {
        let (_dir, conn) = db();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute(
            "INSERT INTO projects VALUES('project','Project','D:/workspace','0')",
            [],
        )
        .unwrap();
        let mut facts = Vec::new();
        for (session, cwd, points) in [
            (
                "one",
                "D:/workspace/one",
                [
                    ("a", "2026-01-01T12:00:00.000Z"),
                    ("b", "2026-01-01T12:04:00.000Z"),
                ],
            ),
            (
                "two",
                "D:/workspace/two",
                [
                    ("c", "2026-01-01T12:02:00.000Z"),
                    ("d", "2026-01-01T12:06:00.000Z"),
                ],
            ),
        ] {
            for (key, occurred_at) in points {
                let mut value = fact(key, 1, 1);
                value.native_session_id = session.into();
                value.occurred_at = occurred_at.into();
                value.cwd = Some(cwd.into());
                value.source = format!("native:{session}@{key}");
                facts.push(value);
            }
        }
        upsert_facts(&conn, &facts).unwrap();
        assert!(activity_dirty(&conn, None, None).unwrap());
        assert!(rebuild_dirty_activity(&conn, &AtomicBool::new(false)).unwrap());
        assert!(!activity_dirty(&conn, None, None).unwrap());
        let local_day = time::local_day("2026-01-01T12:00:00.000Z").unwrap();
        let all: (i64, i64) = conn
            .query_row(
                "SELECT active_ms,estimated FROM usage_activity_daily
                 WHERE local_day=? AND dimensions_mask=0",
                [&local_day],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(all, (360_000, 1));
        let projected: i64 = conn
            .query_row(
                "SELECT active_ms FROM usage_activity_daily
                 WHERE local_day=? AND dimensions_mask=5
                   AND provider='fixture' AND project_id='project'",
                [&local_day],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(projected, 360_000);
    }

    #[test]
    fn rewritten_source_clears_stale_suppression() {
        let (_dir, conn) = db();
        let mut legacy = fact("legacy", 7, 1);
        legacy.source = "native:old@1".into();
        let mut typed = fact("typed", 9, 1);
        typed.source = "native:typed@1".into();
        upsert_facts(&conn, &[legacy.clone(), typed]).unwrap();
        remove_fact_keys(&conn, &[legacy.key.clone()]).unwrap();
        remove_source(&conn, "native:typed@").unwrap();
        assert_eq!(
            conn.query_row("SELECT fact_key FROM usage_facts", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            legacy.key
        );
    }

    #[test]
    fn archived_duplicate_survives_one_source_rewrite() {
        let (_dir, conn) = db();
        let mut first = fact("shared", 3, 1);
        first.source = "native:active@1".into();
        let mut archive = first.clone();
        archive.source = "native:archive@1".into();
        archive.buckets.input = Some(8);
        upsert_facts(&conn, &[first, archive]).unwrap();
        remove_source(&conn, "native:active@").unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT input_tokens FROM usage_facts WHERE fact_key='fixture:shared'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            8
        );
        assert_eq!(
            conn.query_row("SELECT SUM(requests) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn native_coverage_restores_live_only_after_last_source_is_removed() {
        let (_dir, conn) = db();
        let mut live = fact("live", 4, 2);
        live.source = "live:tt:turn".into();
        upsert_fact(&conn, &live).unwrap();
        cover_session(&conn, "fixture", "native", "native:first@").unwrap();
        cover_session(&conn, "fixture", "native", "native:second@").unwrap();
        remove_source(&conn, "native:first@").unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        remove_source(&conn, "native:second@").unwrap();
        assert_eq!(
            conn.query_row("SELECT SUM(requests) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn binding_a_late_native_id_moves_and_suppresses_fallback_live_facts() {
        let (_dir, conn) = db();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute(
            "INSERT INTO sessions VALUES('tt',NULL,NULL,'title','fixture','chat','idle','0','1','real',NULL,0,0)",
            [],
        )
        .unwrap();
        let mut live = fact("live-bind", 4, 2);
        live.native_session_id = "tt".into();
        live.source = "live:tt:request".into();
        live.threadterm_session_id = Some("tt".into());
        upsert_fact(&conn, &live).unwrap();
        cover_session(&conn, "fixture", "real", "native:file@").unwrap();
        assert_eq!(
            conn.query_row("SELECT SUM(requests) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
        let tx = conn.unchecked_transaction().unwrap();
        bind_live_native(&tx, "tt", "real").unwrap();
        assert_eq!(
            tx.query_row("SELECT native_session_id FROM usage_facts", [], |row| {
                row.get::<_, String>(0)
            },)
                .unwrap(),
            "real"
        );
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        tx.commit().unwrap();
    }

    #[test]
    fn finish_live_turn_uses_the_callers_transaction() {
        let (_dir, conn) = db();
        let mut live = fact("live-turn", 1, 1);
        live.source = "live:tt:turn".into();
        live.threadterm_session_id = Some("tt".into());
        live.turn_id = Some("turn".into());
        live.started_at = Some("2026-01-01T00:00:00.000Z".into());
        upsert_fact(&conn, &live).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        finish_live_turn(&tx, "tt", "turn", "2026-01-01T00:00:02.000Z").unwrap();
        assert_eq!(
            tx.query_row(
                "SELECT SUM(end_ms-start_ms) FROM usage_intervals",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .unwrap(),
            2_000
        );
        tx.commit().unwrap();
    }

    #[test]
    fn legacy_import_is_deferred_and_cost_is_estimated() {
        let (_dir, conn) = db();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute(
            "INSERT INTO sessions VALUES('tt',NULL,NULL,'title','fixture','chat','idle','0','1',NULL,NULL,0,0)", [],
        ).unwrap();
        crate::usage_ledger::ledger_db::fixture_main(&conn).execute(
            "INSERT INTO usage_records VALUES('old','tt','fixture','2026-01-01T00:00:00Z',2,3,0.25,'USD','unknown')", [],
        ).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        import_legacy(&conn).unwrap();
        let values: (Option<f64>, Option<f64>, String) = conn
            .query_row(
                "SELECT reported_cost,estimated_cost,scope FROM usage_facts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(values, (None, Some(0.25), "threadterm".into()));
    }

    #[test]
    fn comparable_paths_cover_verbatim_unc_case_and_separators() {
        assert_eq!(comparable_path(r"\\?\D:\Repo\"), "d:/repo");
        assert_eq!(
            comparable_path(r"\\?\UNC\Server\Share\Repo"),
            "//server/share/repo"
        );
        assert_eq!(
            comparable_path(r"//SERVER/Share/Repo/"),
            "//server/share/repo"
        );
    }
}



