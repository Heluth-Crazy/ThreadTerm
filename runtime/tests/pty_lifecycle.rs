//! PTY lifecycle checks (task 10-03-windows-terminal-hardening, stage 5). A test binary of its own
//! (`harness = false`) so the handle and child-process counts belong to this process alone, and the
//! terminals start through the production `--pty-bootstrap` path:
//! - repeated launch and stop (forced, graceful, the shell exiting) returns to the baseline handle
//!   count and leaves no process behind;
//! - failed or refused launches (missing folder or program: the bootstrap exits with 1; rejected
//!   script arguments; a second PTY for a live session) leave nothing behind and do not touch the live
//!   session;
//! - stopping terminals that flood output is bounded and leaves nothing behind.
//!
//! Runs on the in-box ConPTY, then in a second process (the host is fixed per process) on the bundled
//! OpenConsole when its pair sits in `<this exe's folder>/conpty/`.
//!
//! Known Windows leak, measured 2026-10-03 on Windows 10 19045: the in-box `ClosePseudoConsole` never
//! closes its process handle to the console host, so every in-box pseudoconsole leaves one handle to an
//! exited conhost.exe (also with raw `CreatePseudoConsole` calls, without portable-pty). Microsoft's
//! conpty.dll 1.24 — the bundled host — leaves none. The checks allow exactly that one on the in-box host.

#[cfg(not(windows))]
fn main() {
    println!("pty_lifecycle: Windows only");
}

#[cfg(windows)]
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--pty-bootstrap") {
        std::process::exit(match threadterm_v3_runtime::bootstrap::run() {
            Ok(code) => code,
            Err(error) => {
                eprintln!("{error:#}");
                1
            }
        });
    }
    if arguments.iter().any(|argument| argument == "--list") {
        println!("pty_lifecycle: test");
        return;
    }
    // Like libtest: a name filter or `--skip` naming another test, or `--ignored`, runs nothing here.
    let mut filters = Vec::new();
    let mut skipped = false;
    let mut words = arguments.iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--ignored" => return,
            "--skip" => skipped |= words.next().is_some_and(|name| "pty_lifecycle".contains(name.as_str())),
            "--test-threads" | "--color" | "--format" | "--logfile" | "-Z" => {
                words.next();
            }
            word if !word.starts_with('-') => filters.push(word),
            _ => {}
        }
    }
    if skipped || (!filters.is_empty() && !filters.iter().any(|filter| "pty_lifecycle".contains(filter))) {
        return;
    }
    lifecycle::run();
}

#[cfg(windows)]
mod lifecycle {
    use std::{
        collections::{HashMap, HashSet},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread::sleep,
        time::{Duration, Instant},
    };
    use threadterm_v3_runtime::{
        conpty::{self, Backend},
        db::{CreateSession, Database},
        output::OutputStore,
        pty::PtyManager,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetHandleInformation, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            Threading::{GetCurrentProcess, GetProcessHandleCount, GetProcessId, WaitForSingleObject},
        },
    };

    const HOST_ENV: &str = "THREADTERM_V3_LIFECYCLE_HOST";
    /// Handle-count noise allowed over the baseline (thread exits and caches settle asynchronously);
    /// every check opens at least 4 terminals per round and several rounds, so a handle leaked per
    /// launch still fails.
    const SLACK: u32 = 6;

    pub fn run() {
        // A hung stop must fail the run, never hang `cargo test`.
        std::thread::spawn(|| {
            sleep(Duration::from_secs(300));
            eprintln!("pty_lifecycle: timed out");
            std::process::exit(2);
        });
        let bundled = std::env::var(HOST_ENV).is_ok_and(|value| value == "bundled");
        // As the runtime's main: the console host first, then the terminal environment.
        let host = conpty::initialize(if bundled { Backend::Bundled } else { Backend::System });
        assert_eq!(host == Backend::Bundled, bundled, "the bundled OpenConsole pair did not load");
        threadterm_v3_runtime::environment::initialize();
        let fixture = Fixture::new();
        fixture.warm_up();
        let mut baseline = Baseline::now(!bundled);
        println!("pty_lifecycle [{}]: baseline {} handles", host.as_str(), baseline.other + baseline.exited);
        let mut ids = repeated_launch_and_stop(&fixture, &mut baseline);
        ids.extend(failed_launches(&fixture, &mut baseline));
        ids.extend(stop_under_heavy_output(&fixture, &mut baseline));
        for id in &ids {
            assert!(fixture.manager.input(id, b"x").is_err(), "session {id} is still registered as live");
        }
        if !bundled {
            if conpty::bundled_available() {
                let status = std::process::Command::new(std::env::current_exe().unwrap()).env(HOST_ENV, "bundled").status().unwrap();
                assert!(status.success(), "the bundled OpenConsole run failed ({status})");
            } else {
                let dir = std::env::current_exe().unwrap().with_file_name("conpty");
                println!("pty_lifecycle [bundled]: skipped, no pair in {} (node runtime/conpty/prepare.mjs --out <that folder>)", dir.display());
            }
        }
        println!("pty_lifecycle [{}]: ok", host.as_str());
    }

    struct Fixture {
        dir: tempfile::TempDir,
        db: Arc<Database>,
        manager: PtyManager,
        next: AtomicUsize,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
            Self { dir, db, manager: PtyManager::new(Arc::new(OutputStore::default())), next: AtomicUsize::new(0) }
        }
        fn cwd(&self) -> &str {
            self.dir.path().to_str().unwrap()
        }
        fn missing_folder(&self) -> String {
            self.dir.path().join("missing-folder").to_string_lossy().into_owned()
        }
        fn session(&self, name: &str) -> String {
            let operation = format!("{name}-{}", self.next.fetch_add(1, Ordering::Relaxed));
            let request = CreateSession { project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None, operation_id: &operation };
            self.db.create_session(request).unwrap().id
        }
        fn launch(&self, id: &str, program: &str, args: &[&str]) -> anyhow::Result<()> {
            let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
            self.manager.launch(Arc::clone(&self.db), id, self.cwd(), Some(program), &args)
        }
        fn shell(&self, name: &str) -> String {
            let id = self.session(name);
            self.launch(&id, "cmd.exe", &["/d", "/k", "prompt READY$G"]).unwrap();
            self.wait_for(&id, "READY>");
            id
        }
        fn text(&self, id: &str) -> String {
            let output: Vec<u8> = self.db.output_from(id, 0, 4 << 20).unwrap().into_iter().flat_map(|(_, bytes)| bytes).collect();
            String::from_utf8_lossy(&output).into_owned()
        }
        fn wait_for(&self, id: &str, needle: &str) {
            wait(&format!("{needle:?} in {id}"), || self.text(id).contains(needle));
        }
        fn status(&self, id: &str) -> (String, Option<i32>) {
            let session = self.db.session_by_id(id).unwrap().unwrap();
            (session.status, session.exit_code)
        }
        fn wait_exited(&self, id: &str) -> Option<i32> {
            wait(&format!("{id} to exit"), || self.status(id).0 == "exited");
            self.status(id).1
        }
        /// The first launch and failure paths load the console host, the environment APIs and caches.
        fn warm_up(&self) {
            let id = self.shell("warm-up");
            self.manager.stop(&self.db, &id, true).unwrap();
            let _ = self.manager.launch(Arc::clone(&self.db), &self.session("warm-up-missing"), &self.missing_folder(), Some("cmd.exe"), &[]);
            wait("the warm-up processes to end", || descendants().is_empty());
            sleep(Duration::from_millis(500));
        }
    }

    fn wait(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(50));
        }
    }

    fn handles() -> u32 {
        let mut count = 0;
        assert_ne!(unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) }, 0);
        count
    }

    /// Handles this process holds to processes that have exited (see the module note).
    fn exited_process_handles() -> u32 {
        let mut count = 0;
        // Handle values are multiples of 4; this process never holds anywhere near 32,768 handles.
        for value in (4..0x20000usize).step_by(4) {
            let handle = value as HANDLE;
            let mut flags = 0;
            if unsafe { GetHandleInformation(handle, &mut flags) } != 0
                && unsafe { GetProcessId(handle) } != 0
                && unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0
            {
                count += 1;
            }
        }
        count
    }

    /// Every process descended from this one (bootstraps, shells, console hosts).
    fn descendants() -> Vec<String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        assert_ne!(snapshot, INVALID_HANDLE_VALUE);
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut children: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while more {
            let name = &entry.szExeFile[..entry.szExeFile.iter().position(|&unit| unit == 0).unwrap_or(entry.szExeFile.len())];
            children.entry(entry.th32ParentProcessID).or_default().push((entry.th32ProcessID, String::from_utf16_lossy(name)));
            more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        let (mut found, mut queue, mut seen) = (Vec::new(), vec![std::process::id()], HashSet::new());
        while let Some(parent) = queue.pop() {
            for (pid, name) in children.get(&parent).into_iter().flatten() {
                if *pid != parent && seen.insert(*pid) {
                    found.push(format!("{name} ({pid})"));
                    queue.push(*pid);
                }
            }
        }
        found
    }

    struct Baseline {
        /// Handles other than those to exited processes.
        other: u32,
        exited: u32,
        inbox: bool,
    }

    impl Baseline {
        fn now(inbox: bool) -> Self {
            let (total, exited) = (handles(), exited_process_handles());
            Self { other: total - exited, exited, inbox }
        }
        /// Waits until no process is left, the other handles are back at the baseline (plus [`SLACK`]),
        /// and handles to exited processes grew by at most one per console on the in-box host and not
        /// at all on the bundled one.
        fn settle(&mut self, what: &str, consoles: u32) {
            let started = Instant::now();
            let allowed = self.exited + if self.inbox { consoles } else { 0 };
            loop {
                let (left, total, exited) = (descendants(), handles(), exited_process_handles());
                let other = total.saturating_sub(exited);
                if left.is_empty() && other <= self.other + SLACK && exited <= allowed {
                    let note = if exited > self.exited { format!(", {} console-host handles left by the in-box ConPTY", exited - self.exited) } else { String::new() };
                    println!("  {what}: {other} handles (baseline {}){note}, no process left after {:?}", self.other, started.elapsed());
                    self.exited = exited;
                    return;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(20),
                    "{what}: {other} handles (baseline {} + {SLACK}), {exited} to exited processes (at most {allowed}); processes left: {left:?}",
                    self.other
                );
                sleep(Duration::from_millis(100));
            }
        }
    }

    fn repeated_launch_and_stop(f: &Fixture, baseline: &mut Baseline) -> Vec<String> {
        let mut ids = Vec::new();
        let (mut forced, mut graceful) = (Duration::ZERO, Duration::ZERO);
        for _ in 0..4 {
            let id = f.shell("forced");
            let started = Instant::now();
            f.manager.stop(&f.db, &id, true).unwrap();
            forced = forced.max(started.elapsed());
            assert_eq!(f.status(&id).0, "exited");
            ids.push(id);

            // Graceful stop sends Ctrl+C, which ends ping and with it `cmd /c`.
            let id = f.session("graceful");
            f.launch(&id, "cmd.exe", &["/d", "/c", "ping -n 30 127.0.0.1"]).unwrap();
            f.wait_for(&id, "127.0.0.1");
            let started = Instant::now();
            f.manager.stop(&f.db, &id, false).unwrap();
            graceful = graceful.max(started.elapsed());
            assert!(started.elapsed() < Duration::from_secs(3), "Ctrl+C did not end the command: stop took {:?}", started.elapsed());
            ids.push(id);

            let id = f.shell("exits");
            f.manager.input(&id, b"exit 7\r").unwrap();
            assert_eq!(f.wait_exited(&id), Some(7));
            ids.push(id);
        }
        println!("  slowest forced stop {forced:?}, slowest graceful stop {graceful:?}");
        baseline.settle("12 launches stopped three ways", 12);
        ids
    }

    fn failed_launches(f: &Fixture, baseline: &mut Baseline) -> Vec<String> {
        let mut ids = Vec::new();
        let script = f.dir.path().join("args.cmd");
        std::fs::write(&script, "@echo off\r\necho %*\r\n").unwrap();
        for _ in 0..3 {
            // A missing folder: portable-pty starts the bootstrap in USERPROFILE instead, and the
            // bootstrap, which must start the program in the requested folder, exits with 1.
            let id = f.session("missing-folder");
            f.manager.launch(Arc::clone(&f.db), &id, &f.missing_folder(), Some("cmd.exe"), &[]).unwrap();
            assert_eq!(f.wait_exited(&id), Some(1));
            ids.push(id);

            // Arguments cmd.exe cannot carry safely are refused before a console is opened.
            let id = f.session("rejected");
            f.launch(&id, &script.to_string_lossy(), &["%PATH%"]).unwrap_err();
            ids.push(id);

            // A second PTY for a live session is refused, and the live one is left as it was.
            let id = f.shell("twice");
            let before = f.db.output_end(&id).unwrap();
            let error = f.launch(&id, "cmd.exe", &["/d", "/k", "prompt SECOND$G"]).unwrap_err();
            assert!(error.to_string().contains("already has a live PTY"), "{error:#}");
            sleep(Duration::from_millis(500));
            let added = f.db.output_end(&id).unwrap() - before;
            assert_eq!(added, 0, "the refused launch wrote {added} bytes into the live session: {:?}", &f.text(&id)[before as usize..]);
            f.manager.input(&id, b"echo STILL-%USERDOMAIN:~0,0%FIRST\r").unwrap();
            f.wait_for(&id, "STILL-FIRST");
            f.manager.stop(&f.db, &id, true).unwrap();
            ids.push(id);

            // A program that does not exist: the bootstrap starts, cannot start it and exits with 1.
            let id = f.session("no-program");
            f.launch(&id, "threadterm-no-such-program.exe", &[]).unwrap();
            assert_eq!(f.wait_exited(&id), Some(1));
            ids.push(id);
        }
        // Consoles: the missing folder, the live "twice" and the missing program; refused launches open none.
        baseline.settle("12 failed or refused launches", 9);
        ids
    }

    fn stop_under_heavy_output(f: &Fixture, baseline: &mut Baseline) -> Vec<String> {
        let flood = ["/d", "/c", "for /L %i in (1,1,5000000) do @echo flood-%i-0123456789abcdefghijklmnopqrstuvwxyz"];
        let ids: Vec<String> = (0..4)
            .map(|_| {
                let id = f.session("flood");
                f.launch(&id, "cmd.exe", &flood).unwrap();
                id
            })
            .collect();
        for id in &ids {
            wait(&format!("256 KiB of output from {id}"), || f.db.output_end(id).unwrap() >= 256 * 1024);
        }
        let started = Instant::now();
        f.manager.stop(&f.db, &ids[0], true).unwrap();
        let forced = started.elapsed();
        assert!(forced < Duration::from_secs(1), "forced stop took {forced:?}");
        let started = Instant::now();
        f.manager.stop(&f.db, &ids[1], false).unwrap();
        let graceful = started.elapsed();
        assert!(graceful < Duration::from_secs(3), "Ctrl+C did not end the flood: stop took {graceful:?}");
        // Runtime shutdown: the remaining two, one after the other.
        let started = Instant::now();
        f.manager.terminate_all(&f.db);
        let all = started.elapsed();
        assert!(all < Duration::from_secs(6), "terminate_all took {all:?}");
        for id in &ids {
            assert_eq!(f.status(id).0, "exited", "{id}");
        }
        baseline.settle("4 flooding terminals stopped", 4);
        let ends: Vec<i64> = ids.iter().map(|id| f.db.output_end(id).unwrap()).collect();
        sleep(Duration::from_millis(500));
        assert_eq!(ends, ids.iter().map(|id| f.db.output_end(id).unwrap()).collect::<Vec<_>>(), "output kept growing after stop");
        println!("  flood: forced stop {forced:?}, graceful stop {graceful:?}, terminate_all (2) {all:?}, output {} KiB", ends.iter().sum::<i64>() / 1024);
        ids
    }
}
