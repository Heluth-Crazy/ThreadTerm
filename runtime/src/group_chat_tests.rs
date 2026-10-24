use crate::{
    chat_queue::{self, ChatQueues},
    db::{CreateSession, Database},
    group_chat,
    providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent, Providers,
        TerminalCommand,
    },
    session_configs::{self, LaunchSpec},
};
use serde_json::{json, Value};
#[path = "group_changes_tests.rs"]
mod folder_changes;
use rusqlite::params;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
struct Sent {
    session: String,
    turn: String,
    prompt: String,
}

#[derive(Default)]
struct Script {
    sent: Vec<Sent>,
    cancelled: Vec<String>,
    options: Value,
}

struct Adapter {
    script: Arc<Mutex<Script>>,
    next_turn: Arc<AtomicUsize>,
}

impl ProviderAdapter for Adapter {
    fn id(&self) -> &str {
        "fixture"
    }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "fixture",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: "fixture".into(),
            name: "Fixture provider".into(),
            installed: true,
            version: None,
            terminal: false,
            chat: true,
            history: false,
            resume: false,
            terminal_resume_capture: "none",
            reason: None,
            auth: "authenticated".into(),
        }
    }

    fn terminal_command(
        &self,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "fixture"))
    }

    fn history_list(
        &self,
        _: Option<&str>,
        _: u32,
        _: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }

    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        Ok(json!([]))
    }

    fn open_chat(
        &self,
        session: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        Ok(Box::new(FakeChat {
            session: session.into(),
            script: Arc::clone(&self.script),
            next_turn: Arc::clone(&self.next_turn),
        }))
    }
}

struct FakeChat {
    session: String,
    script: Arc<Mutex<Script>>,
    next_turn: Arc<AtomicUsize>,
}

impl ChatSession for FakeChat {
    fn native_id(&self) -> Option<String> {
        Some(format!("fixture-{}", self.session))
    }

    fn send(&mut self, text: &str, _: &str) -> Result<Value, ProviderError> {
        let turn = format!("turn-{}", self.next_turn.fetch_add(1, Ordering::SeqCst));
        self.script.lock().unwrap().sent.push(Sent {
            session: self.session.clone(),
            turn: turn.clone(),
            prompt: text.into(),
        });
        Ok(json!({"turnId":turn}))
    }

    fn cancel(&mut self, turn: &str) -> Result<(), ProviderError> {
        self.script.lock().unwrap().cancelled.push(turn.into());
        Ok(())
    }

    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        Ok(())
    }

    fn ui_state(&self) -> Value {
        self.script.lock().unwrap().options.clone()
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    repo: PathBuf,
    db: Arc<Database>,
    providers: Arc<Providers>,
    queues: Arc<ChatQueues>,
    script: Arc<Mutex<Script>>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("group-chat-")
            .tempdir()
            .unwrap();
        let repo = root.path().join("workspace");
        fs::create_dir(&repo).unwrap();
        run(&repo, &["init", "-q"]);
        run(&repo, &["config", "user.email", "fixture@example.test"]);
        run(&repo, &["config", "user.name", "Fixture"]);
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "base"]);

        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        session_configs::initialize(&db).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        chat_queue::initialize(&db).unwrap();
        group_chat::initialize(&db).unwrap();
        let script = Arc::new(Mutex::new(Script::default()));
        let adapter = Adapter {
            script: Arc::clone(&script),
            next_turn: Arc::new(AtomicUsize::new(1)),
        };
        Self {
            _root: root,
            repo,
            db,
            providers: Arc::new(Providers::for_test(vec![Arc::new(adapter)])),
            queues: Arc::new(ChatQueues::default()),
            script,
        }
    }

    fn standalone_chat(&self, title: &str) -> Value {
        let project = self
            .db
            .add_project(
                &self.repo.to_string_lossy(),
                Some("fixture"),
                "group-project",
            )
            .unwrap();
        create_chat(
            &self.db,
            &self.repo,
            &project.id,
            &json!({"title":title,"provider":"fixture","operationId":"create-source"}),
        )
        .unwrap()
    }

    fn create(&self, members: usize) -> Value {
        self.create_with_members(
            (0..members)
                .map(|_| json!({"provider":"fixture"}))
                .collect(),
            "Fixture group",
        )
    }

    fn create_with_members(&self, members: Vec<Value>, title: &str) -> Value {
        let project = self
            .db
            .add_project(
                &self.repo.to_string_lossy(),
                Some("fixture"),
                "group-project",
            )
            .unwrap();
        let db = Arc::clone(&self.db);
        let cwd = self.repo.clone();
        let project_id = project.id.clone();
        group_chat::dispatch(
            &self.db,
            &self.providers,
            &self.queues,
            "group.create",
            &json!({
                "projectId":project.id,
                "cwd":self.repo,
                "title":title,
                "members":members,
                "operationId":format!("create-{}", title)
            }),
            &move |value| create_chat(&db, &cwd, &project_id, value),
        )
        .unwrap()
    }

    fn read(&self, id: &str) -> Value {
        self.dispatch("group.read", json!({"id":id}))
    }

    fn dispatch(&self, method: &str, value: Value) -> Value {
        self.dispatch_with_create(method, value, &|_| unreachable!())
    }

    fn dispatch_with_create(
        &self,
        method: &str,
        value: Value,
        create: &dyn Fn(&Value) -> anyhow::Result<Value>,
    ) -> Value {
        group_chat::dispatch(
            &self.db,
            &self.providers,
            &self.queues,
            method,
            &value,
            create,
        )
        .unwrap()
    }

    fn complete(&self, sent: &Sent, text: &str) {
        for (kind, data) in [
            ("chat.turn.started", json!({})),
            ("chat.delta", json!({"text":text})),
            ("chat.turn.completed", json!({"status":"completed"})),
        ] {
            self.db
                .record_provider_event(&sent.session, Some(&sent.turn), kind, &data)
                .unwrap();
            group_chat::provider_event(
                &self.db,
                &self.providers,
                &self.queues,
                &ProviderEvent {
                    provider: "fixture".into(),
                    session_id: sent.session.clone(),
                    native_id: Some(format!("fixture-{}", sent.session)),
                    turn_id: Some(sent.turn.clone()),
                    kind: kind.into(),
                    data,
                    worker_token: None,
                },
            );
            self.queues.provider_event(
                &self.db,
                &self.providers,
                &ProviderEvent {
                    provider: "fixture".into(),
                    session_id: sent.session.clone(),
                    native_id: Some(format!("fixture-{}", sent.session)),
                    turn_id: Some(sent.turn.clone()),
                    kind: kind.into(),
                    data: json!({"status":"completed"}),
                    worker_token: None,
                },
            );
        }
    }
}

fn create_chat(
    db: &Database,
    cwd: &Path,
    project_id: &str,
    value: &Value,
) -> anyhow::Result<Value> {
    let session = db.create_session(CreateSession {
        project_id: Some(project_id),
        title: value["title"].as_str(),
        provider: value["provider"].as_str().unwrap_or("fixture"),
        mode: "chat",
        native_id: None,
        operation_id: value["operationId"].as_str().unwrap(),
    })?;
    session_configs::save_new(
        db,
        &session.id,
        &LaunchSpec {
            provider: "fixture".into(),
            mode: "chat".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            project_id: Some(project_id.into()),
            title: None,
            executable: None,
            args: vec![],
        },
        None,
    )?;
    db.set_session_status(&session.id, "idle", None)?;
    Ok(json!({"id":session.id}))
}

fn run(path: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[track_caller]
fn wait_for(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "group delivery did not reach expected state"
        );
        thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn create_allows_repeated_providers_and_default_handles() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let handles = group["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| member["handle"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(handles, ["fixture", "fixture-2"]);
    assert!(group["members"]
        .as_array()
        .unwrap()
        .iter()
        .all(|member| member["mode"] == "default"));
}

#[test]
fn create_operation_replay_returns_the_same_group_without_new_sessions() {
    let fixture = Fixture::new();
    let project = fixture
        .db
        .add_project(
            &fixture.repo.to_string_lossy(),
            Some("fixture"),
            "group-project",
        )
        .unwrap();
    let db = Arc::clone(&fixture.db);
    let cwd = fixture.repo.clone();
    let project_id = project.id.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let create_calls = Arc::clone(&calls);
    let request = json!({
        "projectId":project.id,
        "cwd":fixture.repo,
        "title":"Replay",
        "members":[{"provider":"fixture"},{"provider":"fixture"}],
        "expectedRevision":0,
        "operationId":"create-replay"
    });
    let create = move |value: &Value| {
        create_calls.fetch_add(1, Ordering::SeqCst);
        create_chat(&db, &cwd, &project_id, value)
    };
    let first = group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.create",
        &request,
        &create,
    )
    .unwrap();
    let replay = group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.create",
        &request,
        &create,
    )
    .unwrap();
    assert_eq!(replay["id"], first["id"]);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.db.snapshot().unwrap().sessions.len(), 2);
    let rejected = group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.create",
        &json!({
            "projectId":project.id,
            "cwd":fixture.repo,
            "title":"Rejected",
            "members":[{"provider":"fixture"}],
            "expectedRevision":1,
            "operationId":"create-rejected"
        }),
        &|_| unreachable!("revision conflict must reject before creating a session"),
    )
    .unwrap_err();
    assert_eq!(rejected.to_string(), "revision_conflict");
    assert_eq!(fixture.db.snapshot().unwrap().sessions.len(), 2);
}

#[test]
fn create_can_link_an_existing_chat_as_a_member() {
    let fixture = Fixture::new();
    let source = fixture.standalone_chat("Source");
    let source_id = source["id"].as_str().unwrap().to_owned();
    let project = fixture.db.snapshot().unwrap().projects[0].clone();
    let group = group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.create",
        &json!({
            "projectId":project.id,
            "cwd":fixture.repo,
            "title":"Linked",
            "members":[{"provider":"fixture"}],
            "fromSessionId":source_id,
            "operationId":"link-source"
        }),
        &|_| unreachable!(),
    )
    .unwrap();
    assert_eq!(group["members"][0]["sessionId"], source_id);
}

#[test]
fn send_routes_only_to_selected_member_and_keeps_other_member_private() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    let first = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"Design the page","to":[first],"operationId":"send-one"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    assert_eq!(sent.session, group["members"][0]["sessionId"]);
    assert!(sent.prompt.contains("Design the page"));
    assert!(sent
        .prompt
        .contains("You only see messages addressed to you"));
    assert!(!sent.prompt.contains("group-chat-private"));
}

#[test]
fn direct_member_turn_never_creates_a_group_reply_or_delivery() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let session = group["members"][0]["sessionId"].as_str().unwrap();
    let before = fixture.read(id)["messages"].as_array().unwrap().len();
    for (kind, data) in [
        (
            "message.user",
            json!({"text":"private direct turn","operationId":"direct"}),
        ),
        ("chat.turn.started", json!({})),
        ("chat.delta", json!({"text":"private answer"})),
        ("chat.turn.completed", json!({"status":"completed"})),
    ] {
        fixture
            .db
            .record_provider_event(session, Some("direct-turn"), kind, &data)
            .unwrap();
        group_chat::provider_event(
            &fixture.db,
            &fixture.providers,
            &fixture.queues,
            &ProviderEvent {
                provider: "fixture".into(),
                session_id: session.into(),
                native_id: None,
                turn_id: Some("direct-turn".into()),
                kind: kind.into(),
                data,
                worker_token: None,
            },
        );
    }
    let after = fixture.read(id);
    assert_eq!(after["messages"].as_array().unwrap().len(), before);
    assert!(after["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["author"] != "member"));
}

#[test]
fn group_header_is_first_delivery_only_and_other_replies_require_an_explicit_reference() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    let first = group["members"][0]["handle"].as_str().unwrap();
    let second = group["members"][1]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"first task","to":[first],"operationId":"header-first"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let initial = fixture.script.lock().unwrap().sent[0].clone();
    assert!(initial.prompt.starts_with("[Group chat]"));
    fixture.complete(&initial, "secret from first member");
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"second task","to":[first],"operationId":"header-second"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    let follow_up = fixture.script.lock().unwrap().sent[1].clone();
    assert!(!follow_up.prompt.starts_with("[Group chat]"));
    fixture.complete(&follow_up, "done");
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"independent task","to":[second],"operationId":"private-second"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 3);
    assert!(!fixture.script.lock().unwrap().sent[2]
        .prompt
        .contains("secret from first member"));
    let private_second = fixture.script.lock().unwrap().sent[2].clone();
    fixture.complete(&private_second, "independent result");
    let state = fixture.read(id);
    let reply = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["author"] == "member" && message["body"] == "secret from first member"
        })
        .unwrap()["id"]
        .clone();
    fixture.dispatch("group.send", json!({"id":id,"text":"use the handoff","to":[second],"references":[{"kind":"reply","messageId":reply}],"operationId":"explicit-reference"}));
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 4);
    assert!(fixture.script.lock().unwrap().sent[3]
        .prompt
        .contains("secret from first member"));
}

#[test]
fn group_header_displays_windows_verbatim_paths_without_changing_stored_canonical_paths() {
    for (stored, displayed) in [
        (r"\\?\D:\workspace", r"D:\workspace"),
        (r"\\?\UNC\server\share\workspace", r"\\server\share\workspace"),
        (r"D:\workspace", r"D:\workspace"),
    ] {
        let fixture = Fixture::new();
        let group = fixture.create(1);
        let id = group["id"].as_str().unwrap();
        fixture.db.transaction(|tx| {
            let raw: String = tx.query_row("SELECT data FROM groups WHERE id=?", [id], |row| row.get(0))?;
            let mut value: Value = serde_json::from_str(&raw)?;
            value["cwd"] = json!(stored);
            tx.execute("UPDATE groups SET data=? WHERE id=?", params![value.to_string(), id])?;
            Ok(())
        }).unwrap();

        let handle = group["members"][0]["handle"].as_str().unwrap();
        fixture.dispatch("group.send", json!({"id":id,"text":"path task","to":[handle],"operationId":format!("path-{handle}")}));
        wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
        let prompt = &fixture.script.lock().unwrap().sent[0].prompt;
        assert!(prompt.contains(&format!("Shared folder: {displayed}")));
        assert!(!prompt.contains(stored) || stored == displayed);

        let canonical: Value = fixture.db.transaction(|tx| {
            let raw: String = tx.query_row("SELECT data FROM groups WHERE id=?", [id], |row| row.get(0))?;
            Ok(serde_json::from_str::<Value>(&raw)?["cwd"].clone())
        }).unwrap();
        assert_eq!(canonical, json!(stored));
    }
}

#[test]
fn all_routes_to_every_member_and_each_reply_is_linked_to_the_user_message() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"Make independent drafts","to":["all"],"operationId":"send-all"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    let sends = fixture.script.lock().unwrap().sent.clone();
    for (index, sent) in sends.iter().enumerate() {
        fixture.complete(sent, &format!("draft {index}"));
    }
    let state = fixture.read(id);
    let user = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["author"] == "user")
        .unwrap();
    assert!(user["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|delivery| delivery["state"] == "replied"));
    let replies = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["author"] == "member")
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    assert!(replies.iter().all(|reply| reply["replyTo"] == user["id"]));
}

#[test]
fn references_are_private_bounded_and_support_reply_message_file_and_url() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    let first = group["members"][0]["handle"].as_str().unwrap();
    let second = group["members"][1]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"Initial work","to":[first],"operationId":"initial"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let initial = fixture.script.lock().unwrap().sent[0].clone();
    fixture.complete(
        &initial,
        &format!("{}\nhttps://example.test/result", "x".repeat(10 * 1024)),
    );
    wait_for(|| {
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["author"] == "member")
    });
    let state = fixture.read(id);
    let user = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["author"] == "user")
        .unwrap();
    let reply = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["author"] == "member")
        .unwrap();
    wait_for(|| {
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["id"] == reply["id"])
            .is_some_and(|message| {
                message["outputs"]["urls"]
                    .as_array()
                    .is_some_and(|urls| urls.iter().any(|url| url == "https://example.test/result"))
            })
    });
    fixture.dispatch(
        "group.send",
        json!({
            "id":id,
            "text":"Review only the attached work",
            "to":[second],
            "references":[
                {"kind":"reply","messageId":reply["id"]},
                {"kind":"message","messageId":user["id"]},
                {"kind":"file","path":"base.txt"},
                {"kind":"url","url":"https://example.test/brief"}
            ],
            "operationId":"references"
        }),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    let sent = fixture.script.lock().unwrap().sent[1].clone();
    assert_eq!(sent.session, group["members"][1]["sessionId"]);
    assert!(sent.prompt.contains("## Referenced: @fixture's reply"));
    assert!(sent.prompt.contains("File base.txt"));
    assert!(sent.prompt.contains("https://example.test/brief"));
    assert!(sent.prompt.contains("https://example.test/result"));
    assert!(sent
        .prompt
        .contains("[shortened — ask the user for the rest]"));
    assert!(!sent.prompt.contains("Initial work\nInitial work"));
}

#[test]
fn group_delivery_does_not_intercept_the_fork_local_command() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"/fork","to":[handle],"operationId":"fork-delivery"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    assert!(fixture.script.lock().unwrap().sent[0]
        .prompt
        .contains("/fork"));
}

#[test]
fn busy_member_queues_private_follow_up_then_delivers_after_completion() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"first","to":[handle],"operationId":"first"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"second-private","to":[handle],"operationId":"second"}),
    );
    thread::sleep(Duration::from_millis(80));
    assert_eq!(fixture.script.lock().unwrap().sent.len(), 1);
    let first = fixture.script.lock().unwrap().sent[0].clone();
    fixture.complete(&first, "done");
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    assert!(fixture.script.lock().unwrap().sent[1]
        .prompt
        .contains("second-private"));
}

#[test]
fn failure_resend_stop_and_restart_are_explicit() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"recover","to":[handle],"operationId":"recover"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fixture
        .db
        .record_provider_event(
            &sent.session,
            Some(&sent.turn),
            "chat.turn.started",
            &json!({}),
        )
        .unwrap();
    fixture
        .db
        .record_provider_event(
            &sent.session,
            Some(&sent.turn),
            "chat.error",
            &json!({"message":"fixture failure"}),
        )
        .unwrap();
    group_chat::provider_event(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        &ProviderEvent {
            provider: "fixture".into(),
            session_id: sent.session.clone(),
            native_id: None,
            turn_id: Some(sent.turn.clone()),
            kind: "chat.error".into(),
            data: json!({"message":"fixture failure"}),
            worker_token: None,
        },
    );
    let failed = fixture.read(id);
    let message = failed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["author"] == "user")
        .unwrap();
    assert_eq!(message["deliveries"][0]["state"], "failed");
    fixture.dispatch(
        "group.resend",
        json!({"id":id,"messageId":message["id"],"handle":handle,"operationId":"resend"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    fixture.dispatch(
        "group.stop",
        json!({"id":id,"messageId":message["id"],"handle":handle,"operationId":"stop"}),
    );
    assert_eq!(
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["author"] == "user")
            .unwrap()["deliveries"][0]["state"],
        "stopped"
    );

    fixture
        .db
        .transaction(|tx| {
            tx.execute("UPDATE group_deliveries SET state='working'", [])?;
            Ok(())
        })
        .unwrap();
    group_chat::initialize(&fixture.db).unwrap();
    assert_eq!(
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["author"] == "user")
            .unwrap()["deliveries"][0]["state"],
        "failed"
    );
}

#[test]
fn approval_in_a_member_chat_marks_that_delivery_needs_user() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"needs approval","to":[handle],"operationId":"approval"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    wait_for(|| fixture.db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE session_id=? AND turn_id=? AND state='working')", params![sent.session, sent.turn], |row| row.get::<_, bool>(0))?)).unwrap());
    fixture
        .db
        .record_provider_event(
            &sent.session,
            Some(&sent.turn),
            "chat.approval",
            &json!({"approvalId":"fixture-approval","title":"Approve fixture"}),
        )
        .unwrap();
    assert_eq!(
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["author"] == "user")
            .unwrap()["deliveries"][0]["state"],
        "needs_user"
    );
}

#[test]
fn final_group_reply_uses_last_tool_event_not_tool_row_creation_order() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch("group.send", json!({"id":id,"text":"review and test","to":["fixture"],"operationId":"final-answer"}));
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    wait_for(|| fixture.db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE session_id=? AND turn_id=? AND state='working')", params![sent.session, sent.turn], |row| row.get::<_, bool>(0))?)).unwrap());
    for (kind, data) in [
        ("chat.delta", json!({"text":"First reading"})),
        ("chat.item", json!({"merge":true,"part":{"type":"tool","toolId":"read","status":"complete"}})),
        ("chat.delta", json!({"item":{"id":"seg18"},"text":"Next run tests"})),
        ("chat.item", json!({"merge":true,"part":{"type":"tool","toolId":"test","status":"complete"}})),
        ("chat.delta", json!({"item":{"id":"seg25"},"text":"Tests pass. No findings."})),
        ("chat.turn.completed", json!({"status":"completed"})),
    ] {
        fixture.db.record_provider_event(&sent.session, Some(&sent.turn), kind, &data).unwrap();
    }
    let result = fixture.read(id);
    let reply = result["messages"].as_array().unwrap().iter().find(|message| message["author"] == "member").unwrap();
    assert_eq!(reply["body"], "Tests pass. No findings.");
    let chat = fixture.db.chat_items(&sent.session).unwrap();
    for text in ["First reading", "Next run tests", "Tests pass. No findings."] {
        assert!(chat.iter().any(|item| item.parts.iter().any(|part| part["text"] == text)));
    }
    assert_eq!(fixture.db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM group_reply_cutoffs", [], |row| row.get::<_, i64>(0))?)).unwrap(), 0);
}

#[test]
fn unread_completed_member_is_idle_but_pending_question_is_needs_user() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch("group.send", json!({"id":id,"text":"answer","to":["fixture"],"operationId":"unread-reply"}));
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    wait_for(|| fixture.db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE session_id=? AND turn_id=?)", params![sent.session, sent.turn], |row| row.get::<_, bool>(0))?)).unwrap());
    fixture.db.record_provider_event(&sent.session, Some(&sent.turn), "chat.approval", &json!({"approvalId":"question","part":{"data":{"interaction":"question","runtimeOwned":true,"waitingForPrompt":true}}})).unwrap();
    assert_eq!(fixture.read(id)["members"][0]["state"], "needs_user");
    fixture.db.record_provider_event(&sent.session, Some(&sent.turn), "chat.approval.resolved", &json!({"approvalId":"question","status":"answered","returnToIdle":true})).unwrap();
    let resolved = fixture.read(id);
    assert_ne!(resolved["members"][0]["state"], "needs_user");
    assert_ne!(resolved["messages"][0]["deliveries"][0]["state"], "needs_user");
    fixture.db.record_provider_event(&sent.session, Some(&sent.turn), "chat.approval", &json!({"approvalId":"parent","part":{"data":{"delegation":{"route":"parent"}}}})).unwrap();
    assert_ne!(fixture.read(id)["members"][0]["state"], "needs_user");
    fixture.db.record_provider_event(&sent.session, Some(&sent.turn), "chat.approval.resolved", &json!({"approvalId":"parent","status":"resolved"})).unwrap();
    fixture.complete(&sent, "Done");
    assert_eq!(fixture.db.session_by_id(&sent.session).unwrap().unwrap().activity.unwrap().state, "awaiting_input");
    let completed = fixture.read(id);
    assert_eq!(completed["members"][0]["state"], "idle");
    assert_eq!(completed["messages"][0]["deliveries"][0]["state"], "replied");
}

#[test]
fn approval_only_boundary_omits_progress_from_the_group_answer() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch("group.send", json!({"id":id,"text":"question","to":["fixture"],"operationId":"approval-tail"}));
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    wait_for(|| fixture.db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE session_id=? AND turn_id=?)", params![sent.session, sent.turn], |row| row.get::<_, bool>(0))?)).unwrap());
    for (kind, data) in [
        ("chat.delta", json!({"text":"I need clarification"})),
        ("chat.approval", json!({"approvalId":"question","part":{"data":{"interaction":"question"}}})),
        ("chat.approval.resolved", json!({"approvalId":"question","status":"answered"})),
        ("chat.delta", json!({"item":{"id":"answer"},"text":"Final answer"})),
        ("chat.turn.completed", json!({"status":"completed"})),
    ] {
        fixture.db.record_provider_event(&sent.session, Some(&sent.turn), kind, &data).unwrap();
    }
    let result = fixture.read(id);
    assert_eq!(result["messages"].as_array().unwrap().iter().find(|message| message["author"] == "member").unwrap()["body"], "Final answer");
}

#[test]
fn stop_and_session_stop_clear_owned_capture_checkpoints() {
    for whole_session in [false, true] {
        let fixture = Fixture::new();
        let group = fixture.create(1);
        let id = group["id"].as_str().unwrap();
        let pending = fixture.dispatch("group.send", json!({"id":id,"text":"working","to":["fixture"],"operationId":"stop-checkpoint"}));
        wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
        let sent = fixture.script.lock().unwrap().sent[0].clone();
        wait_for(|| fixture.db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM group_deliveries WHERE session_id=? AND turn_id=?)", params![sent.session, sent.turn], |row| row.get::<_, bool>(0))?)).unwrap());
        fixture.db.record_provider_event(&sent.session, Some(&sent.turn), "chat.item", &json!({"part":{"type":"tool","toolId":"tool"}})).unwrap();
        let count = || fixture.db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM group_reply_cutoffs WHERE session_id=?", [&sent.session], |row| row.get::<_, i64>(0))?)).unwrap();
        assert_eq!(count(), 1);
        if whole_session { group_chat::session_stopped(&fixture.db, &sent.session).unwrap(); }
        else {
            let message = pending["messages"].as_array().unwrap().iter().find(|message| message["author"] == "user").unwrap();
            fixture.dispatch("group.stop", json!({"id":id,"messageId":message["id"],"operationId":"stop-capture"}));
        }
        assert_eq!(count(), 0);
    }
}

#[test]
fn member_crud_rename_and_archive_preserve_linked_chats() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let project = fixture.db.snapshot().unwrap().projects[0].clone();
    let db = Arc::clone(&fixture.db);
    let cwd = fixture.repo.clone();
    let project_id = project.id.clone();
    let added = fixture.dispatch_with_create(
        "group.member.add",
        json!({"id":id,"provider":"fixture","handle":"reviewer","operationId":"add"}),
        &move |value| create_chat(&db, &cwd, &project_id, value),
    );
    let session = added["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["handle"] == "reviewer")
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.dispatch(
        "group.send",
        json!({
            "id": id,
            "text": "remember reviewer",
            "to": ["reviewer"],
            "operationId": "seed-recipients"
        }),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let renamed = fixture.dispatch(
        "group.member.update",
        json!({"id":id,"sessionId":session,"handle":"critic","operationId":"update"}),
    );
    assert!(renamed["members"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["handle"] == "critic"));
    assert_eq!(renamed["lastRecipients"], json!(["critic"]));
    let historical = renamed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["author"] == "user")
        .unwrap();
    assert_eq!(historical["recipients"], json!(["reviewer"]));
    assert_eq!(
        fixture.dispatch(
            "group.rename",
            json!({"id":id,"title":"Renamed","operationId":"rename"})
        )["title"],
        "Renamed"
    );
    let removed = fixture.dispatch(
        "group.member.remove",
        json!({"id":id,"sessionId":session,"operationId":"remove"}),
    );
    assert!(removed["members"]
        .as_array()
        .unwrap()
        .iter()
        .all(|member| member["sessionId"] != session));
    assert_eq!(removed["lastRecipients"], json!([]));
    let historical = removed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["author"] == "user")
        .unwrap();
    assert_eq!(historical["recipients"], json!(["reviewer"]));
    let archived = fixture.dispatch("group.archive", json!({"id":id,"operationId":"archive"}));
    assert_eq!(archived["archived"], true);
    assert!(fixture.db.session_by_id(&session).unwrap().is_some());
}

#[test]
fn read_only_member_gets_reviewer_instruction_and_guard_reports_changes() {
    let fixture = Fixture::new();
    let group = fixture.create_with_members(
        vec![json!({"provider":"fixture","mode":"read_only"})],
        "Review group",
    );
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"inspect","to":[handle],"operationId":"review"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    assert!(sent.prompt.contains("Read-only reviewer"));
    fs::write(fixture.repo.join("base.txt"), "changed by fixture\n").unwrap();
    fixture
        .db
        .record_provider_event(
            &sent.session,
            Some(&sent.turn),
            "chat.item",
            &json!({"merge":true,"part":{"type":"tool","toolId":"fixture-edit","toolName":"Write","status":"completed","data":{"path":"base.txt"}}}),
        )
        .unwrap();
    fixture.complete(&sent, "review complete");
    wait_for(|| {
        fixture.read(id)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| {
                m["author"] == "system"
                    && m["body"].as_str().and_then(|body| serde_json::from_str::<Value>(body).ok())
                        .is_some_and(|notice| notice["kind"] == "read_only_files_changed" && notice["paths"] == json!(["base.txt"]))
            })
    });
    let state = fixture.read(id);
    let reply = state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["author"] == "member")
        .unwrap();
    assert_eq!(reply["outputs"]["changed"], json!(["base.txt"]));
}

#[test]
fn read_paginates_with_a_stable_cursor_and_rejects_unknown_cursor() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    for (index, operation) in ["page-one", "page-two"].iter().enumerate() {
        fixture.dispatch(
            "group.send",
            json!({"id":id,"text":format!("message {index}"),"to":[handle],"operationId":operation}),
        );
        wait_for(|| fixture.script.lock().unwrap().sent.len() == index + 1);
        let sent = fixture.script.lock().unwrap().sent[index].clone();
        fixture.complete(&sent, &format!("reply {index}"));
        wait_for(|| {
            fixture.read(id)["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["author"] == "member")
                .count()
                == index + 1
        });
    }
    let newest = fixture.dispatch("group.read", json!({"id":id,"limit":1}));
    assert_eq!(newest["messages"].as_array().unwrap().len(), 1);
    assert_eq!(newest["hasMore"], true);
    let cursor = newest["before"].as_str().unwrap();
    let older = fixture.dispatch("group.read", json!({"id":id,"limit":1,"before":cursor}));
    assert_eq!(older["messages"].as_array().unwrap().len(), 1);
    assert_ne!(older["messages"][0]["id"], newest["messages"][0]["id"]);
    assert!(group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.read",
        &json!({"id":id,"before":"unknown-message"}),
        &|_| unreachable!(),
    )
    .is_err());
}

#[test]
fn recipient_and_reference_bounds_reject_unknown_all_mixes_and_excess_entries() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    for (operation, recipients) in [
        ("unknown-recipient", json!(["unknown"])),
        ("all-mixed", json!(["all", handle])),
    ] {
        assert!(group_chat::dispatch(
            &fixture.db,
            &fixture.providers,
            &fixture.queues,
            "group.send",
            &json!({"id":id,"text":"invalid","to":recipients,"operationId":operation}),
            &|_| unreachable!(),
        )
        .is_err());
    }
    let references = (0..9)
        .map(|_| json!({"kind":"file","path":"base.txt"}))
        .collect::<Vec<_>>();
    assert!(group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.send",
        &json!({"id":id,"text":"invalid","to":[handle],"references":references,"operationId":"too-many-references"}),
        &|_| unreachable!(),
    )
    .is_err());
    assert!(group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.send",
        &json!({"id":id,"text":"invalid","to":[handle],"references":[{"kind":"url","url":"file:///not-allowed"}],"operationId":"invalid-reference"}),
        &|_| unreachable!(),
    )
    .is_err());
}

#[test]
fn archived_group_rejects_new_delivery() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    let handle = group["members"][0]["handle"].as_str().unwrap();
    fixture.dispatch(
        "group.archive",
        json!({"id":id,"operationId":"archive-reject"}),
    );
    assert!(group_chat::dispatch(
        &fixture.db,
        &fixture.providers,
        &fixture.queues,
        "group.send",
        &json!({"id":id,"text":"blocked","to":[handle],"operationId":"send-archived"}),
        &|_| unreachable!(),
    )
    .is_err());
}
