use super::{discovery, queries, scanner, store};
use crate::db::Database;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

struct Job {
    id: String,
    cancel: Arc<AtomicBool>,
    running: bool,
    pending_reprice: bool,
}
fn jobs() -> &'static Mutex<HashMap<PathBuf, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Job>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn queue_reprice_after_cancelled_job(job: &mut Job, price_only: bool) {
    if price_only && job.cancel.load(Ordering::Relaxed) {
        job.pending_reprice = true;
    }
}

pub fn dispatch(db: &Arc<Database>, method: &str, params: &Value) -> Result<Option<Value>> {
    if !method.starts_with("usage.ledger.") {
        return Ok(None);
    }
    let value = match method {
        "usage.ledger.refresh" | "usage.ledger.rebuild" => {
            start(db, params, method.ends_with("rebuild"), true)?
        }
        "usage.ledger.cancel" => {
            let id = string(params, "scanId")?;
            let operation = string(params, "operationId")?;
            db.bind_operation(operation, method, params)?;
            if let Some(value) = db.operation(operation)? {
                return Ok(Some(value));
            }
            let mut guard = jobs().lock().map_err(|_| anyhow!("usage_job_lock"))?;
            let accepted = guard
                .get(db.path())
                .is_some_and(|j| j.id == id && j.running);
            if accepted {
                let job = guard
                    .get_mut(db.path())
                    .expect("accepted usage job remains present");
                job.pending_reprice = false;
                job.cancel.store(true, Ordering::Relaxed);
            }
            let result = json!({"scanId":id,"cancelRequested":accepted});
            db.transaction(|tx| crate::db::complete(tx, operation, method, &result))?;
            result
        }
        "usage.ledger.settings" => settings(db)?,
        "usage.ledger.settings.update" => {
            let result = update_settings(db, params)?;
            schedule_pricing(db)?;
            result
        }
        "usage.ledger.sources" => {
            let conn = read_connection(db.path())?;
            let mut value = scanner::sources(&conn)?;
            let setting = settings(db)?;
            let history_enabled = setting["value"]["includeOutside"].as_bool().unwrap_or(true);
            if let Some(providers) = value["providers"].as_array_mut() {
                let known: BTreeSet<String> = providers
                    .iter()
                    .filter_map(|source| source["provider"].as_str().map(str::to_owned))
                    .collect();
                for source in providers.iter_mut() {
                    let enabled = history_enabled
                        && setting["value"]["providers"][source["provider"].as_str().unwrap_or("")]
                            .as_bool()
                            != Some(false);
                    source["historyReadEnabled"] = json!(enabled);
                    source["historyReadLabelKey"] = if enabled {
                        Value::Null
                    } else {
                        json!("historyNotReadThreadtermOnly")
                    };
                }
                for root in discovery::roots() {
                    if known.contains(&root.provider)
                        || (history_enabled
                            && setting["value"]["providers"][&root.provider].as_bool()
                                != Some(false))
                    {
                        continue;
                    }
                    providers.push(json!({
                        "provider": root.provider,
                        "root": root.path.to_string_lossy(),
                        "status": "history_not_read",
                        "missingSources": 0,
                        "historyReadEnabled": false,
                        "historyReadLabelKey": "historyNotReadThreadtermOnly",
                        "lastRead": Value::Null,
                        "stats": {"filesFound":0,"filesRead":0,"bytesRead":0,"facts":0,"problems":{},"cancelled":false},
                        "bucketsReported": Vec::<&str>::new(),
                    }));
                }
                providers.sort_by(|left, right| {
                    left["provider"].as_str().cmp(&right["provider"].as_str())
                });
            }
            let guard = jobs().lock().map_err(|_| anyhow!("usage_job_lock"))?;
            value["scan"] = guard
                .get(db.path())
                .map(|j| json!({"scanId":j.id,"state":if j.running {"running"} else {"idle"}}))
                .unwrap_or(Value::Null);
            value
        }
        "usage.ledger.summary"
        | "usage.ledger.series"
        | "usage.ledger.breakdown"
        | "usage.ledger.sessions"
        | "usage.ledger.session" => {
            let setting = settings(db)?;
            let mut query = params.clone();
            let filter = if query.get("filters").is_some() {
                &mut query["filters"]
            } else {
                &mut query
            };
            if !filter.is_object() {
                return Err(anyhow!("invalid_usage_filters"));
            }
            if setting["value"]["includeOutside"].as_bool() == Some(false) {
                filter["includeOutside"] = json!(false);
            } else if filter.get("includeOutside").is_none() {
                filter["includeOutside"] = setting["value"]["includeOutside"].clone();
            }
            let disabled: BTreeSet<String> = setting["value"]["providers"]
                .as_object()
                .into_iter()
                .flat_map(|providers| providers.iter())
                .filter_map(|(provider, enabled)| {
                    (enabled.as_bool() == Some(false)).then(|| provider.clone())
                })
                .collect();
            if !disabled.is_empty() {
                // This is an internal filter: native observations disappear, while
                // ThreadTerm live observations for the same provider remain visible.
                filter["nativeProvidersDisabled"] = json!(disabled);
            }
            let conn = read_connection(db.path())?;
            if query.get("weekStart").is_none() {
                query["weekStart"] = setting["value"]["weekStart"].clone();
            }
            query["priceOverrides"] = setting["value"]["priceOverrides"].clone();
            queries::query(&conn, method, &query)?
        }
        _ => return Err(anyhow!("unknown_usage_method")),
    };
    Ok(Some(value))
}

fn read_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(1000))?;
    Ok(conn)
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| anyhow!("invalid_usage_{key}"))
}

fn settings(db: &Database) -> Result<Value> {
    let conn = read_connection(db.path())?;
    let (revision, raw): (i64, String) = conn.query_row(
        "SELECT revision,value FROM settings WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let raw: Value = serde_json::from_str(&raw)?;
    let mut value = raw
        .get("usageLedger")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if value.get("includeOutside").is_none() {
        value["includeOutside"] = json!(true);
    }
    if value.get("providers").is_none() {
        value["providers"] = json!({});
    }
    if value.get("weekStart").is_none() {
        value["weekStart"] = json!("auto");
    }
    let mut prices = raw
        .get("modelPrices")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(overrides) = value.get("priceOverrides").and_then(Value::as_object) {
        for (key, value) in overrides {
            prices[key] = value.clone();
        }
    }
    value["priceOverrides"] = prices;
    Ok(json!({"revision":revision,"value":value}))
}

fn update_settings(db: &Database, params: &Value) -> Result<Value> {
    let operation = string(params, "operationId")?;
    db.bind_operation(operation, "usage.ledger.settings.update", params)?;
    if let Some(result) = db.operation(operation)? {
        return Ok(result);
    }
    let expected = params
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("invalid_usage_revision"))?;
    let value = params
        .get("value")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("invalid_usage_settings"))?;
    let disables_native_history = value.get("includeOutside").and_then(Value::as_bool)
        == Some(false)
        || value
            .get("providers")
            .and_then(Value::as_object)
            .is_some_and(|providers| {
                providers
                    .values()
                    .any(|enabled| enabled.as_bool() == Some(false))
            });
    for (name, v) in value {
        match name.as_str() {
            "includeOutside" if v.is_boolean() => {}
            "weekStart" if matches!(v.as_str(), Some("auto" | "monday" | "sunday")) => {}
            "providers"
                if v.as_object()
                    .is_some_and(|o| o.iter().all(|(k, v)| k.len() <= 64 && v.is_boolean())) => {}
            "priceOverrides" if valid_prices(v) => {}
            _ => return Err(anyhow!("invalid_usage_settings")),
        }
    }
    let result = db.transaction(|tx| {
        let (revision, raw): (i64, String) = tx.query_row(
            "SELECT revision,value FROM settings WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if revision != expected {
            return Err(anyhow!("revision_conflict"));
        }
        let mut raw: Value = serde_json::from_str(&raw)?;
        if !raw["usageLedger"].is_object() {
            raw["usageLedger"] = json!({});
        }
        for (name, v) in value {
            raw["usageLedger"][name] = v.clone();
        }
        tx.execute(
            "UPDATE settings SET revision=?,value=? WHERE singleton=1",
            params![revision + 1, serde_json::to_string(&raw)?],
        )?;
        let mut effective = raw["usageLedger"].clone();
        if effective.get("includeOutside").is_none() {
            effective["includeOutside"] = json!(true);
        }
        if effective.get("providers").is_none() {
            effective["providers"] = json!({});
        }
        if effective.get("weekStart").is_none() {
            effective["weekStart"] = json!("auto");
        }
        let mut prices = raw
            .get("modelPrices")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(overrides) = effective.get("priceOverrides").and_then(Value::as_object) {
            for (key, v) in overrides {
                prices[key] = v.clone();
            }
        }
        effective["priceOverrides"] = prices;
        let result = json!({"revision":revision+1,"value":effective});
        crate::db::complete(tx, operation, "usage.ledger.settings.update", &result)?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
            params![
                json!({"kind":"settings"}).to_string(),
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(result)
    })?;
    if disables_native_history {
        if let Ok(guard) = jobs().lock() {
            if let Some(job) = guard.get(db.path()).filter(|job| job.running) {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    Ok(result)
}

fn valid_prices(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.len() <= 1000
            && o.iter().all(|(key, row)| {
                key.len() <= 256
                    && row.as_object().is_some_and(|r| {
                        !r.is_empty()
                            && r.iter().all(|(k, v)| {
                                matches!(
                                    k.as_str(),
                                    "input"
                                        | "output"
                                        | "cacheRead"
                                        | "cacheWrite5m"
                                        | "cacheWrite1h"
                                ) && v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
                            })
                    })
            })
    })
}

pub fn schedule_pricing(db: &Arc<Database>) -> Result<()> {
    let revision = settings(db)?["revision"].as_i64().unwrap_or(0);
    schedule_pricing_with_operation(db, format!("usage-pricing:{revision}"))
}

fn schedule_pending_pricing(db: &Arc<Database>) -> Result<()> {
    schedule_pricing_with_operation(
        db,
        format!("usage-pricing-followup:{}", uuid::Uuid::new_v4()),
    )
}

fn schedule_pricing_with_operation(db: &Arc<Database>, operation_id: String) -> Result<()> {
    start(db, &json!({"operationId":operation_id}), false, false)?;
    Ok(())
}

fn start(db: &Arc<Database>, params: &Value, rebuild: bool, scan_history: bool) -> Result<Value> {
    let operation = string(params, "operationId")?;
    let method = if !scan_history {
        "usage.ledger.pricing"
    } else if rebuild {
        "usage.ledger.rebuild"
    } else {
        "usage.ledger.refresh"
    };
    db.bind_operation(operation, method, params)?;
    if let Some(result) = db.operation(operation)? {
        return Ok(result);
    }
    let scan_settings = settings(db)?;
    db.transaction(|tx| store::request_reprice(tx, &scan_settings["value"]["priceOverrides"]))?;
    let mut guard = jobs().lock().map_err(|_| anyhow!("usage_job_lock"))?;
    if let Some(job) = guard.get_mut(db.path()).filter(|j| j.running) {
        queue_reprice_after_cancelled_job(job, !scan_history);
        let result = json!({"scanId":job.id,"state":"already_running"});
        db.transaction(|tx| crate::db::complete(tx, operation, method, &result))?;
        return Ok(result);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    guard.insert(
        db.path().to_owned(),
        Job {
            id: id.clone(),
            cancel: Arc::clone(&cancel),
            running: true,
            pending_reprice: false,
        },
    );
    let response = json!({"scanId":id,"state":"running"});
    db.transaction(|tx| crate::db::complete(tx, operation, method, &response))?;
    let worker_db = Arc::clone(db);
    let worker_id = id.clone();
    let spawned = std::thread::Builder::new().name("usage-history".into()).spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
            let conn = Connection::open(worker_db.path())?;
            conn.set_prepared_statement_cache_capacity(128);
            conn.busy_timeout(std::time::Duration::from_millis(1000))?;
            if !store::rebuild_query_cache(&conn, &cancel)? {
                return Ok(());
            }
            if rebuild && !scanner::rebuild_cancellable(&conn, &cancel)? {
                return Ok(());
            }
            if scan_history {
                store::import_legacy_cancellable(&conn,&cancel)?;
            // Provider discovery and all history reads happen on this worker.
            for root in discovery::roots() {
                if cancel.load(Ordering::Relaxed) { break; }
                if scan_settings["value"]["includeOutside"].as_bool() == Some(false) { continue; }
                if scan_settings["value"]["providers"][&root.provider].as_bool() == Some(false) { continue; }
                scanner::scan(&root,&conn,&cancel,&mut |provider,stats| {
                    let _ = progress(&worker_db,&json!({"scanId":worker_id,"provider":provider,"state":"running","stats":stats}));
                })?;
            }
            }
            if scan_history { store::refresh_attributions(&conn,&cancel)?; }
            store::rebuild_dirty_activity(&conn,&cancel)?;
            loop {
                if cancel.load(Ordering::Relaxed){break;}
                let current=settings(&worker_db)?;
                let overrides=&current["value"]["priceOverrides"];
                let _=progress(&worker_db,&json!({"scanId":worker_id,"state":"running","phase":"pricing"}));
                store::reprice_all(&conn,overrides,&cancel)?;
                let mut guard=jobs().lock().map_err(|_|anyhow!("usage_job_lock"))?;
                if settings(&worker_db)?["value"]["priceOverrides"]==*overrides {
                    if let Some(job)=guard.get_mut(worker_db.path()).filter(|j|j.id==worker_id){job.running=false;}
                    break;
                }
            }
            Ok(())
        }));
        let (state,error) = match outcome {
            Ok(Ok(())) => (if cancel.load(Ordering::Relaxed) {"cancelled"} else {"completed"}, None),
            Ok(Err(_)) => ("failed",Some("usage_scan_failed")),
            Err(_) => ("failed",Some("usage_scan_panicked")),
        };
        let pending_reprice = jobs().lock().ok().and_then(|mut guard| {
            let job = guard.get_mut(worker_db.path()).filter(|job| job.id == worker_id)?;
            job.running = false;
            let pending = job.pending_reprice;
            job.pending_reprice = false;
            Some(pending)
        }).unwrap_or(false);
        if pending_reprice {
            let _ = schedule_pending_pricing(&worker_db);
        }
        let _ = progress(&worker_db,&json!({"scanId":worker_id,"state":state,"error":error}));
    });
    if spawned.is_err() {
        if let Some(job) = guard.get_mut(db.path()) {
            job.running = false;
        }
        return Err(anyhow!("usage_worker_start_failed"));
    }
    Ok(response)
}

fn progress(db: &Database, value: &Value) -> Result<()> {
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('usage.ledger.progress',?,?)",
            params![
                serde_json::to_string(value)?,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_overrides_are_revisioned_idempotent_and_reprice_without_scanning() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("settings.sqlite")).unwrap());
        let initial = dispatch(&db, "usage.ledger.settings", &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(initial["value"]["includeOutside"], true);
        let request = json!({"expectedRevision":initial["revision"],"operationId":"settings-fixture","value":{"weekStart":"monday","priceOverrides":{"fixture/unknown":{"input":2,"output":3}}}});
        let changed = dispatch(&db, "usage.ledger.settings.update", &request)
            .unwrap()
            .unwrap();
        assert_eq!(
            changed["revision"].as_i64(),
            Some(initial["revision"].as_i64().unwrap() + 1)
        );
        assert_eq!(
            dispatch(&db, "usage.ledger.settings.update", &request)
                .unwrap()
                .unwrap(),
            changed
        );
        assert!(dispatch(&db,"usage.ledger.settings.update",&json!({"expectedRevision":initial["revision"],"operationId":"stale","value":{"includeOutside":false}})).is_err());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while jobs()
            .lock()
            .unwrap()
            .get(db.path())
            .is_some_and(|j| j.running)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "pricing job failed to settle"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        db.transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM usage_scan_providers", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM outbox WHERE event='usage.ledger.progress'",
                [],
                |r| r.get(0),
            )?;
            assert!(count > 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn disabling_native_history_cancels_an_active_scan() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("settings.sqlite")).unwrap());
        let initial = settings(&db).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        jobs().lock().unwrap().insert(
            db.path().to_owned(),
            Job {
                id: "scan".into(),
                cancel: Arc::clone(&cancel),
                running: true,
                pending_reprice: false,
            },
        );
        update_settings(
            &db,
            &json!({
                "expectedRevision": initial["revision"],
                "operationId": "disable-native-history",
                "value": {"includeOutside": false}
            }),
        )
        .unwrap();
        assert!(cancel.load(Ordering::Relaxed));
        jobs().lock().unwrap().remove(db.path());
    }

    #[test]
    fn price_join_after_cancellation_queues_only_a_price_followup() {
        let cancel = Arc::new(AtomicBool::new(true));
        let mut job = Job {
            id: "scan".into(),
            cancel,
            running: true,
            pending_reprice: false,
        };
        queue_reprice_after_cancelled_job(&mut job, true);
        assert!(job.pending_reprice);
        job.pending_reprice = false;
        queue_reprice_after_cancelled_job(&mut job, false);
        assert!(!job.pending_reprice);
    }
}
