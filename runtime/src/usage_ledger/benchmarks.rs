//! Explicit-only scale benchmark: `cargo test usage_ledger::benchmarks::two_million_facts -- --ignored --nocapture`.

use super::{queries, store};
use crate::db::Database;
use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Instant,
};
static SLOW: AtomicUsize = AtomicUsize::new(0);

const FACTS: usize = 2_000_000;
const CALLS_PER_SESSION: usize = 100;
const SESSIONS: usize = FACTS / CALLS_PER_SESSION;
const PROVIDERS: [&str; 6] = [
    "fixture-a",
    "fixture-b",
    "fixture-c",
    "fixture-d",
    "fixture-e",
    "fixture-f",
];
const MODELS: [&str; 8] = [
    "fixture-model-a",
    "fixture-model-b",
    "fixture-model-c",
    "fixture-model-d",
    "fixture-model-e",
    "fixture-model-f",
    "fixture-model-g",
    "fixture-model-h",
];

fn scratch() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = std::env::var_os("UA1_BENCH_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dir.path().join("usage-ledger-benchmark.sqlite"));
    assert!(
        path.is_absolute() && path.starts_with(std::env::temp_dir()),
        "benchmark DB must be under TEMP"
    );
    drop(Database::open(&path).unwrap());
    let conn = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    store::initialize(&conn).unwrap();
    (dir, conn)
}

fn day(index: usize) -> String {
    (NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + Duration::days((index % 365) as i64))
        .format("%F")
        .to_string()
}

/// Fast raw seed only: production store materializes rollups, intervals, and
/// session batches afterwards, so query timing never includes setup work.
fn seed(conn: &mut Connection, root: &std::path::Path) -> i64 {
    let main = crate::usage_ledger::ledger_db::fixture_main(conn);
    for project in 0..4 {
        main.execute(
            "INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)",
            params![
                format!("fixture-project-{project}"),
                format!("Fixture project {project}"),
                root.join(format!("fixture-project-{project}"))
                    .to_string_lossy(),
                "2025-01-01T00:00:00Z"
            ],
        )
        .unwrap();
    }
    let mut sessions = main.prepare("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES(?,?,?,?,?,?,?,?,?,?,0,0)").unwrap();
    let tx = conn.transaction().unwrap();
    for index in (0..SESSIONS).filter(|index| index % 2 == 0) {
        sessions
            .execute(params![
                format!("fixture-threadterm-{index}"),
                format!("fixture-project-{}", index % 4),
                Option::<String>::None,
                format!("Fixture session {index}"),
                PROVIDERS[index % 6],
                "chat",
                "exited",
                "2025-01-01T00:00:00Z",
                "2025-12-31T00:00:00Z",
                format!("fixture-native-{index}")
            ])
            .unwrap();
    }
    drop(sessions);
    let mut observations = tx.prepare("INSERT INTO usage_fact_observations(source,fact_key,provider,model,occurred_at,native_session_id,parent_native_session_id,subagent,input_tokens,cache_read_tokens,cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,output_tokens,reasoning_tokens,quality,reported_cost,estimated_cost,cwd,parser_version,threadterm_session_id,turn_id,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").unwrap();
    let mut facts = tx.prepare("INSERT INTO usage_facts(fact_key,provider,model,occurred_at,local_day,native_session_id,parent_native_session_id,subagent,input_tokens,cache_read_tokens,cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,output_tokens,reasoning_tokens,quality,reported_cost,estimated_cost,cwd,source,parser_version,threadterm_session_id,turn_id,started_at,ended_at,project_id,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").unwrap();
    let mut expected = 0_i64;
    for index in 0..FACTS {
        let session = index / CALLS_PER_SESSION;
        let provider = PROVIDERS[session % 6];
        let model = MODELS[(session + index) % 8];
        let local_day = day(index);
        let at = format!("{local_day}T12:{:02}:00.000Z", index % 60);
        let input = 10 + (index % 17) as i64;
        let read = (index % 5) as i64;
        let write5m = (index % 3) as i64;
        let write1h = ((index / 3) % 2) as i64;
        let unknown = if index % 97 == 0 { 1 } else { 0 };
        let output = 5 + (index % 13) as i64;
        expected += input + read + write5m + write1h + unknown + output;
        let key = format!("fixture-fact-{index}");
        let native = format!("fixture-native-{session}");
        let threadterm = (session % 2 == 0).then(|| format!("fixture-threadterm-{session}"));
        let project = format!("fixture-project-{}", session % 4);
        let scope = if threadterm.is_some() {
            "threadterm"
        } else {
            "outside"
        };
        let cwd = root
            .join(format!("fixture-project-{}", session % 4))
            .to_string_lossy()
            .into_owned();
        observations
            .execute(params![
                "native:benchmark",
                key,
                provider,
                model,
                at,
                native,
                Option::<String>::None,
                0_i64,
                input,
                read,
                write5m,
                write1h,
                unknown,
                output,
                output / 2,
                "exact",
                Option::<f64>::None,
                Option::<f64>::None,
                cwd,
                1_i64,
                threadterm,
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None
            ])
            .unwrap();
        facts
            .execute(params![
                format!("fixture-fact-{index}"),
                provider,
                model,
                format!("{local_day}T12:{:02}:00.000Z", index % 60),
                local_day,
                format!("fixture-native-{session}"),
                Option::<String>::None,
                0_i64,
                input,
                read,
                write5m,
                write1h,
                unknown,
                output,
                output / 2,
                "exact",
                Option::<f64>::None,
                Option::<f64>::None,
                cwd,
                "native:benchmark",
                1_i64,
                (session % 2 == 0).then(|| format!("fixture-threadterm-{session}")),
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                project,
                scope
            ])
            .unwrap();
    }
    drop(observations);
    drop(facts);
    tx.commit().unwrap();
    expected
}

fn timed(conn: &Connection, method: &str, params: Value, budget: u128) -> Value {
    let start = Instant::now();
    let value = queries::query(conn, method, &params).unwrap();
    let ms = start.elapsed().as_millis();
    println!(
        "{} usage_ledger_benchmark rpc={method} elapsed_ms={ms} budget_ms={budget} params={params}",
        if ms <= budget { "PASS" } else { "FAIL" }
    );
    if ms > budget {
        SLOW.fetch_add(1, Ordering::Relaxed);
    }
    value
}

#[test]
#[ignore = "Explicit 2-million-fact ledger query benchmark"]
fn two_million_facts() {
    let (dir, mut conn) = scratch();
    let start = Instant::now();
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
        .unwrap();
    let expected = if existing == 0 {
        seed(&mut conn, dir.path())
    } else {
        assert_eq!(existing, FACTS as i64);
        conn.query_row("SELECT SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens) FROM usage_facts",[],|r|r.get(0)).unwrap()
    };
    println!(
        "PASS usage_ledger_benchmark seed_ms={} facts={FACTS} sessions={SESSIONS}",
        start.elapsed().as_millis()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        FACTS as i64
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_fact_observations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        FACTS as i64
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(DISTINCT native_session_id) FROM usage_facts",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        SESSIONS as i64
    );
    assert_eq!(conn.query_row("SELECT SUM(input_tokens+cache_read_tokens+cache_write5m_tokens+cache_write1h_tokens+cache_write_unknown_tokens+output_tokens) FROM usage_facts", [], |r| r.get::<_, i64>(0)).unwrap(), expected);
    store::reset_write_metrics();
    let rebuild = Instant::now();
    let rollups: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_ledger_sessions", [], |r| {
            r.get(0)
        })
        .unwrap();
    if rollups != SESSIONS as i64 {
        assert!(store::rebuild_all_rollups(&conn, &AtomicBool::new(false)).unwrap());
    }
    println!(
        "PASS usage_ledger_benchmark materialize_ms={}",
        rebuild.elapsed().as_millis()
    );
    let cache_start = Instant::now();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    let (writes, max_us) = store::write_metrics();
    println!(
        "{} usage_ledger_query_projection ms={} transactions={} longest_write_us={}",
        if max_us <= 25_000 { "PASS" } else { "FAIL" },
        cache_start.elapsed().as_millis(),
        writes,
        max_us
    );
    let all = json!({"from":"2025-01-01","to":"2026-01-01","scope":"all"});
    let cases = vec![
        ("usage.ledger.summary", json!({"filters":all})),
        (
            "usage.ledger.summary",
            json!({"filters":{"from":"2025-01-01","to":"2026-01-01","scope":"outside","provider":"fixture-b"}}),
        ),
        (
            "usage.ledger.summary",
            json!({"filters":{"from":"2025-01-01","to":"2026-01-01","scope":"threadterm","provider":"fixture-a"}}),
        ),
        (
            "usage.ledger.series",
            json!({"filters":all,"granularity":"day","stack":"tokens","weekStart":"monday"}),
        ),
        (
            "usage.ledger.breakdown",
            json!({"filters":all,"dimension":"provider"}),
        ),
        (
            "usage.ledger.breakdown",
            json!({"filters":all,"dimension":"model"}),
        ),
        (
            "usage.ledger.breakdown",
            json!({"filters":all,"dimension":"project"}),
        ),
        (
            "usage.ledger.sessions",
            json!({"filters":all,"search":"fixture-model-c","sort":"tokens","order":"desc","limit":50,"offset":0}),
        ),
        (
            "usage.ledger.sessions",
            json!({"filters":{"from":"2025-01-01","to":"2026-01-01","scope":"threadterm","projectId":"fixture-project-2"},"sort":"recent","order":"asc","limit":100,"offset":100}),
        ),
        (
            "usage.ledger.sessions",
            json!({"filters":{"from":"2025-01-01","to":"2026-01-01","scope":"all","model":"fixture-model-a","projectId":"fixture-project-0"},"search":"fixture-model-a","sort":"activeTime","order":"desc","limit":50,"offset":0}),
        ),
        (
            "usage.ledger.summary",
            json!({"filters":{"from":"2025-02-13","to":"2025-11-20","scope":"threadterm","provider":"fixture-a","model":"fixture-model-a","projectId":"fixture-project-0"}}),
        ),
        (
            "usage.ledger.series",
            json!({"filters":{"from":"2025-02-13","to":"2025-11-20","scope":"all"},"granularity":"month","stack":"provider"}),
        ),
        (
            "usage.ledger.sessions",
            json!({"filters":{"from":"2025-02-13","to":"2025-11-20","scope":"all"},"sort":"tokens","limit":50}),
        ),
    ];
    let selected = std::env::var("UA1R_BENCH_QUERY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok());
    for (index, (method, params)) in cases.into_iter().enumerate() {
        if selected.is_some_and(|selected| selected != index) {
            continue;
        }
        println!("PASS benchmark_case index={index} phase=cold_process_first_read");
        let result = timed(&conn, method, params.clone(), 150);
        if index == 0 {
            assert_eq!(result["tokens"]["total"].as_i64(), Some(expected));
            assert_eq!(result["requests"].as_i64(), Some(FACTS as i64));
            assert_eq!(result["sessions"].as_i64(), Some(SESSIONS as i64));
        }
        println!("PASS benchmark_case index={index} phase=warm_sqlite_cache");
        timed(&conn, method, params, 50);
    }
    assert_eq!(
        SLOW.load(Ordering::Relaxed),
        0,
        "UA1r2 queries must meet <=150ms cold process and <=50ms warm SQLite cache"
    );
}

/// Foreground stall: the main database is written from another connection (a
/// Chat-like interactive write) while the history worker rebuilds every
/// projection of the two-million-fact ledger. Run with
/// `UA1_BENCH_DB=<absolute TEMP path>/main.sqlite UA1R_FORCE_QUERY_REBUILD=1`.
#[test]
#[ignore = "Explicit 2-million-fact foreground write-stall measurement"]
fn two_million_facts_foreground_write_stall() {
    let (dir, conn) = scratch();
    assert!(
        std::env::var_os("UA1R_FORCE_QUERY_REBUILD").is_some(),
        "set UA1R_FORCE_QUERY_REBUILD=1 so the projection rebuild really runs"
    );
    let facts: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(facts, FACTS as i64, "seed the benchmark first");

    let main = crate::usage_ledger::ledger_db::fixture_main(&conn);
    main.busy_timeout(std::time::Duration::from_millis(5000))
        .unwrap();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let probe_stop = std::sync::Arc::clone(&stop);
    let probe = std::thread::spawn(move || {
        let mut writes = Vec::<u128>::new();
        while !probe_stop.load(Ordering::Relaxed) {
            let started = Instant::now();
            main.execute(
                "INSERT INTO metadata(key,value) VALUES('usage-stall-probe','1')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )
            .unwrap();
            writes.push(started.elapsed().as_micros());
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        writes
    });

    store::reset_write_metrics();
    let started = Instant::now();
    // The forced projection rebuild (materialized rows, membership, session
    // ranges and the query cache) is the full rebuild the foreground has to
    // survive.
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    let projection_ms = started.elapsed().as_millis();
    let (transactions, longest) = store::write_metrics();

    stop.store(true, Ordering::Relaxed);
    let mut writes = probe.join().unwrap();
    let samples = writes.len();
    writes.sort_unstable();
    let max = writes.last().copied().unwrap_or(0);
    let p99 = writes[(writes.len().saturating_sub(1) as f64 * 0.99).round() as usize];
    let median = writes[writes.len() / 2];
    println!(
        "{} foreground_write_stall projection_ms={} ledger_transactions={} ledger_longest_write_us={} samples={} max_us={} p99_us={} median_us={}",
        if max <= 150_000 && p99 <= 150_000 { "PASS" } else { "FAIL" },
        projection_ms,
        transactions,
        longest,
        samples,
        max,
        p99,
        median
    );
    drop(dir);
}
