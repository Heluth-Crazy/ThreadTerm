use crate::{
    agent_review::{self, Scope, StartRequest},
    db::{CreateSession, Database},
    providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, Providers, TerminalCommand},
    review::ReviewFile,
    session_configs::{self, LaunchSpec},
    config::RuntimeConfig,
};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Barrier, Mutex, atomic::{AtomicUsize, Ordering}}, thread, time::Duration};

#[derive(Default)]
struct ChatLog { opens: Vec<String>, sends: Vec<String> }
struct Adapter { installed: bool, chat: bool, open_ok: bool, log: Arc<Mutex<ChatLog>> }

impl ProviderAdapter for Adapter {
    fn id(&self) -> &str { "reviewer" }
    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "fixture", plugin_id: None, icon: None, sign_in: None, homepage: None,
            id: "reviewer".into(), name: "Reviewer".into(), installed: self.installed,
            version: None, terminal: false, chat: self.chat, history: false, resume: false,
            terminal_resume_capture: "none", reason: None, auth: "authenticated".into(),
        }
    }
    fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> { Err(ProviderError::new("unsupported", "fixture")) }
    fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({"items":[]})) }
    fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
    fn open_chat(&self, _: &str, cwd: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.log.lock().unwrap().opens.push(cwd.into());
        if self.open_ok { Ok(Box::new(FixtureChat { log: Arc::clone(&self.log) })) } else { Err(ProviderError::new("unused", "not used by unit tests")) }
    }
}

struct FixtureChat { log: Arc<Mutex<ChatLog>> }
impl ChatSession for FixtureChat {
    fn native_id(&self) -> Option<String> { Some("fixture-review".into()) }
    fn send(&mut self, text: &str, _: &str) -> Result<Value, ProviderError> { self.log.lock().unwrap().sends.push(text.into()); Ok(json!({"turnId":"review-turn"})) }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
}

struct Fixture { root: tempfile::TempDir, db: Arc<Database>, providers: Arc<Providers>, log: Arc<Mutex<ChatLog>> }

impl Fixture {
    fn new(installed: bool, chat: bool) -> Self {
        Self::build(installed, chat, false)
    }
    fn with_open_chat(installed: bool, chat: bool) -> Self {
        Self::build(installed, chat, true)
    }
    fn build(installed: bool, chat: bool, open_ok: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        session_configs::initialize(&db).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        crate::review::initialize(&db).unwrap();
        agent_review::initialize(&db).unwrap();
        let log = Arc::new(Mutex::new(ChatLog::default()));
        Self { root, db, providers: Arc::new(Providers::for_test(vec![Arc::new(Adapter { installed, chat, open_ok, log: Arc::clone(&log) })])), log }
    }

    fn project_session(&self, repo: &Path, operation: &str) -> String {
        let project = self.db.add_project(&repo.to_string_lossy(), Some("repo"), &format!("project-{operation}")).unwrap();
        let session = self.db.create_session(CreateSession { project_id: Some(&project.id), title: Some("Implementation"), provider: "reviewer", mode: "chat", native_id: None, operation_id: operation }).unwrap();
        session_configs::save_new(&self.db, &session.id, &LaunchSpec { provider: "reviewer".into(), mode: "chat".into(), cwd: repo.to_string_lossy().into_owned(), project_id: Some(project.id), title: None, executable: None, args: vec![] }, None).unwrap();
        self.db.set_session_status(&session.id, "idle", None).unwrap();
        session.id
    }

    fn session(&self, cwd: &Path, operation: &str) -> String {
        let session = self.db.create_session(CreateSession { project_id: None, title: Some("Implementation"), provider: "reviewer", mode: "chat", native_id: None, operation_id: operation }).unwrap();
        session_configs::save_new(&self.db, &session.id, &LaunchSpec { provider: "reviewer".into(), mode: "chat".into(), cwd: cwd.to_string_lossy().into_owned(), project_id: None, title: None, executable: None, args: vec![] }, None).unwrap();
        self.db.set_session_status(&session.id, "idle", None).unwrap();
        session.id
    }

    fn review(&self, session: &str, reviewer: &str, state: &str, root: &Path) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.db.transaction(|tx| {
            tx.execute("INSERT INTO agent_reviews(id,session_id,reviewer_session_id,agent,scope_json,root,state,files,truncated_json,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'[]','built-in','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')", rusqlite::params![id,session,reviewer,"reviewer",json!({"kind":"uncommitted"}).to_string(),root.to_string_lossy(),state])?;
            Ok(())
        }).unwrap();
        id
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn git_output(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn repository(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "qa@example.test"]);
    git(&repo, &["config", "user.name", "QA"]);
    fs::write(repo.join("tracked.txt"), "old\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "initial"]);
    repo
}

fn code(error: anyhow::Error) -> String {
    error.downcast_ref::<ProviderError>().map(|error| error.code.clone()).unwrap_or_else(|| error.to_string())
}

#[test]
fn prompt_uses_repository_override_bounds_diffs_and_binaries() {
    let fixture = Fixture::new(true, true);
    let root = fixture.root.path();
    fs::create_dir(root.join(".threadterm")).unwrap();
    fs::write(root.join(".threadterm/review.md"), "Repository rules").unwrap();
    let oversized = "x".repeat(205 * 1024);
    let files = vec![
        ReviewFile { path: "a.rs".into(), status: "M".into(), diff: Some("small".into()), binary: false },
        ReviewFile { path: "image.png".into(), status: "M".into(), diff: Some(String::new()), binary: true },
        ReviewFile { path: "late.rs".into(), status: "M".into(), diff: Some(oversized), binary: false },
    ];
    let prompt = agent_review::build_prompt(root, "changes in session", &files);
    assert_eq!(prompt.instructions, "repository");
    assert!(prompt.text.contains("Repository rules") && prompt.text.contains("image.png (binary; not inlined)"));
    assert!(prompt.text.contains("### a.rs") && !prompt.text.contains("### image.png"));
    assert_eq!(prompt.truncated, vec!["late.rs"]);
    assert!(prompt.text.contains("```threadterm-review"));
    fs::write(root.join(".threadterm/review.md"), "x".repeat(64 * 1024 + 1)).unwrap();
    assert_eq!(agent_review::build_prompt(root, "uncommitted changes", &[]).instructions, "built-in");
}

#[test]
fn uncommitted_snapshot_contains_tracked_and_untracked_without_writing_index() {
    let fixture = Fixture::new(true, true);
    let repo = repository(fixture.root.path());
    let index_before = fs::read(repo.join(".git/index")).unwrap();
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    fs::write(repo.join("new.txt"), "new\n").unwrap();
    fs::write(repo.join("binary.bin"), [0, 1, 2]).unwrap();
    let files = agent_review::uncommitted_snapshot(&repo).unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["binary.bin", "new.txt", "tracked.txt"]);
    assert!(files.iter().find(|f| f.path == "new.txt").unwrap().diff.as_deref().unwrap().contains("new file mode"));
    assert!(files.iter().find(|f| f.path == "binary.bin").unwrap().binary);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index_before);
}

#[test]
fn snapshot_budget_omits_late_files_lists_binaries_and_keeps_large_unicode_untracked_text() {
    let fixture = Fixture::new(true, true);
    let repo = repository(fixture.root.path());
    fs::write(repo.join("binary.bin"), b"initial").unwrap();
    git(&repo, &["add", "binary.bin"]);
    git(&repo, &["commit", "-qm", "binary"]);
    fs::write(repo.join("a-large.txt"), "x".repeat(150 * 1024)).unwrap();
    fs::write(repo.join("z-suffix.txt"), "y".repeat(100 * 1024)).unwrap();
    fs::write(repo.join("binary.bin"), [0, 1, 2, 3]).unwrap();
    fs::write(repo.join("unicode.txt"), "界".repeat(80 * 1024)).unwrap();
    let files = agent_review::uncommitted_snapshot(&repo).unwrap();
    let unicode = files.iter().find(|file| file.path == "unicode.txt").unwrap();
    assert!(!unicode.binary, "a bounded multibyte read must not turn UTF-8 text into a binary file");
    let prompt = agent_review::build_prompt(&repo, "uncommitted", &files);
    assert!(prompt.truncated.iter().any(|path| path == "z-suffix.txt"));
    assert!(prompt.text.contains("binary.bin (binary; not inlined)"));
    assert!(!prompt.text.contains("### binary.bin"));
}

#[test]
fn expired_bounded_diff_returns_before_starting_git() {
    let root = tempfile::tempdir().unwrap();
    let deadline = std::time::Instant::now() - Duration::from_secs(1);
    assert_eq!(crate::review::bounded_unified_diff(root.path(), &["not-a-real-git-command"], &[], 128, deadline).unwrap(), None);
}

#[test]
fn checkpoint_and_current_snapshots_build_prompts_without_mutating_the_repository() {
    let fixture = Fixture::new(true, true);
    let repo = repository(fixture.root.path());
    let session = fixture.project_session(&repo, "project-session");
    let head = git_output(&repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let first = crate::review::dispatch(&fixture.db, "review.checkpoint", &json!({"sessionId":session,"kind":"manual","operationId":"checkpoint-one"})).unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    fs::write(repo.join("tracked.txt"), "second\n").unwrap();
    let second = crate::review::dispatch(&fixture.db, "review.checkpoint", &json!({"sessionId":session,"kind":"manual","operationId":"checkpoint-two"})).unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    fs::write(repo.join("tracked.txt"), "third\n").unwrap();
    let checkpoints = StartRequest { session_id: session.clone(), agent: "reviewer".into(), scope: Scope::Checkpoints { from: first, to: Some(second) }, operation_id: "checkpoint-review".into() };
    let (_, _, _, files, prompt) = agent_review::prepare(&fixture.db, &fixture.providers, &checkpoints).unwrap();
    assert_eq!(files.len(), 1);
    assert!(prompt.text.contains("Changes in session") && prompt.text.contains("second"));
    let uncommitted = StartRequest { session_id: session, agent: "reviewer".into(), scope: Scope::Uncommitted, operation_id: "current-review".into() };
    let (_, _, _, current, prompt) = agent_review::prepare(&fixture.db, &fixture.providers, &uncommitted).unwrap();
    assert_eq!(current.len(), 1);
    assert!(prompt.text.contains("Uncommitted changes against HEAD"));
    assert_eq!(git_output(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
}

#[test]
fn parser_keeps_last_fence_and_enforces_findings_contract() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("ok.rs"), "x\n").unwrap();
    let long_body = "x".repeat(4001);
    let answer = format!("prose\n```threadterm-review\n[]\n```\nmore\n```threadterm-review\n[{{\"severity\":\"high\",\"path\":\"ok.rs\",\"line\":2,\"title\":\" valid \",\"body\":\"{long_body}\"}},{{\"severity\":\"info\",\"path\":\"future/new.rs\",\"line\":1,\"title\":\"future\",\"body\":\"x\"}},{{\"severity\":\"bad\",\"title\":\"drop\",\"body\":\"x\"}},{{\"severity\":\"low\",\"path\":\"../bad\",\"line\":1,\"title\":\"general\",\"body\":\"x\"}}]\n```");
    let (findings, unparsed) = agent_review::parse_answer(root.path(), &answer);
    assert!(!unparsed);
    let findings = findings.unwrap();
    assert_eq!(findings.len(), 3);
    assert_eq!(findings[0]["path"], "ok.rs");
    assert_eq!(findings[0]["title"], "valid");
    assert!(findings[0]["body"].as_str().unwrap().ends_with('…'));
    assert_eq!(findings[1]["path"], "future/new.rs", "a contained path need not exist yet");
    assert!(findings[2].get("path").is_none() && findings[2].get("line").is_none());
    assert_eq!(agent_review::parse_answer(root.path(), "```threadterm-review\nnot json\n```"), (None, true));
}

#[test]
fn prepare_validation_order_and_active_limit_are_stable() {
    let fixture = Fixture::new(true, true);
    let missing = StartRequest { session_id: "missing".into(), agent: "unknown".into(), scope: Scope::Uncommitted, operation_id: "one".into() };
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &missing).unwrap_err()), "session_not_found");
    let cwd = fixture.root.path().join("plain"); fs::create_dir(&cwd).unwrap();
    let session = fixture.session(&cwd, "session");
    let request = |agent: &str, scope| StartRequest { session_id: session.clone(), agent: agent.into(), scope, operation_id: uuid::Uuid::new_v4().to_string() };
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &request("missing", Scope::Uncommitted)).unwrap_err()), "unknown_agent");
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &request("reviewer", Scope::Checkpoints { from: "missing".into(), to: None })).unwrap_err()), "checkpoint_not_found");
    let other = fixture.session(&cwd, "other-session");
    fixture.db.transaction(|tx| {
        tx.execute("INSERT INTO review_checkpoints(id,session_id,kind,status,skipped,created_at) VALUES('other-ready',?,'manual','ready','[]','2026-10-06T00:00:00Z')", [&other])?;
        tx.execute("INSERT INTO review_checkpoints(id,session_id,kind,status,skipped,created_at) VALUES('not-ready',?,'manual','starting','[]','2026-10-06T00:00:00Z')", [&session])?;
        Ok(())
    }).unwrap();
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &request("reviewer", Scope::Checkpoints { from: "other-ready".into(), to: None })).unwrap_err()), "checkpoint_not_found");
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &request("reviewer", Scope::Checkpoints { from: "not-ready".into(), to: None })).unwrap_err()), "checkpoint_not_found");
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &request("reviewer", Scope::Uncommitted)).unwrap_err()), "not_a_git_worktree");
    let repo = repository(fixture.root.path());
    let git_session = fixture.session(&repo, "git-session");
    let no_changes = StartRequest { session_id: git_session.clone(), agent: "reviewer".into(), scope: Scope::Uncommitted, operation_id: "empty".into() };
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &no_changes).unwrap_err()), "no_changes");
    for number in 0..3 { let reviewer = fixture.session(&repo, &format!("reviewer-{number}")); fixture.review(&git_session, &reviewer, "running", &repo); }
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let capped = StartRequest { session_id: git_session, agent: "reviewer".into(), scope: Scope::Uncommitted, operation_id: "capped".into() };
    assert_eq!(code(agent_review::prepare(&fixture.db, &fixture.providers, &capped).unwrap_err()), "agent_review_limit");
    let unavailable = Fixture::new(true, false);
    let unavailable_session = unavailable.session(&cwd, "unavailable-session");
    let unavailable_request = StartRequest { session_id: unavailable_session, agent: "reviewer".into(), scope: Scope::Uncommitted, operation_id: "unavailable".into() };
    assert_eq!(code(agent_review::prepare(&unavailable.db, &unavailable.providers, &unavailable_request).unwrap_err()), "agent_unavailable");
}

#[test]
fn dispatch_start_is_idempotent_and_fails_a_background_open_without_creating_on_empty() {
    let fixture = Fixture::new(true, true);
    let repo = repository(fixture.root.path());
    let session = fixture.session(&repo, "implementation");
    let no_changes = json!({"sessionId":session,"agent":"reviewer","scope":{"kind":"uncommitted"},"operationId":"empty-start"});
    let creates = Arc::new(AtomicUsize::new(0));
    let impossible = |_: &Value| -> anyhow::Result<Value> { creates.fetch_add(1, Ordering::SeqCst); panic!("empty review must not create a reviewer") };
    assert_eq!(code(agent_review::dispatch(&fixture.db, &fixture.providers, "agentReview.start", &no_changes, &impossible).unwrap_err()), "no_changes");
    assert_eq!(creates.load(Ordering::SeqCst), 0);

    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let params = json!({"sessionId":session,"agent":"reviewer","scope":{"kind":"uncommitted"},"operationId":"start-once"});
    let created = Arc::new(Mutex::new(None::<String>));
    let create_count = Arc::new(AtomicUsize::new(0));
    let create = |value: &Value| -> anyhow::Result<Value> {
        create_count.fetch_add(1, Ordering::SeqCst);
        let reviewer = fixture.db.create_session(CreateSession { project_id: None, title: value["title"].as_str(), provider: value["provider"].as_str().unwrap(), mode: value["mode"].as_str().unwrap(), native_id: None, operation_id: value["operationId"].as_str().unwrap() })?;
        session_configs::save_new(&fixture.db, &reviewer.id, &LaunchSpec { provider: "reviewer".into(), mode: "chat".into(), cwd: repo.to_string_lossy().into_owned(), project_id: None, title: None, executable: None, args: vec![] }, None)?;
        *created.lock().unwrap() = Some(reviewer.id.clone());
        Ok(json!({"id":reviewer.id}))
    };
    let first = agent_review::dispatch(&fixture.db, &fixture.providers, "agentReview.start", &params, &create).unwrap();
    let replay = agent_review::dispatch(&fixture.db, &fixture.providers, "agentReview.start", &params, &create).unwrap();
    assert_eq!(first["id"], replay["id"]);
    assert_eq!(create_count.load(Ordering::SeqCst), 1);
    let reviewer = created.lock().unwrap().clone().unwrap();
    let created_session = fixture.db.session_by_id(&reviewer).unwrap().unwrap();
    assert_eq!(created_session.title, "Review: Implementation");
    for _ in 0..50 {
        if agent_review::get(&fixture.db, first["id"].as_str().unwrap()).unwrap()["state"] == "failed" { break; }
        thread::sleep(Duration::from_millis(10));
    }
    let failed = agent_review::get(&fixture.db, first["id"].as_str().unwrap()).unwrap();
    assert_eq!(failed["state"], "failed");
    assert!(failed["error"].as_str().unwrap().contains("could not start"));
}

#[test]
fn list_lazily_parses_new_answers_and_mark_is_idempotent() {
    let fixture = Fixture::new(true, true);
    let root = fixture.root.path(); fs::write(root.join("file.rs"), "x\n").unwrap();
    let session = fixture.session(root, "implementation");
    let reviewer = fixture.session(root, "reviewer-session");
    let review = fixture.review(&session, &reviewer, "completed", root);
    fixture.db.record_provider_event(&reviewer, Some("turn-1"), "chat.item", &json!({"raw":{"params":{"item":{"id":"answer-1","type":"agentMessage","text":"```threadterm-review\n[{\"severity\":\"medium\",\"path\":\"file.rs\",\"line\":1,\"title\":\"first\",\"body\":\"body\"}]\n```"}}}})).unwrap();
    let first = agent_review::list(&fixture.db, &session).unwrap();
    let finding = first[0]["findings"][0].clone(); let finding_id = finding["id"].as_str().unwrap().to_owned();
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap()[0]["findings"][0]["id"], finding_id);
    let marked = agent_review::mark(&fixture.db, &json!({"reviewId":review,"findingIds":[finding_id],"state":"dismissed","operationId":"mark-1"})).unwrap();
    assert_eq!(marked["findings"][0]["state"], "dismissed");
    assert_eq!(agent_review::mark(&fixture.db, &json!({"reviewId":review,"findingIds":[finding_id],"state":"dismissed","operationId":"mark-1"})).unwrap()["findings"][0]["state"], "dismissed");
    assert_eq!(code(agent_review::mark(&fixture.db, &json!({"reviewId":review,"findingIds":["nope"],"state":"added","operationId":"mark-2"})).unwrap_err()), "finding_not_found");
    assert_eq!(code(agent_review::mark(&fixture.db, &json!({"reviewId":"missing","findingIds":[finding_id],"state":"added","operationId":"mark-missing"})).unwrap_err()), "review_not_found");
    assert_eq!(code(agent_review::mark(&fixture.db, &json!({"reviewId":review,"findingIds":[finding_id,"missing"],"state":"added","operationId":"mark-mixed"})).unwrap_err()), "finding_not_found");
    assert_eq!(agent_review::get(&fixture.db, &review).unwrap()["findings"][0]["state"], "dismissed", "a mixed mark has no partial write");
    fixture.db.record_provider_event(&reviewer, Some("turn-2"), "chat.item", &json!({"raw":{"params":{"item":{"id":"answer-2","type":"agentMessage","text":"```threadterm-review\n[{\"severity\":\"low\",\"title\":\"second\",\"body\":\"new\"}]\n```"}}}})).unwrap();
    let reparsed = agent_review::list(&fixture.db, &session).unwrap();
    assert_eq!(reparsed[0]["findings"][0]["title"], "second");
}

#[test]
fn completed_review_with_no_fence_is_marked_unparsed_once() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    fixture.review(&session, &reviewer, "completed", fixture.root.path());
    let before = fixture.db.events_after(0).unwrap().len();
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap()[0]["unparsed"], true);
    let after_first = fixture.db.events_after(0).unwrap().len();
    assert!(after_first > before);
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap()[0]["unparsed"], true);
    assert_eq!(fixture.db.events_after(0).unwrap().len(), after_first, "an unchanged bad answer is not reparsed or re-emitted");
}

#[test]
fn concurrent_lists_keep_stable_finding_ids_and_later_nontext_assistant_is_unparsed() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    let review = fixture.review(&session, &reviewer, "completed", fixture.root.path());
    fixture.db.transaction(|tx| {
        for (id, parts) in [
            ("answer", json!([{"type":"text","text":"```threadterm-review\n[{\"severity\":\"low\",\"title\":\"first\",\"body\":\"x\"}]\n```"}])),
            ("tool", json!([{"type":"tool","name":"read_file"}])),
            ("thinking", json!([{"type":"thinking","text":"considering"}])),
        ] {
            tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES(?,?,NULL,'message',?,'2026-10-06T00:00:00Z')", rusqlite::params![id, reviewer, json!({"id":id,"role":"assistant","parts":parts,"createdAt":"2026-10-06T00:00:00Z"}).to_string()])?;
        }
        Ok(())
    }).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let db = Arc::clone(&fixture.db); let session = session.clone(); let barrier = Arc::clone(&barrier);
        joins.push(thread::spawn(move || { barrier.wait(); agent_review::list(&db, &session).unwrap() }));
    }
    barrier.wait();
    for join in joins { assert_eq!(join.join().unwrap()[0]["unparsed"], true); }
    assert_eq!(agent_review::get(&fixture.db, &review).unwrap()["unparsed"], true);
}

#[test]
fn concurrent_lists_of_a_valid_answer_keep_one_stable_finding_id_for_marks() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    let review = fixture.review(&session, &reviewer, "completed", fixture.root.path());
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.item", &json!({"raw":{"params":{"item":{"id":"answer","type":"agentMessage","text":"```threadterm-review\n[{\"severity\":\"low\",\"title\":\"stable\",\"body\":\"x\"}]\n```"}}}})).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let db = Arc::clone(&fixture.db); let session = session.clone(); let barrier = Arc::clone(&barrier);
        joins.push(thread::spawn(move || { barrier.wait(); agent_review::list(&db, &session).unwrap()[0]["findings"][0]["id"].clone() }));
    }
    barrier.wait();
    let first = joins.pop().unwrap().join().unwrap();
    assert_eq!(joins.pop().unwrap().join().unwrap(), first);
    assert_eq!(agent_review::mark(&fixture.db, &json!({"reviewId":review,"findingIds":[first],"state":"added","operationId":"concurrent-mark"})).unwrap()["findings"][0]["state"], "added");
}

#[test]
fn projected_completed_turn_transitions_a_running_review_to_completed() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    fixture.review(&session, &reviewer, "running", fixture.root.path());
    fixture.db.record_provider_event(&reviewer, Some("turn"), "message.user", &json!({"text":"review"})).unwrap();
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.turn.started", &json!({})).unwrap();
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap()[0]["state"], "completed");
}

#[test]
fn completed_reviews_survive_later_stop_or_deletion_and_list_is_bounded() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    let review = fixture.review(&session, &reviewer, "running", fixture.root.path());
    fixture.db.record_provider_event(&reviewer, Some("turn"), "message.user", &json!({"text":"review"})).unwrap();
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.turn.started", &json!({})).unwrap();
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.item", &json!({"raw":{"params":{"item":{"id":"answer","type":"agentMessage","text":"```threadterm-review\n[{\"severity\":\"info\",\"title\":\"done\",\"body\":\"ok\"}]\n```"}}}})).unwrap();
    fixture.db.record_provider_event(&reviewer, Some("turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    fixture.db.set_session_status(&reviewer, "interrupted", None).unwrap();
    let completed = agent_review::list(&fixture.db, &session).unwrap();
    assert_eq!(completed[0]["id"], review);
    assert_eq!(completed[0]["state"], "completed");
    assert_eq!(completed[0]["findings"][0]["title"], "done");
    fixture.db.transaction(|tx| { tx.execute("DELETE FROM sessions WHERE id=?", [&reviewer])?; Ok(()) }).unwrap();
    let after_delete = agent_review::list(&fixture.db, &session).unwrap();
    assert_eq!(after_delete[0]["state"], "completed");
    assert_eq!(after_delete[0]["findings"][0]["title"], "done");
    for index in 0..21 {
        let reviewer = fixture.session(fixture.root.path(), &format!("extra-{index}"));
        fixture.review(&session, &reviewer, "failed", fixture.root.path());
    }
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap().as_array().unwrap().len(), 20);
}

#[test]
fn list_reconciles_an_active_review_even_when_it_is_older_than_the_visible_twenty() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "old-reviewer");
    let active = fixture.review(&session, &reviewer, "running", fixture.root.path());
    fixture.db.set_session_status(&reviewer, "error", None).unwrap();
    for index in 0..20 {
        let reviewer = fixture.session(fixture.root.path(), &format!("newer-{index}"));
        fixture.review(&session, &reviewer, "failed", fixture.root.path());
    }
    assert_eq!(agent_review::list(&fixture.db, &session).unwrap().as_array().unwrap().len(), 20);
    assert_eq!(agent_review::get(&fixture.db, &active).unwrap()["state"], "failed");
}

#[test]
fn successful_start_sends_the_snapshot_prompt_from_the_reviewed_cwd() {
    let fixture = Fixture::with_open_chat(true, true);
    let repo = repository(fixture.root.path());
    let session = fixture.session(&repo, "implementation");
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let create = |value: &Value| -> anyhow::Result<Value> {
        let reviewer = fixture.db.create_session(CreateSession { project_id: None, title: value["title"].as_str(), provider: "reviewer", mode: "chat", native_id: None, operation_id: value["operationId"].as_str().unwrap() })?;
        session_configs::save_new(&fixture.db, &reviewer.id, &LaunchSpec { provider: "reviewer".into(), mode: "chat".into(), cwd: repo.to_string_lossy().into_owned(), project_id: None, title: None, executable: None, args: vec![] }, None)?;
        Ok(json!({"id":reviewer.id}))
    };
    let started = agent_review::dispatch(&fixture.db, &fixture.providers, "agentReview.start", &json!({"sessionId":session,"agent":"reviewer","scope":{"kind":"uncommitted"},"operationId":"successful-start"}), &create).unwrap();
    for _ in 0..50 {
        if agent_review::get(&fixture.db, started["id"].as_str().unwrap()).unwrap()["state"] == "running" { break; }
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(agent_review::get(&fixture.db, started["id"].as_str().unwrap()).unwrap()["state"], "running");
    let log = fixture.log.lock().unwrap();
    assert_eq!(log.opens, vec![repo.to_string_lossy().into_owned()]);
    assert_eq!(log.sends.len(), 1);
    assert!(log.sends[0].contains("## Diffs") && log.sends[0].contains("tracked.txt"));
}

#[test]
fn deleted_reviewer_fails_and_never_gets_delegation_tools() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    let review = fixture.review(&session, &reviewer, "running", fixture.root.path());
    fixture.db.transaction(|tx| { tx.execute("DELETE FROM sessions WHERE id=?", [&reviewer])?; Ok(()) }).unwrap();
    let listed = agent_review::list(&fixture.db, &session).unwrap();
    assert_eq!(listed[0]["id"], review);
    assert_eq!(listed[0]["state"], "failed");
    assert!(listed[0]["error"].as_str().unwrap().contains("deleted"));
}

#[test]
fn errored_or_interrupted_reviewers_fail_before_completion() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    for (index, status) in ["error", "interrupted"].into_iter().enumerate() {
        let reviewer = fixture.session(fixture.root.path(), &format!("reviewer-{index}"));
        let review = fixture.review(&session, &reviewer, "running", fixture.root.path());
        fixture.db.set_session_status(&reviewer, status, None).unwrap();
        let listed = agent_review::list(&fixture.db, &session).unwrap();
        let row = listed.as_array().unwrap().iter().find(|row| row["id"] == review).unwrap();
        assert_eq!(row["state"], "failed");
        assert!(row["error"].as_str().unwrap().contains(status));
    }
}

#[test]
fn reviewer_sessions_do_not_receive_the_delegation_tool_server() {
    let fixture = Fixture::new(true, true);
    let session = fixture.session(fixture.root.path(), "implementation");
    let reviewer = fixture.session(fixture.root.path(), "reviewer");
    fixture.review(&session, &reviewer, "starting", fixture.root.path());
    let executable = fixture.root.path().join("threadterm-v3-mcp.exe");
    fs::write(&executable, []).unwrap();
    let resolver = crate::delegation::tool_server_resolver(
        Arc::clone(&fixture.db), Arc::new(crate::delegation::Delegations::default()),
        RuntimeConfig { data_dir: fixture.root.path().to_owned(), database_path: fixture.root.path().join("runtime.sqlite"), credential_path: fixture.root.path().join("credential"), pipe_base: "fixture-pipe".into() },
        Some(executable),
    );
    assert!(resolver(&reviewer, "grok").is_none(), "reviewers never get delegation tools");
}
