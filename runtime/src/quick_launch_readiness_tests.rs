//! Readiness tests: port selection, URL precedence, pid reuse, the table-sizing retry,
//! the watch schedule, every exit of the watch loop itself, the schema migration and
//! startup recovery, plus two Windows runs that really listen.
use super::readiness::{
    capped, next_step, observe_port, poll_delay, select_port, sized_tcp_table,
    stable_listening_ports, url_port, watch, Step, WatchHost, FAST_POLL, FAST_WINDOW, GIVE_UP,
    MAX_PORTS, SLOW_POLL,
};
use super::*;
#[cfg(windows)]
use std::{thread, time::Instant};

fn test_db() -> (tempfile::TempDir, Arc<Database>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    crate::workspace_services::initialize(&db).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    crate::retry_scheduler::initialize(&db).unwrap();
    (root, db)
}

fn project(db: &Database, root: &Path, operation: &str) -> String {
    db.add_project(&root.to_string_lossy(), Some("Readiness"), operation)
        .unwrap()
        .id
}

/// A run row with the given projection columns, so precedence can be tested without
/// launching anything. Returns the session id.
fn run_row(
    db: &Database,
    project_id: &str,
    root: &Path,
    url: Option<&str>,
    url_source: Option<&str>,
    readiness: Option<&str>,
) -> String {
    let session = db
        .create_session(crate::db::CreateSession {
            project_id: Some(project_id),
            title: Some("Dev"),
            provider: "custom",
            mode: "terminal",
            native_id: None,
            operation_id: &format!("readiness-{}", uuid::Uuid::new_v4()),
        })
        .unwrap();
    let snapshot = json!({
        "id": format!("command-{}", session.id), "projectId": project_id, "revision": 1,
        "name": "Dev", "command": "npm run dev", "shell": "cmd", "cwd": "", "kind": "service",
        "env": [], "createdAt": "now", "updatedAt": "now"
    });
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,\
             url,url_source,stop_requested,started_at,readiness) VALUES(?,?,?,?,?,?,?,0,'now',?)",
            params![
                session.id,
                snapshot["id"].as_str().unwrap(),
                project_id,
                root.to_string_lossy(),
                snapshot.to_string(),
                url,
                url_source,
                readiness
            ],
        )?;
        Ok(())
    })
    .unwrap();
    session.id
}

fn run_of(db: &Database, id: &str) -> SessionRun {
    db.session_by_id(id).unwrap().unwrap().run.unwrap()
}

fn set_status(db: &Database, id: &str, status: &str) {
    db.set_session_status(id, status, None).unwrap();
}

/// A run that is already watching: `waiting` and live.
fn watching_run(db: &Database, project: &str, root: &Path) -> String {
    let id = run_row(db, project, root, None, None, Some("waiting"));
    set_status(db, &id, "running");
    id
}

/// The watch loop's outside world, with no real time in it: `sleep` only moves the
/// injected clock, so a give-up after ten minutes is a loop of cheap iterations.
#[derive(Default)]
struct FakeHost {
    clock: std::cell::Cell<Duration>,
    sleeps: std::cell::RefCell<Vec<Duration>>,
    ports: Vec<u16>,
    reads: std::cell::Cell<usize>,
}

impl FakeHost {
    fn new(ports: &[u16]) -> Self {
        Self {
            ports: ports.to_vec(),
            ..Self::default()
        }
    }
    fn sleeps(&self) -> Vec<Duration> {
        self.sleeps.borrow().clone()
    }
    fn reads(&self) -> usize {
        self.reads.get()
    }
}

impl WatchHost for FakeHost {
    fn elapsed(&self) -> Duration {
        self.clock.get()
    }
    fn sleep(&self, delay: Duration) {
        self.sleeps.borrow_mut().push(delay);
        self.clock.set(self.clock.get() + delay);
    }
    fn ports(&self, _session_id: &str) -> Vec<u16> {
        self.reads.set(self.reads.get() + 1);
        self.ports.clone()
    }
}

#[test]
fn port_selection_prefers_the_printed_port_then_skips_debuggers() {
    // The printed URL's port wins whenever it is listening.
    assert_eq!(select_port(&[3000, 5173], Some(5173)), Some(5173));
    // A printed port that is not listening leaves the lowest real port.
    assert_eq!(select_port(&[3000, 5173], Some(9999)), Some(3000));
    assert_eq!(select_port(&[3000, 5173], None), Some(3000));
    // Debugger and inspector ports are not the application.
    assert_eq!(select_port(&[9229, 9230, 8080], None), Some(8080));
    assert_eq!(select_port(&[5005, 5678, 7000], None), Some(7000));
    // Only debugger ports: the lowest one is still better than no address.
    assert_eq!(select_port(&[9229, 5005], None), Some(5005));
    assert_eq!(select_port(&[], Some(3000)), None);
    assert_eq!(select_port(&[], None), None);
    assert_eq!(select_port(&[9], Some(8080)), Some(9));
}

#[test]
fn listening_ports_are_sorted_deduplicated_and_capped() {
    let mut ports: Vec<u16> = (1..=100).rev().collect();
    ports.extend([1000, 1000, 7]);
    let limited = capped(ports);
    assert_eq!(limited.len(), MAX_PORTS);
    assert_eq!(limited.first(), Some(&1), "ascending order");
    assert_eq!(limited.last(), Some(&(MAX_PORTS as u16)));
    assert!(limited.windows(2).all(|pair| pair[0] < pair[1]), "no duplicates");
    assert!(stable_listening_ports(&[], &[], &[]).is_empty());
}

#[test]
fn a_reused_pid_does_not_lend_its_socket_to_this_run() {
    let rows = [(11u32, 5173u16), (22, 3000), (33, 8080)];
    // Owners stable across the table read are the run's.
    assert_eq!(
        stable_listening_ports(&[11, 22, 33], &[33, 22, 11], &rows),
        vec![3000, 5173, 8080]
    );
    // A pid that left between the snapshots may already belong to another process.
    assert_eq!(
        stable_listening_ports(&[11, 22], &[11], &rows),
        vec![5173],
        "a pid that left is dropped"
    );
    // A pid that only appeared after the first snapshot cannot own an older row.
    assert_eq!(
        stable_listening_ports(&[11], &[11, 22], &rows),
        vec![5173],
        "a pid that joined late is not trusted"
    );
    assert!(stable_listening_ports(&[44], &[44], &rows).is_empty());
    // The cap still applies to the intersection.
    let many: Vec<(u32, u16)> = (1..=100).map(|index| (index as u32, index as u16)).collect();
    let ids: Vec<u32> = (1..=100).collect();
    assert_eq!(stable_listening_ports(&ids, &ids, &many).len(), MAX_PORTS);
}

#[test]
fn a_table_that_grows_while_it_is_read_is_retried_with_the_reported_size() {
    let mut calls = 0;
    let mut sizes = Vec::new();
    let table = sized_tcp_table(
        |buffer, written| {
            calls += 1;
            sizes.push(*written);
            if calls < 3 {
                *written += 64;
                122
            } else {
                buffer[0] = 7;
                0
            }
        },
        128,
    );
    assert!(table.is_some(), "the third call fits");
    assert_eq!(calls, 3);
    assert_eq!(sizes, vec![128, 192, 256], "each retry asks for the returned size");
    // A table that never stops growing, or any other error, ends the poll without rows.
    let mut growing: u32 = 16;
    assert_eq!(
        sized_tcp_table(|_, written| { growing += 8; *written = growing; 122 }, 16),
        None
    );
    assert_eq!(sized_tcp_table(|_, _| 87, 16), None, "an unrelated error is not retried");
    assert_eq!(sized_tcp_table(|_, _| 122, 16), None, "no new size, no second call");
    assert_eq!(sized_tcp_table(|_, _| 0, 0), None, "an empty table has nothing to read");
}

#[test]
fn the_watch_polls_fast_then_slow_and_gives_up() {
    assert_eq!(poll_delay(Duration::ZERO), Some(FAST_POLL));
    assert_eq!(poll_delay(FAST_WINDOW - Duration::from_millis(1)), Some(FAST_POLL));
    assert_eq!(poll_delay(FAST_WINDOW), Some(SLOW_POLL));
    assert_eq!(poll_delay(GIVE_UP - Duration::from_millis(1)), Some(SLOW_POLL));
    assert_eq!(poll_delay(GIVE_UP), None);
    assert_eq!(next_step(Duration::ZERO, &[], None), Step::Wait(FAST_POLL));
    assert_eq!(next_step(FAST_WINDOW, &[], None), Step::Wait(SLOW_POLL));
    assert_eq!(next_step(GIVE_UP, &[], None), Step::GiveUp);
    assert_eq!(next_step(Duration::from_secs(3600), &[], None), Step::GiveUp);
    // A listening port ends the watch immediately, even at the give-up time.
    assert_eq!(next_step(GIVE_UP, &[8080], None), Step::Ready(8080));
    assert_eq!(url_port("http://localhost:5173/x"), Some(5173));
    assert_eq!(url_port("http://[::1]:3000/"), Some(3000));
    assert_eq!(url_port("http://localhost:0/"), None);
    assert_eq!(url_port("http://localhost/"), None);
}

#[test]
fn the_watch_ends_ready_on_the_first_port_it_sees() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-watch-ready");
    let id = watching_run(&db, &project_id, root.path());
    let host = FakeHost::new(&[9229, 5173]);
    watch(&db, &host, &id);
    let run = run_of(&db, &id);
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.port, Some(5173), "the debugger port is skipped");
    assert_eq!(run.url.as_deref(), Some("http://localhost:5173/"));
    assert_eq!(run.url_source.as_deref(), Some("port"));
    assert!(host.sleeps().is_empty(), "the first poll already answered");
}

#[test]
fn the_watch_settles_a_dead_or_stopped_run_to_none() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-watch-dead");
    // The session ended before the server listened.
    let ended = watching_run(&db, &project_id, root.path());
    set_status(&db, &ended, "exited");
    let host = FakeHost::new(&[5173]);
    watch(&db, &host, &ended);
    assert_eq!(run_of(&db, &ended).readiness.as_deref(), Some("none"));
    assert_eq!(host.reads(), 0, "a dead run is not polled at all");
    // The user stopped it before the server listened.
    let stopped = watching_run(&db, &project_id, root.path());
    request_stop(&db, &stopped).unwrap();
    let host = FakeHost::new(&[]);
    watch(&db, &host, &stopped);
    assert_eq!(run_of(&db, &stopped).readiness.as_deref(), Some("none"));
    assert_eq!(host.reads(), 0, "a stopped run is not polled");
    // Its configured fallback link is openable again: nothing still claims "Starting".
    assert_eq!(run_of(&db, &stopped).url_source, None);
}

#[test]
fn the_watch_gives_up_to_none_after_ten_minutes() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-watch-give-up");
    let id = watching_run(&db, &project_id, root.path());
    let host = FakeHost::new(&[]);
    watch(&db, &host, &id);
    assert_eq!(run_of(&db, &id).readiness.as_deref(), Some("none"));
    let sleeps = host.sleeps();
    assert!(sleeps.len() > 60, "the watch polled until the deadline");
    assert!(
        sleeps.iter().take(60).all(|delay| *delay == FAST_POLL),
        "the first 30 s poll every 500 ms"
    );
    assert!(
        sleeps.iter().skip(60).all(|delay| *delay == SLOW_POLL),
        "after 30 s the polls slow down"
    );
    assert!(
        host.elapsed() >= GIVE_UP,
        "the injected clock passed the give-up time: {:?}",
        host.elapsed()
    );
}

#[test]
fn a_printed_url_while_waiting_keeps_the_run_ready() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-watch-output");
    let id = watching_run(&db, &project_id, root.path());
    observe_output(&db, &id, "http://localhost:3000/").unwrap();
    // A port is listening too, but the printed address already decided.
    let host = FakeHost::new(&[5173]);
    watch(&db, &host, &id);
    let run = run_of(&db, &id);
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.url.as_deref(), Some("http://localhost:3000/"));
    assert_eq!(run.url_source.as_deref(), Some("output"));
    assert_eq!(run.port, None, "the port did not decide");
    assert_eq!(host.reads(), 0, "a ready run is not polled");
}

#[test]
fn the_watch_retries_a_failing_state_read_then_settles() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-watch-error");
    let id = watching_run(&db, &project_id, root.path());
    // Every read now fails, the way a transient database error would look.
    db.transaction(|tx| {
        tx.execute("DROP TABLE quick_launch_runs", [])?;
        Ok(())
    })
    .unwrap();
    let host = FakeHost::new(&[]);
    watch(&db, &host, &id);
    assert_eq!(
        host.sleeps(),
        vec![FAST_POLL, FAST_POLL],
        "two quick retries, then the watch stops"
    );
    assert_eq!(host.reads(), 0);
}

#[test]
fn a_port_url_replaces_a_configured_one_but_never_a_printed_one() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-precedence");

    // Configured fallback: port readiness replaces it.
    let configured = run_row(
        &db,
        &project_id,
        root.path(),
        Some("http://localhost:3000/"),
        Some("configured"),
        Some("waiting"),
    );
    observe_port(&db, &configured, 5173).unwrap();
    let run = run_of(&db, &configured);
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.port, Some(5173));
    assert_eq!(run.url.as_deref(), Some("http://localhost:5173/"));
    assert_eq!(run.url_source.as_deref(), Some("port"));

    // No address at all: the port supplies one.
    let bare = run_row(&db, &project_id, root.path(), None, None, Some("waiting"));
    observe_port(&db, &bare, 8080).unwrap();
    let run = run_of(&db, &bare);
    assert_eq!(run.url.as_deref(), Some("http://localhost:8080/"));
    assert_eq!(run.url_source.as_deref(), Some("port"));

    // A printed address always wins: the port marks it ready without rewriting it,
    // and without recording a port that is not the address.
    let printed = run_row(
        &db,
        &project_id,
        root.path(),
        Some("http://127.0.0.1:4444/app"),
        Some("output"),
        Some("waiting"),
    );
    observe_port(&db, &printed, 8080).unwrap();
    let run = run_of(&db, &printed);
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.port, None);
    assert_eq!(run.url.as_deref(), Some("http://127.0.0.1:4444/app"));
    assert_eq!(run.url_source.as_deref(), Some("output"));

    // And output takes over a port URL, including the readiness state and the port.
    let before = run_events(&db);
    observe_output(&db, &bare, "http://localhost:9999/").unwrap();
    let run = run_of(&db, &bare);
    assert_eq!(run.url.as_deref(), Some("http://localhost:9999/"));
    assert_eq!(run.url_source.as_deref(), Some("output"));
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.port, None, "the replaced port is cleared");
    assert_eq!(run_events(&db), before + 1, "one state change, one event");
    // A second identical print is not a second state change.
    observe_output(&db, &bare, "http://localhost:9999/").unwrap();
    assert_eq!(run_events(&db), before + 1);
    // A URL printed after the watcher gave up still makes the run ready.
    let gave_up = run_row(&db, &project_id, root.path(), None, None, Some("none"));
    observe_output(&db, &gave_up, "http://localhost:4321/").unwrap();
    let run = run_of(&db, &gave_up);
    assert_eq!(run.readiness.as_deref(), Some("ready"));
    assert_eq!(run.url.as_deref(), Some("http://localhost:4321/"));
}

/// `session.run` events written since the last read, so a no-op update is provable.
fn run_events(db: &Database) -> i64 {
    db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT COUNT(*) FROM outbox WHERE data LIKE '%session.run%'",
            [],
            |r| r.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn tasks_and_older_runs_keep_no_readiness_state() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-absent");
    let id = run_row(&db, &project_id, root.path(), None, None, None);
    let run = run_of(&db, &id);
    assert_eq!(run.readiness, None);
    assert_eq!(run.port, None);
    // Output on a run without readiness leaves it without one.
    observe_output(&db, &id, "http://localhost:1234/").unwrap();
    assert_eq!(run_of(&db, &id).readiness, None);
    assert_eq!(run_of(&db, &id).url_source.as_deref(), Some("output"));
}

#[test]
fn an_old_run_table_gains_the_readiness_columns() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("old.sqlite")).unwrap();
    conn.execute_batch(
        "CREATE TABLE operations (id TEXT PRIMARY KEY, method TEXT NOT NULL);
         CREATE TABLE quick_launch_runs (
         session_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, project_id TEXT NOT NULL,
         root TEXT NOT NULL, snapshot_json TEXT NOT NULL, url TEXT, url_source TEXT,
         stop_requested INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL);",
    )
    .unwrap();
    initialize_connection(&conn).unwrap();
    let columns = || {
        let mut stmt = conn.prepare("PRAGMA table_info(quick_launch_runs)").unwrap();
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        names
    };
    assert!(columns().iter().any(|name| name == "readiness"));
    assert!(columns().iter().any(|name| name == "ready_port"));
    // Existing rows read as "no readiness", and a second pass changes nothing.
    conn.execute(
        "INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,started_at) \
         VALUES('s','c','p','r','{}','now')",
        [],
    )
    .unwrap();
    initialize_connection(&conn).unwrap();
    let readiness: Option<String> = conn
        .query_row(
            "SELECT readiness FROM quick_launch_runs WHERE session_id='s'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(readiness, None);
}

#[test]
fn startup_settles_a_waiting_run_whose_session_is_gone() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-recovery");
    let dead = run_row(&db, &project_id, root.path(), None, None, Some("waiting"));
    let live = run_row(&db, &project_id, root.path(), None, None, Some("waiting"));
    let task = run_row(&db, &project_id, root.path(), None, None, None);
    set_status(&db, &dead, "interrupted");
    set_status(&db, &live, "running");
    set_status(&db, &task, "running");
    reconcile_readiness(&db).unwrap();
    assert_eq!(run_of(&db, &dead).readiness.as_deref(), Some("none"));
    // A live session keeps waiting, and a task is never given a readiness state.
    assert_eq!(run_of(&db, &live).readiness.as_deref(), Some("waiting"));
    assert_eq!(run_of(&db, &task).readiness, None);
}

/// Waits for the live watcher to settle a run, which it does on its next poll.
#[cfg(windows)]
fn settled_readiness(db: &Database, id: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let readiness = db.session_by_id(id).unwrap().unwrap().run.unwrap().readiness;
        if readiness.as_deref() != Some("waiting") || Instant::now() >= deadline {
            return readiness;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn output_text(db: &Database, session_id: &str) -> String {
    String::from_utf8_lossy(
        &db.output_from(session_id, 0, 1024 * 1024)
            .unwrap()
            .into_iter()
            .flat_map(|(_, data)| data)
            .collect::<Vec<_>>(),
    )
    .into_owned()
}

/// A service run that only listens: it prints no URL, writes its ephemeral port to a
/// file, and stays up. The run's own Job must be what makes it ready.
#[cfg(windows)]
#[test]
fn a_service_run_that_only_listens_becomes_ready_on_its_own_port() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-listen");
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    let port_file = root.path().join("port.txt");
    let command = "$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);\
        $l.Start();Set-Content -LiteralPath 'port.txt' -Encoding ascii -Value $l.LocalEndpoint.Port;\
        Start-Sleep -Seconds 120";
    let saved = dispatch(
        &db,
        &pty,
        "quickLaunch.save",
        &json!({"projectId":project_id,"name":"Listener","command":command,"shell":"powershell","cwd":"","kind":"service","env":[],"operationId":"save-listen"}),
    )
    .unwrap();
    let launched = dispatch(
        &db,
        &pty,
        "quickLaunch.run",
        &json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"run-listen"}),
    )
    .unwrap();
    let id = launched["session"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        launched["session"]["run"]["readiness"].as_str(),
        Some("waiting"),
        "a service run starts out watched"
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    let ready = loop {
        if let Some(run) = db.session_by_id(&id).unwrap().unwrap().run {
            if run.readiness.as_deref() == Some("ready") {
                break run;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the listening run never became ready; output: {}",
            output_text(&db, &id)
        );
        thread::sleep(Duration::from_millis(100));
    };
    let port = loop {
        if let Ok(text) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = text.trim().parse::<u16>() {
                break port;
            }
        }
        assert!(Instant::now() < deadline, "the fixture never wrote its port");
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(ready.port, Some(port), "the ready port is the listener's");
    assert_eq!(ready.url_source.as_deref(), Some("port"));
    assert_eq!(ready.url, Some(format!("http://localhost:{port}/")));
    let printed = output_text(&db, &id);
    assert!(
        !printed.contains("http://"),
        "the fixture printed no URL: {printed:?}"
    );
    pty.stop(&db, &id, true).unwrap();
    // Stopping settles the run instead of leaving it watched.
    let run = db.session_by_id(&id).unwrap().unwrap().run.unwrap();
    assert_eq!(run.readiness.as_deref(), Some("ready"), "a finished run keeps what it reached");
}

/// A listener opened outside the run's Job belongs to another pid: it must never mark
/// an unrelated run ready, even while that run's own tree is alive.
#[cfg(windows)]
#[test]
fn a_listener_outside_the_job_never_marks_another_run_ready() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-outside");
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    let saved = dispatch(
        &db,
        &pty,
        "quickLaunch.save",
        &json!({"projectId":project_id,"name":"Idle","command":"Start-Sleep -Seconds 120","shell":"powershell","cwd":"","kind":"service","env":[],"operationId":"save-outside"}),
    )
    .unwrap();
    let launched = dispatch(
        &db,
        &pty,
        "quickLaunch.run",
        &json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"run-outside"}),
    )
    .unwrap();
    let id = launched["session"]["id"].as_str().unwrap().to_owned();
    // The test's own listener, outside every job, on an ephemeral port.
    let outside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let outside_port = outside.local_addr().unwrap().port();
    thread::sleep(Duration::from_millis(2500));
    let run = db.session_by_id(&id).unwrap().unwrap().run.unwrap();
    assert_eq!(
        run.readiness.as_deref(),
        Some("waiting"),
        "a listener of another process must not mark the run ready"
    );
    assert_eq!(run.port, None);
    assert_eq!(run.url, None);
    assert_ne!(outside_port, 0);
    drop(outside);
    pty.stop(&db, &id, true).unwrap();
    // Stop settles it: the next read is `none`, not a run that still claims Starting.
    assert_eq!(settled_readiness(&db, &id).as_deref(), Some("none"));
}

/// A stopped run must not keep "waiting": the watcher settles it, so the UI never keeps
/// a dead run's preview disabled.
#[cfg(windows)]
#[test]
fn stopping_a_run_before_it_listens_settles_its_readiness() {
    let (root, db) = test_db();
    let project_id = project(&db, root.path(), "project-stopped");
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    let saved = dispatch(
        &db,
        &pty,
        "quickLaunch.save",
        &json!({"projectId":project_id,"name":"Quiet","command":"Start-Sleep -Seconds 120","shell":"powershell","cwd":"","kind":"service","env":[],"previewUrl":"http://localhost:3000/","operationId":"save-stopped"}),
    )
    .unwrap();
    let launched = dispatch(
        &db,
        &pty,
        "quickLaunch.run",
        &json!({"commandId":saved["id"],"cwd":root.path().to_string_lossy(),"operationId":"run-stopped"}),
    )
    .unwrap();
    let id = launched["session"]["id"].as_str().unwrap().to_owned();
    let run = db.session_by_id(&id).unwrap().unwrap().run.unwrap();
    assert_eq!(run.readiness.as_deref(), Some("waiting"));
    assert_eq!(run.url_source.as_deref(), Some("configured"));
    pty.stop(&db, &id, true).unwrap();
    assert_eq!(
        settled_readiness(&db, &id).as_deref(),
        Some("none"),
        "a stopped run never keeps waiting"
    );
    let run = db.session_by_id(&id).unwrap().unwrap().run.unwrap();
    assert_eq!(run.url_source.as_deref(), Some("configured"));
    assert_eq!(run.url.as_deref(), Some("http://localhost:3000/"));
}
