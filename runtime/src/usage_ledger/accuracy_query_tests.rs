use super::{discovery, facts::Fact, ledger_db, queries, scanner, store, time};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, sync::atomic::AtomicBool};

fn scratch() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage-ledger-accuracy.sqlite");
    let database = crate::db::Database::open(&path).unwrap();
    drop(database);
    (dir, ledger_db::test_connection(&path).unwrap())
}

fn timestamp(millis: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn native_fact(key: &str, occurred_at: String, input: i64) -> Fact {
    let mut fact = Fact::new("fixture", "native", key, &occurred_at);
    fact.model = Some("fixture-model".into());
    fact.buckets.input = Some(input);
    fact.source = format!("native:range@{key}");
    fact
}

fn total(conn: &Connection, from: &str, to: &str) -> i64 {
    queries::query(
        conn,
        "usage.ledger.summary",
        &json!({"filters":{"from":from,"to":to,"scope":"all","includeOutside":true}}),
    )
    .unwrap()["tokens"]["total"]
        .as_i64()
        .unwrap()
}

fn dst_days() -> Option<(NaiveDate, NaiveDate)> {
    let mut spring = None;
    let mut fall = None;
    let first = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
    for offset in 0..366 {
        let day = first + Duration::days(offset);
        let (start, end) = time::local_day_range(&day.format("%F").to_string()).unwrap();
        let width = time::timestamp_millis(&end).unwrap() - time::timestamp_millis(&start).unwrap();
        if width == 23 * 60 * 60 * 1000 {
            spring = Some(day);
        } else if width == 25 * 60 * 60 * 1000 {
            fall = Some(day);
        }
    }
    spring.zip(fall)
}

#[test]
fn direct_rpc_uses_system_local_dst_midnights_and_exclusive_range_end() {
    // Some supported system zones have no DST. The fixture only asserts
    // spring/fall boundary semantics when this machine's local zone supplies
    // both transitions.
    let Some((spring, fall)) = dst_days() else {
        return;
    };
    let (_dir, conn) = scratch();

    for (label, day) in [("spring", spring), ("fall", fall)] {
        let next = day.succ_opt().unwrap();
        let (start, end) = time::local_day_range(&day.format("%F").to_string()).unwrap();
        let start = time::timestamp_millis(&start).unwrap();
        let end = time::timestamp_millis(&end).unwrap();
        store::upsert_facts(
            &conn,
            &[
                native_fact(&format!("{label}-before"), timestamp(start - 1), 1),
                native_fact(&format!("{label}-start"), timestamp(start), 2),
                native_fact(&format!("{label}-end"), timestamp(end - 1), 4),
                native_fact(&format!("{label}-next"), timestamp(end), 8),
            ],
        )
        .unwrap();

        assert_eq!(
            total(&conn, &day.format("%F").to_string(), &next.format("%F").to_string()),
            6,
            "{label} local day must include its midnight and final instant, but exclude next midnight"
        );
    }
}

fn codex_snapshot(response: &str, input: i64) -> String {
    format!(
        "{}\n",
        json!({
            "timestamp":"2026-10-02T12:00:00Z",
            "type":"token_usage_record",
            "payload":{
                "thread_id":"archive-session",
                "response_id":response,
                "usage":{"input_tokens":input,"cached_input_tokens":0,"output_tokens":0}
            }
        })
    )
}

fn zstd(data: &[u8]) -> Vec<u8> {
    use ruzstd::encoding::{CompressionLevel, FrameCompressor};

    let mut output = Vec::new();
    let mut compressor = FrameCompressor::new(CompressionLevel::Fastest);
    compressor.set_source(data);
    compressor.set_drain(&mut output);
    compressor.compress();
    output
}

#[test]
fn equivalent_codex_jsonl_and_zst_archive_copy_preserves_one_max_snapshot_and_coverage() {
    let (dir, conn) = scratch();
    let history = dir.path().join("history");
    fs::create_dir_all(&history).unwrap();
    let jsonl = history.join("rollout.jsonl");
    let contents = format!(
        "{}\n{}{}",
        json!({"type":"session_meta","payload":{"id":"archive-session"}}),
        codex_snapshot("same-response", 3),
        codex_snapshot("same-response", 7),
    );
    fs::write(&jsonl, &contents).unwrap();
    let root = discovery::Root {
        provider: "codex".into(),
        path: history.clone(),
        trees: vec![history.clone()],
    };
    let cancelled = AtomicBool::new(false);

    let first = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(first.facts, 2);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*),SUM(input_tokens) FROM usage_facts",
            [],
            |row| { Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)) }
        )
        .unwrap(),
        (1, 7)
    );

    fs::write(history.join("rollout.jsonl.zst"), zstd(contents.as_bytes())).unwrap();
    let copied = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(copied.compressed_files_read, 1);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*),SUM(input_tokens) FROM usage_facts",
            [],
            |row| { Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)) }
        )
        .unwrap(),
        (1, 7)
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM usage_fact_observations WHERE fact_key='codex:archive-session:same-response'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        4
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(DISTINCT substr(source, 1, instr(source, '@') - 1))
             FROM usage_fact_observations
             WHERE fact_key='codex:archive-session:same-response'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM usage_native_coverage
             WHERE provider='codex' AND native_session_id='archive-session'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );

    // The temporary plain file may disappear after the compressed archive is
    // written; historical source coverage and the canonical fact remain.
    fs::remove_file(jsonl).unwrap();
    scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*),SUM(input_tokens) FROM usage_facts",
            [],
            |row| { Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)) }
        )
        .unwrap(),
        (1, 7)
    );
}
