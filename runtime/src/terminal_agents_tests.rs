use super::*;
use crate::db::{CreateSession, Database};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tempfile::tempdir;

fn open_db() -> (tempfile::TempDir, Database) {
    let dir = tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.sqlite")).unwrap();
    (dir, db)
}

fn shell_session(db: &Database, id_suffix: &str) -> String {
    db.create_session(CreateSession {
        project_id: None,
        title: Some("PowerShell"),
        provider: "shell",
        mode: "terminal",
        native_id: None,
        operation_id: &format!("ta-{id_suffix}"),
    })
    .unwrap()
    .id
}

#[test]
fn normalize_folds_case_and_slashes() {
    assert_eq!(normalize(r"C:\Users\Demo\.grok\bin\Grok.EXE"), "c:/users/demo/.grok/bin/grok.exe");
    assert_eq!(normalize("@Anthropic-AI/Claude-Code"), "@anthropic-ai/claude-code");
}

#[test]
fn signature_table_matches_and_rejects_ordinary_programs() {
    assert_eq!(match_agent(r"C:\npm\claude.exe", None), Some("claude"));
    assert_eq!(
        match_agent(r"C:\node.exe", Some(r"node C:\npm\node_modules\@anthropic-ai\claude-code\cli.js")),
        Some("claude")
    );
    assert_eq!(match_agent(r"C:\Program Files\OpenAI\codex.exe", None), Some("codex"));
    assert_eq!(
        match_agent(r"C:\node.exe", Some("node ./node_modules/@openai/codex/bin.js")),
        Some("codex")
    );
    assert_eq!(match_agent(r"C:\tools\gemini.exe", None), Some("gemini"));
    assert_eq!(
        match_agent(r"C:\node.exe", Some("node @google/gemini-cli")),
        Some("gemini")
    );
    assert_eq!(match_agent(r"C:\Users\x\.kimi-code\bin\kimi.exe", None), Some("kimi"));
    assert_eq!(match_agent(r"C:\node.exe", Some("python -m kimi_cli")), Some("kimi"));
    assert_eq!(match_agent(r"C:\node.exe", Some("kimi-cli run")), Some("kimi"));
    assert_eq!(match_agent(r"C:\npm\opencode.exe", None), Some("opencode"));
    assert_eq!(
        match_agent(r"C:\node.exe", Some(r"node C:\npm\node_modules\opencode-ai\bin.js")),
        Some("opencode")
    );
    assert_eq!(match_agent(r"C:\Users\x\.grok\bin\agent.exe", None), Some("grok"));
    assert_eq!(match_agent(r"C:\Users\x\.grok\bin\grok.exe", None), Some("grok"));
    assert_eq!(match_agent(r"C:\tools\pi.exe", None), Some("pi"));
    assert_eq!(
        match_agent(r"C:\node.exe", Some(r"node C:\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js")),
        Some("pi")
    );

    assert_eq!(match_agent(r"C:\node.exe", Some("node server.js")), None);
    assert_eq!(match_agent(r"C:\Python\python.exe", Some("python -m http.server")), None);
    assert_eq!(match_agent(r"C:\nodejs\node.exe", Some("npm run dev")), None);
    assert_eq!(match_agent(r"C:\Windows\System32\cmd.exe", None), None);
}

#[test]
fn the_outermost_agent_wins_over_one_it_runs_as_a_tool() {
    let hits = [(10, "claude".to_owned()), (20, "codex".to_owned()), (15, "kimi".to_owned())];
    assert_eq!(pick_outermost(&hits).as_deref(), Some("claude"));
    assert_eq!(pick_outermost(&[]), None);
}

struct FakeHost {
    sleeps: AtomicUsize,
    sessions: Mutex<Vec<String>>,
    trees: Mutex<HashMap<String, Vec<ProcessInfo>>>,
    /// When set, each sleep advances the scripted trees for that session.
    script: Mutex<Vec<HashMap<String, Vec<ProcessInfo>>>>,
}

impl FakeHost {
    fn new(sessions: Vec<String>, trees: HashMap<String, Vec<ProcessInfo>>) -> Self {
        Self {
            sleeps: AtomicUsize::new(0),
            sessions: Mutex::new(sessions),
            trees: Mutex::new(trees),
            script: Mutex::new(Vec::new()),
        }
    }
}

impl WatchHost for FakeHost {
    fn sleep(&self, _delay: Duration) {
        let n = self.sleeps.fetch_add(1, Ordering::SeqCst);
        if let Some(next) = self.script.lock().unwrap().get(n).cloned() {
            *self.trees.lock().unwrap() = next;
        }
    }
    fn eligible_sessions(&self) -> Vec<String> {
        self.sessions.lock().unwrap().clone()
    }
    fn process_ids(&self, session_id: &str) -> Vec<u32> {
        self.trees
            .lock()
            .unwrap()
            .get(session_id)
            .map(|rows| {
                rows.iter()
                    .enumerate()
                    .map(|(index, _)| (index as u32) + 1)
                    .collect()
            })
            .unwrap_or_default()
    }
    fn inspect(&self, pid: u32) -> Option<ProcessInfo> {
        let trees = self.trees.lock().unwrap();
        for rows in trees.values() {
            if let Some(info) = rows.get((pid as usize).saturating_sub(1)) {
                return Some(info.clone());
            }
        }
        None
    }
}

#[test]
fn watcher_writes_once_per_change_and_clears_on_exit() {
    let (_dir, db) = open_db();
    let id = shell_session(&db, "watch");
    let host = FakeHost::new(
        vec![id.clone()],
        HashMap::from([(id.clone(), vec![])]),
    );
    // First sleep → claude appears; second sleep → gone.
    *host.script.lock().unwrap() = vec![
        HashMap::from([(
            id.clone(),
            vec![ProcessInfo {
                image: r"C:\tools\claude.exe".into(),
                created: 100,
                cmdline: None,
            }],
        )]),
        HashMap::from([(id.clone(), vec![])]),
    ];
    let mut cache = Detection::default();
    poll_once(&db, &host, &mut cache);
    assert_eq!(stored(&db, &id), None);

    host.sleep(Duration::ZERO); // advance script to claude
    poll_once(&db, &host, &mut cache);
    assert_eq!(stored(&db, &id).as_deref(), Some("claude"));
    let outbox_after_set = outbox_count(&db);

    poll_once(&db, &host, &mut cache);
    assert_eq!(outbox_count(&db), outbox_after_set, "unchanged poll must not publish");

    host.sleep(Duration::ZERO); // advance script to empty
    poll_once(&db, &host, &mut cache);
    assert_eq!(stored(&db, &id), None);
    assert!(outbox_count(&db) > outbox_after_set);
}

#[test]
fn startup_clear_drops_rows() {
    let (_dir, db) = open_db();
    let id = shell_session(&db, "clear");
    set_terminal_agent(&db, &id, Some("claude")).unwrap();
    assert_eq!(stored(&db, &id).as_deref(), Some("claude"));
    clear_all(&db).unwrap();
    assert_eq!(stored(&db, &id), None);
}

#[test]
fn projection_carries_terminal_agent_only_for_shell_custom() {
    let (_dir, db) = open_db();
    let shell = shell_session(&db, "proj-shell");
    let chat = db
        .create_session(CreateSession {
            project_id: None,
            title: Some("Chat"),
            provider: "claude",
            mode: "chat",
            native_id: None,
            operation_id: "ta-proj-chat",
        })
        .unwrap()
        .id;
    set_terminal_agent(&db, &shell, Some("codex")).unwrap();
    // A chat session must never surface a terminalAgent even if a row somehow exists.
    set_terminal_agent(&db, &chat, Some("codex")).unwrap();
    let snapshot = db.snapshot().unwrap();
    let shell_row = snapshot.sessions.iter().find(|s| s.id == shell).unwrap();
    let chat_row = snapshot.sessions.iter().find(|s| s.id == chat).unwrap();
    assert_eq!(shell_row.terminal_agent.as_deref(), Some("codex"));
    // Projection only joins for shell/custom terminals; chat stays absent.
    assert_eq!(chat_row.terminal_agent, None);
}

fn stored(db: &Database, id: &str) -> Option<String> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT provider FROM terminal_agents WHERE session_id=?",
                [id],
                |row| row.get(0),
            )
            .optional()?)
    })
    .unwrap()
}

fn outbox_count(db: &Database) -> i64 {
    db.transaction(|tx| {
        Ok(tx.query_row("SELECT COUNT(*) FROM outbox WHERE event='state.changed'", [], |row| {
            row.get(0)
        })?)
    })
    .unwrap()
}

/// Windows integration: a harmless copy of timeout.exe named claude.exe inside a real PTY.
#[cfg(windows)]
#[test]
fn windows_pty_detects_and_clears_a_renamed_claude() {
    use std::fs;
    use std::process::Command;
    use std::time::{Duration as StdDuration, Instant};

    let dir = tempdir().unwrap();
    let db = Arc::new(Database::open(&dir.path().join("pty.sqlite")).unwrap());
    let output = Arc::new(crate::output::OutputStore::default());
    let pty = PtyManager::new(Arc::clone(&output));
    let session = db
        .create_session(CreateSession {
            project_id: None,
            title: Some("detect"),
            provider: "shell",
            mode: "terminal",
            native_id: None,
            operation_id: "ta-pty-claude",
        })
        .unwrap();

    let windir = std::env::var_os("WINDIR").unwrap_or_else(|| r"C:\Windows".into());
    let timeout = PathBuf::from(&windir).join("System32").join("timeout.exe");
    let decoy_dir = dir.path().join("decoy");
    fs::create_dir_all(&decoy_dir).unwrap();
    let decoy = decoy_dir.join("claude.exe");
    fs::copy(&timeout, &decoy).unwrap();

    let cwd = dir.path().to_string_lossy().to_string();
    pty.launch(Arc::clone(&db), &session.id, &cwd, Some("cmd.exe"), &[])
        .unwrap();

    // Start the decoy inside the shell; timeout /t 30 keeps it alive for the assertion.
    let command = format!("\"{}\" /t 30 /nobreak\r", decoy.display());
    pty.input(&session.id, command.as_bytes()).unwrap();

    let host = LiveHost {
        db: Arc::clone(&db),
        pty: pty.clone(),
    };
    let mut cache = Detection::default();
    let deadline = Instant::now() + StdDuration::from_secs(20);
    let mut seen = false;
    while Instant::now() < deadline {
        poll_once(&db, &host, &mut cache);
        if stored(&db, &session.id).as_deref() == Some("claude") {
            seen = true;
            break;
        }
        thread::sleep(StdDuration::from_millis(200));
    }
    assert!(seen, "renamed timeout.exe as claude.exe was not detected");

    // Kill only this decoy, by pid, found in this terminal's own Job by its exact path.
    // Never kill by image name: `/IM claude.exe` also kills a real Claude Code.
    let decoy_path = normalize(&decoy.to_string_lossy());
    let decoy_pids: Vec<u32> = pty
        .process_ids(&session.id)
        .into_iter()
        .filter(|pid| inspect_process(*pid).is_some_and(|info| normalize(&info.image) == decoy_path))
        .collect();
    assert!(!decoy_pids.is_empty(), "the decoy was detected but its pid was not found in the terminal's Job");
    for pid in decoy_pids {
        let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
    }
    let clear_deadline = Instant::now() + StdDuration::from_secs(15);
    let mut cleared = false;
    while Instant::now() < clear_deadline {
        poll_once(&db, &host, &mut cache);
        if stored(&db, &session.id).is_none() {
            cleared = true;
            break;
        }
        thread::sleep(StdDuration::from_millis(200));
    }
    assert!(cleared, "terminalAgent did not clear after claude.exe exited");
    let _ = pty.stop(&db, &session.id, true);
}

fn rules_from(rows: serde_json::Value) -> Vec<UserRule> {
    user_rules(&serde_json::json!({"terminalIcons":{"rules":rows,"images":[]}}))
}

#[test]
fn user_rules_match_an_executable_a_package_folder_or_a_path_fragment() {
    let rules = rules_from(serde_json::json!([
        {"id":"a","match":"copilot","icon":"image:copilot"},
        {"id":"b","match":"cursor-agent","icon":"image:cursor"},
        {"id":"c","match":"@acme/agent","icon":"codex"},
        {"id":"d","match":"aider","icon":"image:aider"}
    ]));
    // A package folder in a Node command line.
    assert_eq!(
        match_process(&rules, r"C:\nodejs\node.exe", Some(r#"node "C:\npm\node_modules\@github\copilot\index.js""#)).as_deref(),
        Some("image:copilot")
    );
    // An executable, with or without .exe; a Python module.
    assert_eq!(match_process(&rules, r"C:\Users\x\.local\bin\aider.exe", None).as_deref(), Some("image:aider"));
    assert_eq!(match_process(&rules, r"C:\Python\python.exe", Some("python -m aider --model x")).as_deref(), Some("image:aider"));
    // A folder of the host's own path (Cursor ships its node.exe under cursor-agent).
    assert_eq!(
        match_process(&rules, r"C:\cursor-agent\versions\1\node.exe", Some(r"C:\cursor-agent\versions\1\node.exe index.js")).as_deref(),
        Some("image:cursor")
    );
    // A path fragment matches anywhere, with either slash.
    assert_eq!(match_process(&rules, r"C:\node.exe", Some(r"node C:\npm\node_modules\@acme\agent\cli.js")).as_deref(), Some("codex"));
    // A name never matches part of a word, and built-ins still apply when no rule does.
    assert_eq!(match_process(&rules, r"C:\node.exe", Some("node copiloting.js")), None);
    assert_eq!(match_process(&rules, r"C:\npm\claude.exe", None).as_deref(), Some("claude"));
}

#[test]
fn a_user_rule_overrides_a_built_in_and_the_first_rule_wins() {
    let rules = rules_from(serde_json::json!([
        {"id":"a","match":"claude","icon":"image:mine"},
        {"id":"b","match":"claude.exe","icon":"codex"}
    ]));
    assert_eq!(match_process(&rules, r"C:\npm\claude.exe", None).as_deref(), Some("image:mine"));
    assert!(rules_from(serde_json::json!([{"id":"a","match":"  ","icon":"codex"}])).is_empty(), "a blank pattern is skipped");
}

#[test]
fn edited_rules_rematch_running_processes_on_the_next_poll() {
    let (_dir, db) = open_db();
    let session = shell_session(&db, "rules");
    let mut trees = HashMap::new();
    trees.insert(
        session.clone(),
        vec![ProcessInfo {
            image: r"C:\nodejs\node.exe".into(),
            created: 5,
            cmdline: Some(r"node C:\npm\node_modules\@github\copilot\index.js".into()),
        }],
    );
    let host = FakeHost::new(vec![session.clone()], trees);
    let mut state = Detection::default();
    poll_once(&db, &host, &mut state);
    assert_eq!(stored(&db, &session), None, "without a rule an unknown agent keeps the terminal icon");
    let rules = serde_json::json!({"terminalIcons":{
        "rules":[{"id":"a","match":"copilot","icon":"image:copilot"}],
        "images":[{"id":"copilot","name":"Copilot","src":"data:image/png;base64,iVBORw0KGgo="}]
    }});

    db.update_settings(&rules, 0, "rules-on").unwrap();
    poll_once(&db, &host, &mut state);
    assert_eq!(stored(&db, &session).as_deref(), Some("image:copilot"));
}
