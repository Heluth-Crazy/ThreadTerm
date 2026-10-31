use super::*;
use crate::db::CreateSession;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    },
    thread,
    time::{Duration, Instant},
};

#[test]
#[ignore]
fn output_flood_benchmark() {
    for mode in ["FULL", "NORMAL"] {
        for sessions in [1, 8] {
            for chunk_size in [8192, 65536] {
                let dir = tempfile::tempdir().unwrap();
                let db = Arc::new(Database::open(&dir.path().join("flood.sqlite")).unwrap());
                // Set both modes explicitly: the runtime default is NORMAL.
                db.set_synchronous_for_test(mode).unwrap();
                let ids: Vec<_> = (0..sessions)
                    .map(|i| {
                        db.create_session(CreateSession {
                            project_id: None,
                            title: None,
                            provider: "shell",
                            mode: "terminal",
                            native_id: None,
                            operation_id: &format!("bench-{i}"),
                        })
                        .unwrap()
                        .id
                    })
                    .collect();
                let store = Arc::new(OutputStore::default());
                let done = Arc::new(AtomicBool::new(false));
                let barrier = Arc::new(Barrier::new(sessions + 2));
                let probe = {
                    let db = db.clone();
                    let done = done.clone();
                    let barrier = barrier.clone();
                    let id = ids[0].clone();
                    thread::spawn(move || {
                        let mut samples = Vec::new();
                        barrier.wait();
                        while !done.load(Ordering::Acquire) {
                            let start = Instant::now();
                            db.lease(&id).unwrap();
                            samples.push(start.elapsed().as_secs_f64() * 1000.0);
                            thread::sleep(Duration::from_millis(5));
                        }
                        samples
                    })
                };
                let writers: Vec<_> = ids
                    .into_iter()
                    .map(|id| {
                        let db = db.clone();
                        let store = store.clone();
                        let barrier = barrier.clone();
                        thread::spawn(move || {
                            let data = vec![b'x'; chunk_size];
                            barrier.wait();
                            let start = Instant::now();
                            let mut written = 0;
                            for _ in 0..(64 * 1024 * 1024 / sessions / chunk_size) {
                                store.append(&db, &id, &data).unwrap();
                                written += chunk_size;
                                if start.elapsed() > Duration::from_secs(20) {
                                    break;
                                }
                            }
                            written
                        })
                    })
                    .collect();
                let start = Instant::now();
                barrier.wait();
                let written: usize = writers.into_iter().map(|w| w.join().unwrap()).sum();
                let elapsed = start.elapsed().as_secs_f64();
                done.store(true, Ordering::Release);
                let mut samples = probe.join().unwrap();
                samples.sort_by(f64::total_cmp);
                let percentile = |p: f64| samples[((samples.len() - 1) as f64 * p) as usize];
                println!("FLOOD {mode} sessions={sessions} chunk={chunk_size} MiB/s={:.2} p50_ms={:.3} p99_ms={:.3} wall_s={elapsed:.3} MiB={:.2} probes={}", written as f64 / 1048576.0 / elapsed, percentile(0.50), percentile(0.99), written as f64 / 1048576.0, samples.len());
                drop(store);
                drop(db);
                drop(dir);
            }
        }
    }
}
