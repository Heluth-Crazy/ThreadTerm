//! Caller-scoped agent run tools: authorization, scope, approval and the log tail.
//!
//! The approval path is driven exactly as the runtime drives it: `prepare_run` under
//! the gates, `await_run` with nothing held, the user's answer through the shared
//! `chat.answer` path, then `execute_run`.
use super::*;
use crate::{
    chat_tools::{self, ChatTools},
    db::CreateSession,
    output::OutputStore,
    pty::PtyManager,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    project: String,
    db: Arc<Database>,
    providers: Arc<Providers>,
    tools: Arc<ChatTools>,
    pty: PtyManager,
    session: String,
    token: String,
}

impl Fixture {
    fn new() -> Self {
        Self::switches(true, true)
    }

    fn with_run(run: bool) -> Self {
        Self::switches(true, run)
    }

    fn switches(ask: bool, run: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        std::fs::create_dir_all(&root).unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let project = db
            .add_project(&root.to_string_lossy(), Some("Run tools"), "run-project")
            .unwrap()
            .id;
        let session = chat_session(&db, &project, &root, "run-caller");
        start_turn(&db, &session, "turn-one");
        let providers = Arc::new(Providers::for_test(vec![]));
        providers.preview_test_worker(&session, Some("generation-one"));
        let tools = chat_tools::shared(&dir.path().join("runtime.sqlite"), Arc::clone(&db)).unwrap();
        let token = tools
            .issue(&session, "generation-one".into(), ask, true, true, run)
            .unwrap();
        let pty = PtyManager::new(Arc::new(OutputStore::default()));
        Self {
            dir,
            root,
            project,
            db,
            providers,
            tools,
            pty,
            session,
            token,
        }
    }

    fn save(&self, name: &str, command: &str, kind: &str) -> String {
        crate::quick_launch::dispatch(
            &self.db,
            &self.pty,
            "quickLaunch.save",
            &json!({
                "projectId":self.project,"name":name,"command":command,"shell":"cmd","cwd":"",
                "kind":kind,"env":[],"operationId":format!("save-{name}")
            }),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn call(&self, method: &str, mut params: Value) -> Result<Value> {
        params["callerSessionId"] = json!(self.session);
        params["callerToken"] = json!(self.token);
        self.tools.dispatch(&self.providers, method, &params)
    }

    /// The request the service makes: prepare under the gates, wait for nothing held,
    /// then execute what was authorized.
    fn start_in_background(&self, method: &str, mut params: Value) -> thread::JoinHandle<Result<Value>> {
        let tools = Arc::clone(&self.tools);
        let providers = Arc::clone(&self.providers);
        let pty = self.pty.clone();
        let session = self.session.clone();
        let token = self.token.clone();
        params["callerSessionId"] = json!(session);
        params["callerToken"] = json!(token);
        let method = method.to_owned();
        thread::spawn(move || {
            let plan = tools.prepare_run(&providers, &method, &params)?;
            let run = tools.await_run(&providers, plan)?;
            tools.execute_run(&providers, &pty, run)
        })
    }

    fn pending_approval(&self) -> (String, String) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some((turn, approval)) = self
                .db
                .chat_items(&self.session)
                .unwrap()
                .into_iter()
                .find_map(|item| {
                    let approval = item.parts.iter().find(|part| {
                        part["type"] == "approval"
                            && part["status"] == "pending"
                            && part["data"]["threadtermTool"] == "ask_user"
                    })?["approvalId"]
                        .as_str()?
                        .to_owned();
                    Some((item.turn_id?, approval))
                })
            {
                return (turn, approval);
            }
            assert!(
                Instant::now() < deadline,
                "the run approval card did not project"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn card(&self, approval: &str) -> Value {
        self.db
            .chat_items(&self.session)
            .unwrap()
            .into_iter()
            .flat_map(|item| item.parts)
            .find(|part| part["approvalId"] == approval)
            .unwrap()
    }

    fn answer(&self, turn: &str, approval: &str, choice: &str) {
        answer_chat_request(
            &self.db,
            &self.providers,
            &self.tools,
            AnswerChatRequest {
                session_id: &self.session,
                turn_id: turn,
                approval_id: approval,
                response: &json!({"action":"submit","values":{"question-1":[choice]}}),
                operation_id: &format!("answer-{approval}"),
            },
        )
        .unwrap();
    }

    /// A second Chat in its own worktree of the same project: two agents on one
    /// database, each with its own grant and provider generation.
    fn second_agent(&self) -> (String, String) {
        let other = self.dir.path().join("second-worktree");
        std::fs::create_dir_all(&other).unwrap();
        self.db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('second',?,?,'second','head',0,0)",
                    rusqlite::params![self.project, other.to_string_lossy()],
                )?;
                Ok(())
            })
            .unwrap();
        let session = chat_session(&self.db, &self.project, &other, "second-caller");
        start_turn(&self.db, &session, "second-turn");
        self.providers
            .preview_test_worker(&session, Some("generation-second"));
        let token = self
            .tools
            .issue(&session, "generation-second".into(), true, true, true, true)
            .unwrap();
        (session, token)
    }

    fn started_by(&self, run_id: &str) -> Option<String> {
        self.db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT started_by FROM quick_launch_runs WHERE session_id=?",
                    [run_id],
                    |row| row.get::<_, Option<String>>(0),
                )?)
            })
            .unwrap()
    }

    fn sessions(&self) -> i64 {
        self.db
            .transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?))
            .unwrap()
    }

    fn stop(&self, run_id: &str) {
        crate::quick_launch::request_stop(&self.db, run_id).unwrap();
        let _ = self.pty.stop(&self.db, run_id, true);
        wait_inactive(&self.db, run_id);
    }

    /// A detected run row without launching a process: the run's snapshot is the
    /// entry's own detected text, so scope, status and logs can be exercised alone.
    fn detected_run(&self, key: &str) -> String {
        let root = self.root.canonicalize().unwrap().to_string_lossy().into_owned();
        let command = crate::quick_launch::detected_command(
            &self.project,
            crate::run_detect::detect(&self.root)
                .entries
                .into_iter()
                .find(|entry| entry.key == key)
                .unwrap(),
        )
        .unwrap();
        let id = format!("detected-run-{key}");
        let now = chrono::Utc::now().to_rfc3339();
        self.db
            .transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed) VALUES(?,?,?,?,'custom','terminal','running',?,?,0)", rusqlite::params![id, self.project, root, command.name, now, now])?;
                tx.execute("INSERT INTO session_activity(session_id,state,revision) VALUES(?,'unknown',1)", [&id])?;
                tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at) VALUES(?,?,?,?,?,NULL,NULL,0,?)", rusqlite::params![id, command.id, self.project, root, serde_json::to_string(&command).unwrap(), now])?;
                Ok(())
            })
            .unwrap();
        id
    }

    fn finish(&self, run_id: &str) {
        self.db.set_session_status(run_id, "exited", Some(0)).unwrap();
    }

    /// A run in another project, inserted without launching a process.
    fn foreign_run(&self, project: &str, root: &Path, command_id: &str, session: &str) -> String {
        let root = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = json!({
            "id":command_id,"projectId":project,"revision":1,"name":"Other","command":"exit 0",
            "shell":"cmd","cwd":"","kind":"task","env":[],"createdAt":now,"updatedAt":now
        });
        let id = format!("foreign-run-{session}");
        self.db
            .transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed) VALUES(?,?,?,'Other','custom','terminal','running',?,?,0)", rusqlite::params![id, project, root, now, now])?;
                tx.execute("INSERT INTO session_activity(session_id,state,revision) VALUES(?,'unknown',1)", [&id])?;
                tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at) VALUES(?,?,?,?,?,NULL,NULL,0,?)", rusqlite::params![id, command_id, project, root, snapshot.to_string(), now])?;
                Ok(())
            })
            .unwrap();
        id
    }
}

fn chat_session(db: &Database, project: &str, cwd: &Path, operation: &str) -> String {
    let session = db
        .create_session(CreateSession {
            project_id: Some(project),
            title: Some("Agent".into()),
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: operation,
        })
        .unwrap();
    db.bind_session(&session.id, Some(cwd.to_str().unwrap()), None)
        .unwrap();
    crate::session_configs::save_new(
        db,
        &session.id,
        &crate::session_configs::LaunchSpec {
            provider: "codex".into(),
            mode: "chat".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            project_id: Some(project.to_owned()),
            title: Some("Agent".into()),
            executable: None,
            args: Vec::new(),
        },
        None,
    )
    .unwrap();
    session.id
}

fn start_turn(db: &Database, session: &str, turn: &str) {
    db.set_session_status(session, "running", None).unwrap();
    db.record_provider_event(session, Some(turn), "message.user", &json!({"text":"work"}))
        .unwrap();
}

fn wait_inactive(db: &Database, session_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let status = db.session_by_id(session_id).unwrap().unwrap().status;
        if !matches!(status.as_str(), "starting" | "running" | "idle" | "waiting") {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "session {session_id} stayed {status}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn write_package(root: &Path, command: &str) {
    std::fs::write(
        root.join("package.json"),
        format!(r#"{{"name":"fixture","scripts":{{"dev":"{command}"}}}}"#),
    )
    .unwrap();
}

#[test]
fn every_run_tool_requires_the_capability_a_current_token_and_a_live_grant() {
    let off = Fixture::with_run(false);
    assert_eq!(
        off.call("chat.tool.run.list", json!({}))
            .unwrap_err()
            .to_string(),
        "chat_tool_disabled"
    );
    let fixture = Fixture::new();
    for (method, params) in [
        ("chat.tool.run.list", json!({})),
        ("chat.tool.run.status", json!({"runId":"r"})),
        ("chat.tool.run.logs", json!({"runId":"r"})),
    ] {
        let mut body = params.clone();
        body["callerSessionId"] = json!(fixture.session);
        body["callerToken"] = json!("wrong");
        assert_eq!(
            fixture
                .tools
                .dispatch(&fixture.providers, method, &body)
                .unwrap_err()
                .to_string(),
            "chat_tool_unauthorized",
            "{method}"
        );
    }
    // A model-supplied extra field is not silently accepted.
    assert_eq!(
        fixture
            .call("chat.tool.run.list", json!({"worktree":"C:/elsewhere"}))
            .unwrap_err()
            .to_string(),
        "invalid_request"
    );
    // The grant is bound to one provider worker generation.
    fixture
        .providers
        .preview_test_worker(&fixture.session, Some("other-generation"));
    assert_eq!(
        fixture
            .call("chat.tool.run.list", json!({}))
            .unwrap_err()
            .to_string(),
        "chat_tool_stale_generation"
    );
}

#[test]
fn list_reports_saved_detected_and_attributed_runs_of_the_callers_worktree() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "node dev.js");
    let saved = fixture.save("Dev", "ping -n 30 127.0.0.1 > nul", "task");
    let detected = fixture.detected_run("node:package.json:dev");
    fixture.finish(&detected);
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE quick_launch_runs SET started_by=? WHERE session_id=?",
                rusqlite::params![fixture.session, detected],
            )?;
            Ok(())
        })
        .unwrap();
    let list = fixture.call("chat.tool.run.list", json!({})).unwrap();
    assert_eq!(
        list["worktree"],
        json!(fixture.root.canonicalize().unwrap().to_string_lossy())
    );
    let entries = list["entries"].as_array().unwrap();
    let saved_entry = entries
        .iter()
        .find(|entry| entry["id"] == json!(saved))
        .expect("the saved command is listed");
    assert_eq!(saved_entry["source"], "saved");
    assert_eq!(saved_entry["approved"], true);
    assert_eq!(saved_entry["kind"], "task");
    let detected_entry = entries
        .iter()
        .find(|entry| entry["id"] == "detected:node:package.json:dev")
        .expect("the detected entry is listed");
    assert_eq!(detected_entry["source"], "detected");
    assert_eq!(detected_entry["approved"], false);
    let runs = list["runs"].as_array().unwrap();
    let finished = runs
        .iter()
        .find(|run| run["runId"] == json!(detected))
        .unwrap();
    assert_eq!(finished["entryId"], "detected:node:package.json:dev");
    assert_eq!(finished["state"], "exited");
    assert_eq!(finished["exitCode"], 0);
    assert_eq!(finished["startedBy"], "agent");
    assert_eq!(finished["startedBySelf"], true);
    assert!(
        detected_entry.get("activeRunId").is_none(),
        "a finished run is never the active instance"
    );

    // A user-started run of the same scope is attributed to the user, not to the agent.
    let user_run = crate::quick_launch::dispatch(
        &fixture.db,
        &fixture.pty,
        "quickLaunch.run",
        &json!({"commandId":saved,"cwd":fixture.root.to_string_lossy(),"operationId":"user-run"}),
    )
    .unwrap();
    let user_id = user_run["session"]["id"].as_str().unwrap().to_owned();
    let list = fixture.call("chat.tool.run.list", json!({})).unwrap();
    let active = list["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["runId"] == json!(user_id))
        .unwrap();
    assert_eq!(active["startedBy"], "user");
    assert_eq!(active["startedBySelf"], false);
    assert_eq!(active["entryId"], json!(saved));
    assert_eq!(
        list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == json!(saved))
            .unwrap()["activeRunId"],
        json!(user_id)
    );
    fixture.stop(&user_id);
}

#[test]
fn another_projects_run_is_run_not_found_rather_than_forbidden() {
    let fixture = Fixture::new();
    let other = fixture.dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let other_project = fixture
        .db
        .add_project(&other.to_string_lossy(), Some("Other"), "other-project")
        .unwrap()
        .id;
    let other_session = chat_session(&fixture.db, &other_project, &other, "other-caller");
    let saved = crate::quick_launch::dispatch(
        &fixture.db,
        &fixture.pty,
        "quickLaunch.save",
        &json!({
            "projectId":other_project,"name":"Other","command":"exit 0","shell":"cmd","cwd":"",
            "kind":"task","env":[],"operationId":"save-other"
        }),
    )
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = fixture.foreign_run(&other_project, &other, &saved, &other_session);
    for (method, params) in [
        ("chat.tool.run.status", json!({"runId":run})),
        ("chat.tool.run.logs", json!({"runId":run})),
    ] {
        assert_eq!(
            fixture.call(method, params).unwrap_err().to_string(),
            "run_not_found",
            "{method}"
        );
    }
    assert_eq!(
        fixture
            .tools
            .run_stop(
                &fixture.providers,
                &fixture.pty,
                &json!({"callerSessionId":fixture.session,"callerToken":fixture.token,"runId":run}),
            )
            .unwrap_err()
            .to_string(),
        "run_not_found"
    );
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.restart",
                json!({"runId":run,"requestId":"restart-foreign"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "run_not_found"
    );
    // The other project's own Chat finds it.
    let other_token = fixture
        .tools
        .issue(&other_session, "generation-one".into(), true, true, true, true)
        .unwrap();
    fixture.providers.preview_test_worker(&other_session, Some("generation-one"));
    assert_eq!(
        fixture
            .tools
            .dispatch(
                &fixture.providers,
                "chat.tool.run.status",
                &json!({"callerSessionId":other_session,"callerToken":other_token,"runId":run}),
            )
            .unwrap()["runId"],
        json!(run)
    );
}

#[test]
fn a_read_only_delegate_may_look_but_not_start_stop_or_restart() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "node dev.js");
    let run = fixture.detected_run("node:package.json:dev");
    fixture
        .db
        .transaction(|tx| {
            tx.execute("INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,state,authority,created_at,updated_at) VALUES('d',?,?,'codex','shared','C:/fixture',NULL,'work',0,'delegation','running','read_only','t','t')", rusqlite::params![fixture.session, fixture.session])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fixture.call("chat.tool.run.list", json!({})).unwrap()["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture
            .call("chat.tool.run.status", json!({"runId":run}))
            .unwrap()["runId"],
        json!(run)
    );
    assert_eq!(
        fixture.call("chat.tool.run.logs", json!({"runId":run})).unwrap()["totalBytes"],
        0
    );
    for (method, params) in [
        (
            "chat.tool.run.start",
            json!({"id":"detected:node:package.json:dev","requestId":"ro-start"}),
        ),
        ("chat.tool.run.restart", json!({"runId":run,"requestId":"ro-restart"})),
    ] {
        assert_eq!(
            fixture
                .start_in_background(method, params)
                .join()
                .unwrap()
                .unwrap_err()
                .to_string(),
            "run_not_permitted",
            "{method}"
        );
    }
    assert_eq!(
        fixture
            .tools
            .run_stop(
                &fixture.providers,
                &fixture.pty,
                &json!({"callerSessionId":fixture.session,"callerToken":fixture.token,"runId":run}),
            )
            .unwrap_err()
            .to_string(),
        "run_not_permitted"
    );
}

#[test]
fn logs_strip_escapes_collapse_carriage_returns_and_bound_the_tail() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "node dev.js");
    let run = fixture.detected_run("node:package.json:dev");
    let output = b"\x1b[32mready\x1b[0m\r\n10%\r20%\r30%\r\n\x1b]0;window title\x07tail\n";
    fixture.db.append_output(&run, 0, output).unwrap();
    let logs = fixture.call("chat.tool.run.logs", json!({"runId":run})).unwrap();
    assert_eq!(logs["text"], "ready\n30%\ntail");
    assert_eq!(logs["truncated"], false);
    assert_eq!(logs["totalBytes"], output.len());

    // The line bound keeps the last lines and says so.
    let many = (0..300)
        .map(|index| format!("line {index}\n"))
        .collect::<String>();
    let start = output.len() as i64;
    fixture
        .db
        .append_output(&run, start, many.as_bytes())
        .unwrap();
    let logs = fixture
        .call("chat.tool.run.logs", json!({"runId":run,"lines":10}))
        .unwrap();
    let text = logs["text"].as_str().unwrap();
    assert!(text.ends_with("line 299"), "{text}");
    assert_eq!(text.lines().count(), 10);
    assert_eq!(logs["truncated"], true);

    // Scanning stops 1 MiB back, and the text stays within 64 KiB.
    let bulk = "x".repeat(1024 * 1024 + 4096);
    let start = start + many.len() as i64;
    fixture
        .db
        .append_output(&run, start, format!("{bulk}END").as_bytes())
        .unwrap();
    let logs = fixture
        .call("chat.tool.run.logs", json!({"runId":run,"lines":2000}))
        .unwrap();
    let text = logs["text"].as_str().unwrap();
    assert!(text.len() <= 64 * 1024, "{}", text.len());
    assert!(text.ends_with("END"));
    assert_eq!(logs["truncated"], true);
    assert_eq!(logs["totalBytes"], start + bulk.len() as i64 + 3);
}

#[cfg(windows)]
#[test]
fn a_saved_start_replays_by_request_id_and_returns_the_active_instance() {
    let fixture = Fixture::new();
    let saved = fixture.save("Server", "ping -n 30 127.0.0.1 > nul", "task");
    let started = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"agent-start"}),
        )
        .join()
        .unwrap()
        .unwrap();
    let run_id = started["runId"].as_str().unwrap().to_owned();
    assert_eq!(started["existing"], false);
    assert_eq!(started["entryId"], json!(saved));
    assert_eq!(fixture.started_by(&run_id).as_deref(), Some(fixture.session.as_str()));
    let session = fixture.db.session_by_id(&run_id).unwrap().unwrap();
    assert_eq!(
        session.run.unwrap().started_by.as_deref(),
        Some(fixture.session.as_str())
    );

    // The same requestId replays the recorded launch instead of starting another.
    let replay = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"agent-start"}),
        )
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(replay["runId"], json!(run_id));
    // A new request for the same entry returns the active instance without launching.
    let existing = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"agent-start-second"}),
        )
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(existing["runId"], json!(run_id));
    assert_eq!(existing["existing"], true);
    assert_eq!(fixture.started_by(&run_id).as_deref(), Some(fixture.session.as_str()));
    fixture.stop(&run_id);
}

#[cfg(windows)]
#[test]
fn a_detected_start_asks_with_the_detected_text_and_launches_that_snapshot() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"detected-start"}),
    );
    let (turn, approval) = fixture.pending_approval();
    let card = fixture.card(&approval);
    let question = card["data"]["form"]["questions"][0]["question"]
        .as_str()
        .unwrap();
    assert!(question.contains("npm run dev"), "{question}");
    assert!(question.contains("package.json"), "{question}");
    assert!(question.contains(&fixture.root.canonicalize().unwrap().to_string_lossy().to_string()));
    assert_eq!(card["data"]["form"]["questions"][0]["header"], "Run");
    let labels = card["data"]["form"]["questions"][0]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["label"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(labels, ["Run once", "Don't run"]);
    fixture.answer(&turn, &approval, "Run once");
    let started = start.join().unwrap().unwrap();
    let run_id = started["runId"].as_str().unwrap().to_owned();
    let session = fixture.db.session_by_id(&run_id).unwrap().unwrap();
    let run = session.run.unwrap();
    assert_eq!(run.command_id, "detected:node:package.json:dev");
    assert_eq!(run.started_by.as_deref(), Some(fixture.session.as_str()));
    assert_eq!(started["existing"], false);
    wait_inactive(&fixture.db, &run_id);
    assert_eq!(fixture.started_by(&run_id).as_deref(), Some(fixture.session.as_str()));
}

#[cfg(windows)]
#[test]
fn declining_or_cancelling_the_card_never_launches() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    let declined = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"declined-start"}),
    );
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Don't run");
    assert_eq!(
        declined.join().unwrap().unwrap_err().to_string(),
        "run_declined"
    );
    assert_eq!(fixture.sessions(), 1, "a declined start launches nothing");

    start_turn(&fixture.db, &fixture.session, "turn-two");
    let cancelled = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"cancelled-start"}),
    );
    fixture.pending_approval();
    fixture.tools.cancel_turn(&fixture.session, "turn-two").unwrap();
    assert_eq!(
        cancelled.join().unwrap().unwrap_err().to_string(),
        "run_declined"
    );
    assert_eq!(fixture.sessions(), 1);
}

#[cfg(windows)]
#[test]
fn a_changed_detection_after_approval_is_never_launched() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"changed-start"}),
    );
    let (turn, approval) = fixture.pending_approval();
    // The detected command text changes while the card is open (a lockfile selects
    // another runner): the launched text must still be the approved one.
    std::fs::write(fixture.root.join("bun.lock"), "").unwrap();
    fixture.answer(&turn, &approval, "Run once");
    assert_eq!(
        start.join().unwrap().unwrap_err().to_string(),
        "detected_entry_changed"
    );
    assert_eq!(fixture.sessions(), 1, "the text the user never saw is not run");
}

#[test]
fn a_detected_start_without_an_active_turn_cannot_ask() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    fixture
        .db
        .record_provider_event(
            &fixture.session,
            Some("turn-one"),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.start",
                json!({"id":"detected:node:package.json:dev","requestId":"inactive-start"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "chat_turn_inactive"
    );
}

#[test]
fn an_unknown_detected_key_or_a_saved_id_from_another_project_is_not_found() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.start",
                json!({"id":"detected:node:missing/package.json:dev","requestId":"unknown-key"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "detected_entry_not_found"
    );
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.start",
                json!({"id":"no-such-command","requestId":"unknown-command"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "run_not_found"
    );
}

#[cfg(windows)]
#[test]
fn stop_and_restart_work_within_the_scope_and_a_detected_restart_asks_again() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "ping -n 30 127.0.0.1 > nul");
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"restart-base"}),
    );
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Run once");
    let first = start.join().unwrap().unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    let state = fixture.call("chat.tool.run.status", json!({"runId":first})).unwrap()["state"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(matches!(state.as_str(), "starting" | "running"), "{state}");

    // A restart of a detected run asks again, with the re-detected text.
    let restart = fixture.start_in_background(
        "chat.tool.run.restart",
        json!({"runId":first,"requestId":"restart-detected"}),
    );
    let (turn, approval) = fixture.pending_approval();
    assert_eq!(fixture.card(&approval)["status"], "pending");
    fixture.answer(&turn, &approval, "Run once");
    let second = restart.join().unwrap().unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(second, first);
    assert_eq!(
        fixture.started_by(&second).as_deref(),
        Some(fixture.session.as_str())
    );
    assert_eq!(
        fixture.db.session_by_id(&first).unwrap().unwrap().status,
        "exited",
        "the restarted run was stopped"
    );

    // The same restart request replays its receipt.
    let replay = fixture
        .start_in_background(
            "chat.tool.run.restart",
            json!({"runId":first,"requestId":"restart-detected"}),
        )
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(replay["runId"], json!(second));

    let stopped = fixture
        .tools
        .run_stop(
            &fixture.providers,
            &fixture.pty,
            &json!({"callerSessionId":fixture.session,"callerToken":fixture.token,"runId":second}),
        )
        .unwrap();
    assert_eq!(stopped["runId"], json!(second));
    wait_inactive(&fixture.db, &second);
    assert_eq!(
        fixture.db.session_by_id(&second).unwrap().unwrap().run.unwrap().stop_requested,
        Some(true)
    );
}

#[cfg(windows)]
#[test]
fn a_saved_restart_launches_without_a_card_and_carries_attribution() {
    let fixture = Fixture::new();
    let saved = fixture.save("Server", "ping -n 30 127.0.0.1 > nul", "task");
    let started = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"saved-start"}),
        )
        .join()
        .unwrap()
        .unwrap();
    let first = started["runId"].as_str().unwrap().to_owned();
    let restarted = fixture
        .start_in_background(
            "chat.tool.run.restart",
            json!({"runId":first,"requestId":"saved-restart"}),
        )
        .join()
        .unwrap()
        .unwrap();
    let second = restarted["runId"].as_str().unwrap().to_owned();
    assert_ne!(second, first);
    assert_eq!(
        fixture.started_by(&second).as_deref(),
        Some(fixture.session.as_str())
    );
    fixture.stop(&second);
}

#[test]
fn the_started_by_column_is_added_to_an_existing_runs_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.sqlite");
    {
        // The schema before 2a: no `started_by` column on the runs table.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE quick_launch_runs (
             session_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, project_id TEXT NOT NULL,
             root TEXT NOT NULL, snapshot_json TEXT NOT NULL, url TEXT, url_source TEXT,
             stop_requested INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL);
             INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,started_at)
             VALUES('old','saved','project','C:\\root','{\"id\":\"saved\",\"projectId\":\"project\",\"revision\":1,\"name\":\"Old\",\"command\":\"exit 0\",\"shell\":\"cmd\",\"cwd\":\"\",\"kind\":\"task\",\"env\":[],\"createdAt\":\"t\",\"updatedAt\":\"t\"}','t');",
        )
        .unwrap();
    }
    let db = Database::open(&path).unwrap();
    let columns = db
        .transaction(|tx| {
            let mut statement = tx.prepare("PRAGMA table_info(quick_launch_runs)")?;
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(names)
        })
        .unwrap();
    assert!(columns.iter().any(|name| name == "started_by"), "{columns:?}");
    let run = db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT snapshot_json,url,url_source,stop_requested,readiness,ready_port,started_by FROM quick_launch_runs WHERE session_id='old'",
                [],
                |row| crate::quick_launch::run_from_row(row, 0),
            )?)
        })
        .unwrap()
        .unwrap();
    assert_eq!(run.command_id, "saved");
    assert_eq!(run.started_by, None, "a user run of the old table stays unattributed");
}

#[cfg(windows)]
#[test]
fn the_runtime_dispatches_the_run_tools() {
    let fixture = Fixture::new();
    let saved = fixture.save("Server", "ping -n 30 127.0.0.1 > nul", "task");
    let service = RuntimeService::new(
        crate::config::RuntimeConfig {
            data_dir: fixture.dir.path().to_owned(),
            database_path: fixture.dir.path().join("runtime.sqlite"),
            credential_path: fixture.dir.path().join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-run-tool-test".into(),
        },
        Arc::clone(&fixture.db),
    );
    // The service composes its own provider registry; the grant is fenced to a
    // generation of that registry, exactly as a live worker open would be.
    service
        .providers
        .preview_test_worker(&fixture.session, Some("generation-one"));
    let rpc = |method: &str, params: Value, id: &str| RpcRequest {
        v: 1,
        id: id.into(),
        method: method.into(),
        params,
    };
    let list = service
        .dispatch(
            "test",
            rpc(
                "chat.tool.run.list",
                json!({"callerSessionId":fixture.session,"callerToken":fixture.token}),
                "list",
            ),
        )
        .unwrap();
    assert_eq!(list["worktree"], json!(fixture.root.canonicalize().unwrap().to_string_lossy()));
    let started = service
        .dispatch(
            "test",
            rpc(
                "chat.tool.run.start",
                json!({"id":saved,"requestId":"service-start","callerSessionId":fixture.session,"callerToken":fixture.token}),
                "start",
            ),
        )
        .unwrap();
    let run_id = started["runId"].as_str().unwrap().to_owned();
    assert_eq!(started["existing"], false);
    let stopped = service
        .dispatch(
            "test",
            rpc(
                "chat.tool.run.stop",
                json!({"runId":run_id,"callerSessionId":fixture.session,"callerToken":fixture.token}),
                "stop",
            ),
        )
        .unwrap();
    assert_eq!(stopped["stopRequested"], true);
    wait_inactive(&fixture.db, &run_id);
    // A wrong token never reaches a run.
    let error = service
        .dispatch(
            "test",
            rpc(
                "chat.tool.run.list",
                json!({"callerSessionId":fixture.session,"callerToken":"wrong"}),
                "list-bad",
            ),
        )
        .unwrap_err();
    assert_eq!(error.code, "invalid_request");
    assert!(error.message.contains("chat_tool_unauthorized"));
    service.shutdown();
}

#[test]
fn another_worktree_of_the_same_project_is_run_not_found() {
    let fixture = Fixture::new();
    let other = fixture.dir.path().join("second-worktree");
    std::fs::create_dir_all(&other).unwrap();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('second',?,?,'second','head',0,0)",
                rusqlite::params![fixture.project, other.to_string_lossy()],
            )?;
            Ok(())
        })
        .unwrap();
    let other_session = chat_session(&fixture.db, &fixture.project, &other, "second-caller");
    let saved = fixture.save("Server", "exit 0", "task");
    let run = fixture.foreign_run(&fixture.project, &other, &saved, &other_session);
    assert_eq!(
        fixture
            .call("chat.tool.run.status", json!({"runId":run}))
            .unwrap_err()
            .to_string(),
        "run_not_found"
    );
    let list = fixture.call("chat.tool.run.list", json!({})).unwrap();
    assert!(
        !list["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["runId"] == json!(run)),
        "a run of another worktree is not listed"
    );
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.restart",
                json!({"runId":run,"requestId":"restart-other-worktree"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "run_not_found"
    );
}

#[cfg(windows)]
#[test]
fn a_long_detected_command_is_shown_in_full_or_refused_never_shortened() {
    let fixture = Fixture::new();
    // The card shows the command verbatim, on its own line, so a padded Procfile line
    // cannot hide a second half behind a shortened prefix.
    let shown = format!("node -e {}", "x".repeat(2_000));
    std::fs::write(fixture.root.join("Procfile"), format!("web: {shown}\n")).unwrap();
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:procfile:Procfile:web","requestId":"long-shown"}),
    );
    let (turn, approval) = fixture.pending_approval();
    let question = fixture.card(&approval)["data"]["form"]["questions"][0]["question"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(question.contains(&shown), "the approved text is shown in full");
    assert!(!question.contains('…'), "the command is never shortened: {question}");
    assert!(question.starts_with("Run this detected command from `Procfile` in `"));
    assert!(question.contains(&format!("\n{shown}")), "the command is on its own line");
    // The card renders the command from its own runtime-only field, marked `presentation:"command"`.
    let form = &fixture.card(&approval)["data"]["form"]["questions"][0];
    assert_eq!(form["presentation"], "command");
    assert_eq!(form["command"], json!(shown));
    fixture.answer(&turn, &approval, "Don't run");
    assert_eq!(start.join().unwrap().unwrap_err().to_string(), "run_declined");

    // Beyond the card's bound nothing is launched either: the tool refuses.
    let oversized = format!("node -e {}", "y".repeat(4_100));
    std::fs::write(fixture.root.join("Procfile"), format!("web: {oversized}\n")).unwrap();
    assert_eq!(
        fixture
            .start_in_background(
                "chat.tool.run.start",
                json!({"id":"detected:procfile:Procfile:web","requestId":"long-refused"}),
            )
            .join()
            .unwrap()
            .unwrap_err()
            .to_string(),
        "detected_command_too_long"
    );
    assert_eq!(fixture.sessions(), 1, "a command too long to show is never launched");
}

#[cfg(windows)]
#[test]
fn a_detected_command_with_unprintable_characters_is_never_shown_or_launched() {
    let fixture = Fixture::new();
    // Invisible format characters (zero-width, bidi override, BOM), line/paragraph separators and
    // other controls (except tab) can make the card read differently from what would run.
    for (name, command) in [
        ("zero_width", "node safe\u{200B}.js"),
        ("bidi", "node \u{202E}sj.exe"),
        ("bom", "node \u{FEFF}safe.js"),
        ("line_separator", "node safe\u{2028}.js"),
        ("paragraph_separator", "node safe\u{2029}.js"),
        ("other_control", "node safe\u{7}.js"),
    ] {
        std::fs::write(fixture.root.join("Procfile"), format!("web: {command}\n")).unwrap();
        assert_eq!(
            fixture
                .start_in_background(
                    "chat.tool.run.start",
                    json!({"id":"detected:procfile:Procfile:web","requestId":name}),
                )
                .join()
                .unwrap()
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable",
            "{name}"
        );
    }
    assert_eq!(fixture.sessions(), 1, "an unprintable command is never launched");
    // A tab is ordinary whitespace inside a command and stays approvable.
    std::fs::write(fixture.root.join("Procfile"), "web: node\tsafe.js\n").unwrap();
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:procfile:Procfile:web","requestId":"tab"}),
    );
    let (turn, approval) = fixture.pending_approval();
    assert_eq!(fixture.card(&approval)["data"]["form"]["questions"][0]["presentation"], "command");
    fixture.answer(&turn, &approval, "Don't run");
    assert_eq!(start.join().unwrap().unwrap_err().to_string(), "run_declined");
}

#[cfg(windows)]
#[test]
fn an_active_instance_that_ends_before_the_answer_asks_before_launching() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "ping -n 30 127.0.0.1 > nul");
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"first-start"}),
    );
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Run once");
    let running = start.join().unwrap().unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned();

    // The instance is active, so this call is authorized to answer `existing:true`
    // without a card...
    let mut params = json!({"id":"detected:node:package.json:dev","requestId":"second-start"});
    params["callerSessionId"] = json!(fixture.session);
    params["callerToken"] = json!(fixture.token);
    let plan = fixture
        .tools
        .prepare_run(&fixture.providers, "chat.tool.run.start", &params)
        .unwrap();
    assert!(
        !fixture
            .db
            .chat_items(&fixture.session)
            .unwrap()
            .iter()
            .flat_map(|item| &item.parts)
            .any(|part| part["type"] == "approval" && part["status"] == "pending"),
        "an active instance raises no card"
    );
    // ...but it ends before the answer, so the launch must still be approved.
    fixture.stop(&running);
    let launched = {
        let tools = Arc::clone(&fixture.tools);
        let providers = Arc::clone(&fixture.providers);
        let pty = fixture.pty.clone();
        thread::spawn(move || {
            let run = tools.await_run(&providers, plan)?;
            tools.execute_run(&providers, &pty, run)
        })
    };
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Don't run");
    assert_eq!(
        launched.join().unwrap().unwrap_err().to_string(),
        "run_declined"
    );
    assert_eq!(
        fixture.db.snapshot().unwrap().sessions.len(),
        2,
        "only the first run exists after a declined fallback"
    );
}

#[test]
fn operation_ids_are_namespaced_per_caller_and_method() {
    let fixture = Fixture::new();
    let (second, second_token) = fixture.second_agent();
    let saved = fixture.save("Server", "ping -n 30 127.0.0.1 > nul", "task");

    // An unrelated receipt that happens to use the raw request id must not answer a
    // run start: the tool keys its receipts by method and caller.
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO operations(id,method,result,created_at) VALUES('start-1','quickLaunch.save','null','t')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let first = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"start-1"}),
        )
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(first["existing"], false, "an unrelated operation is not a replay");
    let first_run = first["runId"].as_str().unwrap().to_owned();
    assert_eq!(
        fixture.started_by(&first_run).as_deref(),
        Some(fixture.session.as_str())
    );

    // The same request id from another agent of the same runtime gets its own run.
    let second_start = fixture
        .tools
        .prepare_run(
            &fixture.providers,
            "chat.tool.run.start",
            &json!({"id":saved,"requestId":"start-1","callerSessionId":second,"callerToken":second_token}),
        )
        .unwrap();
    let launched = fixture
        .tools
        .await_run(&fixture.providers, second_start)
        .unwrap();
    let value = fixture
        .tools
        .execute_run(&fixture.providers, &fixture.pty, launched)
        .unwrap();
    assert_eq!(value["existing"], false);
    let second_run = value["runId"].as_str().unwrap().to_owned();
    assert_ne!(second_run, first_run, "same request id, different agent");
    assert_eq!(
        fixture.started_by(&second_run).as_deref(),
        Some(second.as_str())
    );

    // Replay is method-matched: a receipt recorded by another method never answers a
    // run start, which is what `start_entry` and `prepare_run` rely on.
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO operations(id,method,result,created_at) VALUES('replay-check','quickLaunch.save','null','t')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        crate::quick_launch::replayed_operation(&fixture.db, "replay-check", "chat.tool.run.start")
            .unwrap(),
        None
    );
    // The same saved entry is already active in this worktree: the tool answers with
    // that instance instead of the foreign receipt.
    let own = fixture
        .start_in_background(
            "chat.tool.run.start",
            json!({"id":saved,"requestId":"own-later"}),
        )
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(own["existing"], true);
    assert_eq!(own["runId"], json!(first_run));
    fixture.stop(&first_run);
    fixture.stop(&second_run);
}

#[cfg(windows)]
#[test]
fn a_detected_start_asks_with_the_run_switch_alone() {
    // The approval card belongs to the run switch: turning Ask off must not make every
    // detected start fail with `chat_tool_disabled`.
    let fixture = Fixture::switches(false, true);
    write_package(&fixture.root, "exit 0");
    assert_eq!(
        fixture
            .call(
                "chat.tool.ask",
                json!({"questions":[{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}]}),
            )
            .unwrap_err()
            .to_string(),
        "chat_tool_disabled",
        "the Ask switch really is off"
    );
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"ask-off"}),
    );
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Run once");
    let run_id = start.join().unwrap().unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        fixture.started_by(&run_id).as_deref(),
        Some(fixture.session.as_str())
    );
    wait_inactive(&fixture.db, &run_id);
}

#[cfg(windows)]
#[test]
fn an_approval_answered_during_shutdown_never_launches() {
    use std::sync::Barrier;
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    let service = Arc::new(RuntimeService::new(
        crate::config::RuntimeConfig {
            data_dir: fixture.dir.path().to_owned(),
            database_path: fixture.dir.path().join("runtime.sqlite"),
            credential_path: fixture.dir.path().join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-run-shutdown-test".into(),
        },
        Arc::clone(&fixture.db),
    ));
    service
        .providers
        .preview_test_worker(&fixture.session, Some("generation-one"));
    // Hold the card publication so the shutdown can land while the request is in the
    // runtime, then let it continue to the wait and the answer.
    let reached = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    fixture
        .tools
        .pause_next_ask_publication(Arc::clone(&reached), Arc::clone(&resume));
    let dispatch = Arc::clone(&service);
    let session = fixture.session.clone();
    let token = fixture.token.clone();
    let handle = thread::spawn(move || {
        dispatch.dispatch(
            "test",
            RpcRequest {
                v: 1,
                id: "gated-start".into(),
                method: "chat.tool.run.start".into(),
                params: json!({
                    "id":"detected:node:package.json:dev","requestId":"during-shutdown",
                    "callerSessionId":session,"callerToken":token
                }),
            },
        )
    });
    reached.wait();
    service.shutdown_pending.store(true, Ordering::Release);
    resume.wait();
    let (turn, approval) = fixture.pending_approval();
    fixture.answer(&turn, &approval, "Run once");
    let error = handle.join().unwrap().unwrap_err();
    assert_eq!(error.code, "runtime_stopping");
    assert_eq!(fixture.sessions(), 1, "nothing launched after shutdown began");
    let _ = service.shutdown();
}

#[test]
fn a_delegated_childs_run_approval_stays_with_the_user() {
    let fixture = Fixture::new();
    write_package(&fixture.root, "exit 0");
    // The parent agent is inside a turn: its delegates' permission requests would be
    // routed to it. A run approval is the user's, because the command runs outside the
    // child's sandbox.
    let (parent, _) = fixture.second_agent();
    start_turn(&fixture.db, &parent, "parent-turn");
    let child = fixture.session.clone();
    fixture
        .db
        .transaction(|tx| {
            tx.execute("INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,state,authority,created_at,updated_at) VALUES('route',?,?,'codex','shared','C:/fixture',NULL,'work',0,'route-op','awaiting_parent','full_access','t','t')", rusqlite::params![parent, child])?;
            Ok(())
        })
        .unwrap();
    let start = fixture.start_in_background(
        "chat.tool.run.start",
        json!({"id":"detected:node:package.json:dev","requestId":"child-start"}),
    );
    let (turn, approval) = fixture.pending_approval();
    let card = fixture.card(&approval);
    assert_eq!(card["data"]["delegation"]["parentSessionId"], json!(parent));
    assert_eq!(
        card["data"]["delegation"]["route"],
        "user",
        "a run approval is never answered by the parent agent"
    );
    // The card is the user's, so the projection moved the child to `awaiting_user`:
    // the parent agent is never asked and never sees it as a pending request.
    let delegations = crate::delegation::Delegations::default();
    let parent_token = delegations.issue_token(&parent);
    let status = crate::delegation::dispatch(
        &delegations,
        &fixture.db,
        &fixture.providers,
        "delegation.status",
        &json!({"callerSessionId":parent,"callerToken":parent_token,"ids":[]}),
    )
    .unwrap()
    .unwrap();
    let delegate = status["delegates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|delegate| delegate["sessionId"] == json!(child))
        .unwrap()
        .clone();
    assert_eq!(
        delegate["state"],
        "awaiting_user",
        "the run approval is the user's, so the child waits for the user"
    );
    assert!(
        !delegate["pendingRequests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|request| request["requestId"] == json!(approval)),
        "the run approval is not in the parent's pending requests: {delegate}"
    );
    // The user answers it and the child's run starts.
    fixture.answer(&turn, &approval, "Run once");
    let run_id = start.join().unwrap().unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        fixture.started_by(&run_id).as_deref(),
        Some(child.as_str())
    );
    wait_inactive(&fixture.db, &run_id);
}
