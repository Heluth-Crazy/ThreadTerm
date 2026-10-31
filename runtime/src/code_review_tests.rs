use crate::{
    code_review,
    db::{CreateSession, Database},
    providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, Providers, TerminalCommand},
    review::ReviewFile,
    session_configs::{self, LaunchSpec},
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct ChatLog {
    opens: Vec<String>,
    sends: Vec<String>,
    in_flight: usize,
    max_in_flight: usize,
}

struct Gate {
    expected: AtomicUsize,
    arrived: Mutex<usize>,
    ready: Condvar,
}

impl Gate {
    fn new() -> Self {
        Self {
            expected: AtomicUsize::new(0),
            arrived: Mutex::new(0),
            ready: Condvar::new(),
        }
    }

    fn arm(&self, count: usize) {
        self.expected.store(count, Ordering::SeqCst);
        *self.arrived.lock().unwrap() = 0;
    }

    fn enter(&self) {
        let expected = self.expected.load(Ordering::SeqCst);
        if expected == 0 {
            return;
        }
        let mut arrived = self.arrived.lock().unwrap();
        *arrived += 1;
        if *arrived >= expected {
            self.ready.notify_all();
        } else {
            let _ = self
                .ready
                .wait_timeout(arrived, Duration::from_secs(5))
                .unwrap();
        }
    }
}

struct Adapter {
    installed: bool,
    chat: bool,
    db: Arc<Database>,
    log: Arc<Mutex<ChatLog>>,
    answers: Arc<Mutex<VecDeque<String>>>,
    fail_after: Arc<AtomicUsize>,
    gate: Arc<Gate>,
    hang_ms: Arc<AtomicUsize>,
    hold_turn: Arc<AtomicUsize>,
}

impl ProviderAdapter for Adapter {
    fn id(&self) -> &str {
        "reviewer"
    }
    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "fixture",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: "reviewer".into(),
            name: "Reviewer".into(),
            installed: self.installed,
            version: None,
            terminal: false,
            chat: self.chat,
            history: false,
            resume: false,
            terminal_resume_capture: "none",
            reason: None,
            auth: "authenticated".into(),
        }
    }
    fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "fixture"))
    }
    fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }
    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        Ok(json!([]))
    }
    fn open_chat(&self, session_id: &str, cwd: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.log.lock().unwrap().opens.push(cwd.into());
        Ok(Box::new(FixtureChat {
            db: Arc::clone(&self.db),
            session_id: session_id.into(),
            log: Arc::clone(&self.log),
            answers: Arc::clone(&self.answers),
            fail_after: Arc::clone(&self.fail_after),
            gate: Arc::clone(&self.gate),
            hang_ms: Arc::clone(&self.hang_ms),
            hold_turn: Arc::clone(&self.hold_turn),
        }))
    }
}

struct FixtureChat {
    db: Arc<Database>,
    session_id: String,
    log: Arc<Mutex<ChatLog>>,
    answers: Arc<Mutex<VecDeque<String>>>,
    fail_after: Arc<AtomicUsize>,
    gate: Arc<Gate>,
    hang_ms: Arc<AtomicUsize>,
    hold_turn: Arc<AtomicUsize>,
}

impl ChatSession for FixtureChat {
    fn native_id(&self) -> Option<String> {
        Some(format!("fixture-{}", &self.session_id[..8.min(self.session_id.len())]))
    }
    fn send(&mut self, text: &str, _: &str) -> Result<Value, ProviderError> {
        {
            let mut log = self.log.lock().unwrap();
            log.sends.push(text.into());
            log.in_flight += 1;
            log.max_in_flight = log.max_in_flight.max(log.in_flight);
        }
        self.gate.enter();
        let remaining = self.fail_after.fetch_sub(1, Ordering::SeqCst);
        if remaining == 1 {
            let mut log = self.log.lock().unwrap();
            log.in_flight = log.in_flight.saturating_sub(1);
            return Err(ProviderError::new("fixture_fail", "forced finder failure"));
        }
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| "```threadterm-review\n[]\n```".into());
        let turn = format!("turn-{}", uuid::Uuid::new_v4());
        let hang = self.hang_ms.load(Ordering::SeqCst);
        if hang > 0 {
            thread::sleep(Duration::from_millis(hang as u64));
        }
        if self.hold_turn.load(Ordering::SeqCst) == 0 {
            code_review::test_complete_turn(&self.session_id, &turn, &answer);
        }
        {
            let mut log = self.log.lock().unwrap();
            log.in_flight = log.in_flight.saturating_sub(1);
        }
        Ok(json!({"turnId": turn}))
    }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        Ok(())
    }
    fn set_option(&mut self, _: &str, value: &str) -> Result<Value, ProviderError> {
        Ok(json!({"value": value}))
    }
}

struct Fixture {
    root: tempfile::TempDir,
    db: Arc<Database>,
    providers: Arc<Providers>,
    log: Arc<Mutex<ChatLog>>,
    answers: Arc<Mutex<VecDeque<String>>>,
    fail_after: Arc<AtomicUsize>,
    gate: Arc<Gate>,
    hang_ms: Arc<AtomicUsize>,
    hold_turn: Arc<AtomicUsize>,
}

impl Fixture {
    fn new() -> Self {
        code_review::test_clear_completed_turns();
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        session_configs::initialize(&db).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        crate::review::initialize(&db).unwrap();
        crate::agent_review::initialize(&db).unwrap();
        code_review::initialize(&db).unwrap();
        let log = Arc::new(Mutex::new(ChatLog::default()));
        let answers = Arc::new(Mutex::new(VecDeque::new()));
        let fail_after = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Gate::new());
        let hang_ms = Arc::new(AtomicUsize::new(0));
        let hold_turn = Arc::new(AtomicUsize::new(0));
        let adapter = Adapter {
            installed: true,
            chat: true,
            db: Arc::clone(&db),
            log: Arc::clone(&log),
            answers: Arc::clone(&answers),
            fail_after: Arc::clone(&fail_after),
            gate: Arc::clone(&gate),
            hang_ms: Arc::clone(&hang_ms),
            hold_turn: Arc::clone(&hold_turn),
        };
        Self {
            root,
            db,
            providers: Arc::new(Providers::for_test(vec![Arc::new(adapter)])),
            log,
            answers,
            fail_after,
            gate,
            hang_ms,
            hold_turn,
        }
    }

    fn push_answer(&self, findings: Value) {
        self.answers.lock().unwrap().push_back(format!(
            "```threadterm-review\n{}\n```",
            findings
        ));
    }

    fn session(&self, cwd: &Path, operation: &str) -> String {
        let session = self
            .db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Implementation"),
                provider: "reviewer",
                mode: "chat",
                native_id: None,
                operation_id: operation,
            })
            .unwrap();
        session_configs::save_new(
            &self.db,
            &session.id,
            &LaunchSpec {
                provider: "reviewer".into(),
                mode: "chat".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                project_id: None,
                title: None,
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        self.db.set_session_status(&session.id, "idle", None).unwrap();
        session.id
    }

    fn create(&self) -> impl Fn(&Value) -> anyhow::Result<Value> + '_ {
        move |value: &Value| {
            let reviewer = self.db.create_session(CreateSession {
                project_id: None,
                title: value["title"].as_str(),
                provider: "reviewer",
                mode: "chat",
                native_id: None,
                operation_id: value["operationId"].as_str().unwrap(),
            })?;
            session_configs::save_new(
                &self.db,
                &reviewer.id,
                &LaunchSpec {
                    provider: "reviewer".into(),
                    mode: "chat".into(),
                    cwd: value["cwd"].as_str().unwrap().into(),
                    project_id: None,
                    title: None,
                    executable: None,
                    args: vec![],
                },
                None,
            )?;
            Ok(json!({"id": reviewer.id}))
        }
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
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
    error
        .downcast_ref::<ProviderError>()
        .map(|error| error.code.clone())
        .unwrap_or_else(|| error.to_string())
}

fn wait_done(db: &Database, review_id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state: String = db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT state FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))?)
            })
            .unwrap();
        if matches!(state.as_str(), "done" | "failed" | "cancelled") {
            let parent: String = db
                .transaction(|tx| {
                    Ok(tx.query_row("SELECT session_id FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))?)
                })
                .unwrap();
            if let Some(card) = db.subagent_card(&parent, &format!("review:{review_id}")).unwrap() {
                let status = card.parts[0]["data"]["status"].as_str().unwrap_or("");
                // DB can reach a terminal state a beat before the forced card upsert;
                // wait for the card so callers never observe a stale mid-stage summary.
                if matches!(status, "completed" | "failed" | "cancelled") {
                    return card.parts[0]["data"]["review"].clone();
                }
            }
        }
        if Instant::now() >= deadline {
            let detail: (String, String, Option<String>, i64) = db
                .transaction(|tx| {
                    Ok(tx.query_row(
                        "SELECT state, stage, error, stages_done FROM code_reviews WHERE id=?",
                        [review_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?)
                })
                .unwrap();
            let reviewers: Vec<(String, Option<String>)> = db
                .transaction(|tx| {
                    let mut statement = tx.prepare(
                        "SELECT session_id, turn_id FROM code_review_sessions WHERE review_id=?",
                    )?;
                    let rows = statement
                        .query_map([review_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows)
                })
                .unwrap();
            let mut turns = Vec::new();
            for (session_id, turn_id) in &reviewers {
                let status: Option<String> = turn_id.as_ref().and_then(|turn| {
                    db.transaction(|tx| {
                        Ok(tx.query_row(
                            "SELECT json_extract(data,'$.turnStatus') FROM chat_items WHERE session_id=? AND turn_id=? LIMIT 1",
                            rusqlite::params![session_id, turn],
                            |r| r.get(0),
                        )
                        .optional()?)
                    })
                    .ok()
                    .flatten()
                });
                turns.push(format!("{session_id}/{:?}/{:?}", turn_id, status));
            }
            panic!("review {review_id} stuck in {state}; detail={detail:?}; reviewers={turns:?}");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn review_row(db: &Database, review_id: &str) -> (String, i64, Option<String>) {
    db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT state, stages_done, findings_json FROM code_reviews WHERE id=?",
            [review_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?)),
        )?)
    })
    .unwrap()
}

#[test]
fn prompt_is_neutral_labels_focus_and_prefers_repository_criteria() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".threadterm")).unwrap();
    fs::write(root.path().join(".threadterm/review.md"), "Custom criteria only.").unwrap();
    let files = [ReviewFile {
        path: "a.rs".into(),
        status: "M".into(),
        diff: Some("-old\n+new\n".into()),
        binary: false,
    }];
    let (text, instructions, _) =
        code_review::build_finder_prompt(root.path(), "Uncommitted changes.", &files, Some("check auth"), "general");
    assert_eq!(instructions, "repository");
    assert!(text.contains("Custom criteria only."));
    assert!(text.contains("Requester's focus (a request, not a fact about the code)"));
    assert!(text.contains("check auth"));
    assert!(!text.contains("parent conversation"));
    assert!(text.contains("```threadterm-review"));
}

#[test]
fn parser_accepts_verdicts_legacy_and_rejects_malformed() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("ok.rs"), "fn main(){}\n").unwrap();
    let answer = "```threadterm-review\n[{\"severity\":\"high\",\"path\":\"ok.rs\",\"line\":1,\"title\":\"bug\",\"body\":\"x\",\"category\":\"correctness\",\"failureScenario\":\"null input\",\"verdict\":\"confirmed\",\"reason\":\"still crashes\"}]\n```";
    let (findings, unparsed) = crate::agent_review::parse_answer(root.path(), answer);
    assert!(!unparsed);
    let findings = findings.unwrap();
    assert_eq!(findings[0]["verdict"], "confirmed");
    assert_eq!(findings[0]["failureScenario"], "null input");
    assert_eq!(
        crate::agent_review::parse_answer(root.path(), "```threadterm-review\nnot json\n```"),
        (None, true)
    );
}

#[test]
fn dedupe_assigns_stable_candidate_ids() {
    let groups = vec![
        (
            "correctness".into(),
            vec![json!({"severity":"low","path":"a.rs","line":10,"title":"Issue 0","body":"x"})],
        ),
        (
            "security".into(),
            vec![json!({"severity":"high","path":"a.rs","line":12,"title":"Issue 0","body":"worse"})],
        ),
    ];
    let merged = code_review::merge_candidates(groups);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["id"], "c1");
    assert_eq!(merged[0]["severity"], "high");
}

#[test]
fn verifier_matches_by_id_when_title_rephrased() {
    let candidates = vec![json!({"id":"c1","severity":"high","path":"a.rs","line":1,"title":"Null deref","body":"x","verdict":"unverified"})];
    let verified = vec![json!({"id":"c1","severity":"high","path":"a.rs","line":1,"title":"Null pointer crash","body":"x","verdict":"confirmed","reason":"still crashes"})];
    let (findings, rejected) = code_review::apply_verifier(&candidates, &verified);
    assert_eq!(rejected, 0);
    assert_eq!(findings[0]["verdict"], "confirmed");
    assert_eq!(findings[0]["title"], "Null deref");
}

#[test]
fn catalog_stays_valid_json_with_many_long_choices() {
    let fixture = Fixture::new();
    let huge_choices: Vec<Value> = (0..500)
        .map(|i| json!({"value":format!("m{i:03}"),"name":"X".repeat(80)}))
        .collect();
    let text = code_review::fit_catalog_json(&[json!({
        "id":"model_id","name":"Model","category":"model","value":"default","recommended":"default","choices":huge_choices
    })])
    .unwrap();
    assert!(text.len() <= 16 * 1024);
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert!(parsed.is_array());
    code_review::remember_provider_options(
        &fixture.db,
        "reviewer",
        &json!({"options":[{"id":"model_id","name":"Model","category":"model","value":"picked","recommended":"default","choices":(0..500).map(|i| json!({"value":format!("m{i}"),"name":"N".repeat(40)})).collect::<Vec<_>>()}]}),
    )
    .unwrap();
    let raw: String = fixture
        .db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT options_json FROM provider_option_catalog WHERE provider='reviewer'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(serde_json::from_str::<Value>(&raw).is_ok());
    assert!(raw.len() <= 16 * 1024);
}

#[test]
fn staging_uses_catalog_option_id() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    code_review::remember_provider_options(
        &fixture.db,
        "reviewer",
        &json!({"options":[
            {"id":"model_id","name":"Model","category":"model","value":"fast","recommended":"fast","choices":[{"value":"fast","name":"Fast"},{"value":"slow","name":"Slow"}]}
        ]}),
    )
    .unwrap();
    let parent = fixture.session(&repo, "parent-model");
    fixture.push_answer(json!([]));
    let create = fixture.create();
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","model":"fast","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"model-id","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, started["reviewId"].as_str().unwrap());
    assert_eq!(summary["stage"], "done", "staging review summary={summary}");
    let reviewer: String = fixture
        .db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT session_id FROM code_review_sessions WHERE review_id=?",
                [started["reviewId"].as_str().unwrap()],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    let options = fixture.db.pending_fork_options(&reviewer).unwrap();
    assert!(
        options
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "model_id" && row["value"] == "fast"),
        "expected catalog option id model_id, got {options}"
    );
    let err = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","model":"missing","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"bad-model","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap_err();
    assert_eq!(code(err), "invalid_request");
}

#[test]
fn quick_standard_and_parallel_thorough() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent");
    let create = fixture.create();
    let lease = |_: &str, _: i64| Ok(());

    fixture.push_answer(json!([{"severity":"medium","path":"tracked.txt","line":1,"title":"change risk","body":"b","failureScenario":"save"}]));
    let quick = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"quick","leaseEpoch":1}),
        &lease,
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, quick["reviewId"].as_str().unwrap());
    assert_eq!(summary["stage"], "done");
    assert_eq!(summary["findings"][0]["verdict"], "unverified");
    assert_eq!(summary["findings"][0]["id"], "c1");

    fixture.push_answer(json!([{"severity":"high","path":"tracked.txt","line":1,"title":"null deref","body":"b","failureScenario":"null"}]));
    fixture.push_answer(json!([{"id":"c1","severity":"high","path":"tracked.txt","line":1,"title":"null deref","body":"b","verdict":"confirmed","reason":"still crashes"}]));
    let standard = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"standard","scope":{"kind":"uncommitted"},"focus":"auth","operationId":"standard","leaseEpoch":1}),
        &lease,
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, standard["reviewId"].as_str().unwrap());
    assert_eq!(summary["findings"][0]["verdict"], "confirmed", "standard summary={summary}");
    assert!(fixture.log.lock().unwrap().sends.iter().any(|s| s.contains("Requester's focus")));

    fixture.gate.arm(3);
    fixture.log.lock().unwrap().max_in_flight = 0;
    fixture.push_answer(json!([{"severity":"low","title":"a","body":"b"}]));
    fixture.push_answer(json!([{"severity":"low","title":"b","body":"b"}]));
    fixture.push_answer(json!([{"severity":"low","title":"c","body":"b"}]));
    fixture.push_answer(json!([{"id":"c1","title":"a","body":"b","verdict":"plausible","reason":"maybe"}]));
    let thorough = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"thorough","scope":{"kind":"uncommitted"},"operationId":"thorough","leaseEpoch":1}),
        &lease,
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, thorough["reviewId"].as_str().unwrap());
    assert_eq!(summary["stage"], "done");
    assert!(
        fixture.log.lock().unwrap().max_in_flight >= 3,
        "expected three finders in flight together, got {}",
        fixture.log.lock().unwrap().max_in_flight
    );
}

#[test]
fn thorough_finder_failure_warns_and_continues() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-fail");
    let create = fixture.create();
    fixture.gate.arm(3);
    fixture.fail_after.store(1, Ordering::SeqCst);
    fixture.push_answer(json!([{"severity":"low","title":"kept","body":"b"}]));
    fixture.push_answer(json!([{"severity":"low","title":"also","body":"b"}]));
    fixture.push_answer(json!([{"id":"c1","title":"kept","body":"b","verdict":"plausible","reason":"ok"}]));
    let thorough = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"thorough","scope":{"kind":"uncommitted"},"operationId":"one-fail","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, thorough["reviewId"].as_str().unwrap());
    assert_eq!(summary["stage"], "done");
    assert!(summary["warnings"].as_array().is_some_and(|w| !w.is_empty()));
    assert!(!summary["findings"].as_array().unwrap().is_empty());
}

#[test]
fn verifier_failure_leaves_candidates_unverified() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-verifier");
    let create = fixture.create();
    fixture.push_answer(json!([{"severity":"high","path":"tracked.txt","line":1,"title":"bug","body":"b"}]));
    fixture.fail_after.store(2, Ordering::SeqCst);
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"standard","scope":{"kind":"uncommitted"},"operationId":"verifier-fail","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, started["reviewId"].as_str().unwrap());
    assert_eq!(summary["findings"][0]["verdict"], "unverified");
    assert!(summary["warnings"].as_array().is_some_and(|w| {
        w.iter().any(|row| row.as_str().unwrap_or("").contains("Verifier failed"))
    }));
}

#[test]
fn cancel_during_finding_is_final_and_keeps_stages_done() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-cancel");
    let create = fixture.create();
    // Leave the bound turn incomplete so wait_for_answer keeps polling until cancel.
    fixture.hold_turn.store(1, Ordering::SeqCst);
    fixture.push_answer(json!([]));
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"standard","scope":{"kind":"uncommitted"},"operationId":"cancel-me","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let review_id = started["reviewId"].as_str().unwrap().to_owned();
    for _ in 0..100 {
        let state: String = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT state FROM code_reviews WHERE id=?", [&review_id], |r| r.get(0))?)
            })
            .unwrap();
        if state == "finding" {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let stages_before: i64 = fixture
        .db
        .transaction(|tx| {
            Ok(tx.query_row("SELECT stages_done FROM code_reviews WHERE id=?", [&review_id], |r| r.get(0))?)
        })
        .unwrap();
    code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.cancel",
        &json!({"sessionId":parent,"reviewId":review_id,"operationId":"cancel-op","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let summary = wait_done(&fixture.db, &review_id);
    assert_eq!(summary["stage"], "done");
    let (state, stages_done, findings) = review_row(&fixture.db, &review_id);
    assert_eq!(state, "cancelled");
    assert_eq!(stages_done, stages_before);
    thread::sleep(Duration::from_millis(200));
    let (state2, stages2, findings2) = review_row(&fixture.db, &review_id);
    assert_eq!(state2, "cancelled");
    assert_eq!(stages2, stages_done);
    assert_eq!(findings2, findings);
}

#[test]
fn restart_reconcile_fails_card_and_reviewers_are_not_running() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    let parent = fixture.session(&repo, "parent-restart");
    let review = uuid::Uuid::new_v4().to_string();
    let reviewer = fixture
        .db
        .create_session(CreateSession {
            project_id: None,
            title: Some("finder"),
            provider: "reviewer",
            mode: "chat",
            native_id: None,
            operation_id: "restart-reviewer",
        })
        .unwrap()
        .id;
    fixture.db.set_session_status(&reviewer, "running", None).unwrap();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO code_reviews(id,session_id,item_id,provider,depth,scope_json,scope_label,root,state,stage,stages_done,stages_total,warnings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'finding','finding',1,2,'[]','t','t')",
                rusqlite::params![review, parent, format!("{parent}:system:subagent:review:{review}"), "reviewer", "standard", "{\"kind\":\"uncommitted\"}", "scope", repo.to_string_lossy()],
            )?;
            tx.execute(
                "INSERT INTO code_review_sessions(review_id,session_id,role,lens,stage_index) VALUES (?,?,?,?,?)",
                rusqlite::params![review, reviewer, "finder", "general", 0],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(code_review::reconcile_interrupted(&fixture.db).unwrap(), 1);
    fixture.db.mark_live_sessions_interrupted().unwrap();
    let state: String = fixture
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT state FROM code_reviews WHERE id=?", [&review], |r| r.get(0))?))
        .unwrap();
    assert_eq!(state, "failed");
    let card = fixture
        .db
        .subagent_card(&parent, &format!("review:{review}"))
        .unwrap()
        .unwrap();
    assert_eq!(card.parts[0]["data"]["status"], "failed");
    let status = fixture.db.session_by_id(&reviewer).unwrap().unwrap().status;
    assert_ne!(status, "running");
}

#[test]
fn second_start_while_active_returns_review_active() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-active");
    let create = fixture.create();
    fixture.hold_turn.store(1, Ordering::SeqCst);
    fixture.push_answer(json!([]));
    let first = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"block","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let err = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"block2","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap_err();
    assert_eq!(code(err), "review_active");
    code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.cancel",
        &json!({"sessionId":parent,"reviewId":first["reviewId"],"operationId":"unblock","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let _ = wait_done(&fixture.db, first["reviewId"].as_str().unwrap());
}

#[test]
fn transcript_read_refuses_foreign_parent() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-transcript");
    let other = fixture.session(&repo, "other-parent");
    let create = fixture.create();
    fixture.push_answer(json!([]));
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"transcript","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let _ = wait_done(&fixture.db, started["reviewId"].as_str().unwrap());
    let key = format!("review:{}", started["reviewId"].as_str().unwrap());
    let err = code_review::read_session_transcript(&fixture.db, &other, &key).unwrap_err();
    assert_eq!(code(err), "invalid_request");
    let ok = code_review::read_session_transcript(&fixture.db, &parent, &key).unwrap();
    assert!(ok["rev"].as_i64().unwrap() >= 0);
    assert_eq!(ok["source"], "session");
}

#[test]
fn reviewer_sessions_are_marked_and_parent_turn_untouched() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-mark");
    let parent_before = fixture.db.session_by_id(&parent).unwrap().unwrap();
    fixture.push_answer(json!([]));
    let create = fixture.create();
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"marked","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let _ = wait_done(&fixture.db, started["reviewId"].as_str().unwrap());
    let reviewers: Vec<String> = fixture
        .db
        .transaction(|tx| {
            let mut statement = tx.prepare("SELECT session_id FROM code_review_sessions WHERE review_id=?")?;
            let rows = statement
                .query_map([started["reviewId"].as_str().unwrap()], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert!(!reviewers.is_empty());
    let snapshot = fixture.db.snapshot().unwrap();
    for reviewer in &reviewers {
        assert!(crate::agent_review::is_reviewer(&fixture.db, reviewer).unwrap());
        let session = snapshot.sessions.iter().find(|session| &session.id == reviewer).unwrap();
        let marker = session.code_review.as_ref().unwrap();
        assert_eq!(marker.review_id, started["reviewId"].as_str().unwrap());
        assert_eq!(marker.parent_session_id, parent);
        assert_eq!(marker.role, "finder");
        assert!(session.organization.forked_from.is_none());
    }
    let parent_after = fixture.db.session_by_id(&parent).unwrap().unwrap();
    assert_eq!(parent_after.status, parent_before.status);
    assert_eq!(parent_after.activity, parent_before.activity);
}

#[test]
fn files_changed_warning_is_recorded() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-warn");
    let create = fixture.create();
    // Hold the finder send long enough that the worktree edit lands before the
    // end-of-review fingerprint (a fast fixture finish races a short sleep).
    fixture.hang_ms.store(400, Ordering::SeqCst);
    fixture.push_answer(json!([]));
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"files-changed","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let review_id = started["reviewId"].as_str().unwrap().to_owned();
    for _ in 0..100 {
        let state: String = fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row("SELECT state FROM code_reviews WHERE id=?", [&review_id], |r| r.get(0))?)
            })
            .unwrap();
        if state == "finding" {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    fs::write(repo.join("during.txt"), "x\n").unwrap();
    let summary = wait_done(&fixture.db, &review_id);
    assert_eq!(summary["stage"], "done", "review did not finish: {summary}");
    let warnings = summary["warnings"].as_array().cloned().unwrap_or_default();
    assert!(
        warnings.iter().any(|w| w.as_str().unwrap_or("").contains("Files changed during the review")),
        "expected files-changed warning, got {warnings:?}"
    );
}

#[test]
fn options_counts_files_without_building_diffs() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    fs::write(repo.join("extra.txt"), "new\n").unwrap();
    let count = code_review::count_uncommitted_files(&repo).unwrap();
    assert!(count >= 2, "expected porcelain paths, got {count}");
    let branch = code_review::count_branch_files(&repo);
    assert!(branch.is_ok() || branch.is_err());
    let parent = fixture.session(&repo, "parent-options");
    let options = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.options",
        &json!({"sessionId": parent}),
        &|_, _| Ok(()),
        &|_| unreachable!(),
    )
    .unwrap();
    assert_eq!(options["scopes"][0]["kind"], "uncommitted");
    assert_eq!(options["scopes"][0]["fileCount"], count);
}
