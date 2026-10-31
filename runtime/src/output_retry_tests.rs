use super::*;
use crate::db::{CreateSession, Database};
use std::{
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

fn session(db: &Database, operation_id: &str) -> String {
    db.create_session(CreateSession {
        project_id: None,
        title: None,
        provider: "shell",
        mode: "terminal",
        native_id: None,
        operation_id,
    })
    .unwrap()
    .id
}

fn output_bytes(db: &Database, session_id: &str) -> (Vec<(i64, Vec<u8>)>, Vec<u8>) {
    let chunks = db.output_from(session_id, 0, 16 * 1024 * 1024).unwrap();
    let bytes = chunks
        .iter()
        .flat_map(|(_, data)| data.iter().copied())
        .collect();
    (chunks, bytes)
}

#[test]
fn flush_pending_recovers_a_quiet_tail_once_without_new_data() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let session_id = session(&db, "flush-pending-quiet-tail");
    db.append_output(&session_id, 0, b"occupied").unwrap();
    let store = OutputStore::default();

    assert!(store.append(&db, &session_id, b"tail").is_err());
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM output_chunks WHERE session_id=?",
            [&session_id],
        )?;
        Ok(())
    })
    .unwrap();

    assert_eq!(
        store.flush_pending(&db, &session_id).unwrap(),
        FlushOutcome::Clean { durable_end: 4 }
    );
    assert_eq!(
        store.flush_pending(&db, &session_id).unwrap(),
        FlushOutcome::Clean { durable_end: 4 }
    );
    assert_eq!(output_bytes(&db, &session_id).1, b"tail");
    assert_eq!(store.cursor(&session_id), 4);
    assert!(db.terminal_storage_degraded(&session_id).unwrap().is_none());
    let storage_events: Vec<_> = db
        .events_after(0)
        .unwrap()
        .into_iter()
        .filter(|(_, event, _)| event == "terminal.storage")
        .collect();
    assert_eq!(
        storage_events.len(),
        2,
        "a clean no-data flush must not emit another recovery"
    );
    assert_eq!(
        storage_events
            .iter()
            .filter(|(_, _, data)| data["degraded"] == false)
            .count(),
        1
    );
}

#[test]
fn retry_worker_commits_a_quiet_tail_after_storage_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let session_id = session(&db, "retry-worker-quiet-tail");
    db.append_output(&session_id, 0, b"occupied").unwrap();
    let store = Arc::new(OutputStore::default());

    assert!(store
        .append_shared(&db, &session_id, b"quiet-tail")
        .is_err());
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM output_chunks WHERE session_id=?",
            [&session_id],
        )?;
        Ok(())
    })
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && db.output_end(&session_id).unwrap() != 10 {
        thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(output_bytes(&db, &session_id).1, b"quiet-tail");
    store.stop_retry_worker();
}

#[test]
fn prolonged_refusal_caps_pending_and_leaves_one_durable_gap() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let session_id = session(&db, "pending-cap-gap");
    db.append_output(&session_id, 0, b"occupied").unwrap();
    let store = Arc::new(OutputStore::default());
    assert!(store.append_shared(&db, &session_id, b"first").is_err());
    db.transaction(|tx| {
        tx.execute("DELETE FROM output_chunks WHERE session_id=?", [&session_id])?;
        tx.execute("CREATE TEMP TRIGGER reject_output BEFORE INSERT ON output_chunks BEGIN SELECT RAISE(ABORT, 'storage refused'); END", [])?;
        Ok(())
    }).unwrap();

    assert!(store
        .append_shared(&db, &session_id, &vec![b'x'; MAX_PENDING_BYTES + 5])
        .is_err());
    assert!(store.append_shared(&db, &session_id, b"again").is_err());
    // The 250 ms and 500 ms retries both hit the trigger.  The backoff proves
    // the worker, rather than only the foreground appends, kept retrying.
    let attempts_deadline = Instant::now() + Duration::from_secs(3);
    while store.stream(&session_id).lock().unwrap().backoff < Duration::from_secs(1)
        && Instant::now() < attempts_deadline
    {
        thread::sleep(Duration::from_millis(25));
    }
    let stream = store.stream(&session_id);
    let stream = stream.lock().unwrap();
    assert!(
        stream.backoff >= Duration::from_secs(1),
        "retry worker did not make two outage attempts"
    );
    let pending = stream.pending.len();
    drop(stream);
    assert_eq!(pending, MAX_PENDING_BYTES);
    db.transaction(|tx| {
        tx.execute("DROP TRIGGER reject_output", [])?;
        Ok(())
    })
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && db.output_end(&session_id).unwrap() == 0 {
        thread::sleep(Duration::from_millis(25));
    }
    assert_ne!(
        db.output_end(&session_id).unwrap(),
        0,
        "worker did not recover the quiet pending suffix"
    );
    let gap = db.output_from(&session_id, 0, 64).unwrap_err().to_string();
    assert!(gap.contains("terminal_history_gap"), "{gap}");
    let chunks = db
        .output_from(
            &session_id,
            store.cursor(&session_id) - MAX_PENDING_BYTES as i64,
            64,
        )
        .unwrap();
    assert_eq!(
        chunks.len(),
        1,
        "only the retained suffix is durable after the outage"
    );
    store.stop_retry_worker();
}

#[test]
fn a_blocked_failing_stream_does_not_hold_up_a_healthy_session() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let failing = session(&db, "blocked-failing-stream");
    let healthy = session(&db, "healthy-stream");
    let valid_reject_failing = format!("CREATE TEMP TRIGGER reject_one BEFORE INSERT ON output_chunks WHEN NEW.session_id = '{failing}' BEGIN SELECT RAISE(ABORT, 'storage refused'); END");
    db.transaction(|tx| {
        tx.execute(&valid_reject_failing, [])?;
        Ok(())
    })
    .unwrap();
    let store = Arc::new(OutputStore::default());
    assert!(store.append(&db, &failing, b"pending").is_err());
    let blocked = store.stream(&failing);
    let held = blocked.lock().unwrap();
    let healthy_store = store.clone();
    let healthy_db = db.clone();
    let healthy_id = healthy.clone();
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
    let start = Instant::now();
    let writer = thread::spawn(move || {
        let _ = done_tx.send(healthy_store.append(&healthy_db, &healthy_id, b"healthy"));
    });
    let result = done_rx.recv_timeout(Duration::from_secs(2));
    let elapsed = start.elapsed();
    drop(held);
    writer.join().unwrap();
    let offset = result
        .expect("healthy append waited on another session stream")
        .unwrap();
    assert!(
        elapsed < Duration::from_secs(2),
        "healthy append exceeded the contention bound"
    );
    assert_eq!(offset, 0);
    assert_eq!(output_bytes(&db, &healthy).1, b"healthy");
}

#[test]
fn a_failed_recovery_marker_clear_retries_without_rewriting_output() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let session_id = session(&db, "retry-marker-clear");
    db.append_output(&session_id, 0, b"occupied").unwrap();
    let store = OutputStore::default();
    assert!(store.append(&db, &session_id, b"tail").is_err());
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM output_chunks WHERE session_id=?",
            [&session_id],
        )?;
        tx.execute(
            "CREATE TEMP TRIGGER reject_recovery_event BEFORE INSERT ON outbox \
             WHEN NEW.event = 'terminal.storage' AND json_extract(NEW.data, '$.degraded') = 0 \
             BEGIN SELECT RAISE(ABORT, 'recovery event refused'); END",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    assert_eq!(
        store.flush_pending(&db, &session_id).unwrap(),
        FlushOutcome::Clean { durable_end: 4 },
    );
    assert_eq!(output_bytes(&db, &session_id).1, b"tail");
    assert!(db.terminal_storage_degraded(&session_id).unwrap().is_some());
    db.transaction(|tx| {
        tx.execute("DROP TRIGGER reject_recovery_event", [])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        store.flush_pending(&db, &session_id).unwrap(),
        FlushOutcome::Clean { durable_end: 4 }
    );
    assert!(db.terminal_storage_degraded(&session_id).unwrap().is_none());
    let recovery_events = db
        .events_after(0)
        .unwrap()
        .into_iter()
        .filter(|(_, event, data)| event == "terminal.storage" && data["degraded"] == false)
        .count();
    assert_eq!(recovery_events, 1);
}

#[test]
fn drain_pending_returns_by_its_deadline_while_the_database_mutex_is_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let session_id = session(&db, "bounded-output-drain");
    db.append_output(&session_id, 0, b"occupied").unwrap();
    let store = Arc::new(OutputStore::default());
    assert!(store.append(&db, &session_id, b"tail").is_err());

    let (locked_tx, locked_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let blocked_db = db.clone();
    let holder = thread::spawn(move || {
        blocked_db
            .transaction(|_| {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
    });
    locked_rx.recv().unwrap();
    let start = Instant::now();
    let pending = store.drain_pending(&db, Instant::now() + Duration::from_millis(150));
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "shutdown drain exceeded its caller bound"
    );
    assert_eq!(pending, 4);
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    // Let the one in-flight drain attempt complete before the fixture drops.
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM output_chunks WHERE session_id=?",
            [&session_id],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        store.flush_pending(&db, &session_id).unwrap(),
        FlushOutcome::Clean { .. }
    ));
    assert_eq!(store.cursor(&session_id), 4);
    store.stop_retry_worker();
}

#[test]
fn concurrent_session_appends_and_flush_have_continuous_non_overlapping_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
    let store = Arc::new(OutputStore::default());
    let session_ids: Vec<_> = (0..8)
        .map(|index| session(&db, &format!("concurrent-output-{index}")))
        .collect();
    let expected: Vec<Vec<u8>> = (0..8)
        .map(|index| {
            (0..48)
                .flat_map(|chunk| format!("[{index}:{chunk:02}]").into_bytes())
                .collect()
        })
        .collect();
    let barrier = Arc::new(Barrier::new(9));
    let mut writers = Vec::new();
    for (session_id, bytes) in session_ids.iter().cloned().zip(expected.iter().cloned()) {
        let store = store.clone();
        let db = db.clone();
        let barrier = barrier.clone();
        writers.push(thread::spawn(move || {
            barrier.wait();
            for chunk in bytes.chunks(6) {
                store.append(&db, &session_id, chunk).unwrap();
            }
        }));
    }
    let flush_store = store.clone();
    let flush_db = db.clone();
    let flush_session = session_ids[0].clone();
    let flush_barrier = barrier.clone();
    let flusher = thread::spawn(move || {
        flush_barrier.wait();
        for _ in 0..48 {
            flush_store
                .flush_pending(&flush_db, &flush_session)
                .unwrap();
        }
    });
    for writer in writers {
        writer.join().unwrap();
    }
    flusher.join().unwrap();

    for (session_id, wanted) in session_ids.iter().zip(expected.iter()) {
        let (chunks, actual) = output_bytes(&db, session_id);
        let mut end = 0;
        for (start, data) in chunks {
            assert_eq!(start, end, "{session_id} has a gap or overlap");
            end += data.len() as i64;
        }
        assert_eq!(actual, *wanted, "{session_id} lost or duplicated output");
    }
}
