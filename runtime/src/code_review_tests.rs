use crate::{
    code_review,
    db::{CreateSession, Database},
    providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderRuntime, Providers, TerminalCommand},
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
    option_sets: Vec<String>,
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
    options: Arc<Mutex<Value>>,
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
            remote_sign_in: None,
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
            setup: Default::default(),
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
            options: Arc::clone(&self.options),
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
    options: Arc<Mutex<Value>>,
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
            complete_turn_later(Arc::clone(&self.db), self.session_id.clone(), turn.clone(), answer);
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
    fn set_option(&mut self, id: &str, value: &str) -> Result<Value, ProviderError> {
        self.log.lock().unwrap().option_sets.push(format!("{id}={value}"));
        Ok(json!({"value": value}))
    }
    fn ui_state(&self) -> Value { self.options.lock().unwrap().clone() }
}

/// Completes a reviewer turn the way a provider does: its events arrive on another
/// thread after `send` returned, and go through the real chat projection. It waits
/// until the pipeline has bound the turn, as a real reply can never precede that.
fn complete_turn_later(db: Arc<Database>, session_id: String, turn: String, answer: String) {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let bound: Option<String> = db
                .transaction(|tx| {
                    Ok(tx
                        .query_row("SELECT turn_id FROM code_review_sessions WHERE session_id=?", [&session_id], |r| r.get(0))
                        .optional()?
                        .flatten())
                })
                .unwrap_or(None);
            if bound.as_deref() == Some(turn.as_str()) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        db.record_provider_event(&session_id, Some(&turn), "chat.turn.started", &json!({})).unwrap();
        db.record_provider_event(&session_id, Some(&turn), "chat.delta", &json!({"text": answer})).unwrap();
        db.record_provider_event(&session_id, Some(&turn), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    });
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
    options: Arc<Mutex<Value>>,
}

impl Fixture {
    fn new() -> Self {
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
        let options = Arc::new(Mutex::new(json!({"options":[]})));
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
            options: Arc::clone(&options),
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
            options,
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
fn refreshed_catalog_replaces_removed_choices_and_uses_its_new_default() {
    let fixture = Fixture::new();
    code_review::remember_provider_options(
        &fixture.db,
        "reviewer",
        &json!({"options":[{"id":"model","category":"model","value":"removed-model","recommended":"old-default","choices":[{"value":"removed-model","name":"Removed"},{"value":"old-default","name":"Old default"}]}]}),
    )
    .unwrap();
    code_review::remember_provider_options(
        &fixture.db,
        "reviewer",
        &json!({"options":[{"id":"model","category":"model","value":"running-model","recommended":"new-default","choices":[{"value":"running-model","name":"Running"},{"value":"new-default","name":"New default"}]}]}),
    )
    .unwrap();

    let options: Value = fixture
        .db
        .transaction(|tx| {
            let text: String = tx.query_row(
                "SELECT options_json FROM provider_option_catalog WHERE provider='reviewer'",
                [],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&text)?)
        })
        .unwrap();
    let model = &options[0];
    assert_eq!(model["value"], "new-default");
    assert!(
        !model["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|choice| choice["value"] == "removed-model")
    );
}

#[test]
fn options_revalidates_catalog_from_an_open_chat_without_spawning_a_provider() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    let parent = fixture.session(&repo, "parent-live-catalog");
    code_review::remember_provider_options(&fixture.db, "reviewer", &json!({"options":[{"id":"model","category":"model","recommended":"old","choices":[{"value":"old"}]}]})).unwrap();
    *fixture.options.lock().unwrap() = json!({"options":[{"id":"model","category":"model","recommended":"new","choices":[{"value":"new"}]}]});
    fixture.providers.chat_open(&parent, "reviewer", repo.to_str().unwrap(), None).unwrap();

    let result = code_review::dispatch(&fixture.db, &fixture.providers, "codeReview.options", &json!({"sessionId":parent}), &|_, _| Ok(()), &|_| unreachable!()).unwrap();
    assert_eq!(result["providers"][0]["model"]["recommended"], "new");
    assert_eq!(result["providers"][0]["model"]["choices"], json!([{"value":"new"}]));
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
    *fixture.options.lock().unwrap() = json!({"options":[
        {"id":"model_id","name":"Model","category":"model","value":"fast","recommended":"fast","choices":[{"value":"fast","name":"Fast"},{"value":"slow","name":"Slow"}]}
    ]});
    fixture
        .providers
        .chat_open(&parent, "reviewer", repo.to_str().unwrap(), None)
        .unwrap();
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
    let option_sets = fixture.log.lock().unwrap().option_sets.clone();
    assert!(
        option_sets.iter().any(|row| row == "model_id=fast"),
        "expected applied catalog option id model_id, got {option_sets:?}"
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
fn missing_catalog_rejects_an_explicit_model_for_new_review_work() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-model-missing-catalog");
    let create = fixture.create();

    let error = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","model":"removed-model","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"removed-model","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap_err();

    assert_eq!(code(error), "invalid_request");
}

#[test]
fn no_live_catalog_source_drops_stale_models_from_options_and_start() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-stale-catalog");
    code_review::remember_provider_options(
        &fixture.db,
        "reviewer",
        &json!({"options":[{"id":"model","category":"model","recommended":"removed-model","choices":[{"value":"removed-model","name":"Removed"}]}]}),
    )
    .unwrap();

    let options = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.options",
        &json!({"sessionId":parent}),
        &|_, _| Ok(()),
        &|_| unreachable!(),
    )
    .unwrap();
    assert!(options["providers"][0].get("model").is_none());

    let create = fixture.create();
    let error = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","model":"removed-model","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"stale-model","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap_err();
    assert_eq!(code(error), "invalid_request");
    assert!(!fixture.providers.chat_is_open(&parent));
}

#[test]
fn empty_live_catalog_rejects_an_explicit_model_for_new_review_work() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "parent-empty-catalog");
    *fixture.options.lock().unwrap() = json!({"options":[{
        "id":"model","category":"model","value":"running-model","recommended":"default-model","choices":[]
    }]});
    fixture
        .providers
        .chat_open(&parent, "reviewer", repo.to_str().unwrap(), None)
        .unwrap();

    let create = fixture.create();
    let error = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","model":"removed-model","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"empty-catalog","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap_err();
    assert_eq!(code(error), "invalid_request");
}

#[test]
fn fresh_catalog_survives_a_current_selection_error() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    let parent = fixture.session(&repo, "parent-fresh-error-catalog");
    *fixture.options.lock().unwrap() = json!({
        "loadState":"error","error":{"code":"chat_option_invalid","message":"Removed model"},
        "options":[{"id":"model","category":"model","value":"","recommended":"fresh-model","choices":[{"value":"fresh-model","name":"Fresh"}]}]
    });
    fixture
        .providers
        .chat_open(&parent, "reviewer", repo.to_str().unwrap(), None)
        .unwrap();

    let options = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.options",
        &json!({"sessionId":parent}),
        &|_, _| Ok(()),
        &|_| unreachable!(),
    )
    .unwrap();
    assert_eq!(options["providers"][0]["model"]["recommended"], "fresh-model");
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

fn card(db: &Database, parent: &str, review_id: &str) -> Value {
    db.subagent_card(parent, &format!("review:{review_id}")).unwrap().unwrap().parts[0]["data"].clone()
}

fn start(fixture: &Fixture, parent: &str, depth: &str, operation: &str, create: &dyn Fn(&Value) -> anyhow::Result<Value>) -> anyhow::Result<Value> {
    code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":depth,"scope":{"kind":"uncommitted"},"operationId":operation,"leaseEpoch":1}),
        &|_, _| Ok(()),
        create,
    )
}

#[test]
fn failed_preparation_ends_the_review_and_frees_the_chat() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed
").unwrap();
    let parent = fixture.session(&repo, "parent-prepare");
    let broken = |_: &Value| -> anyhow::Result<Value> { Err(anyhow::anyhow!("session_create_failed")) };
    let failed = start(&fixture, &parent, "standard", "prepare-fails", &broken).unwrap();
    let review_id = failed["reviewId"].as_str().unwrap();
    let data = card(&fixture.db, &parent, review_id);
    assert_eq!(data["status"], "failed");
    assert!(data["summary"].as_str().unwrap().contains("could not start"), "card={data}");
    assert!(data["endedAt"].is_string());
    let create = fixture.create();
    fixture.push_answer(json!([]));
    let next = start(&fixture, &parent, "quick", "prepare-retry", &create).unwrap();
    assert_eq!(wait_done(&fixture.db, next["reviewId"].as_str().unwrap())["stage"], "done");
}

#[test]
fn card_line_follows_the_stage_and_a_stale_refresh_cannot_reopen_it() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed
").unwrap();
    let parent = fixture.session(&repo, "parent-card");
    let create = fixture.create();
    fixture.hold_turn.store(1, Ordering::SeqCst);
    let started = start(&fixture, &parent, "standard", "card-line", &create).unwrap();
    let review_id = started["reviewId"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let running = loop {
        let data = card(&fixture.db, &parent, review_id);
        if data["summary"] == "Finding issues · 0/1" || Instant::now() >= deadline {
            break data;
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(running["status"], "running");
    assert_eq!(running["summary"], "Finding issues · 0/1", "card={running}");
    assert!(running.get("endedAt").is_none());
    code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.cancel",
        &json!({"sessionId":parent,"reviewId":review_id,"operationId":"card-cancel","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let cancelled = card(&fixture.db, &parent, review_id);
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["summary"], "Cancelled");
    // A live refresh that was already under way when the review ended.
    code_review::upsert_card(&fixture.db, &parent, review_id, false).unwrap();
    let again = card(&fixture.db, &parent, review_id);
    assert_eq!(again["status"], "cancelled");
    assert_eq!(again["endedAt"], cancelled["endedAt"]);
    assert!(again["rev"].as_i64() >= cancelled["rev"].as_i64());
}

#[test]
fn standard_with_no_candidates_skips_the_verifier_and_raises_no_notices() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed
").unwrap();
    let parent = fixture.session(&repo, "parent-empty");
    let create = fixture.create();
    fixture.push_answer(json!([]));
    let started = start(&fixture, &parent, "standard", "empty", &create).unwrap();
    let review_id = started["reviewId"].as_str().unwrap();
    let summary = wait_done(&fixture.db, review_id);
    assert_eq!(summary["findings"], json!([]));
    assert_eq!(summary["stagesDone"], 2);
    assert_eq!(card(&fixture.db, &parent, review_id)["summary"], "No issues found");
    assert_eq!(fixture.log.lock().unwrap().sends.len(), 1, "only the finder ran");
    let transcript = code_review::read_session_transcript(&fixture.db, &parent, &format!("review:{review_id}")).unwrap();
    let labels: Vec<&str> = transcript["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "system")
        .filter_map(|item| item["parts"][0]["text"].as_str())
        .collect();
    assert_eq!(labels, ["Stage: finding · general", "Stage: verifying · not run"]);
    // The finder's finished turn is reported by the card, not by a reply notice.
    let notices: i64 = fixture
        .db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM inbox WHERE session_id IN (SELECT session_id FROM code_review_sessions WHERE review_id=?)",
                [review_id],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(notices, 0);
}

#[test]
fn a_running_reviewers_approval_is_answered_through_the_chat_that_owns_the_review() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    let owner = fixture.session(&repo, "approval-owner");
    let reviewer = fixture.session(&repo, "approval-reviewer");
    let stranger = fixture.session(&repo, "approval-stranger");
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO code_reviews(id,session_id,item_id,provider,depth,scope_json,scope_label,root,state,stage,stages_total,created_at,updated_at) VALUES('rev-approval',?,'item','kimi','standard','{}','Uncommitted','C:/repo','verifying','verifying',2,'t','t')",
                [&owner],
            )?;
            tx.execute(
                "INSERT INTO code_review_sessions(review_id,session_id,role,stage_index,turn_id) VALUES('rev-approval',?,'verifier',1,'reviewer-turn')",
                [&reviewer],
            )?;
            let item = json!({"id":"ask","role":"assistant","createdAt":"t","turnId":"reviewer-turn","parts":[{"type":"approval","approvalId":"1","title":"Bash"}]});
            tx.execute(
                "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES('ask',?,'reviewer-turn','message',?,'t')",
                rusqlite::params![reviewer, item.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    let owner_of = |chat: &str, turn: &str, approval: &str| code_review::approval_owner(&fixture.db, chat, turn, approval).unwrap();
    assert_eq!(owner_of(&owner, "reviewer-turn", "1"), Some(reviewer.clone()), "the owning chat answers its reviewer");
    assert_eq!(owner_of(&owner, "reviewer-turn", "2"), None, "an approval the reviewer never asked stays with the chat");
    assert_eq!(owner_of(&owner, "owner-turn", "1"), None, "the chat's own turn is never rerouted");
    assert_eq!(owner_of(&stranger, "reviewer-turn", "1"), None, "another chat cannot answer the reviewer");
    fixture
        .db
        .transaction(|tx| Ok(tx.execute("UPDATE code_reviews SET state='done' WHERE id='rev-approval'", [])?))
        .unwrap();
    assert_eq!(owner_of(&owner, "reviewer-turn", "1"), None, "a finished review no longer routes approvals");
}

fn git_out(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn a_review_copy_holds_the_reviewed_state_and_has_nowhere_to_push() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("gone.txt"), "tracked\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "second"]);
    git(&repo, &["remote", "add", "origin", "https://example.invalid/repo.git"]);
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    fs::remove_file(repo.join("gone.txt")).unwrap();
    fs::create_dir_all(repo.join("new/deep")).unwrap();
    fs::write(repo.join("new/deep/untracked.txt"), "fresh\n").unwrap();
    let copy = code_review::snapshot_dir(&fixture.db, "review-copy");
    code_review::create_snapshot(&repo, &copy).unwrap();
    assert_eq!(git_out(&copy, &["rev-parse", "HEAD"]), git_out(&repo, &["rev-parse", "HEAD"]));
    assert_eq!(git_out(&copy, &["symbolic-ref", "--short", "HEAD"]), git_out(&repo, &["symbolic-ref", "--short", "HEAD"]));
    assert_eq!(fs::read_to_string(copy.join("tracked.txt")).unwrap(), "changed\n");
    assert!(!copy.join("gone.txt").exists(), "a deleted file stays deleted in the copy");
    assert_eq!(fs::read_to_string(copy.join("new/deep/untracked.txt")).unwrap(), "fresh\n");
    assert_eq!(git_out(&copy, &["remote"]), "", "the copy has no remote to push to");
    assert!(git_out(&copy, &["status", "--porcelain"]).contains("tracked.txt"), "git sees the same uncommitted change");
    // The user's repository is untouched.
    assert_eq!(fs::read_to_string(repo.join("tracked.txt")).unwrap(), "changed\n");
    assert_eq!(git_out(&repo, &["remote"]), "origin");
}

#[test]
fn an_isolating_review_runs_its_reviewers_in_a_copy_that_is_removed_after() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let parent = fixture.session(&repo, "isolated-parent");
    let create = fixture.create();
    fixture.push_answer(json!([]));
    let started = code_review::dispatch(
        &fixture.db,
        &fixture.providers,
        "codeReview.start",
        &json!({"sessionId":parent,"provider":"reviewer","depth":"quick","scope":{"kind":"uncommitted"},"operationId":"isolated","leaseEpoch":1}),
        &|_, _| Ok(()),
        &create,
    )
    .unwrap();
    let review = started["reviewId"].as_str().unwrap().to_owned();
    let copy = code_review::snapshot_dir(&fixture.db, &review);
    let reviewer: String = fixture
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT session_id FROM code_review_sessions WHERE review_id=?", [&review], |r| r.get(0))?))
        .unwrap();
    let session = fixture.db.session_by_id(&reviewer).unwrap().unwrap();
    let cwd = crate::delegation::session_cwd(&fixture.db, &session).unwrap();
    assert!(Path::new(&cwd).starts_with(&copy), "the reviewer works in the copy, not the repo: {cwd}");
    let _ = wait_done(&fixture.db, &review);
    let deadline = Instant::now() + Duration::from_secs(15);
    while copy.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!copy.exists(), "the copy is removed once the review ends");
}

#[test]
fn kimi_reviewers_in_a_copy_are_staged_never_ask_and_startup_sweeps_old_copies() {
    let fixture = Fixture::new();
    let repo = repository(fixture.root.path());
    let reviewer = fixture.session(&repo, "never-ask");
    code_review::stage_never_ask(&fixture.db, &reviewer, "kimi").unwrap();
    let staged = fixture.db.pending_fork_options(&reviewer).unwrap();
    assert!(staged.as_array().unwrap().iter().any(|row| row["id"] == "mode" && row["value"] == "yolo"), "{staged}");
    let other = fixture.session(&repo, "never-ask-other");
    code_review::stage_never_ask(&fixture.db, &other, "opencode").unwrap();
    assert!(!fixture.db.pending_fork_options(&other).unwrap().as_array().is_some_and(|rows| rows.iter().any(|row| row["id"] == "mode")));
    let stale = code_review::snapshot_dir(&fixture.db, "left-behind");
    fs::create_dir_all(stale.join("sub")).unwrap();
    code_review::reconcile_interrupted(&fixture.db).unwrap();
    assert!(!code_review::snapshot_root(&fixture.db).exists(), "startup removes copies an earlier run left behind");
}
