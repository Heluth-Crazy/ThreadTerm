use crate::{
    db::{CreateSession, Database, ImportHistorySession},
    domain::{ChatItem, NativeForkAnchor, NativeTurnStatus, Session},
    providers::{ProviderRuntime, Providers},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};

pub(crate) const COPIED_CONVERSATION_PREFIX: &str = "[ThreadTerm copied conversation v1]\n";
const MAX_TRANSCRIPT_BYTES: usize = 64 * 1024;
const OMITTED_NOTE: &str = "[Earlier conversation omitted]\n\n";

pub(crate) struct ForkRequest<'a> {
    pub session_id: &'a str,
    pub item_id: Option<&'a str>,
    pub operation_id: &'a str,
}

pub(crate) fn fork(
    db: &Database,
    providers: &Providers,
    request: ForkRequest<'_>,
) -> Result<Value> {
    let session_gate = session_admission(db, request.session_id)?;
    let _session_guard = session_gate
        .lock()
        .map_err(|_| anyhow!("provider_internal"))?;
    let flight = fork_flight(db, request.operation_id)?;
    let _guard = flight.lock().map_err(|_| anyhow!("provider_internal"))?;
    fork_inner(db, providers, request)
}

pub(crate) fn session_admission(db: &Database, session_id: &str) -> Result<Arc<Mutex<()>>> {
    type Gates = HashMap<(std::path::PathBuf, String), Weak<Mutex<()>>>;
    static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow!("provider_internal"))?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    let key = (db.path().to_owned(), session_id.to_owned());
    if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
        return Ok(gate);
    }
    let gate = Arc::new(Mutex::new(()));
    gates.insert(key, Arc::downgrade(&gate));
    Ok(gate)
}

fn fork_flight(db: &Database, operation_id: &str) -> Result<Arc<Mutex<()>>> {
    type Flights = HashMap<(std::path::PathBuf, String), Weak<Mutex<()>>>;
    static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
    let mut flights = FLIGHTS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow!("provider_internal"))?;
    flights.retain(|_, flight| flight.strong_count() > 0);
    let key = (db.path().to_owned(), operation_id.to_owned());
    if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
        return Ok(flight);
    }
    let flight = Arc::new(Mutex::new(()));
    flights.insert(key, Arc::downgrade(&flight));
    Ok(flight)
}

fn fork_inner(db: &Database, providers: &Providers, request: ForkRequest<'_>) -> Result<Value> {
    if request.session_id.is_empty()
        || request.operation_id.is_empty()
        || request.item_id.is_some_and(str::is_empty)
    {
        return Err(anyhow!("invalid_fork_request"));
    }
    if let Some(result) = db.operation(request.operation_id)? {
        return Ok(result);
    }
    let source = db
        .session_by_id(request.session_id)?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    if source.mode != "chat" {
        return Err(anyhow!("fork_unavailable"));
    }
    ensure_source_idle(&source)?;
    let config = crate::session_configs::read(db, &source.id)?
        .ok_or_else(|| anyhow!("launch_config_missing"))?;
    let cwd = config.launch.cwd.as_str();
    if !std::path::Path::new(cwd).is_absolute() || !std::path::Path::new(cwd).is_dir() {
        return Err(anyhow!("cwd_missing_choose_relocation"));
    }
    let all_items = db.chat_items(&source.id)?;
    let (items, anchor, is_latest, copied_at) = fork_point(&all_items, request.item_id)?;
    let title = fork_title(&source.title);
    let options = capture_options(db, providers, &source.id);
    let native_intent = db.chat_fork_intent(request.operation_id)?;

    // A retry after local child creation repairs metadata and returns that
    // child without asking a provider to fork a second time.
    for (suffix, mode) in [("native-import", "native"), ("copy-create", "copy")] {
        if let Some(value) = db.operation(&derived(request.operation_id, suffix))? {
            let child: Session = serde_json::from_value(value)?;
            if mode == "native" {
                let expected_child = native_intent
                    .as_ref()
                    .and_then(|intent| intent.1.as_deref());
                if expected_child.is_none() {
                    if !db.recover_chat_fork_child_intent(request.operation_id, &child.id)? {
                        return Err(anyhow!("operation_outcome_unknown"));
                    }
                } else if expected_child != Some(child.id.as_str()) {
                    return Err(anyhow!("operation_outcome_unknown"));
                }
                if child.read_only {
                    let workspace = source.worktree_path.as_deref().unwrap_or(cwd);
                    db.reserve_resume(
                        &child.id,
                        workspace,
                        cwd,
                        &derived(request.operation_id, "native-resume"),
                    )
                    .map_err(|_| anyhow!("operation_outcome_unknown"))?;
                }
            }
            finish_child(db, &source, &child, &title, &options)?;
            if mode == "copy" {
                let envelope = copied_conversation(&items, &copied_at)?;
                db.save_chat_draft(
                    &child.id,
                    &envelope,
                    0,
                    &derived(request.operation_id, "copy-draft"),
                )?;
            }
            return db.complete_chat_fork(
                &child.id,
                &source.id,
                request.item_id,
                &source.title,
                mode,
                request.operation_id,
            );
        }
    }
    let selected_anchor = request
        .item_id
        .and(anchor.as_ref())
        .filter(|value| source.native_id.as_deref() == Some(value.native_id.as_str()));
    let can_try_native = source.native_id.as_deref().is_some_and(|native_id| {
        request.item_id.is_none()
            || selected_anchor.is_some_and(|value| value.native_id == native_id)
    });
    if can_try_native {
        if native_intent.is_none() && !db.claim_external_operation(request.operation_id)? {
            return Err(anyhow!("operation_outcome_unknown"));
        }
        let native_id = source.native_id.as_deref().unwrap_or_default();
        let forked = if let Some((native_id, _)) = native_intent.as_ref() {
            Some(native_id.clone())
        } else {
            let result = providers
                .fork_session(&source.provider, cwd, native_id, selected_anchor, is_latest)
                .ok()
                .flatten()
                .filter(|value| !value.is_empty() && value != native_id);
            if let Some(forked_native_id) = result.as_deref() {
                // This is the first durable write after the provider-owned
                // fork. A process kill between the native response and this
                // write remains outcome-unknown and must never retry the
                // non-idempotent provider request.
                db.save_chat_fork_native_intent(
                    request.operation_id,
                    &source.id,
                    forked_native_id,
                )?;
            }
            result
        };
        if let Some(forked_native_id) = forked {
            if let Ok(history) = providers.history_read(&source.provider, &forked_native_id) {
                if let Ok(transcript) = serde_json::from_value::<Vec<ChatItem>>(history) {
                    let import_operation = derived(request.operation_id, "native-import");
                    if let Ok((child, created)) = db.import_history_session(ImportHistorySession {
                        project_id: source.project_id.as_deref(),
                        title: Some(&title),
                        provider: &source.provider,
                        mode: "chat",
                        cwd,
                        native_id: &forked_native_id,
                        operation_id: &import_operation,
                        transcript: &transcript,
                    }) {
                        if created && child.id != source.id {
                            db.save_chat_fork_child_intent(request.operation_id, &child.id)
                                .map_err(|_| anyhow!("operation_outcome_unknown"))?;
                            let resume_operation = derived(request.operation_id, "native-resume");
                            let workspace = source.worktree_path.as_deref().unwrap_or(cwd);
                            db.reserve_resume(&child.id, workspace, cwd, &resume_operation)
                                .map_err(|_| anyhow!("operation_outcome_unknown"))?;
                            finish_child(db, &source, &child, &title, &options)
                                .map_err(|_| anyhow!("operation_outcome_unknown"))?;
                            return db.complete_chat_fork(
                                &child.id,
                                &source.id,
                                request.item_id,
                                &source.title,
                                "native",
                                request.operation_id,
                            );
                        }
                    }
                }
            }
        }
    }

    let create_operation = derived(request.operation_id, "copy-create");
    let child = db.create_session(CreateSession {
        project_id: source.project_id.as_deref(),
        title: Some(&title),
        provider: &source.provider,
        mode: "chat",
        native_id: None,
        operation_id: &create_operation,
    })?;
    db.bind_session(
        &child.id,
        source.worktree_path.as_deref().or(Some(cwd)),
        None,
    )?;
    finish_child(db, &source, &child, &title, &options)?;
    let envelope = copied_conversation(&items, &copied_at)?;
    db.save_chat_draft(
        &child.id,
        &envelope,
        0,
        &derived(request.operation_id, "copy-draft"),
    )?;
    db.complete_chat_fork(
        &child.id,
        &source.id,
        request.item_id,
        &source.title,
        "copy",
        request.operation_id,
    )
}

fn finish_child(
    db: &Database,
    source: &Session,
    child: &Session,
    title: &str,
    options: &Value,
) -> Result<()> {
    db.bind_session(&child.id, source.worktree_path.as_deref(), None)?;
    db.clone_fork_launch_config(&source.id, &child.id, title, options)
}

fn ensure_source_idle(source: &Session) -> Result<()> {
    if matches!(source.status.as_str(), "starting" | "running" | "waiting")
        || source.activity.as_ref().is_some_and(|activity| {
            matches!(
                activity.state.as_str(),
                "running" | "awaiting_approval" | "awaiting_parent" | "waiting"
            )
        })
    {
        return Err(anyhow!("fork_source_active"));
    }
    Ok(())
}

fn completed_reply(items: &[ChatItem], index: usize) -> bool {
    let item = &items[index];
    let group = items
        .iter()
        .filter(|candidate| {
            item.turn_id
                .as_deref()
                .is_some_and(|turn| candidate.turn_id.as_deref() == Some(turn))
                || (item.turn_id.is_none() && candidate.id == item.id)
        })
        .collect::<Vec<_>>();
    let completed = (item.turn_status.is_none()
        && item.turn_origin == Some(crate::domain::ChatTurnOrigin::History)
        || group
            .iter()
            .any(|candidate| candidate.turn_status == Some(NativeTurnStatus::Completed)))
        && !group.iter().any(|candidate| {
            candidate
                .turn_status
                .is_some_and(|status| status != NativeTurnStatus::Completed)
        });
    item.role == "assistant"
        && completed
        && item.parts.iter().any(|part| {
            part.get("type").and_then(Value::as_str) == Some("text")
                && part.get("phase").and_then(Value::as_str) != Some("commentary")
                && part.pointer("/data/kind").and_then(Value::as_str) != Some("plan")
                && part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
        })
        && !item.parts.iter().any(|part| {
            matches!(
                part.get("status").and_then(Value::as_str),
                Some("streaming" | "running" | "pending")
            )
        })
}

fn fork_point(
    all_items: &[ChatItem],
    item_id: Option<&str>,
) -> Result<(Vec<ChatItem>, Option<NativeForkAnchor>, bool, String)> {
    let latest = (0..all_items.len()).rfind(|index| completed_reply(all_items, *index));
    let selected = match item_id {
        Some(id) => {
            let index = all_items
                .iter()
                .position(|item| item.id == id)
                .ok_or_else(|| anyhow!("fork_item_not_found"))?;
            if !completed_reply(all_items, index) {
                return Err(anyhow!("fork_point_invalid"));
            }
            Some(index)
        }
        None => latest,
    };
    let end = if item_id.is_some() {
        selected.map_or(all_items.len(), |index| index + 1)
    } else {
        all_items.len()
    };
    let anchor = selected.and_then(|index| all_items[index].fork_anchor.clone());
    let is_latest = item_id.is_none()
        || selected.is_some_and(|index| {
            // A saved projection can lag native history. Without a stable
            // point coordinate, a selected import must copy its saved text;
            // a native latest-only API would otherwise include unseen turns.
            if all_items[index].turn_origin == Some(crate::domain::ChatTurnOrigin::History)
                && anchor.as_ref().is_none_or(|anchor| anchor.turn_id.is_none()
                    && anchor.message_id.is_none() && anchor.entry_id.is_none())
            { return false; }
            let turn = all_items[index].turn_id.as_deref();
            !all_items[index + 1..].iter().any(|later| {
                later.role == "user"
                    || (later.turn_id.as_deref() != turn && !later.parts.is_empty())
                    || (later.role == "assistant"
                        && later.parts.iter().any(|part| {
                            part.get("type").and_then(Value::as_str) == Some("text")
                                && part
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|text| !text.trim().is_empty())
                        }))
            })
        });
    let copied_at = selected
        .and_then(|index| all_items.get(index))
        .or_else(|| all_items.last())
        .map(|item| item.created_at.clone())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    Ok((all_items[..end].to_vec(), anchor, is_latest, copied_at))
}

fn capture_options(db: &Database, providers: &Providers, session_id: &str) -> Value {
    let snapshot = providers
        .chat_options(session_id)
        .unwrap_or_else(|_| json!({"options":[]}));
    let options = snapshot
        .get("options")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            db.latest_chat_options(session_id)
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
        });
    Value::Array(
        options
            .iter()
            .filter_map(|option| {
                let id = option.get("id")?.as_str()?;
                let value = option.get("value")?;
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                (!id.is_empty()).then(|| json!({"id":id,"value":value}))
            })
            .collect(),
    )
}

pub(crate) fn apply_pending_options(
    db: &Database,
    providers: &Providers,
    session_id: &str,
) -> Result<()> {
    let pending = db.pending_fork_options(session_id)?;
    for option in pending.as_array().into_iter().flatten() {
        let id = option
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("invalid_fork_options"))?;
        let value = option
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("invalid_fork_options"))?;
        providers.chat_set_option(session_id, id, value)?;
    }
    db.clear_pending_fork_options(session_id)
}

fn copied_conversation(items: &[ChatItem], copied_at: &str) -> Result<String> {
    let blocks = items
        .iter()
        .filter_map(|item| {
            let text = item
                .parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then(|| format!("{}:\n{}", item.role, text.trim()))
        })
        .collect::<Vec<_>>();
    let transcript = cap_transcript(&blocks.join("\n\n"));
    Ok(format!(
        "{COPIED_CONVERSATION_PREFIX}{}",
        serde_json::to_string(&json!({
            "copiedAt":copied_at,
            "transcript":transcript,
            "text":"",
        }))?
    ))
}

fn cap_transcript(transcript: &str) -> String {
    if transcript.len() <= MAX_TRANSCRIPT_BYTES {
        return transcript.to_owned();
    }
    let keep = MAX_TRANSCRIPT_BYTES - OMITTED_NOTE.len();
    let mut start = transcript.len() - keep;
    while !transcript.is_char_boundary(start) {
        start += 1;
    }
    format!("{OMITTED_NOTE}{}", &transcript[start..])
}

fn fork_title(title: &str) -> String {
    let suffix = " (fork)";
    let max = 240usize.saturating_sub(suffix.len());
    let mut base = title.to_owned();
    while base.len() > max {
        base.pop();
    }
    format!("{base}{suffix}")
}

fn derived(operation_id: &str, suffix: &str) -> String {
    format!("{operation_id}:fork:{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    };

    struct ForkAdapter {
        calls: Arc<AtomicUsize>,
    }

    struct AdmissionAdapter {
        started: mpsc::Sender<()>,
        release: Mutex<Option<mpsc::Receiver<()>>>,
    }

    struct AdmissionChat {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl ChatSession for AdmissionChat {
        fn native_id(&self) -> Option<String> {
            None
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            self.started.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(json!({"turnId":"sent-turn"}))
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
    }

    impl ProviderAdapter for AdmissionAdapter {
        fn id(&self) -> &str {
            "fork-fixture"
        }
        fn capability(&self) -> ProviderCapability {
            ForkAdapter {
                calls: Arc::new(AtomicUsize::new(0)),
            }
            .capability()
        }
        fn terminal_command(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "chat only"))
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
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<Box<dyn ChatSession>, ProviderError> {
            Ok(Box::new(AdmissionChat {
                started: self.started.clone(),
                release: self.release.lock().unwrap().take().unwrap(),
            }))
        }
    }

    impl ProviderAdapter for ForkAdapter {
        fn id(&self) -> &str {
            "fork-fixture"
        }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability {
                source: "test",
                plugin_id: None,
                icon: None,
                sign_in: None,
                homepage: None,
                id: self.id().into(),
                name: "Fork fixture".into(),
                installed: true,
                version: None,
                terminal: false,
                chat: true,
                history: true,
                resume: true,
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
            Err(ProviderError::new("unsupported", "chat only"))
        }
        fn history_list(
            &self,
            _: Option<&str>,
            _: u32,
            _: Option<&str>,
        ) -> Result<Value, ProviderError> {
            Ok(json!({"items":[]}))
        }
        fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
            Ok(json!([{
                "id":"forked-answer","role":"assistant","parts":[{"type":"text","text":"forked"}],
                "createdAt":"2026-01-01T00:00:00Z","turnStatus":"completed",
                "forkAnchor":{"nativeId":native_id,"turnId":"forked-turn"}
            }]))
        }
        fn fork_session(
            &self,
            _: &str,
            native_id: &str,
            anchor: Option<&NativeForkAnchor>,
            is_latest: bool,
        ) -> Result<Option<String>, ProviderError> {
            assert_eq!(native_id, "source-native");
            assert_eq!(
                anchor.and_then(|value| value.turn_id.as_deref()),
                Some("source-turn")
            );
            assert!(is_latest);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Some("forked-native".into()))
        }
        fn open_chat(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<Box<dyn ChatSession>, ProviderError> {
            Err(ProviderError::new("unused", "unused"))
        }
    }

    fn source(db: &Database, root: &std::path::Path, native: Option<&str>) -> (Session, String) {
        crate::session_configs::initialize(db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Source"),
                provider: "fork-fixture",
                mode: "chat",
                native_id: native,
                operation_id: "source-create",
            })
            .unwrap();
        crate::session_configs::save_new(
            db,
            &session.id,
            &crate::session_configs::LaunchSpec {
                provider: "fork-fixture".into(),
                mode: "chat".into(),
                cwd: root.display().to_string(),
                project_id: None,
                title: Some("Source".into()),
                executable: Some("fixture".into()),
                args: vec!["--same".into()],
            },
            None,
        )
        .unwrap();
        db.bind_session(&session.id, Some(&root.display().to_string()), native)
            .unwrap();
        db.set_session_status(&session.id, "idle", None).unwrap();
        db.import_chat_history(
            &session.id,
            &[ChatItem {
                id: "answer".into(),
                role: "assistant".into(),
                parts: vec![json!({"type":"text","text":"hello"})],
                created_at: "2026-01-01T00:00:00Z".into(),
                turn_id: Some("turn".into()),
                elapsed_ms: None,
                turn_status: Some(NativeTurnStatus::Completed),
                turn_origin: None,
                fork_anchor: native.map(|native_id| NativeForkAnchor {
                    native_id: native_id.into(),
                    turn_id: Some("source-turn".into()),
                    message_id: None,
                    entry_id: None,
                }),
            }],
        )
        .unwrap();
        let item_id = db.chat_items(&session.id).unwrap()[0].id.clone();
        (db.session_by_id(&session.id).unwrap().unwrap(), item_id)
    }

    #[test]
    fn copied_transcript_is_utf8_safe_and_bounded() {
        let source = "界".repeat(MAX_TRANSCRIPT_BYTES);
        let capped = cap_transcript(&source);
        assert!(capped.len() <= MAX_TRANSCRIPT_BYTES);
        assert!(capped.starts_with(OMITTED_NOTE));
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
    }

    #[test]
    fn selected_point_requires_completed_assistant_reply() {
        let item = |id: &str, role: &str, status| ChatItem {
            id: id.into(),
            role: role.into(),
            parts: vec![json!({"type":"text","text":"ok"})],
            created_at: id.into(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: status,
            turn_origin: None,
            fork_anchor: None,
        };
        let items = vec![
            item("u", "user", None),
            item("a", "assistant", Some(NativeTurnStatus::Completed)),
        ];
        assert_eq!(fork_point(&items, Some("a")).unwrap().0.len(), 2);
        assert_eq!(
            fork_point(&items, Some("u")).unwrap_err().to_string(),
            "fork_point_invalid"
        );
        let whole = fork_point(&items, None).unwrap();
        assert_eq!(whole.0.len(), 2);
        assert!(whole.2);
        let trailing = vec![
            item("a", "assistant", Some(NativeTurnStatus::Completed)),
            item("later", "user", None),
        ];
        assert!(!fork_point(&trailing, Some("a")).unwrap().2);
        let unknown = vec![item(
            "unknown",
            "assistant",
            Some(NativeTurnStatus::Unknown),
        )];
        assert_eq!(
            fork_point(&unknown, Some("unknown"))
                .unwrap_err()
                .to_string(),
            "fork_point_invalid"
        );
        let mut reply = item("reply", "assistant", None);
        reply.turn_id = Some("live-turn".into());
        let mut boundary = item("boundary", "assistant", Some(NativeTurnStatus::Completed));
        boundary.turn_id = Some("live-turn".into());
        boundary.parts.clear();
        assert!(
            fork_point(&[reply.clone(), boundary], Some("reply"))
                .unwrap()
                .2
        );
        let mut failed_boundary = item(
            "failed-boundary",
            "assistant",
            Some(NativeTurnStatus::Failed),
        );
        failed_boundary.turn_id = Some("live-turn".into());
        failed_boundary.parts.clear();
        assert_eq!(
            fork_point(&[reply.clone(), failed_boundary], Some("reply"))
                .unwrap_err()
                .to_string(),
            "fork_point_invalid"
        );
        let mut later_text = item("later-text", "assistant", Some(NativeTurnStatus::Completed));
        later_text.turn_id = Some("live-turn".into());
        assert!(
            !fork_point(&[reply.clone(), later_text], Some("reply"))
                .unwrap()
                .2
        );
        reply.turn_status = Some(NativeTurnStatus::Failed);
        assert_eq!(
            fork_point(&[reply], Some("reply")).unwrap_err().to_string(),
            "fork_point_invalid"
        );
        let mut pending = item("pending", "assistant", Some(NativeTurnStatus::Completed));
        pending.parts[0]["status"] = json!("pending");
        assert_eq!(
            fork_point(&[pending], Some("pending"))
                .unwrap_err()
                .to_string(),
            "fork_point_invalid"
        );
        let mut plan = item("plan", "assistant", Some(NativeTurnStatus::Completed));
        plan.parts[0]["data"] = json!({"kind":"plan"});
        assert_eq!(
            fork_point(&[plan], Some("plan")).unwrap_err().to_string(),
            "fork_point_invalid"
        );
    }

    #[test]
    fn imported_statusless_reply_gets_anchor_without_inventing_turn_status() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-history-status.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Imported"),
                provider: "fork-fixture",
                mode: "chat",
                native_id: Some("history-native"),
                operation_id: "history-source",
            })
            .unwrap();
        let statusless = ChatItem {
            id: "statusless".into(),
            role: "assistant".into(),
            parts: vec![json!({"type":"text","text":"history reply"})],
            created_at: "now".into(),
            turn_id: Some("history-turn".into()),
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
        };
        assert_eq!(
            fork_point(&[statusless.clone()], Some("statusless"))
                .unwrap_err()
                .to_string(),
            "fork_point_invalid"
        );
        db.import_chat_history(&session.id, &[statusless]).unwrap();
        let imported = db.chat_items(&session.id).unwrap().pop().unwrap();
        assert_eq!(imported.turn_status, None);
        assert_eq!(
            imported.turn_origin,
            Some(crate::domain::ChatTurnOrigin::History)
        );
        assert_eq!(
            imported
                .fork_anchor
                .as_ref()
                .map(|anchor| anchor.native_id.as_str()),
            Some("history-native")
        );
        assert!(fork_point(&[imported.clone()], Some(&imported.id)).is_ok());
        assert!(!fork_point(&[imported.clone()], Some(&imported.id)).unwrap().2,
            "a selected saved reply without a point coordinate cannot prove the current native tip");
        assert!(fork_point(&[imported.clone()], None).unwrap().2,
            "whole-session forks intentionally use the current native session");
    }

    #[test]
    fn copy_fork_is_idempotent_preserves_source_and_persists_private_draft() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork.sqlite")).unwrap();
        let (source, item_id) = source(&db, root.path(), None);
        db.record_provider_event(
            &source.id,
            None,
            "chat.ui",
            &json!({
                "options":[{"id":"model","value":"kept-model","choices":[]}]
            }),
        )
        .unwrap();
        let before = db.chat_items(&source.id).unwrap();
        let providers = Providers::for_test(vec![]);
        // An interrupted local-only copy must not inherit the terminal
        // uncertainty fence needed by non-idempotent provider calls.
        db.claim_external_operation("fork-copy").unwrap();
        let request = || ForkRequest {
            session_id: &source.id,
            item_id: Some(&item_id),
            operation_id: "fork-copy",
        };
        let first = fork(&db, &providers, request()).unwrap();
        let second = fork(&db, &providers, request()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["mode"], "copy");
        assert_eq!(db.chat_items(&source.id).unwrap(), before);
        let child: Session = serde_json::from_value(first["session"].clone()).unwrap();
        assert_eq!(
            child.organization.forked_from.as_ref().unwrap().session_id,
            source.id
        );
        assert_eq!(
            child
                .organization
                .forked_from
                .as_ref()
                .unwrap()
                .item_id
                .as_deref(),
            Some(item_id.as_str())
        );
        let draft = db.chat_draft(&child.id).unwrap();
        assert!(draft["text"]
            .as_str()
            .unwrap()
            .starts_with(COPIED_CONVERSATION_PREFIX));
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
        let config = crate::session_configs::read(&db, &child.id)
            .unwrap()
            .unwrap();
        assert_eq!(config.launch.args, ["--same"]);
        assert_eq!(
            config.source_session_id.as_deref(),
            Some(source.id.as_str())
        );
        assert_eq!(
            db.pending_fork_options(&child.id).unwrap()[0]["value"],
            "kept-model"
        );
    }

    #[test]
    fn native_fork_uses_anchor_once_and_creates_interactive_child() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-native.sqlite")).unwrap();
        let (source, item_id) = source(&db, root.path(), Some("source-native"));
        let calls = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(ForkAdapter {
            calls: Arc::clone(&calls),
        })]);
        let request = || ForkRequest {
            session_id: &source.id,
            item_id: Some(&item_id),
            operation_id: "fork-native",
        };
        let first = fork(&db, &providers, request()).unwrap();
        let second = fork(&db, &providers, request()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["mode"], "native");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let child = db
            .session_by_id(first["session"]["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(child.native_id.as_deref(), Some("forked-native"));
        assert!(!child.read_only);
        assert_ne!(child.id, source.id);
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
    }

    #[test]
    fn retry_repairs_copy_draft_after_child_creation() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-copy-repair.sqlite")).unwrap();
        let (source, item_id) = source(&db, root.path(), None);
        let create_operation = derived("fork-recover-copy", "copy-create");
        let child = db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Source (fork)"),
                provider: &source.provider,
                mode: "chat",
                native_id: None,
                operation_id: &create_operation,
            })
            .unwrap();
        assert_eq!(db.chat_draft(&child.id).unwrap()["text"], "");
        let result = fork(
            &db,
            &Providers::for_test(vec![]),
            ForkRequest {
                session_id: &source.id,
                item_id: Some(&item_id),
                operation_id: "fork-recover-copy",
            },
        )
        .unwrap();
        assert_eq!(result["session"]["id"], child.id);
        assert!(db.chat_draft(&child.id).unwrap()["text"]
            .as_str()
            .unwrap()
            .starts_with(COPIED_CONVERSATION_PREFIX));
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
    }

    #[test]
    fn retry_resumes_existing_native_import_without_reforking() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-native-repair.sqlite")).unwrap();
        let (source, item_id) = source(&db, root.path(), Some("source-native"));
        let imported = db
            .import_history_session(ImportHistorySession {
                project_id: None,
                title: Some("Source (fork)"),
                provider: &source.provider,
                mode: "chat",
                cwd: &root.path().display().to_string(),
                native_id: "already-forked",
                operation_id: &derived("fork-recover-native", "native-import"),
                transcript: &[],
            })
            .unwrap()
            .0;
        db.save_chat_fork_native_intent("fork-recover-native", &source.id, "already-forked")
            .unwrap();
        assert!(imported.read_only);
        let calls = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(ForkAdapter {
            calls: Arc::clone(&calls),
        })]);
        let result = fork(
            &db,
            &providers,
            ForkRequest {
                session_id: &source.id,
                item_id: Some(&item_id),
                operation_id: "fork-recover-native",
            },
        )
        .unwrap();
        assert_eq!(result["session"]["id"], imported.id);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!db.session_by_id(&imported.id).unwrap().unwrap().read_only);
        assert_eq!(
            db.chat_fork_intent("fork-recover-native")
                .unwrap()
                .unwrap()
                .1
                .as_deref(),
            Some(imported.id.as_str())
        );
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
    }

    #[test]
    fn retry_with_persisted_native_id_imports_without_reforking() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-native-intent.sqlite")).unwrap();
        let (source, item_id) = source(&db, root.path(), Some("source-native"));
        db.save_chat_fork_native_intent("fork-known-native", &source.id, "forked-native")
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(ForkAdapter {
            calls: Arc::clone(&calls),
        })]);
        let result = fork(
            &db,
            &providers,
            ForkRequest {
                session_id: &source.id,
                item_id: Some(&item_id),
                operation_id: "fork-known-native",
            },
        )
        .unwrap();
        assert_eq!(result["mode"], "native");
        assert_eq!(result["session"]["nativeId"], "forked-native");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
    }

    #[test]
    fn concurrent_send_admission_prevents_forking_a_turn_that_just_started() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("fork-send-race.sqlite")).unwrap());
        let (source, item_id) = source(&db, root.path(), None);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let providers = Arc::new(Providers::for_test(vec![Arc::new(AdmissionAdapter {
            started: started_tx,
            release: Mutex::new(Some(release_rx)),
        })]));
        providers
            .chat_open(
                &source.id,
                &source.provider,
                &root.path().display().to_string(),
                None,
            )
            .unwrap();
        db.accept_chat_connection(&source.id, None).unwrap();
        let send_db = Arc::clone(&db);
        let send_providers = Arc::clone(&providers);
        let source_id = source.id.clone();
        let send = std::thread::spawn(move || {
            crate::service::send_chat_message(
                &send_db,
                &send_providers,
                &source_id,
                "new message",
                &[],
                "send-race",
            )
        });
        started_rx.recv().unwrap();
        let fork_db = Arc::clone(&db);
        let fork_providers = Arc::clone(&providers);
        let fork_source = source.id.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let fork_thread = std::thread::spawn(move || {
            let result = fork(
                &fork_db,
                &fork_providers,
                ForkRequest {
                    session_id: &fork_source,
                    item_id: Some(&item_id),
                    operation_id: "fork-race",
                },
            );
            result_tx.send(result.map(|_| ())).unwrap();
        });
        assert!(
            result_rx.try_recv().is_err(),
            "fork crossed the active send admission gate"
        );
        release_tx.send(()).unwrap();
        send.join().unwrap().unwrap();
        assert_eq!(
            result_rx.recv().unwrap().unwrap_err().to_string(),
            "fork_source_active"
        );
        fork_thread.join().unwrap();
        assert_eq!(db.snapshot().unwrap().sessions.len(), 1);
    }

    #[test]
    fn legacy_queued_fork_routes_through_common_send_without_provider_send() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork-legacy-queue.sqlite")).unwrap();
        let (source, _) = source(&db, root.path(), None);
        db.bind_operation(
            "queue:legacy",
            "chat.queue.dispatch",
            &json!({"sessionId":source.id,"itemId":"legacy"}),
        )
        .unwrap();
        let result = crate::service::send_chat_message(
            &db,
            &Providers::for_test(vec![]),
            &source.id,
            "/fork",
            &[],
            "queue:legacy",
        )
        .unwrap();
        assert_eq!(result["turnId"], "queue:legacy:fork");
        assert_eq!(
            db.operation("queue:legacy:fork").unwrap().unwrap()["mode"],
            "copy"
        );
        assert_eq!(db.operation("queue:legacy").unwrap().unwrap(), result);
        assert_eq!(db.snapshot().unwrap().sessions.len(), 2);
    }
}
