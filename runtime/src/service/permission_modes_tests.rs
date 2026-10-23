use super::*;
use crate::providers::{
    ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
};

struct PermissionAdapter {
    provider: &'static str,
    reject: Arc<AtomicBool>,
    mismatch: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl ProviderAdapter for PermissionAdapter {
    fn id(&self) -> &str {
        self.provider
    }
    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: self.provider.into(),
            name: "Permission fixture".into(),
            installed: true,
            version: None,
            terminal: false,
            chat: true,
            history: false,
            resume: true,
            terminal_resume_capture: "none",
            reason: None,
            auth: "unknown".into(),
        }
    }
    fn terminal_command(
        &self,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "No terminal"))
    }
    fn history_list(
        &self,
        _: Option<&str>,
        _: u32,
        _: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Ok(json!({}))
    }
    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        Ok(json!([]))
    }
    fn open_chat(
        &self,
        session_id: &str,
        _: &str,
        native: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("open:{}", native.unwrap_or("new")));
        Ok(Box::new(PermissionChat {
            mode: "default".into(),
            native_id: native
                .map(str::to_owned)
                .unwrap_or_else(|| format!("native-{session_id}")),
            provider: self.provider,
            reject: Arc::clone(&self.reject),
            mismatch: Arc::clone(&self.mismatch),
            calls: Arc::clone(&self.calls),
        }))
    }
}

struct PermissionChat {
    mode: String,
    native_id: String,
    provider: &'static str,
    reject: Arc<AtomicBool>,
    mismatch: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl PermissionChat {
    fn option_id(&self) -> &str {
        if self.provider == "fixture-acp" {
            "approval-policy"
        } else {
            "mode"
        }
    }
}

impl ChatSession for PermissionChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }
    fn ui_state(&self) -> Value {
        json!({"options":[{"id":self.option_id(),"name":"Permission mode","category":"mode","value":self.mode,"choices":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"},{"value":"dontAsk","name":"Don't ask"},{"value":"yolo","name":"YOLO"},{"value":"auto","name":"Auto"}]}]})
    }
    fn send(&mut self, text: &str, operation: &str) -> Result<Value, ProviderError> {
        let value = match text.trim() {
            "/yolo" | "/yes" => Some("yolo"),
            "/auto" => Some("auto"),
            "/plan" => Some("plan"),
            _ => None,
        };
        if let Some(value) = value {
            self.set_option("mode", value)?;
        }
        Ok(json!({"turnId":operation}))
    }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
        self.mode = "auto".into();
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        self.calls.lock().unwrap().push("stop".into());
        Ok(())
    }
    fn set_option(&mut self, id: &str, value: &str) -> Result<Value, ProviderError> {
        if self.reject.load(Ordering::SeqCst) {
            return Err(ProviderError::new(
                "settings_rejected",
                "Fixture rejected permission choice",
            ));
        }
        if id != self.option_id()
            || !["default", "plan", "dontAsk", "yolo", "auto"].contains(&value)
        {
            return Err(ProviderError::new(
                "chat_option_invalid",
                "Unknown permission choice",
            ));
        }
        self.calls.lock().unwrap().push(format!("{id}={value}"));
        if !self.mismatch.load(Ordering::SeqCst) {
            self.mode = value.into();
        }
        Ok(self.ui_state())
    }
}

fn providers(
    provider: &'static str,
    reject: &Arc<AtomicBool>,
    mismatch: &Arc<AtomicBool>,
    calls: &Arc<Mutex<Vec<String>>>,
) -> Providers {
    Providers::for_test(vec![Arc::new(PermissionAdapter {
        provider,
        reject: Arc::clone(reject),
        mismatch: Arc::clone(mismatch),
        calls: Arc::clone(calls),
    })])
}

fn session(
    db: &Database,
    root: &std::path::Path,
    provider: &str,
    operation: &str,
) -> crate::domain::Session {
    let session = db
        .create_session(CreateSession {
            project_id: None,
            title: None,
            provider,
            mode: "chat",
            native_id: None,
            operation_id: operation,
        })
        .unwrap();
    db.bind_session(&session.id, Some(root.to_str().unwrap()), None)
        .unwrap();
    db.set_session_status(&session.id, "idle", None).unwrap();
    session
}

fn selected(providers: &Providers, id: &str) -> String {
    providers.chat_options(id).unwrap()["options"][0]["value"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn permission_modes_survive_reconnect_and_database_restart_for_each_provider() {
    for (provider, option_id, value) in [
        ("claude", "mode", "dontAsk"),
        ("kimi", "mode", "yolo"),
        ("grok", "mode", "auto"),
        ("gemini", "mode", "plan"),
        ("fixture-acp", "approval-policy", "plan"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.sqlite");
        let db = Database::open(&path).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let chat = session(&db, root.path(), provider, "permission-save");
        let reject = Arc::new(AtomicBool::new(false));
        let mismatch = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(vec![]));
        let registry = providers(provider, &reject, &mismatch, &calls);
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "no restore calls with no saved state"
        );
        db.set_chat_option_selections(
            &chat.id,
            provider,
            &json!([{"id":"unrelated","value":"keep"}]),
        )
        .unwrap();
        set_chat_option(&db, &registry, &chat.id, provider, option_id, value).unwrap();
        assert!(db
            .chat_option_selections(&chat.id, provider)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "unrelated"));
        registry.chat_stop(&chat.id).unwrap();
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(selected(&registry, &chat.id), value, "{provider}");
        registry.chat_stop(&chat.id).unwrap();
        drop(registry);
        drop(db);
        let db = Database::open(&path).unwrap();
        let registry = providers(provider, &reject, &mismatch, &calls);
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(selected(&registry, &chat.id), value, "{provider} restart");
        assert!(calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call.starts_with("open:native-")));
    }
}

#[test]
fn rejected_unknown_or_mismatched_permissions_fail_closed_and_remain_recoverable() {
    for provider in ["claude", "kimi", "grok", "gemini", "fixture-acp"] {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("runtime.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let chat = session(&db, root.path(), provider, "permission-failure");
        let reject = Arc::new(AtomicBool::new(false));
        let mismatch = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(vec![]));
        let registry = providers(provider, &reject, &mismatch, &calls);
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        let id = if provider == "fixture-acp" {
            "approval-policy"
        } else {
            "mode"
        };
        set_chat_option(&db, &registry, &chat.id, provider, id, "plan").unwrap();
        db.record_provider_event(
            &chat.id,
            None,
            "chat.ui",
            &registry.chat_options(&chat.id).unwrap(),
        )
        .unwrap();
        registry.chat_stop(&chat.id).unwrap();
        let saved = db.chat_option_selections(&chat.id, provider).unwrap();
        for (reject_value, mismatch_value) in [(true, false), (false, true)] {
            reject.store(reject_value, Ordering::SeqCst);
            mismatch.store(mismatch_value, Ordering::SeqCst);
            assert!(
                connect_chat_session(&db, &registry, &chat.id).is_err(),
                "{provider}"
            );
            assert!(!registry.chat_is_open(&chat.id));
            assert_eq!(
                registry.chat_connection(&chat.id)["error"]["code"],
                "chat_permission_restore_failed"
            );
            let restore = &registry.chat_connection(&chat.id)["error"]["permissionRestore"];
            assert_eq!(
                restore["reason"],
                if reject_value { "rejected" } else { "mismatch" }
            );
            assert_eq!(restore["optionId"], id);
            assert_eq!(restore["savedValue"], "plan");
            assert_eq!(restore["optionName"], "Permission mode");
            assert_eq!(restore["savedLabel"], "Plan");
            if mismatch_value {
                assert_eq!(restore["reportedValue"], "default");
                assert_eq!(restore["reportedLabel"], "Default");
            }
            assert_eq!(
                db.chat_option_selections(&chat.id, provider).unwrap(),
                saved
            );
        }
        reject.store(false, Ordering::SeqCst);
        mismatch.store(false, Ordering::SeqCst);
        let unknown = json!([{"id":id,"value":"retired","category":"mode"}]);
        db.set_chat_option_selections(&chat.id, provider, &unknown)
            .unwrap();
        assert!(connect_chat_session(&db, &registry, &chat.id).is_err());
        assert_eq!(
            db.chat_option_selections(&chat.id, provider).unwrap(),
            unknown
        );
        let recovered = set_chat_option(&db, &registry, &chat.id, provider, id, "default").unwrap();
        assert_eq!(recovered["error"]["code"], "chat_permission_restore_failed");
        for state in [
            recovered,
            permission_modes::options(&db, &registry, &chat.id).unwrap(),
        ] {
            assert_eq!(
                state["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["id"] == id)
                    .unwrap()["value"],
                "default",
                "the staged recovery choice is visible before retrying {provider}"
            );
        }
        assert_eq!(
            db.chat_option_selections(&chat.id, provider).unwrap(),
            unknown,
            "recovery choices are not saved as confirmed yet"
        );
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(selected(&registry, &chat.id), "default");
        assert_eq!(db.pending_fork_options(&chat.id).unwrap(), json!([]));
        assert!(db
            .chat_option_selections(&chat.id, provider)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id && row["value"] == "default"));
    }
}

#[test]
fn pending_permission_fork_overrides_win_and_delegates_keep_defaults() {
    for provider in ["claude", "kimi", "grok", "fixture-acp"] {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("runtime.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let chat = session(&db, root.path(), provider, "fork-permission");
        let id = if provider == "fixture-acp" {
            "approval-policy"
        } else {
            "mode"
        };
        db.set_chat_option_selections(
            &chat.id,
            provider,
            &json!([{"id":id,"value":"auto","category":"mode"}]),
        )
        .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO session_fork_options(session_id,data) VALUES (?,?)",
                rusqlite::params![
                    chat.id,
                    json!([{"id":id,"value":"plan","category":"mode"}]).to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
        let reject = Arc::new(AtomicBool::new(false));
        let mismatch = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(vec![]));
        let registry = providers(provider, &reject, &mismatch, &calls);
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(selected(&registry, &chat.id), "plan");
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.as_str() == format!("{id}=plan"))
                .count(),
            1,
            "no redundant post-connect setter"
        );
        registry.chat_stop(&chat.id).unwrap();
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(selected(&registry, &chat.id), "plan");
        let delegate = session(&db, root.path(), provider, "delegate-permission");
        connect_chat_session(&db, &registry, &delegate.id).unwrap();
        assert_eq!(selected(&registry, &delegate.id), "default");
    }
}

#[test]
fn kimi_permission_slash_commands_and_approved_transitions_are_saved() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("runtime.sqlite")).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    let chat = session(&db, root.path(), "kimi", "kimi-permissions");
    let reject = Arc::new(AtomicBool::new(false));
    let mismatch = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(Mutex::new(vec![]));
    let registry = providers("kimi", &reject, &mismatch, &calls);
    connect_chat_session(&db, &registry, &chat.id).unwrap();
    for (index, (command, expected)) in [("/yolo", "yolo"), ("/auto", "auto"), ("/plan", "plan")]
        .iter()
        .enumerate()
    {
        send_chat_message(
            &db,
            &registry,
            &chat.id,
            command,
            &[],
            &format!("slash-{index}"),
        )
        .unwrap();
        assert_eq!(
            db.chat_option_selections(&chat.id, "kimi").unwrap()[0]["value"],
            *expected
        );
    }
    approve_chat_request(
        &db,
        &registry,
        &chat.id,
        "turn",
        "approval",
        "allow_once",
        "approve-mode",
    )
    .unwrap();
    assert_eq!(
        db.chat_option_selections(&chat.id, "kimi").unwrap()[0]["value"],
        "auto"
    );
}

#[test]
fn startup_ui_does_not_overwrite_saved_mode_but_confirmed_transition_does() {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    crate::session_configs::initialize(&db).unwrap();
    let chat = session(&db, root.path(), "claude", "claude-confirmed");
    let reject = Arc::new(AtomicBool::new(false));
    let mismatch = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(Mutex::new(vec![]));
    let registry = providers("claude", &reject, &mismatch, &calls);
    connect_chat_session(&db, &registry, &chat.id).unwrap();
    set_chat_option(&db, &registry, &chat.id, "claude", "mode", "plan").unwrap();
    let mut event = ProviderEvent {
        session_id: chat.id.clone(),
        provider: "claude".into(),
        native_id: Some(format!("native-{}", chat.id)),
        turn_id: None,
        kind: "chat.ui".into(),
        data: json!({"options":[{"id":"mode","value":"default"}]}),
        worker_token: None,
    };
    assert!(project_provider_event(&db, &registry, &event));
    assert_eq!(
        db.chat_option_selections(&chat.id, "claude").unwrap()[0]["value"],
        "plan"
    );
    event.data["permissionChangeConfirmed"] = json!(true);
    db.record_provider_event(
        &chat.id,
        None,
        "chat.ui",
        &registry.chat_options(&chat.id).unwrap(),
    )
    .unwrap();
    assert!(project_provider_event(&db, &registry, &event));
    assert_eq!(
        db.chat_option_selections(&chat.id, "claude").unwrap()[0]["value"],
        "plan",
        "a delayed confirmed event cannot replace a newer picker choice"
    );
    assert_eq!(
        db.latest_chat_options(&chat.id).unwrap()[0]["value"],
        "plan",
        "a stale event cannot poison fork/recovery options"
    );
    registry
        .chat_set_option(&chat.id, "mode", "default")
        .unwrap();
    assert!(project_provider_event(&db, &registry, &event));
    assert_eq!(
        db.chat_option_selections(&chat.id, "claude").unwrap()[0]["value"],
        "default"
    );
}

#[test]
fn removed_acp_permission_ids_can_be_explicitly_reset_without_changing_saved_state_early() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("runtime.sqlite")).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    let chat = session(&db, root.path(), "fixture-acp", "reset-permission");
    let saved = json!([{"id":"removed-policy","value":"plan","category":"mode"},{"id":"unrelated","value":"keep"}]);
    db.set_chat_option_selections(&chat.id, "fixture-acp", &saved)
        .unwrap();
    let reject = Arc::new(AtomicBool::new(false));
    let mismatch = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(Mutex::new(vec![]));
    let registry = providers("fixture-acp", &reject, &mismatch, &calls);
    assert!(connect_chat_session(&db, &registry, &chat.id).is_err());
    let restore = &registry.chat_connection(&chat.id)["error"]["permissionRestore"];
    assert_eq!(restore["reason"], "missing");
    assert_eq!(restore["optionId"], "removed-policy");
    assert_eq!(restore["savedValue"], "plan");
    let catalogue = permission_modes::options(&db, &registry, &chat.id).unwrap();
    assert!(
        catalogue["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "approval-policy"),
        "fresh failed worker catalogue is preserved"
    );
    let staged = set_chat_option(
        &db,
        &registry,
        &chat.id,
        "fixture-acp",
        "threadterm-permission-recovery",
        "defaults",
    )
    .unwrap();
    for state in [
        staged,
        permission_modes::options(&db, &registry, &chat.id).unwrap(),
    ] {
        let rows = state["options"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .find(|row| row["id"] == "approval-policy")
                .unwrap()["value"],
            "default",
            "discarding saved permissions advertises the provider default before retry"
        );
        assert_eq!(
            rows.iter()
                .find(|row| row["id"] == "threadterm-permission-recovery")
                .unwrap()["value"],
            "defaults",
            "the staged reset remains visible before retry"
        );
    }
    assert_eq!(
        db.chat_option_selections(&chat.id, "fixture-acp").unwrap(),
        saved
    );
    connect_chat_session(&db, &registry, &chat.id).unwrap();
    let final_rows = db.chat_option_selections(&chat.id, "fixture-acp").unwrap();
    assert!(!final_rows
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "removed-policy"));
    assert!(final_rows
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "unrelated"));
    assert_eq!(selected(&registry, &chat.id), "default");
    assert_eq!(db.pending_fork_options(&chat.id).unwrap(), json!([]));
}

#[test]
fn claude_auto_carries_its_model_dependency_and_pending_fork_model_wins() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("runtime.sqlite")).unwrap();
    let chat = session(&db, root.path(), "claude", "auto-model");
    permission_modes::remember(
        &db,
        &chat.id,
        "claude",
        &json!({"options":[{"id":"model","value":"auto-model-a"},{"id":"mode","value":"auto"}]}),
    )
    .unwrap();
    let saved = permission_modes::startup_options(&db, &chat.id, "claude").unwrap();
    assert!(saved
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "model"
            && row["value"] == "auto-model-a"
            && row["startupDependency"] == true));
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO session_fork_options(session_id,data) VALUES (?,?)",
            rusqlite::params![
                chat.id,
                json!([{"id":"model","value":"auto-model-b"},{"id":"mode","value":"auto"}])
                    .to_string()
            ],
        )?;
        Ok(())
    })
    .unwrap();
    let startup = permission_modes::startup_options(&db, &chat.id, "claude").unwrap();
    assert!(startup
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "model" && row["value"] == "auto-model-b"));
    assert!(
        !permission_modes::is_permission_option(
            "fixture-acp",
            &json!({"id":"mode","category":"other"})
        ),
        "generic ACP mode ids require native category metadata"
    );
}

#[test]
fn initial_launch_finalizes_permission_overrides_before_the_next_selection() {
    for provider in ["claude", "kimi", "grok", "fixture-acp"] {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let chat = session(&db, root.path(), provider, "initial-permission-override");
        let id = if provider == "fixture-acp" {
            "approval-policy"
        } else {
            "mode"
        };
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO session_fork_options(session_id,data) VALUES (?,?)",
                rusqlite::params![
                    chat.id,
                    json!([{"id":id,"value":"plan","category":"mode"}]).to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
        let reject = Arc::new(AtomicBool::new(false));
        let mismatch = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(vec![]));
        let registry = Arc::new(providers(provider, &reject, &mismatch, &calls));
        let pty = Arc::new(PtyManager::new(Arc::new(OutputStore::default())));
        let request: SessionCreate = serde_json::from_value(json!({"provider":provider,"mode":"chat","operationId":"initial-permission-override","cwd":root.path().to_str().unwrap()})).unwrap();
        RuntimeService::launch_session_with(
            &db,
            &registry,
            &pty,
            &chat.id,
            &request,
            root.path().to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(selected(&registry, &chat.id), "plan");
        assert_eq!(db.pending_fork_options(&chat.id).unwrap(), json!([]));
        set_chat_option(&db, &registry, &chat.id, provider, id, "auto").unwrap();
        registry.chat_stop(&chat.id).unwrap();
        connect_chat_session(&db, &registry, &chat.id).unwrap();
        assert_eq!(
            selected(&registry, &chat.id),
            "auto",
            "consumed fork state must not override a later picker choice"
        );
    }
}
