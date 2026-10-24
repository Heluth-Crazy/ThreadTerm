use super::*;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, io::Write, sync::atomic::AtomicBool, time::Instant};

fn scratch() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let db = crate::db::Database::open(&path).unwrap();
    drop(db);
    let conn = Connection::open(path).unwrap();
    initialize_connection(&conn).unwrap();
    (dir, conn)
}

fn claude_line(request: &str, input: i64) -> String {
    format!(
        "{}\n",
        json!({"type":"assistant","sessionId":"synthetic-session","timestamp":"2026-01-04T15:00:00Z","cwd":std::env::temp_dir(),"requestId":request,"message":{"id":request,"model":"fixture-unpriced-model","usage":{"input_tokens":input,"output_tokens":7,"cache_read_input_tokens":13,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3}},"content":[{"type":"text","text":"PRIVATE_REPLY_NEVER_LEDGER"}]},"prompt":"PRIVATE_PROMPT_NEVER_LEDGER","toolResult":"PRIVATE_TOOL_NEVER_LEDGER"})
    )
}

#[test]
fn incremental_append_rewrite_truncation_and_privacy() {
    let (dir, conn) = scratch();
    let history = dir.path().join("synthetic-history");
    fs::create_dir_all(&history).unwrap();
    let path = history.join("session.jsonl");
    fs::write(&path, claude_line("request-a", 10)).unwrap();
    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history.clone()],
    };
    let cancelled = AtomicBool::new(false);
    let first = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(first.facts, 1);
    let unchanged = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(unchanged.bytes_read, 0);
    assert_eq!(unchanged.files_read, 0);
    let append = claude_line("request-b", 20);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(append.as_bytes())
        .unwrap();
    let grown = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(grown.facts, 1);
    assert!(grown.bytes_read <= append.len() as u64 + 8192);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    fs::write(&path, claude_line("rewritten", 31)).unwrap();
    scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(
        conn.query_row("SELECT SUM(input_tokens) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        31
    );
    let partial = claude_line("request-c", 45);
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&partial.as_bytes()[..partial.len() - 1])
        .unwrap();
    let tail = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(tail.problems.get("truncated_last_line"), Some(&1));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_private_text_absent(&conn);
}

fn assert_private_text_absent(conn: &Connection) {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for table in tables {
        let columns: Vec<(String, String)> = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .unwrap()
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for (column, kind) in columns {
            if kind.to_uppercase() != "TEXT" {
                continue;
            }
            let count:i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" LIKE '%PRIVATE_%_NEVER_LEDGER%'"),[],|r|r.get(0)).unwrap();
            assert_eq!(count, 0, "private text in {table}.{column}");
        }
    }
}

#[test]
fn bounded_oversized_line_and_cancellation() {
    let (dir, conn) = scratch();
    let history = dir.path().join("oversized");
    fs::create_dir_all(&history).unwrap();
    let mut file = fs::File::create(history.join("session.jsonl")).unwrap();
    file.write_all(&vec![b'x'; 9 * 1024 * 1024]).unwrap();
    file.write_all(b"\n").unwrap();
    file.write_all(claude_line("after-large-line", 5).as_bytes())
        .unwrap();
    drop(file);
    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history],
    };
    let stats = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(stats.problems.get("record_too_large"), Some(&1));
    assert_eq!(stats.facts, 1);
    let stats = scanner::scan(&root, &conn, &AtomicBool::new(true), &mut |_, _| {}).unwrap();
    assert!(stats.cancelled);
}

#[test]
#[ignore = "Explicit 200 MB incremental scan measurement"]
fn incremental_200mb_measurement() {
    let (dir, conn) = scratch();
    let history = dir.path().join("large");
    fs::create_dir_all(&history).unwrap();
    let mut file = std::io::BufWriter::new(fs::File::create(history.join("large.jsonl")).unwrap());
    let line = format!("{}\n", json!({"type":"user","text":"x".repeat(4000)}));
    for _ in 0..(200 * 1024 * 1024 / line.len()) {
        file.write_all(line.as_bytes()).unwrap();
    }
    file.write_all(claude_line("measured-request", 11).as_bytes())
        .unwrap();
    file.flush().unwrap();
    drop(file);
    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history.clone()],
    };
    let start = Instant::now();
    let first = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    println!(
        "PASS 200MB first_scan_ms={} bytes_read={} facts={}",
        start.elapsed().as_millis(),
        first.bytes_read,
        first.facts
    );
    let start = Instant::now();
    let second = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(second.bytes_read, 0);
    println!(
        "PASS 200MB unchanged_scan_ms={} bytes_read=0",
        start.elapsed().as_millis()
    );
    let append = claude_line("measured-append", 17);
    fs::OpenOptions::new()
        .append(true)
        .open(history.join("large.jsonl"))
        .unwrap()
        .write_all(append.as_bytes())
        .unwrap();
    let start = Instant::now();
    let third = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(third.facts, 1);
    assert!(third.bytes_read <= append.len() as u64 + 8192);
    println!(
        "PASS 200MB append_scan_ms={} appended_bytes={} bytes_read={}",
        start.elapsed().as_millis(),
        append.len(),
        third.bytes_read
    );
}

#[test]
#[ignore = "Explicitly authorized content-free read-only machine smoke"]
fn content_free_machine_smoke() {
    let (_dir, conn) = scratch();
    let selected = std::env::var("UA1_SMOKE_PROVIDERS").ok();
    store::configure_index_connection(&conn).unwrap();
    store::reset_write_metrics();
    let mut total_scan_ms = 0_u128;
    let probe_db =
        std::sync::Arc::new(crate::db::Database::open(&_dir.path().join("ledger.sqlite")).unwrap());
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let probe_stop = stop.clone();
    struct ScanProbe {
        stop: std::sync::Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<(i32, u128, u128)>>,
    }
    impl Drop for ScanProbe {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }
    let handle = std::thread::spawn(move || {
        let mut samples = 0;
        let mut read_max = 0_u128;
        let mut write_max = 0_u128;
        while !probe_stop.load(std::sync::atomic::Ordering::Relaxed) {
            let t = Instant::now();
            service::dispatch(&probe_db, "usage.ledger.settings", &json!({}))
                .unwrap()
                .unwrap();
            read_max = read_max.max(t.elapsed().as_micros());
            let t = Instant::now();
            probe_db.transaction(|tx|{tx.execute("INSERT INTO usage_ledger_state(key,value) VALUES('smoke-interactive-write','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[])?;Ok(())}).unwrap();
            write_max = write_max.max(t.elapsed().as_micros());
            samples += 1;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        (samples, read_max, write_max)
    });
    let mut probe = ScanProbe {
        stop: stop.clone(),
        handle: Some(handle),
    };
    for root in discovery::roots() {
        if selected
            .as_ref()
            .is_some_and(|list| !list.split(',').any(|provider| provider == root.provider))
        {
            continue;
        }
        let start = Instant::now();
        let mut progress_events = 0_u64;
        let first = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {
            progress_events += 1;
        })
        .unwrap();
        let elapsed = start.elapsed().as_millis();
        eprintln!(
            "PROFILE ingestion provider={} values={}",
            root.provider,
            store::ingestion_profile_take()
        );
        total_scan_ms += elapsed;
        assert!(
            progress_events >= first.files_found,
            "progress must occur after each file"
        );
        println!("PASS provider_scan_progress provider={} events={} files={} bytes={} compressed_found={} compressed_read={}",root.provider,progress_events,first.files_found,first.bytes_read,first.compressed_files_found,first.compressed_files_read);
        let provider = &root.provider;
        let aggregate:Value=conn.query_row("SELECT COUNT(*),COUNT(DISTINCT native_session_id),MIN(occurred_at),MAX(occurred_at),SUM(input_tokens),SUM(cache_read_tokens),SUM(cache_write5m_tokens),SUM(cache_write1h_tokens),SUM(output_tokens),SUM(reasoning_tokens),SUM(cache_write_unknown_tokens) FROM usage_facts WHERE provider=?",[provider],|r|Ok(json!({"facts":r.get::<_,i64>(0)?,"sessions":r.get::<_,i64>(1)?,"from":r.get::<_,Option<String>>(2)?,"to":r.get::<_,Option<String>>(3)?,"input":r.get::<_,Option<i64>>(4)?,"cacheRead":r.get::<_,Option<i64>>(5)?,"cacheWrite5m":r.get::<_,Option<i64>>(6)?,"cacheWrite1h":r.get::<_,Option<i64>>(7)?,"output":r.get::<_,Option<i64>>(8)?,"reasoning":r.get::<_,Option<i64>>(9)?,"cacheWriteUnknown":r.get::<_,Option<i64>>(10)?}))).unwrap();
        let mut stmt=conn.prepare("SELECT model,COUNT(*) FROM usage_facts WHERE provider=? GROUP BY model ORDER BY COUNT(*) DESC LIMIT 5").unwrap();
        let models: Vec<Value> = stmt
            .query_map([provider], |r| {
                Ok(json!({"model":r.get::<_,Option<String>>(0)?,"requests":r.get::<_,i64>(1)?}))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let start = Instant::now();
        let second = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        println!("PASS provider={} files_found={} files_read={} problems={} totals={} top_models={} scan_ms={} second_scan_ms={} second_bytes={}",provider,first.files_found,first.files_read,json!(first.problems),aggregate,json!(models),elapsed,start.elapsed().as_millis(),second.bytes_read);
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (samples, read_max, write_max) = probe.handle.take().unwrap().join().unwrap();
    println!(
        "{} scan_responsiveness samples={} read_rpc_max_us={} interactive_write_max_us={}",
        if read_max <= 150_000 && write_max <= 150_000 {
            "PASS"
        } else {
            "FAIL"
        },
        samples,
        read_max,
        write_max
    );
    let (writes, longest) = store::write_metrics();
    println!(
        "{} first_scan_total_ms={} transactions={} longest_write_us={}",
        if total_scan_ms <= 120_000 {
            "PASS"
        } else {
            "FAIL"
        },
        total_scan_ms,
        writes,
        longest
    );
    let totals = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    println!("PASS priced_coverage={}", totals["cost"]);
    let mut audit=conn.prepare("SELECT provider,model,SUM(COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write5m_tokens,0)+COALESCE(cache_write1h_tokens,0)+COALESCE(cache_write_unknown_tokens,0)+COALESCE(output_tokens,0)) tokens,COUNT(*) FROM usage_facts WHERE estimated_cost IS NULL GROUP BY provider,model ORDER BY tokens DESC LIMIT 30").unwrap();
    let models = audit
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for (provider, model, tokens, requests) in models {
        let equivalent = model
            .as_deref()
            .and_then(|m| prices::catalog_model_id(&provider, m));
        println!(
            "PASS unpriced_model provider={} model={} tokens={} requests={} snapshot_equivalent={}",
            provider,
            json!(model),
            tokens,
            requests,
            json!(equivalent)
        );
    }
    assert_private_text_absent(&conn);
    assert!(
        total_scan_ms <= 120_000,
        "all-provider first scan exceeds 120 seconds"
    );
    println!(
        "{} index_batch_target_us=25000 measured_max_us={longest}",
        if longest <= 25_000 { "PASS" } else { "FAIL" }
    );
    assert!(
        read_max <= 150_000 && write_max <= 150_000,
        "interactive RPC/write exceeds 150 ms"
    );
}
#[test]
fn aggregate_rpc_contract_scope_children_and_reconciliation() {
    let (dir, conn) = scratch();
    for (id, native) in [
        ("parent", "np"),
        ("group-member", "ng"),
        ("delegate", "nd"),
        ("live-only", "nl"),
        ("missing", "nm"),
    ] {
        conn.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES(?,?,'fixture','chat','exited','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?,0,0)",rusqlite::params![id,id,native]).unwrap();
    }
    for native in ["np", "ng", "nd", "outside", "child", "nl"] {
        let mut fact = facts::Fact::new(
            "fixture",
            native,
            &format!("request-{native}"),
            "2026-01-04T15:00:00Z",
        );
        fact.model = Some("fixture-model".into());
        fact.buckets.input = Some(10);
        fact.buckets.output = Some(2);
        fact.source = if native == "nl" {
            "live:fixture".into()
        } else {
            format!("native:{native}")
        };
        if native == "child" {
            fact.parent_native_session_id = Some("np".into());
            fact.subagent = true;
        }
        if native == "nl" {
            fact.threadterm_session_id = Some("live-only".into());
            fact.started_at = Some("2026-01-04T15:00:00Z".into());
            fact.ended_at = Some("2026-01-04T15:00:02Z".into());
        }
        store::upsert_fact(&conn, &fact).unwrap();
    }
    let mut duplicate = facts::Fact::new("fixture", "np", "live-duplicate", "2026-01-04T15:00:00Z");
    duplicate.threadterm_session_id = Some("parent".into());
    duplicate.source = "live:fixture".into();
    duplicate.buckets.input = Some(999);
    store::upsert_fact(&conn, &duplicate).unwrap();
    store::cover_session(&conn, "fixture", "np", "native:np").unwrap();
    store::rebuild_dirty_activity(&conn, &AtomicBool::new(false)).unwrap();
    let all = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(all["requests"], 6);
    assert_eq!(all["tokens"]["input"], 60);
    assert_eq!(all["tokens"]["cacheRead"], Value::Null);
    assert_eq!(all["activeTimeMs"], 2000);
    for (scope, count) in [("threadterm", 4), ("outside", 2)] {
        let v = queries::query(&conn, "usage.ledger.summary", &json!({"scope":scope})).unwrap();
        assert_eq!(v["requests"], count);
    }
    let detail = queries::query(
        &conn,
        "usage.ledger.session",
        &json!({"provider":"fixture","nativeSessionId":"np"}),
    )
    .unwrap();
    assert_eq!(detail["subagents"].as_array().unwrap().len(), 1);
    assert_eq!(detail["subagents"][0]["models"], json!(["fixture-model"]));
    assert_eq!(detail["subagentCount"], 1);
    let mut results = Vec::<Value>::new();
    for (method, params) in [
        ("usage.ledger.summary", json!({})),
        (
            "usage.ledger.series",
            json!({"filters":{"from":"2026-01-01","to":"2026-01-10"},"granularity":"week"}),
        ),
        ("usage.ledger.breakdown", json!({"dimension":"model"})),
        (
            "usage.ledger.sessions",
            json!({"sort":"activeTime","limit":10}),
        ),
        (
            "usage.ledger.session",
            json!({"provider":"fixture","nativeSessionId":"np"}),
        ),
    ] {
        let result = queries::query(&conn, method, &params).unwrap();
        if method == "usage.ledger.sessions" {
            assert_eq!(result["items"][0]["nativeSessionId"], "nl");
        }
        results.push(json!({"method":method,"params":params,"result":result}));
    }
    let db =
        std::sync::Arc::new(crate::db::Database::open(&dir.path().join("ledger.sqlite")).unwrap());
    for method in ["usage.ledger.sources", "usage.ledger.settings"] {
        results.push(json!({"method":method,"params":{},"result":service::dispatch(&db,method,&json!({})).unwrap().unwrap()}));
    }
    if let Some(path) = std::env::var_os("UA1_RPC_DUMP") {
        let path = std::path::PathBuf::from(path);
        assert!(path.is_absolute() && path.starts_with(std::env::temp_dir()));
        fs::write(path, serde_json::to_vec(&results).unwrap()).unwrap();
    }
    assert_private_text_absent(&conn);
}
#[test]
fn cache_write_snapshot_refinement_never_adds_the_old_unknown_total_twice() {
    let (_dir, conn) = scratch();
    let mut fact = facts::Fact::new("fixture", "native", "cache-request", "2026-01-01T15:00:00Z");
    fact.source = "native:cache".into();
    fact.buckets.cache_write_unknown = Some(10);
    store::upsert_fact(&conn, &fact).unwrap();
    fact.buckets.cache_write_unknown = None;
    fact.buckets.cache_write5m = Some(6);
    store::upsert_fact(&conn, &fact).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT cache_write_unknown_tokens FROM usage_facts",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    fact.buckets.cache_write1h = Some(4);
    store::upsert_fact(&conn, &fact).unwrap();
    let totals = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(totals["tokens"]["total"], 10);
    assert_eq!(totals["tokens"]["cacheWriteUnknown"], 0);
}
#[test]
fn a_new_live_turn_preserves_unrelated_legacy_turns() {
    let (_dir, conn) = scratch();
    conn.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES('s','s','fixture','chat','exited','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','n',0,0)",[]).unwrap();
    for (id, input) in [("s:old:usage", 10), ("s:current:usage", 20)] {
        conn.execute("INSERT INTO usage_records(id,session_id,provider,recorded_at,input_tokens) VALUES(?,'s','fixture','2026-01-01T00:00:00Z',?)",rusqlite::params![id,input]).unwrap();
    }
    store::import_legacy(&conn).unwrap();
    let mut fact = facts::Fact::new("fixture", "n", "new-call", "2026-01-01T00:00:01Z");
    fact.threadterm_session_id = Some("s".into());
    fact.turn_id = Some("current".into());
    fact.source = "live:fixture".into();
    fact.buckets.input = Some(25);
    store::upsert_fact(&conn, &fact).unwrap();
    let totals = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(totals["requests"], 2);
    assert_eq!(totals["tokens"]["input"], 35);
}
#[test]
fn codex_native_forks_and_spawned_agents_have_different_relationships() {
    for (source, subagent) in [
        (json!("cli"), false),
        (
            json!({"subagent":{"thread_spawn":{"parent_thread_id":"parent","depth":1}}}),
            true,
        ),
    ] {
        let mut state = facts::ReaderState::default();
        readers::parse(
            "codex",
            &json!({"type":"session_meta","timestamp":"2026-01-01T00:00:00Z","payload":{"id":"child","forked_from_id":"parent","source":source}}),
            0,
            "file",
            &mut state,
        );
        let parsed = readers::parse(
            "codex",
            &json!({"type":"token_usage_record","timestamp":"2026-01-01T00:00:01Z","payload":{"thread_id":"child","response_id":"response","model":"fixture-model","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}}),
            1,
            "file",
            &mut state,
        );
        assert_eq!(parsed.facts.len(), 1);
        assert_eq!(parsed.facts[0].subagent, subagent);
        assert_eq!(
            parsed.facts[0].parent_native_session_id.as_deref(),
            Some("parent")
        );
    }
}
#[test]
fn unchanged_files_keep_per_file_format_problems_without_multiplying_them() {
    let (dir, conn) = scratch();
    let history = dir.path().join("format-problems");
    fs::create_dir(&history).unwrap();
    fs::write(
        history.join("unsupported.jsonl"),
        "{\"schema_version\":99}\n",
    )
    .unwrap();
    fs::write(history.join("invalid.jsonl"), "not-json\n").unwrap();
    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history],
    };
    for iteration in 0..3 {
        let stats = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(stats.problems.get("unsupported_format_v99"), Some(&1));
        assert_eq!(stats.problems.get("invalid_json"), Some(&1));
        if iteration > 0 {
            assert_eq!(stats.bytes_read, 0);
        }
    }
}
#[test]
fn legacy_opencode_pretty_json_is_one_bounded_record() {
    let (dir, conn) = scratch();
    let history = dir.path().join("legacy-opencode");
    fs::create_dir(&history).unwrap();
    let value = json!({"id":"message","sessionID":"native","role":"assistant","modelID":"fixture-model","time":{"completed":1767265200000_i64},"tokens":{"input":5,"output":7,"reasoning":2,"cache":{"read":3,"write":0}}});
    fs::write(
        history.join("message.json"),
        serde_json::to_string_pretty(&value).unwrap(),
    )
    .unwrap();
    let root = discovery::Root {
        provider: "opencode".into(),
        path: history.clone(),
        trees: vec![history],
    };
    let first = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(first.facts, 1);
    assert!(first.problems.is_empty());
    assert_eq!(
        conn.query_row(
            "SELECT input_tokens+cache_read_tokens+output_tokens FROM usage_facts",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        17
    );
    assert_eq!(
        scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {})
            .unwrap()
            .bytes_read,
        0
    );
}
#[test]
fn typed_codex_mirror_replaces_a_committed_legacy_cursor_fact() {
    let (dir, conn) = scratch();
    let history = dir.path().join("mirrors");
    fs::create_dir(&history).unwrap();
    let path = history.join("session.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    for value in [
        json!({"type":"session_meta","payload":{"id":"thread"}}),
        json!({"type":"turn_context","payload":{"turn_id":"turn","model":"fixture-model"}}),
        json!({"type":"event_msg","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}}}),
    ] {
        writeln!(file, "{value}").unwrap();
    }
    drop(file);
    let root = discovery::Root {
        provider: "codex".into(),
        path: history.clone(),
        trees: vec![history],
    };
    scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    let typed = json!({"type":"token_usage_record","timestamp":"2026-01-01T00:00:01Z","payload":{"thread_id":"thread","turn_id":"turn","response_id":"response","model":"fixture-model","usage":{"input_tokens":60,"cached_input_tokens":20,"output_tokens":7},"thread_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}});
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{typed}"
    )
    .unwrap();
    scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    let value = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(value["requests"], 1);
    assert_eq!(value["tokens"]["input"], 40);
    assert_eq!(value["tokens"]["total"], 67);
}
#[test]
fn source_rewrite_prefixes_are_literal_and_do_not_remove_similar_sources() {
    let (_dir, conn) = scratch();
    let mut one = facts::Fact::new("fixture", "native", "one", "2026-01-01T00:00:00Z");
    one.source = "native:file%_:@1".into();
    one.buckets.input = Some(3);
    let mut two = one.clone();
    two.key = "fixture:two".into();
    two.source = "native:fileXX:@1".into();
    two.buckets.input = Some(4);
    store::upsert_facts(&conn, &[one, two]).unwrap();
    store::remove_source(&conn, "native:file%_:@").unwrap();
    assert_eq!(
        conn.query_row("SELECT SUM(input_tokens) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
}
#[test]
fn cancelled_scan_resumes_exactly_and_rebuild_preserves_live_rows() {
    use std::sync::atomic::Ordering;
    let (dir, conn) = scratch();
    let history = dir.path().join("cancel-resume");
    fs::create_dir(&history).unwrap();
    let mut file =
        std::io::BufWriter::new(fs::File::create(history.join("session.jsonl")).unwrap());
    for id in 0..500 {
        file.write_all(claude_line(&format!("request-{id}"), 1).as_bytes())
            .unwrap();
    }
    file.flush().unwrap();
    drop(file);
    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history],
    };
    let cancel = AtomicBool::new(false);
    let partial = scanner::scan(&root, &conn, &cancel, &mut |_, stats| {
        if stats.facts >= 128 {
            cancel.store(true, Ordering::Relaxed);
        }
    })
    .unwrap();
    assert!(partial.cancelled);
    assert!(partial.facts > 0 && partial.facts < 500);
    scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(
        queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap()["requests"],
        500
    );
    let mut live = facts::Fact::new(
        "fixture",
        "live-only",
        "live-request",
        "2026-01-01T00:00:00Z",
    );
    live.source = "live:fixture".into();
    live.buckets.input = Some(7);
    store::upsert_fact(&conn, &live).unwrap();
    scanner::rebuild(&conn).unwrap();
    let rebuilt = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(rebuilt["requests"], 1);
    assert_eq!(rebuilt["tokens"]["input"], 7);
    scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    let restored = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(restored["requests"], 501);
    assert_eq!(restored["tokens"]["input"], 507);
}
#[test]
fn late_binding_does_not_move_historically_known_native_requests() {
    let (_dir, conn) = scratch();
    conn.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only) VALUES('s','s','fixture','chat','exited','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','new-native',0,0)",[]).unwrap();
    let mut early = facts::Fact::new("fixture", "s", "early", "2026-01-01T00:00:00Z");
    early.threadterm_session_id = Some("s".into());
    early.source = "live:fixture".into();
    early.buckets.input = Some(3);
    let mut old = early.clone();
    old.key = "fixture:old".into();
    old.native_session_id = "old-native".into();
    store::upsert_facts(&conn, &[early, old]).unwrap();
    store::bind_live_native(&conn, "s", "new-native").unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT native_session_id FROM usage_facts WHERE fact_key='fixture:early'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "new-native"
    );
    assert_eq!(
        conn.query_row(
            "SELECT native_session_id FROM usage_facts WHERE fact_key='fixture:old'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "old-native"
    );
}
#[test]
fn changed_prices_are_pending_before_a_queued_history_worker_reaches_repricing() {
    let (_dir, conn) = scratch();
    let cancel = AtomicBool::new(false);
    store::reprice_all(&conn, &json!({}), &cancel).unwrap();
    assert!(!store::request_reprice(&conn, &json!({})).unwrap());
    assert_eq!(
        queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap()["pricingPending"],
        false
    );
    let prices = json!({"fixture/model":{"input":2,"output":3}});
    assert!(store::request_reprice(&conn, &prices).unwrap());
    assert_eq!(
        queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap()["pricingPending"],
        true
    );
    store::reprice_all(&conn, &prices, &cancel).unwrap();
    assert_eq!(
        queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap()["pricingPending"],
        false
    );
}
#[test]
fn kimi_archived_copies_share_the_logical_journal_offset_identity() {
    let (_dir, conn) = scratch();
    let mut states = [
        facts::ReaderState {
            session_id: "native-kimi".into(),
            ..Default::default()
        },
        facts::ReaderState {
            session_id: "native-kimi".into(),
            ..Default::default()
        },
    ];
    let value = json!({"type":"usage.record","time":1767265200000_i64,"model":"fixture-model","usage":{"inputOther":1,"inputCacheRead":2,"inputCacheCreation":3,"output":4}});
    let first = readers::parse("kimi", &value, 10, "first-path-hash", &mut states[0]);
    let copy = readers::parse("kimi", &value, 10, "copy-path-hash", &mut states[1]);
    assert_eq!(first.facts[0].key, copy.facts[0].key);
    store::upsert_facts(&conn, &[first.facts[0].clone(), copy.facts[0].clone()]).unwrap();
    let result = queries::query(&conn, "usage.ledger.summary", &json!({})).unwrap();
    assert_eq!(result["requests"], 1);
    assert_eq!(result["tokens"]["total"], 10);
}
