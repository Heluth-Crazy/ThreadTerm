//! Explicit, content-free machine audit through the production worker and RPCs.
use super::*;
use chrono::{Duration, Local};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, io::Write, sync::Arc, time::Instant};

fn scrub(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in ["title", "label", "root", "cwd", "path", "projectPath"] {
                object.remove(key);
            }
            for child in object.values_mut() {
                scrub(child);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(scrub),
        _ => {}
    }
}

fn rpc(db: &Arc<crate::db::Database>, method: &str, params: &Value) -> Value {
    let mut value = dispatch(db, method, params).unwrap().unwrap();
    scrub(&mut value);
    value
}

fn refresh(db: &Arc<crate::db::Database>) -> u128 {
    let started = Instant::now();
    let result = rpc(
        db,
        "usage.ledger.refresh",
        &json!({"operationId": uuid::Uuid::new_v4().to_string()}),
    );
    let scan = result["scanId"].as_str().unwrap();
    loop {
        let finished = db.transaction(|tx| {
            let mut stmt = tx.prepare("SELECT data FROM outbox WHERE event='usage.ledger.progress' ORDER BY rowid DESC LIMIT 32")?;
            let values = stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(values.into_iter().filter_map(|v| serde_json::from_str::<Value>(&v).ok())
                .find(|v| v["scanId"].as_str() == Some(scan)
                    && matches!(v["state"].as_str(), Some("completed" | "failed" | "cancelled"))))
        }).unwrap();
        if let Some(finished) = finished {
            assert_eq!(
                finished["state"], "completed",
                "audit worker did not complete"
            );
            return started.elapsed().as_millis();
        }
        assert!(started.elapsed().as_secs() < 14400, "audit worker deadline");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn raw(conn: &Connection, dimensions: &str) -> Vec<Value> {
    let sql = format!("SELECT {dimensions}, COUNT(*), SUM(input_tokens), SUM(cache_read_tokens), SUM(cache_write5m_tokens), SUM(cache_write1h_tokens), SUM(cache_write_unknown_tokens), SUM(output_tokens), SUM(reasoning_tokens), SUM(reported_cost) FROM usage_facts GROUP BY 1,2,3 ORDER BY 1,2,3");
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map([], |row| Ok(json!({
        "provider": row.get::<_, String>(0)?, "dimension": row.get::<_, String>(1)?,
        "model": row.get::<_, Option<String>>(2)?, "requests": row.get::<_, i64>(3)?,
        "input": row.get::<_, Option<i64>>(4)?, "cacheRead": row.get::<_, Option<i64>>(5)?,
        "cacheWrite5m": row.get::<_, Option<i64>>(6)?, "cacheWrite1h": row.get::<_, Option<i64>>(7)?,
        "cacheWriteUnknown": row.get::<_, Option<i64>>(8)?, "output": row.get::<_, Option<i64>>(9)?,
        "reasoning": row.get::<_, Option<i64>>(10)?, "reportedCost": row.get::<_, Option<f64>>(11)?
    }))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
#[ignore = "Explicitly authorized read-only provider accuracy export; writes only an isolated TEMP ledger"]
fn usage_accuracy_export() {
    let output = std::env::var_os("UA3_EXPORT_DIR")
        .map(std::path::PathBuf::from)
        .expect("set UA3_EXPORT_DIR to a scratch directory");
    assert!(output.is_absolute() && output.starts_with(std::env::temp_dir()));
    fs::create_dir_all(&output).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ledger_dir = std::env::var_os("UA3_LEDGER_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dir.path().to_owned());
    assert!(ledger_dir.is_absolute() && ledger_dir.starts_with(std::env::temp_dir()));
    fs::create_dir_all(&ledger_dir).unwrap();
    let db = Arc::new(crate::db::Database::open(&ledger_dir.join("audit.sqlite")).unwrap());
    let first_ms = refresh(&db);
    let ingestion_profile = store::ingestion_profile_take();
    let conn = ledger_db::open_worker(db.path()).unwrap();
    let (first_day, last_day): (Option<String>, Option<String>) = conn.query_row(
        "SELECT MIN(date(occurred_at,'localtime')),MAX(date(occurred_at,'localtime')) FROM usage_facts", [],
        |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    let today = Local::now().date_naive();
    let end = today + Duration::days(1);
    let first = first_day.unwrap_or_else(|| today.to_string());
    let last = last_day
        .and_then(|v| chrono::NaiveDate::parse_from_str(&v, "%Y-%m-%d").ok())
        .map(|v| v + Duration::days(1))
        .unwrap_or(end)
        .max(end);
    let mut ranges = json!({});
    for (name, from, to) in [
        ("all", first, last.to_string()),
        (
            "last30",
            (today - Duration::days(29)).to_string(),
            end.to_string(),
        ),
    ] {
        let filters = json!({"scope":"all","from":from,"to":to,"includeOutside":true});
        let mut range = json!({"filters": filters});
        range["summary"] = rpc(&db, "usage.ledger.summary", &json!({"filters":filters}));
        range["series"] = rpc(
            &db,
            "usage.ledger.series",
            &json!({"filters":filters,"granularity":"day","stack":"provider"}),
        );
        for dimension in ["provider", "model", "project"] {
            range["breakdown"][dimension] = rpc(
                &db,
                "usage.ledger.breakdown",
                &json!({"filters":filters,"dimension":dimension}),
            );
        }
        let mut sessions = Vec::new();
        loop {
            let page = rpc(
                &db,
                "usage.ledger.sessions",
                &json!({"filters":filters,"offset":sessions.len(),"limit":200}),
            );
            let items = page["items"].as_array().expect("sessions items");
            if items.is_empty() {
                break;
            }
            sessions.extend(items.iter().cloned());
            if sessions.len() >= page["total"].as_u64().unwrap() as usize {
                break;
            }
        }
        range["sessions"] = json!(sessions);
        ranges[name] = range;
    }
    let daily = raw(&conn, "provider,date(occurred_at,'localtime'),model");
    let sessions = raw(&conn, "provider,native_session_id,model");
    // Numeric request snapshots prove that differences between real-history
    // runs are appended requests, without retaining transcript bytes or paths.
    let mut numeric =
        std::io::BufWriter::new(fs::File::create(output.join("facts.jsonl")).unwrap());
    let mut statement = conn.prepare("SELECT json_array(fact_key,provider,native_session_id,model,occurred_at,input_tokens,cache_read_tokens,cache_write5m_tokens,cache_write1h_tokens,cache_write_unknown_tokens,output_tokens,reasoning_tokens,reported_cost,estimated_cost,source) FROM usage_facts ORDER BY fact_key").unwrap();
    for row in statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
    {
        writeln!(numeric, "{}", row.unwrap()).unwrap();
    }
    numeric.flush().unwrap();
    let progress_events: i64 = db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM outbox WHERE event='usage.ledger.progress'",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    let second_ms = refresh(&db);
    let result = json!({"capturedAt":chrono::Utc::now().to_rfc3339(),"parserVersion":facts::PARSER_VERSION,"timeZone":Local::now().offset().to_string(),
        "firstScanMs":first_ms,"secondScanMs":second_ms,"firstScanProgressEvents":progress_events,"ingestionProfile":ingestion_profile,"ranges":ranges,
        "rawDaily":daily,"rawSessions":sessions,"sources":rpc(&db,"usage.ledger.sources",&json!({}))});
    fs::write(
        output.join("threadterm.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("PASS usage_accuracy_export first_scan_ms={first_ms} second_scan_ms={second_ms} facts_sessions={}", result["rawSessions"].as_array().unwrap().len());
}

#[test]
#[ignore = "Explicit real-history refresh timing with a controlled TEMP-only append"]
fn usage_real_history_single_append() {
    let seed = std::path::PathBuf::from(
        std::env::var_os("UA3_APPEND_SEED_DIR").expect("set UA3_APPEND_SEED_DIR"),
    );
    let output =
        std::path::PathBuf::from(std::env::var_os("UA3_EXPORT_DIR").expect("set UA3_EXPORT_DIR"));
    assert!(seed.is_absolute() && seed.starts_with(std::env::temp_dir()));
    assert!(output.is_absolute() && output.starts_with(std::env::temp_dir()));
    fs::create_dir_all(&output).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for name in [
        "audit.sqlite",
        "audit.sqlite-wal",
        "usage-ledger.sqlite",
        "usage-ledger.sqlite-wal",
    ] {
        let source = seed.join(name);
        if source.is_file() {
            fs::copy(source, scratch.path().join(name)).unwrap();
        }
    }
    let db = Arc::new(crate::db::Database::open(&scratch.path().join("audit.sqlite")).unwrap());
    let conn = ledger_db::open_worker(db.path()).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let fixture = scratch.path().join("active.jsonl");
    let event = |index| {
        json!({"type":"token_usage_record","timestamp":"2026-01-02T00:00:01Z","payload":{
        "thread_id":"append-fixture", "response_id":format!("append-{index}"), "model":"fixture-model",
        "usage":{"input_tokens":2,"cached_input_tokens":1,"output_tokens":1}}})
    };
    fs::write(
        &fixture,
        format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"append-fixture"}}),
            event(0)
        ),
    )
    .unwrap();
    let mut roots = discovery::roots();
    roots
        .iter_mut()
        .find(|root| root.provider == "codex")
        .unwrap()
        .trees
        .push(fixture.clone());
    let run = || {
        let started = Instant::now();
        live::import_log(&conn, &cancelled).unwrap();
        store::rebuild_query_cache(&conn, &cancelled).unwrap();
        store::import_legacy_cancellable(&conn, &cancelled).unwrap();
        let mut reads = std::collections::BTreeMap::new();
        for root in &roots {
            let stats = scanner::scan(root, &conn, &cancelled, &mut |provider, stats| {
                db.transaction(|tx| {
                    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('usage.ledger.progress',?,?)", rusqlite::params![json!({"provider":provider,"state":"running","stats":stats}).to_string(), chrono::Utc::now().to_rfc3339()])?;
                    Ok(())
                }).unwrap();
            }).unwrap();
            reads.insert(root.provider.clone(), stats.files_read);
        }
        store::refresh_attributions(&conn, &cancelled).unwrap();
        live::import_log(&conn, &cancelled).unwrap();
        store::rebuild_dirty_activity(&conn, &cancelled).unwrap();
        store::reprice_all(&conn, &json!({}), &cancelled).unwrap();
        (started.elapsed().as_millis(), reads)
    };
    let mut measurements = Vec::new();
    let mut steady = None;
    for _ in 0..5 {
        let (ms, reads) = run();
        measurements.push(json!({"kind":"warm","ms":ms,"filesRead":reads}));
        fs::write(
            output.join("refresh-timings.json"),
            serde_json::to_vec_pretty(&json!({"measurements":measurements})).unwrap(),
        )
        .unwrap();
        if reads.values().sum::<u64>() == 0 {
            steady = Some(ms);
            break;
        }
    }
    let no_change_ms = steady;
    let before: i64 = conn.query_row("SELECT COUNT(*) FROM usage_facts WHERE provider='codex' AND native_session_id='append-fixture'", [], |row| row.get(0)).unwrap();
    let mut single = None;
    for index in 1..=5 {
        writeln!(
            fs::OpenOptions::new().append(true).open(&fixture).unwrap(),
            "{}",
            event(index)
        )
        .unwrap();
        let (ms, reads) = run();
        measurements.push(json!({"kind":"append","ms":ms,"filesRead":reads}));
        fs::write(
            output.join("refresh-timings.json"),
            serde_json::to_vec_pretty(&json!({"measurements":measurements})).unwrap(),
        )
        .unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM usage_facts WHERE provider='codex' AND native_session_id='append-fixture'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, before + index);
        if reads.values().sum::<u64>() == 1 {
            single = Some(ms);
            break;
        }
    }
    let append_ms = single;
    fs::write(output.join("refresh-timings.json"), serde_json::to_vec_pretty(&json!({"noChangeMs":no_change_ms,"singleAppendMs":append_ms,"measurements":measurements})).unwrap()).unwrap();
    println!("PASS usage_real_history_single_append controlled_requests_preserved");
    match (no_change_ms, append_ms) {
        (Some(warm), Some(appended)) => println!("PASS real_history_refresh no_change_ms={warm} single_append_ms={appended}"),
        _ => println!("INCONCLUSIVE strict_refresh_samples real_histories_changed=true; inspect refresh-timings.json"),
    }
}
