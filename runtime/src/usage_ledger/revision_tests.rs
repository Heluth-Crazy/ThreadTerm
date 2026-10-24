use super::{facts::Fact, queries, store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::AtomicBool};

fn scratch() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage-ledger-revision.sqlite");
    let database = crate::db::Database::open(&path).unwrap();
    drop(database);
    let conn = Connection::open(path).unwrap();
    super::initialize_connection(&conn).unwrap();
    (dir, conn)
}

fn project(conn: &Connection, id: &str, name: &str, path: &Path) {
    conn.execute(
        "INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,'2025-01-01T00:00:00Z')",
        params![id, name, path.to_string_lossy()],
    )
    .unwrap();
}

fn threadterm_session(conn: &Connection, id: &str, provider: &str, native: &str) {
    conn.execute(
        "INSERT INTO sessions(
            id,project_id,worktree_path,title,provider,mode,status,
            created_at,updated_at,native_id,followed,read_only)
         VALUES(?,NULL,NULL,?,?,'chat','idle',
                '2025-01-01T00:00:00Z','2026-12-31T00:00:00Z',?,0,0)",
        params![id, format!("Fixture {id}"), provider, native],
    )
    .unwrap();
}

fn fact(
    provider: &str,
    native: &str,
    key: &str,
    occurred_at: &str,
    model: &str,
    input: i64,
    source: &str,
) -> Fact {
    let mut value = Fact::new(provider, native, key, occurred_at);
    value.model = Some(model.into());
    value.buckets.input = Some(input);
    value.source = source.into();
    value
}

fn query(conn: &Connection, method: &str, params: Value) -> Value {
    queries::query(conn, method, &params).unwrap()
}

fn total(value: &Value) -> i64 {
    value["tokens"]["total"].as_i64().unwrap()
}

fn sessions(value: &Value) -> i64 {
    value["sessions"].as_i64().unwrap()
}

fn breakdown_item<'a>(value: &'a Value, key: &str) -> &'a Value {
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["key"] == key)
        .unwrap_or_else(|| panic!("missing breakdown item {key}: {value}"))
}

fn series_point<'a>(value: &'a Value, start: &str) -> &'a Value {
    value["points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|point| point["start"] == start)
        .unwrap_or_else(|| panic!("missing series point {start}: {value}"))
}

fn session_ids(value: &Value) -> Vec<String> {
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["nativeSessionId"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn query_projection_matches_reference_for_cross_year_gaps_and_distinct_sessions() {
    let (_dir, conn) = scratch();
    for value in [
        fact(
            "fixture",
            "session-a",
            "a-december",
            "2025-12-31T10:00:00Z",
            "model-a",
            10,
            "native:keep:a-december",
        ),
        fact(
            "fixture",
            "session-a",
            "a-january",
            "2026-01-02T10:00:00Z",
            "model-a",
            20,
            "native:keep:a-january",
        ),
        fact(
            "fixture",
            "session-a",
            "a-late",
            "2026-01-15T10:00:00Z",
            "model-b",
            30,
            "native:keep:a-late",
        ),
        fact(
            "fixture",
            "session-b",
            "b",
            "2026-01-05T10:00:00Z",
            "model-a",
            40,
            "native:remove-b:file",
        ),
        fact(
            "fixture",
            "session-c",
            "c",
            "2026-01-02T12:00:00Z",
            "model-a",
            5,
            "native:keep:c",
        ),
    ] {
        store::upsert_fact(&conn, &value).unwrap();
    }

    let cross_year = json!({"filters":{
        "from":"2025-12-30","to":"2026-01-10","scope":"all"
    }});
    let january = json!({"filters":{
        "from":"2026-01-01","to":"2026-02-01","scope":"all"
    }});
    let gap = json!({"filters":{
        "from":"2026-01-06","to":"2026-01-14","scope":"all"
    }});

    // Before the completion marker, queries are the raw-rollup reference path.
    let reference_summary = query(&conn, "usage.ledger.summary", cross_year.clone());
    let reference_week = query(
        &conn,
        "usage.ledger.series",
        json!({"filters":cross_year["filters"],"granularity":"week","stack":"provider","weekStart":"monday"}),
    );
    let reference_month = query(
        &conn,
        "usage.ledger.series",
        json!({"filters":{"from":"2025-12-01","to":"2026-02-01","scope":"all"},"granularity":"month","stack":"provider"}),
    );
    let reference_models = query(
        &conn,
        "usage.ledger.breakdown",
        json!({"filters":january["filters"],"dimension":"model"}),
    );

    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    assert_eq!(
        conn.query_row(
            "SELECT value FROM usage_ledger_state WHERE key='query-projection-complete'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "1"
    );

    let projected_summary = query(&conn, "usage.ledger.summary", cross_year.clone());
    assert_eq!(projected_summary, reference_summary);
    assert_eq!(total(&projected_summary), 75);
    assert_eq!(sessions(&projected_summary), 3);

    // Session A has facts on both sides of this range but none inside it.
    let gap_summary = query(&conn, "usage.ledger.summary", gap);
    assert_eq!(total(&gap_summary), 0);
    assert_eq!(sessions(&gap_summary), 0);

    let projected_week = query(
        &conn,
        "usage.ledger.series",
        json!({"filters":cross_year["filters"],"granularity":"week","stack":"provider","weekStart":"monday"}),
    );
    assert_eq!(projected_week, reference_week);
    let first_week = series_point(&projected_week, "2025-12-29");
    assert_eq!(total(first_week), 35);
    assert_eq!(sessions(first_week), 2);
    let second_week = series_point(&projected_week, "2026-01-05");
    assert_eq!(total(second_week), 40);
    assert_eq!(sessions(second_week), 1);

    let projected_month = query(
        &conn,
        "usage.ledger.series",
        json!({"filters":{"from":"2025-12-01","to":"2026-02-01","scope":"all"},"granularity":"month","stack":"provider"}),
    );
    assert_eq!(projected_month, reference_month);
    assert_eq!(sessions(series_point(&projected_month, "2025-12-01")), 1);
    assert_eq!(sessions(series_point(&projected_month, "2026-01-01")), 3);

    let projected_models = query(
        &conn,
        "usage.ledger.breakdown",
        json!({"filters":january["filters"],"dimension":"model"}),
    );
    assert_eq!(projected_models, reference_models);
    assert_eq!(total(breakdown_item(&projected_models, "model-a")), 65);
    assert_eq!(sessions(breakdown_item(&projected_models, "model-a")), 3);
    assert_eq!(total(breakdown_item(&projected_models, "model-b")), 30);
    assert_eq!(sessions(breakdown_item(&projected_models, "model-b")), 1);
}

#[test]
fn completed_projection_tracks_replace_remove_reprice_and_reattribution() {
    let (dir, conn) = scratch();
    let old_root = dir.path().join("workspace");
    let new_root = old_root.join("nested");
    std::fs::create_dir_all(new_root.join("child")).unwrap();
    project(&conn, "project-old", "Old project", &old_root);

    let mut priced = fact(
        "fixture",
        "moving-session",
        "priced",
        "2026-02-03T10:00:00Z",
        "priced-model",
        10,
        "native:priced:file",
    );
    priced.cwd = Some(new_root.join("child").to_string_lossy().into_owned());
    let removable = fact(
        "fixture",
        "removed-session",
        "removed",
        "2026-02-04T10:00:00Z",
        "priced-model",
        7,
        "native:remove-me:file",
    );
    store::upsert_facts(&conn, &[priced.clone(), removable]).unwrap();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());

    let range = json!({"filters":{
        "from":"2026-02-01","to":"2026-03-01","scope":"all"
    }});
    assert_eq!(
        total(&query(&conn, "usage.ledger.summary", range.clone())),
        17
    );
    let projects = query(
        &conn,
        "usage.ledger.breakdown",
        json!({"filters":range["filters"],"dimension":"project"}),
    );
    assert_eq!(total(breakdown_item(&projects, "project-old")), 10);

    let mut replacement = priced.clone();
    replacement.buckets.input = Some(13);
    store::upsert_fact(&conn, &replacement).unwrap();
    assert_eq!(
        total(&query(&conn, "usage.ledger.summary", range.clone())),
        20
    );

    store::remove_source(&conn, "native:remove-me:").unwrap();
    assert_eq!(
        total(&query(&conn, "usage.ledger.summary", range.clone())),
        13
    );
    assert_eq!(
        sessions(&query(&conn, "usage.ledger.summary", range.clone())),
        1
    );

    let overrides = json!({"fixture/priced-model":{"input":2.0,"output":3.0}});
    assert!(store::reprice_all(&conn, &overrides, &AtomicBool::new(false)).unwrap());
    let repriced = query(&conn, "usage.ledger.summary", range.clone());
    assert_eq!(repriced["cost"]["pricedTokens"], 13);
    assert_eq!(repriced["cost"]["unpricedTokens"], 0);
    let cost = repriced["cost"]["apiEquivalentUsd"].as_f64().unwrap();
    assert!(
        (cost - 0.000026).abs() < 1e-12,
        "unexpected repriced cost {cost}"
    );

    project(&conn, "project-new", "New project", &new_root);
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());
    let projects = query(
        &conn,
        "usage.ledger.breakdown",
        json!({"filters":range["filters"],"dimension":"project"}),
    );
    assert!(projects["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["key"] != "project-old"));
    assert_eq!(total(breakdown_item(&projects, "project-new")), 13);
}

#[test]
fn session_page_uses_the_requested_range_for_tokens_and_recent_sorting() {
    let (_dir, conn) = scratch();
    for value in [
        fact(
            "fixture",
            "z-future-session",
            "future-in-range",
            "2026-03-02T10:00:00Z",
            "model-a",
            9,
            "native:future:one",
        ),
        fact(
            "fixture",
            "z-future-session",
            "future-outside-range",
            "2026-03-20T10:00:00Z",
            "model-a",
            100,
            "native:future:two",
        ),
        fact(
            "fixture",
            "a-range-winner",
            "winner",
            "2026-03-05T10:00:00Z",
            "model-a",
            20,
            "native:winner",
        ),
    ] {
        store::upsert_fact(&conn, &value).unwrap();
    }
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    let filters = json!({"from":"2026-03-01","to":"2026-03-10","scope":"all"});

    let by_tokens = query(
        &conn,
        "usage.ledger.sessions",
        json!({"filters":filters,"sort":"tokens","order":"desc","limit":20,"offset":0}),
    );
    assert_eq!(
        session_ids(&by_tokens),
        vec!["a-range-winner".to_owned(), "z-future-session".to_owned()]
    );
    assert_eq!(total(&by_tokens["items"][0]), 20);
    assert_eq!(total(&by_tokens["items"][1]), 9);

    let by_recent = query(
        &conn,
        "usage.ledger.sessions",
        json!({"filters":{"from":"2026-03-01","to":"2026-03-10","scope":"all"},"sort":"recent","order":"desc","limit":20,"offset":0}),
    );
    assert_eq!(session_ids(&by_recent)[0], "a-range-winner");
    assert_eq!(
        by_recent["items"][0]["lastOccurredAt"],
        "2026-03-05T10:00:00Z"
    );

    let full = query(
        &conn,
        "usage.ledger.sessions",
        json!({"filters":{"from":"2026-03-01","to":"2026-04-01","scope":"all"},"sort":"tokens","order":"desc","limit":20,"offset":0}),
    );
    assert_eq!(session_ids(&full)[0], "z-future-session");
    assert_eq!(total(&full["items"][0]), 109);
}

#[test]
fn session_active_time_sort_uses_range_clipped_per_session_unions() {
    let (_dir, conn) = scratch();
    threadterm_session(&conn, "tt-long", "fixture", "z-long-active");
    threadterm_session(&conn, "tt-short", "fixture", "a-short-active");

    let mut long = fact(
        "fixture",
        "z-long-active",
        "long",
        "2026-04-03T10:04:00Z",
        "model-a",
        1,
        "live:tt-long:call",
    );
    long.threadterm_session_id = Some("tt-long".into());
    long.started_at = Some("2026-04-03T10:00:00Z".into());
    long.ended_at = Some("2026-04-03T10:04:00Z".into());
    let mut short = fact(
        "fixture",
        "a-short-active",
        "short",
        "2026-04-03T11:01:00Z",
        "model-a",
        1,
        "live:tt-short:call",
    );
    short.threadterm_session_id = Some("tt-short".into());
    short.started_at = Some("2026-04-03T11:00:00Z".into());
    short.ended_at = Some("2026-04-03T11:01:00Z".into());
    store::upsert_facts(&conn, &[long, short]).unwrap();
    assert!(store::rebuild_all_rollups(&conn, &AtomicBool::new(false)).unwrap());
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());

    let result = query(
        &conn,
        "usage.ledger.sessions",
        json!({
            "filters":{"from":"2026-04-03","to":"2026-04-04","scope":"threadterm","includeOutside":false},
            "sort":"activeTime","order":"desc","limit":20,"offset":0
        }),
    );
    assert_eq!(
        session_ids(&result),
        vec!["z-long-active".to_owned(), "a-short-active".to_owned()]
    );
    assert_eq!(result["items"][0]["activeTimeMs"], 240_000);
    assert_eq!(result["items"][1]["activeTimeMs"], 60_000);
}

#[test]
fn provider_and_global_history_toggles_preserve_only_threadterm_live_usage() {
    let (_dir, conn) = scratch();
    threadterm_session(&conn, "tt", "fixture", "threadterm-native");

    let mut live = fact(
        "fixture",
        "threadterm-native",
        "shared-request",
        "2026-05-03T10:00:00Z",
        "model-a",
        4,
        "live:tt:call",
    );
    live.threadterm_session_id = Some("tt".into());
    let native = fact(
        "fixture",
        "threadterm-native",
        "shared-request",
        "2026-05-03T10:00:00Z",
        "model-a",
        10,
        "native:history:shared",
    );
    let outside = fact(
        "fixture",
        "outside-native",
        "outside",
        "2026-05-04T10:00:00Z",
        "model-a",
        7,
        "native:history:outside",
    );
    store::upsert_facts(&conn, &[live, native, outside]).unwrap();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());

    let range = json!({"from":"2026-05-01","to":"2026-06-01","scope":"all"});
    let normal = query(&conn, "usage.ledger.summary", json!({"filters":range}));
    assert_eq!(total(&normal), 17);
    assert_eq!(sessions(&normal), 2);

    let disabled = query(
        &conn,
        "usage.ledger.summary",
        json!({"filters":{
            "from":"2026-05-01","to":"2026-06-01","scope":"all",
            "nativeProvidersDisabled":["fixture"]
        }}),
    );
    assert_eq!(total(&disabled), 4);
    assert_eq!(sessions(&disabled), 1);

    let global_off = query(
        &conn,
        "usage.ledger.summary",
        json!({"filters":{
            "from":"2026-05-01","to":"2026-06-01","scope":"all",
            "includeOutside":false
        }}),
    );
    assert_eq!(total(&global_off), 4);
    assert_eq!(sessions(&global_off), 1);

    let outside_disabled = query(
        &conn,
        "usage.ledger.summary",
        json!({"filters":{
            "from":"2026-05-01","to":"2026-06-01","scope":"outside",
            "nativeProvidersDisabled":["fixture"]
        }}),
    );
    assert_eq!(total(&outside_disabled), 0);
    assert_eq!(sessions(&outside_disabled), 0);
}

#[test]
fn rebuild_recovers_covered_live_only_coordinate_and_invalidates_completion_first() {
    let (_dir, conn) = scratch();
    threadterm_session(&conn, "tt-live-only", "fixture", "covered-live-only");
    let mut live = fact(
        "fixture",
        "covered-live-only",
        "live-only",
        "2026-06-03T10:00:00Z",
        "model-live",
        6,
        "live:tt-live-only:call",
    );
    live.threadterm_session_id = Some("tt-live-only".into());
    store::upsert_fact(&conn, &live).unwrap();
    store::cover_session(
        &conn,
        "fixture",
        "covered-live-only",
        "native:coverage-only",
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_daily_rollups", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_live_rollups", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );

    // Recreate the pre-projection state: observations and fallback rollups exist,
    // while metadata and every query projection row are absent.
    conn.execute_batch(
        "DELETE FROM usage_session_prefix;
         DELETE FROM usage_session_slices;
         DELETE FROM usage_query_sessions;
         DELETE FROM usage_daily_cube;
         DELETE FROM usage_ledger_sessions;
         INSERT INTO usage_ledger_state(key,value)
         VALUES('query-projection-complete','1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value;
         CREATE TEMP TRIGGER stop_projection BEFORE INSERT ON usage_query_sessions
         BEGIN SELECT RAISE(ABORT,'fixture projection stop'); END;",
    )
    .unwrap();

    let failure = store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap_err();
    assert!(failure.to_string().contains("fixture projection stop"));
    assert_eq!(
        conn.query_row(
            "SELECT value FROM usage_ledger_state WHERE key='query-projection-complete'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "0"
    );

    conn.execute_batch("DROP TRIGGER stop_projection;").unwrap();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    assert_eq!(
        conn.query_row(
            "SELECT value FROM usage_ledger_state WHERE key='query-projection-complete'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "1"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM usage_ledger_sessions
             WHERE provider='fixture' AND native_session_id='covered-live-only'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1
    );
    let fallback = query(
        &conn,
        "usage.ledger.summary",
        json!({"filters":{
            "from":"2026-06-01","to":"2026-07-01","scope":"all",
            "nativeProvidersDisabled":["fixture"]
        }}),
    );
    assert_eq!(total(&fallback), 6);
    assert_eq!(sessions(&fallback), 1);
}

#[test]
fn active_time_sort_unions_overlapping_project_slices_before_paging() {
    let (dir, conn) = scratch();
    let project_a = dir.path().join("active-project-a");
    let project_b = dir.path().join("active-project-b");
    std::fs::create_dir_all(&project_a).unwrap();
    std::fs::create_dir_all(&project_b).unwrap();
    project(&conn, "active-a", "Active A", &project_a);
    project(&conn, "active-b", "Active B", &project_b);
    threadterm_session(&conn, "tt-overlap", "fixture", "a-overlap");
    threadterm_session(&conn, "tt-longer", "fixture", "z-longer");

    let mut overlap_a = fact(
        "fixture",
        "a-overlap",
        "overlap-a",
        "2026-07-03T10:10:00Z",
        "model-a",
        1,
        "live:tt-overlap:a",
    );
    overlap_a.threadterm_session_id = Some("tt-overlap".into());
    overlap_a.cwd = Some(project_a.to_string_lossy().into_owned());
    overlap_a.started_at = Some("2026-07-03T10:00:00Z".into());
    overlap_a.ended_at = Some("2026-07-03T10:10:00Z".into());
    let mut overlap_b = fact(
        "fixture",
        "a-overlap",
        "overlap-b",
        "2026-07-03T10:10:00Z",
        "model-b",
        1,
        "live:tt-overlap:b",
    );
    overlap_b.threadterm_session_id = Some("tt-overlap".into());
    overlap_b.cwd = Some(project_b.to_string_lossy().into_owned());
    overlap_b.started_at = Some("2026-07-03T10:00:00Z".into());
    overlap_b.ended_at = Some("2026-07-03T10:10:00Z".into());
    let mut longer = fact(
        "fixture",
        "z-longer",
        "longer",
        "2026-07-03T11:15:00Z",
        "model-a",
        1,
        "live:tt-longer:call",
    );
    longer.threadterm_session_id = Some("tt-longer".into());
    longer.cwd = Some(project_a.to_string_lossy().into_owned());
    longer.started_at = Some("2026-07-03T11:00:00Z".into());
    longer.ended_at = Some("2026-07-03T11:15:00Z".into());
    store::upsert_facts(&conn, &[overlap_a, overlap_b, longer]).unwrap();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM usage_session_slices
             WHERE mode=1 AND model_mask=0 AND provider='fixture'
               AND native_session_id='a-overlap'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );

    let result = query(
        &conn,
        "usage.ledger.sessions",
        json!({
            "filters":{"from":"2026-07-03","to":"2026-07-04","scope":"threadterm","includeOutside":false},
            "sort":"activeTime","order":"desc","limit":20,"offset":0
        }),
    );
    assert_eq!(
        session_ids(&result),
        vec!["z-longer".to_owned(), "a-overlap".to_owned()]
    );
    assert_eq!(result["items"][0]["activeTimeMs"], 900_000);
    assert_eq!(result["items"][1]["activeTimeMs"], 600_000);
}

#[test]
fn project_name_search_matches_before_and_after_projection_completion() {
    let (dir, conn) = scratch();
    let root = dir.path().join("search-project");
    std::fs::create_dir_all(root.join("child")).unwrap();
    project(&conn, "search-project", "Unique Project Needle", &root);
    let mut value = fact(
        "fixture",
        "project-search-session",
        "search",
        "2026-08-03T10:00:00Z",
        "model-a",
        3,
        "native:search:file",
    );
    value.cwd = Some(root.join("child").to_string_lossy().into_owned());
    store::upsert_fact(&conn, &value).unwrap();

    conn.execute(
        "UPDATE usage_ledger_state SET value='0' WHERE key='query-projection-complete'",
        [],
    )
    .unwrap();
    let params = json!({
        "filters":{"from":"2026-08-01","to":"2026-09-01","scope":"all"},
        "search":"Project Needle","sort":"tokens","order":"desc","limit":20,"offset":0
    });
    let fallback = query(&conn, "usage.ledger.sessions", params.clone());
    assert_eq!(
        session_ids(&fallback),
        vec!["project-search-session".to_owned()]
    );

    conn.execute(
        "UPDATE usage_ledger_state SET value='1' WHERE key='query-projection-complete'",
        [],
    )
    .unwrap();
    let projected = query(&conn, "usage.ledger.sessions", params);
    assert_eq!(projected["total"], fallback["total"]);
    assert_eq!(session_ids(&projected), session_ids(&fallback));
}

#[test]
fn all_provider_unknown_model_uses_grok_specific_label_when_only_grok_contributes() {
    let (_dir, conn) = scratch();
    store::upsert_fact(
        &conn,
        &fact(
            "grok",
            "grok-unknown-model",
            "unknown",
            "2026-09-03T10:00:00Z",
            "",
            5,
            "native:grok:file",
        ),
    )
    .unwrap();
    assert!(store::rebuild_query_cache(&conn, &AtomicBool::new(false)).unwrap());
    let result = query(
        &conn,
        "usage.ledger.breakdown",
        json!({
            "filters":{"from":"2026-09-01","to":"2026-10-01","scope":"all"},
            "dimension":"model"
        }),
    );
    let unknown = breakdown_item(&result, "");
    assert_eq!(unknown["label"], "Grok — model not reported");
    assert_eq!(unknown["labelKey"], "grokModelNotReported");
}

#[test]
fn native_filtered_unknown_grok_model_uses_fallback_label() {
    let (_dir, conn) = scratch();
    store::upsert_fact(
        &conn,
        &fact(
            "grok",
            "grok-native-filter",
            "unknown-native",
            "2026-09-04T10:00:00Z",
            "",
            7,
            "native:grok:native-filter",
        ),
    )
    .unwrap();

    let result = query(
        &conn,
        "usage.ledger.breakdown",
        json!({
            "filters":{
                "from":"2026-09-01","to":"2026-10-01","scope":"all",
                "nativeSessionId":"grok-native-filter"
            },
            "dimension":"model"
        }),
    );
    let unknown = breakdown_item(&result, "");
    assert_eq!(unknown["label"], "Grok — model not reported");
    assert_eq!(unknown["labelKey"], "grokModelNotReported");
}
