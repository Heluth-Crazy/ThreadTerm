//! Explicit, content-free machine audit through the production worker and RPCs.
use super::*;
use chrono::{Duration, Local};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, sync::Arc, time::Instant};

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
    let second_ms = refresh(&db);
    let result = json!({"capturedAt":chrono::Utc::now().to_rfc3339(),"parserVersion":facts::PARSER_VERSION,"timeZone":Local::now().offset().to_string(),
        "firstScanMs":first_ms,"secondScanMs":second_ms,"ingestionProfile":ingestion_profile,"ranges":ranges,
        "rawDaily":daily,"rawSessions":sessions,"sources":rpc(&db,"usage.ledger.sources",&json!({}))});
    fs::write(
        output.join("threadterm.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("PASS usage_accuracy_export first_scan_ms={first_ms} second_scan_ms={second_ms} facts_sessions={}", result["rawSessions"].as_array().unwrap().len());
}
