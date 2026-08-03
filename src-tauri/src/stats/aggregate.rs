//! Aggregator: feed parsed sessions, get an `AgentStats` snapshot.
//!
//! Two paths produce snapshots:
//!   1. `Aggregator` + `feed_session` — in-memory, used for one-off scans
//!      without the DB (and by tests).
//!   2. `aggregate_from_db` — reads persisted `usage_records` rows filtered by
//!      the time window. This is the production path after `sync::sync_all`
//!      has ingested new session-log lines.
//!
//! Correctness rules carried over from cc-sessions-viewer:
//!   1. Dedup Claude calls by `message.id` — fork / sub-agent jsonl copy the
//!      same assistant message, which would otherwise double-count. Dedup now
//!      happens in the parser (best row kept), but the in-memory aggregator
//!      keeps a `HashSet` as a belt-and-suspenders guard.
//!   2. Per-call time-window filter — a session "touched today" (recent mtime)
//!      may contain weeks-old calls; filtering per call (not per session mtime)
//!      keeps "Today" totals honest.

use std::collections::{HashMap, HashSet};

use rusqlite::params;

use crate::stats::pricing;
use crate::stats::types::{AgentStats, CallRecord, StatBucket, UsageSummary};

#[derive(Default)]
struct Bucket {
    usage: UsageSummary,
    cost: f64,
    calls: u64,
}

impl Bucket {
    fn add(&mut self, usage: &UsageSummary, cost: f64) {
        self.usage.add(usage);
        self.cost += cost;
        self.calls += 1;
    }
}

#[allow(dead_code)]
pub struct Aggregator {
    lo_ms: Option<u64>,
    hi_ms: Option<u64>,
    seen_message_ids: HashSet<String>,
    total: Bucket,
    session_count: u64,
    by_model: HashMap<String, Bucket>,
    by_project: HashMap<String, Bucket>,
    by_session: HashMap<String, Bucket>,
}

#[allow(dead_code)]
impl Aggregator {
    pub fn new(lo_ms: Option<u64>, hi_ms: Option<u64>) -> Self {
        Self {
            lo_ms,
            hi_ms,
            seen_message_ids: HashSet::new(),
            total: Bucket::default(),
            session_count: 0,
            by_model: HashMap::new(),
            by_project: HashMap::new(),
            by_session: HashMap::new(),
        }
    }

    fn in_window(&self, ts: Option<u64>, fallback: Option<u64>) -> bool {
        match ts.or(fallback) {
            Some(t) => {
                if let Some(lo) = self.lo_ms {
                    if t < lo {
                        return false;
                    }
                }
                if let Some(hi) = self.hi_ms {
                    if t > hi {
                        return false;
                    }
                }
                true
            }
            // No timestamp at all: only count when there's no lower bound ("all").
            None => self.lo_ms.is_none(),
        }
    }

    pub fn feed_session(
        &mut self,
        session_id: &str,
        project_path: &str,
        session_mtime: Option<u64>,
        calls: &[CallRecord],
    ) {
        let mut had_call = false;
        for call in calls {
            if !self.in_window(call.timestamp_ms, session_mtime) {
                continue;
            }
            if let Some(id) = &call.message_id {
                if !self.seen_message_ids.insert(id.clone()) {
                    continue; // duplicate assistant message across files
                }
            }
            let cost = pricing::cost(&call.model, &call.usage);
            self.total.add(&call.usage, cost);
            let model_key = if call.model.is_empty() {
                "unknown".to_string()
            } else {
                call.model.clone()
            };
            self.by_model
                .entry(model_key)
                .or_default()
                .add(&call.usage, cost);
            self.by_project
                .entry(project_path.to_string())
                .or_default()
                .add(&call.usage, cost);
            let sid = call
                .session_id
                .clone()
                .unwrap_or_else(|| session_id.to_string());
            self.by_session
                .entry(sid)
                .or_default()
                .add(&call.usage, cost);
            had_call = true;
        }
        if had_call {
            self.session_count += 1;
        }
    }

    pub fn snapshot(&self) -> AgentStats {
        AgentStats {
            total_tokens: self.total.usage.total(),
            input_output_tokens: self.total.usage.input_output_tokens(),
            cache_tokens: self.total.usage.cache_tokens(),
            total_cost_usd: self.total.cost,
            total_calls: self.total.calls,
            session_count: self.session_count,
            usage: self.total.usage,
            by_model: to_buckets(&self.by_model),
            by_project: to_buckets(&self.by_project),
            by_session: to_buckets(&self.by_session),
        }
    }
}

/// Aggregate `usage_records` rows within `[lo_ms, hi_ms]` (epoch ms) into an
/// `AgentStats` snapshot. `lo_ms = None` means no lower bound ("all time").
/// `scope` is `"all"` or one of the persisted provider ids — filters by provider.
///
/// Rows are read in a single pass and bucketed in memory — the table is
/// indexed on `created_at` so the range scan is cheap.
pub fn aggregate_from_db(
    conn: &rusqlite::Connection,
    scope: &str,
    lo_ms: Option<u64>,
    hi_ms: Option<u64>,
) -> rusqlite::Result<AgentStats> {
    let lo = lo_ms.map(|ms| (ms / 1000) as i64).unwrap_or(0);
    let hi = hi_ms.map(|ms| (ms / 1000) as i64).unwrap_or(i64::MAX);

    let mut total = Bucket::default();
    let mut session_count: u64 = 0;
    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    let mut by_project: HashMap<String, Bucket> = HashMap::new();
    let mut by_session: HashMap<String, Bucket> = HashMap::new();

    // Build the WHERE clause: time window + optional provider scope. Params
    // are bound positionally; provider filter is optional so "all" doesn't
    // need a placeholder.
    let (sql, use_scope_filter) = match scope {
        "claude" | "codex" | "opencode" | "gemini" | "grok" => (
            "SELECT provider, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, session_id, project_path
             FROM usage_records
             WHERE created_at >= ?1 AND created_at <= ?2 AND provider = ?3",
            true,
        ),
        _ => (
            "SELECT provider, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_cost_usd, session_id, project_path
             FROM usage_records
             WHERE created_at >= ?1 AND created_at <= ?2",
            false,
        ),
    };

    let mut stmt = conn.prepare(sql)?;
    let mut rows = if use_scope_filter {
        stmt.query(params![lo, hi, scope])?
    } else {
        stmt.query(params![lo, hi])?
    };

    let mut seen_sessions: HashSet<String> = HashSet::new();
    while let Some(row) = rows.next()? {
        let model: String = row.get(1)?;
        let input: i64 = row.get(2)?;
        let output: i64 = row.get(3)?;
        let cache_read: i64 = row.get(4)?;
        let cache_creation: i64 = row.get(5)?;
        let cost: f64 = row.get(6)?;
        let session_id: Option<String> = row.get(7)?;
        let project_path: String = row.get::<_, Option<String>>(8)?.unwrap_or_default();

        let usage = UsageSummary {
            input: input as u64,
            output: output as u64,
            cache_read: cache_read as u64,
            cache_creation: cache_creation as u64,
        };
        total.add(&usage, cost);

        let model_key = if model.is_empty() {
            "unknown".to_string()
        } else {
            model.clone()
        };
        by_model.entry(model_key).or_default().add(&usage, cost);
        by_project
            .entry(project_path)
            .or_default()
            .add(&usage, cost);
        if let Some(sid) = &session_id {
            if seen_sessions.insert(sid.clone()) {
                session_count += 1;
            }
            by_session.entry(sid.clone()).or_default().add(&usage, cost);
        }
    }

    Ok(AgentStats {
        total_tokens: total.usage.total(),
        input_output_tokens: total.usage.input_output_tokens(),
        cache_tokens: total.usage.cache_tokens(),
        total_cost_usd: total.cost,
        total_calls: total.calls,
        session_count,
        usage: total.usage,
        by_model: to_buckets(&by_model),
        by_project: to_buckets(&by_project),
        by_session: to_buckets(&by_session),
    })
}

fn to_buckets(map: &HashMap<String, Bucket>) -> Vec<StatBucket> {
    let mut v: Vec<StatBucket> = map
        .iter()
        .map(|(k, b)| StatBucket {
            key: k.clone(),
            label: k.clone(),
            usage: b.usage,
            total_tokens: b.usage.total(),
            input_output_tokens: b.usage.input_output_tokens(),
            cache_tokens: b.usage.cache_tokens(),
            cost_usd: b.cost,
            calls: b.calls,
        })
        .collect();
    v.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.total_tokens.cmp(&a.total_tokens))
    });
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(model: &str, id: Option<&str>, input: u64, output: u64, ts: Option<u64>) -> CallRecord {
        CallRecord {
            model: model.to_string(),
            message_id: id.map(str::to_string),
            usage: UsageSummary {
                input,
                output,
                cache_creation: 0,
                cache_read: 0,
            },
            timestamp_ms: ts,
            stop_reason: None,
            session_id: None,
        }
    }

    #[test]
    fn dedups_by_message_id() {
        let mut agg = Aggregator::new(None, None);
        let c = call("claude-opus-4-8", Some("msg_1"), 100, 50, Some(1000));
        agg.feed_session("s1", "/a", Some(1000), std::slice::from_ref(&c));
        agg.feed_session("s2", "/a", Some(1000), &[c]); // same id, another file
        assert_eq!(agg.snapshot().total_calls, 1);
    }

    #[test]
    fn per_turn_window_excludes_old_calls() {
        let mut agg = Aggregator::new(Some(5000), None);
        let old = call("claude-opus-4-8", Some("a"), 100, 0, Some(1000));
        let fresh = call("claude-opus-4-8", Some("b"), 200, 0, Some(9000));
        agg.feed_session("s1", "/a", Some(9999), &[old, fresh]);
        let snap = agg.snapshot();
        assert_eq!(snap.total_calls, 1);
        assert_eq!(snap.usage.input, 200);
    }

    #[test]
    fn aggregates_by_model_and_session() {
        let mut agg = Aggregator::new(None, None);
        agg.feed_session(
            "s1",
            "/proj",
            Some(1),
            &[
                call("claude-opus-4-8", Some("a"), 10, 5, Some(1)),
                call("gpt-5-codex", Some("b"), 20, 10, Some(1)),
            ],
        );
        let snap = agg.snapshot();
        assert_eq!(snap.by_model.len(), 2);
        assert_eq!(snap.by_session.len(), 1);
        assert_eq!(snap.total_tokens, 45);
        assert_eq!(snap.input_output_tokens, 45);
        assert_eq!(snap.cache_tokens, 0);
    }

    // ── aggregate_from_db ──

    fn mem_conn_with_rows() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_records (
                request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                input_cost_usd REAL NOT NULL DEFAULT 0,
                output_cost_usd REAL NOT NULL DEFAULT 0,
                cache_read_cost_usd REAL NOT NULL DEFAULT 0,
                cache_creation_cost_usd REAL NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0,
                session_id TEXT, project_path TEXT,
                created_at INTEGER NOT NULL, data_source TEXT NOT NULL DEFAULT 'session_log');",
        )
        .unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_row(
        conn: &rusqlite::Connection,
        rid: &str,
        model: &str,
        input: i64,
        output: i64,
        cost: f64,
        session_id: Option<&str>,
        project: &str,
        created_at: i64,
    ) {
        conn.execute(
            "INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES (?1,'claude',?2,?3,?4,0,0,?5,?6,?7,?8)",
            params![rid, model, input, output, cost, session_id, project, created_at],
        )
        .unwrap();
    }

    #[test]
    fn aggregate_from_db_sums_all_rows_when_no_lower_bound() {
        let conn = mem_conn_with_rows();
        insert_row(
            &conn,
            "r1",
            "claude-opus-4-8",
            100,
            10,
            1.5,
            Some("s1"),
            "/a",
            1000,
        );
        insert_row(
            &conn,
            "r2",
            "claude-sonnet-4-5",
            200,
            20,
            0.6,
            Some("s1"),
            "/a",
            2000,
        );
        insert_row(
            &conn,
            "r3",
            "gpt-5-codex",
            300,
            30,
            0.3,
            Some("s2"),
            "/b",
            3000,
        );

        let snap = aggregate_from_db(&conn, "all", None, None).unwrap();
        assert_eq!(snap.total_calls, 3);
        assert_eq!(snap.usage.input, 600);
        assert_eq!(snap.session_count, 2, "two distinct session_ids");
        assert_eq!(snap.by_model.len(), 3);
        assert_eq!(snap.by_project.len(), 2);
    }

    #[test]
    fn aggregate_from_db_reports_token_shape_totals() {
        let conn = mem_conn_with_rows();
        conn.execute(
            "INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES ('r1','codex','gpt-5-codex',100,20,300,40,0.4,'s1','/a',1000)",
            [],
        )
        .unwrap();

        let snap = aggregate_from_db(&conn, "all", None, None).unwrap();

        assert_eq!(snap.input_output_tokens, 120);
        assert_eq!(snap.cache_tokens, 340);
        assert_eq!(snap.total_tokens, 460);
        assert_eq!(snap.by_model[0].input_output_tokens, 120);
        assert_eq!(snap.by_model[0].cache_tokens, 340);
        assert_eq!(snap.by_model[0].total_tokens, 460);
    }

    #[test]
    fn aggregate_from_db_filters_by_time_window() {
        let conn = mem_conn_with_rows();
        insert_row(
            &conn,
            "r1",
            "claude-opus-4-8",
            100,
            10,
            1.5,
            Some("s1"),
            "/a",
            1000,
        );
        insert_row(
            &conn,
            "r2",
            "claude-opus-4-8",
            200,
            20,
            3.0,
            Some("s2"),
            "/b",
            5000,
        );
        // `created_at` is epoch SECONDS; the window args are epoch ms (the fn
        // divides by 1000). 2_000_000ms→2000s .. 6_000_000ms→6000s brackets r2
        // (created_at 5000s) and excludes r1 (1000s).
        let snap = aggregate_from_db(&conn, "all", Some(2_000_000), Some(6_000_000)).unwrap();
        assert_eq!(snap.total_calls, 1);
        assert_eq!(snap.usage.input, 200);
    }

    #[test]
    fn aggregate_from_db_filters_by_scope() {
        let conn = mem_conn_with_rows();
        insert_row(
            &conn,
            "r1",
            "claude-opus-4-8",
            100,
            10,
            1.5,
            Some("s1"),
            "/a",
            1000,
        );
        // r2 is tagged provider='codex' manually for this test.
        conn.execute(
            "INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES ('r2','codex','gpt-5-codex',400,40,0,0,0.4,'s2','/b',1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES ('r3','opencode','deepseek-v4-pro',700,70,0,0,0.7,'s3','',1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES ('r4','gemini','gemini-2.5-pro',800,80,20,0,0.8,'s4','/g',1000);
             INSERT INTO usage_records
                (request_id, provider, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, total_cost_usd,
                 session_id, project_path, created_at)
             VALUES ('r5','grok','grok-4.5-build',900,90,30,0,0.9,'s5','/x',1000);",
        )
        .unwrap();

        let claude_only = aggregate_from_db(&conn, "claude", None, None).unwrap();
        assert_eq!(claude_only.total_calls, 1);
        assert_eq!(claude_only.usage.input, 100);

        let codex_only = aggregate_from_db(&conn, "codex", None, None).unwrap();
        assert_eq!(codex_only.total_calls, 1);
        assert_eq!(codex_only.usage.input, 400);

        let opencode_only = aggregate_from_db(&conn, "opencode", None, None).unwrap();
        assert_eq!(opencode_only.total_calls, 1);
        assert_eq!(opencode_only.usage.input, 700);

        let gemini_only = aggregate_from_db(&conn, "gemini", None, None).unwrap();
        assert_eq!(gemini_only.total_calls, 1);
        assert_eq!(gemini_only.usage.input, 800);
        assert_eq!(gemini_only.usage.cache_read, 20);

        let grok_only = aggregate_from_db(&conn, "grok", None, None).unwrap();
        assert_eq!(grok_only.total_calls, 1);
        assert_eq!(grok_only.usage.input, 900);
        assert_eq!(grok_only.usage.cache_read, 30);

        let all = aggregate_from_db(&conn, "all", None, None).unwrap();
        assert_eq!(all.total_calls, 5);
    }

    #[test]
    fn aggregate_from_db_buckets_sorted_by_cost_desc() {
        let conn = mem_conn_with_rows();
        insert_row(&conn, "r1", "cheap", 100, 0, 0.1, Some("s1"), "/a", 1000);
        insert_row(&conn, "r2", "pricey", 100, 0, 5.0, Some("s2"), "/b", 1000);
        let snap = aggregate_from_db(&conn, "all", None, None).unwrap();
        assert_eq!(snap.by_model[0].key, "pricey");
        assert_eq!(snap.by_model[1].key, "cheap");
    }
}
