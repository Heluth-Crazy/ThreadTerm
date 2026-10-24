//! Native Pi provider: terminal sessions plus `pi --mode rpc` Chat.
//!
//! Pi speaks a flat JSONL command/response protocol that is neither JSON-RPC
//! nor ACP, so this adapter drives it through `JsonLineProcess` with the
//! dedicated `EnvelopeStyle::Pi` framing. Each Chat session owns one long-lived
//! `pi --mode rpc` process.
use super::{
    builtin_name,
    common::{
        history_page, percent_used, validate_native_id, version_probe, CommandSpec, EnvelopeStyle,
        JsonLineProcess, JsonLineRequester, JsonLineResponder,
    },
    emit_bound as emit, ChatSession, NativeForkAnchor, ProviderAdapter, ProviderCapability, ProviderError,
    ScopedProviderEvents, TerminalCapture, TerminalCommand,
};
use crate::pi_project_trust;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use uuid::Uuid;

const PI_HOME: &str = "https://github.com/earendil-works/pi";
const MAX_SESSION_FILES: usize = 512;
const HEAD_BYTES: u64 = 64 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;
const RESOLVED_UI_IDS: usize = 256;
/// Separates provider and model id in a chat option value. The unit separator
/// cannot appear in either, so the round trip is unambiguous even though pi
/// model ids themselves contain `/` (for example `stealth/ox-alpha`).
const PI_MODEL_SEPARATOR: char = '\u{1f}';
/// Pi handles these in its TUI, not through `prompt`, so the adapter executes
/// them from the composer's slash menu and answers with a text turn.
const PI_BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("compact", "Compact the conversation context"),
    ("model", "Show or switch the model"),
    ("thinking", "Show or set the thinking level"),
    ("name", "Rename this session"),
    ("session", "Show session statistics"),
    ("export", "Export the session to HTML"),
    ("new", "Start a fresh session"),
    ("help", "List available commands"),
];

pub struct PiAdapter {
    events: crate::provider_events::Sender,
}

impl PiAdapter {
    pub fn new(events: crate::provider_events::Sender) -> Self {
        Self { events }
    }
}

impl ProviderAdapter for PiAdapter {
    fn id(&self) -> &str {
        "pi"
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, error) = version_probe("pi");
        ProviderCapability {
            id: "pi".to_owned(),
            name: builtin_name("pi").to_owned(),
            installed,
            version,
            terminal: installed,
            chat: installed,
            history: installed,
            resume: installed,
            terminal_resume_capture: TerminalCapture::PreAssigned.as_str(),
            reason: error,
            auth: "unknown".to_owned(),
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: Some(PI_HOME.to_owned()),
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        if resume_id.is_some() && assign_id.is_some() {
            return Err(ProviderError::new(
                "provider_invalid_request",
                "terminal resume and assignment cannot both be requested",
            ));
        }
        let owned = pi_terminal_args(resume_id, assign_id, pi_session_saved)?;
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        let spec = CommandSpec::provider("pi", &refs)?;
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    fn terminal_capture(&self) -> TerminalCapture {
        // `pi --session-id` binds the conversation identity before the PTY starts.
        TerminalCapture::PreAssigned
    }

    fn prepare_terminal(&self, _cwd: &str) -> Result<Option<String>, ProviderError> {
        // Pi accepts a native CLI flag for the id, so no provider API call and
        // no verification round trip are needed before launch.
        Ok(Some(Uuid::new_v4().to_string()))
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let directory = pi_sessions_dir()?;
        let mut files = Vec::new();
        walk_jsonl(&directory, &mut files, MAX_SESSION_FILES);
        let mut rows = Vec::new();
        for path in files {
            let Some((native_id, session_cwd)) = pi_session_identity(&path) else {
                continue;
            };
            if let Some(expected) = cwd {
                if !same_path(&session_cwd, expected) {
                    continue;
                }
            }
            let tail = read_bounded(&path, TAIL_BYTES, true).unwrap_or_default();
            let title = pi_tail_title(&tail).unwrap_or_else(|| "Pi session".to_owned());
            let updated_at = pi_tail_updated_at(&tail).unwrap_or_else(|| file_timestamp(&path));
            rows.push(json!({
                "provider": "pi",
                "nativeId": native_id,
                "title": title,
                "updatedAt": updated_at,
                "cwd": session_cwd,
                "resumable": true
            }));
        }
        rows.sort_by(|left, right| {
            right["updatedAt"]
                .as_str()
                .unwrap_or_default()
                .cmp(left["updatedAt"].as_str().unwrap_or_default())
        });
        let offset = cursor
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let total = rows.len();
        let items = rows
            .into_iter()
            .skip(offset)
            .take(limit as usize)
            .collect::<Vec<_>>();
        let consumed = offset + items.len();
        let next_cursor = (consumed < total).then(|| json!(consumed.to_string()));
        Ok(history_page(items, next_cursor))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let directory = pi_sessions_dir()?;
        let mut files = Vec::new();
        walk_jsonl(&directory, &mut files, MAX_SESSION_FILES);
        let path = files
            .into_iter()
            .find(|path| pi_session_identity(path).is_some_and(|(id, _)| id == native_id))
            .ok_or_else(|| {
                ProviderError::new("history_unavailable", "No Pi session matches that id")
            })?;
        let text = fs::read_to_string(&path).map_err(|error| {
            ProviderError::new(
                "history_unavailable",
                format!("Failed reading the Pi session: {error}"),
            )
        })?;
        Ok(Value::Array(pi_transcript(&text, native_id)))
    }

    fn fork_session(
        &self,
        cwd: &str,
        native_id: &str,
        anchor: Option<&NativeForkAnchor>,
        is_latest: bool,
    ) -> Result<Option<String>, ProviderError> {
        validate_native_id(native_id)?;
        if let Some(anchor) = anchor {
            if anchor.native_id != native_id {
                return Err(ProviderError::new(
                    "invalid_fork_anchor",
                    "Pi fork anchor does not belong to this native session",
                ));
            }
        }

        // Pi's fork and clone change the process's active session.  Always use
        // a short-lived resumed control process, never the visible Chat worker.
        let process = pi_fork_control(cwd, native_id)?;
        let anchored_entry = anchor
            .and_then(|anchor| anchor.entry_id.as_deref())
            .filter(|entry_id| !entry_id.is_empty());
        let result = if let Some(entry_id) = anchored_entry {
            // A persisted UI transcript can be stale while Pi's active branch
            // has already advanced. Inspect native entries even when the
            // service classified this reply as latest: fork before the next
            // active user entry rather than cloning a newer branch.
            let entries = process.request("get_entries", json!({}))?;
            let Some(next_user_entry) = pi_fork_target(&entries, entry_id) else {
                return Ok(None);
            };
            match next_user_entry {
                Some(next_user_entry) => process.request("fork", json!({"entryId":next_user_entry}))?,
                None => process.request("clone", json!({}))?,
            }
        } else if is_latest {
            // Generic live completion anchors intentionally carry no Pi entry
            // coordinate. A whole/latest fork may still clone the current
            // native branch, while an older unbound reply must copy-fallback.
            process.request("clone", json!({}))?
        } else {
            return Ok(None);
        };
        if result.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Ok(None);
        }
        // Pi replies to fork/clone with text only. The selected native identity
        // is observable through get_state after the mutation.
        let state = process.request("get_state", json!({}))?;
        let Some(forked) = state.get("sessionId").and_then(Value::as_str) else {
            return Err(ProviderError::new(
                "provider_protocol",
                "Pi fork did not select a new session id",
            ));
        };
        validate_native_id(forked)?;
        if forked == native_id {
            return Err(ProviderError::new(
                "provider_protocol",
                "Pi fork retained the source session id",
            ));
        }
        Ok(Some(forked.to_owned()))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_scoped(session_id, cwd, native_id, "pi")
    }

    fn scopes_chat_events(&self) -> bool {
        // Every Pi event is emitted through a worker-scoped sender so a
        // replaced worker generation can no longer enter the projection.
        true
    }

    fn open_chat_scoped(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_scoped_with_project_trust(session_id, cwd, native_id, worker_token, None, None, false)
    }

    fn open_chat_with_project_trust(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        _tools: Option<&super::ChatToolServer>,
        decision: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_scoped_with_project_trust(session_id, cwd, native_id, worker_token, decision, None, false)
    }

    fn open_chat_with_startup_options(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        tools: Option<&super::ChatToolServer>,
        startup: &super::ChatStartupOptions<'_>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let _ = tools;
        let staged_read_only_tools = pi_staged_read_only_tools(startup);
        let read_only_tools = startup.pi_read_only_tools.then_some(staged_read_only_tools).flatten();
        if let Some(value) = read_only_tools {
            if value != "read,grep,find,ls" {
                return Err(ProviderError::new("chat_permission_restore_failed", "Invalid Pi Roundtable tool allowlist"));
            }
        }
        self.open_chat_scoped_with_project_trust(
            session_id, cwd, native_id, worker_token, startup.project_trust, read_only_tools,
            staged_read_only_tools.is_some(),
        )
    }
}

impl PiAdapter {
    fn open_chat_scoped_with_project_trust(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        decision: Option<&str>,
        read_only_tools: Option<&str>,
        roundtable_read_only_requested: bool,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let shared = Arc::new(PiShared::default());
        // Capture once: trust inspection and the child process must observe
        // one environment, including a just-installed PI_CODING_AGENT_DIR.
        let launch_environment =
            crate::environment::for_terminal().unwrap_or_else(|| std::env::vars_os().collect());
        let agent_home = pi_environment_value(&launch_environment, "USERPROFILE")
            .or_else(|| pi_environment_value(&launch_environment, "HOME"));
        let resource_home = pi_environment_value(&launch_environment, "HOME")
            .or_else(|| pi_environment_value(&launch_environment, "USERPROFILE"));
        let agent_dir = pi_project_trust::agent_dir_for(
            pi_environment_value(&launch_environment, "PI_CODING_AGENT_DIR"),
            agent_home,
            Some(Path::new(cwd)),
        );
        if let Ok(mut ui) = shared.ui.lock() {
            ui.trust = Some(match agent_dir.as_deref() {
                Some(agent_dir) => pi_project_trust::compute_with_home(
                    Path::new(cwd),
                    agent_dir,
                    resource_home,
                    decision,
                ),
                None => pi_project_trust::compute_without_agent_dir(
                    Path::new(cwd),
                    resource_home,
                    decision,
                ),
            });
            if roundtable_read_only_requested {
                ui.roundtable_tools = Some(json!({
                    "enforced": read_only_tools.is_some(),
                    "reason": if read_only_tools.is_some() {
                        "Pi started with its verified read-only tool allowlist"
                    } else {
                        "Pi tool allowlist was not verified before startup"
                    }
                }));
            }
        }
        let events = ScopedProviderEvents::new(self.events.clone(), worker_token);
        let callback_events = events.clone();
        let callback_session = session_id.to_owned();
        let callback_shared = Arc::clone(&shared);
        let on_message: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |raw: Value| {
            pi_event(
                &callback_events,
                "pi",
                &callback_session,
                &callback_shared,
                raw,
            );
        });

        let mut args: Vec<String> = vec!["--mode".to_owned(), "rpc".to_owned()];
        if let Some(flag) = pi_project_trust::launch_flag(decision) {
            args.push(flag.to_owned());
        }
        args.extend(pi_read_only_args(read_only_tools));
        if let Some(id) = native_id {
            validate_native_id(id)?;
            // Pi saves a session with its first message. A chat reopened before
            // that (project trust, Reconnect, a runtime restart) has nothing to
            // resume and `--session` would exit; `--session-id` creates it under
            // the same id instead.
            args.push(pi_resume_flag(pi_session_saved(id)).to_owned());
            args.push(id.to_owned());
            if let Ok(mut value) = shared.native_id.lock() {
                value.get_or_insert_with(|| id.to_owned());
            }
        } else {
            // Bind the native identity before the first turn so the session can
            // be resumed even if it ends before any message arrives.
            let id = Uuid::new_v4().to_string();
            args.push("--session-id".to_owned());
            args.push(id.clone());
            if let Ok(mut value) = shared.native_id.lock() {
                *value = Some(id);
            }
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let spec = CommandSpec::provider("pi", &refs)?;
        let process =
            JsonLineProcess::spawn_with_environment("pi", &spec, Some(cwd), &[],
            Some(&launch_environment), EnvelopeStyle::Pi, on_message)?;
        // Pi may emit an extension UI request during startup. Publish the responder
        // and drain those records atomically with respect to the stdout callback.
        let queued_ui = {
            let mut control = shared
                .control
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "Pi control lock poisoned"))?;
            control.responder = Some(process.responder());
            std::mem::take(&mut control.queued_ui)
        };
        if let Ok(mut slot) = shared.requester.lock() {
            *slot = Some(Arc::new(process.requester()));
        }
        for raw in queued_ui {
            pi_event(&events, "pi", session_id, &shared, raw);
        }
        let chat = PiChat {
            session_id: session_id.to_owned(),
            shared,
            events,
            process,
            retired: false,
        };
        // Resolve the durable identity and the live option snapshot.
        chat.refresh_ui();
        Ok(Box::new(chat))
    }
}

fn pi_read_only_args(read_only_tools: Option<&str>) -> Vec<String> {
    let Some(tools) = read_only_tools else { return Vec::new(); };
    vec![
        "--no-mcp".to_owned(),
        "--no-extensions".to_owned(),
        "--tools".to_owned(),
        tools.to_owned(),
    ]
}

fn pi_staged_read_only_tools<'a>(
    startup: &super::ChatStartupOptions<'a>,
) -> Option<&'a str> {
    startup
        .permissions
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| option["id"] == "roundtable-tools")
        .and_then(|option| option["value"].as_str())
}

/// State shared with the stdout reader thread; it outlives every borrow of
/// `PiChat` that the reader might otherwise need.
#[derive(Default)]
struct PiShared {
    native_id: Mutex<Option<String>>,
    active_turn: Mutex<Option<String>>,
    started: Mutex<Option<Instant>>,
    /// The most recent failed attempt. Kept unpublished until the turn settles,
    /// because pi may still recover through its own retry budget.
    pending_error: Mutex<Option<Value>>,
    /// Pi splits one tool call across start/update/end frames. Keep only the
    /// stable call identity and arguments for the active turn so a sparse end
    /// frame cannot erase the useful description from the durable projection.
    tool_calls: Mutex<PiToolCalls>,
    ui: Mutex<PiUi>,
    control: Mutex<PiControl>,
    interactions: Mutex<HashMap<String, PiInteraction>>,
    /// Lets the stdout callback issue a non-blocking usage query after the turn
    /// settles without owning the process.
    requester: Mutex<Option<Arc<dyn PiStatsRequester>>>,
    /// Settlement/read generation. Publication shares this lock with advancing
    /// the generation, so an old callback cannot enqueue after a newer read.
    context_sequence: Arc<Mutex<u64>>,
    /// A bounded exact-id fence prevents Pi extension replays from reopening a
    /// card after its response/cancellation has been written.
    resolved_interactions: Mutex<VecDeque<String>>,
    /// The turn whose reply text has started, and whether its next text opens a
    /// new paragraph. Every assistant message of a turn streams into one item.
    reply_text: Mutex<Option<(String, bool)>>,
    /// Token usage summed over the turn's assistant messages, for its footer.
    turn_usage: Mutex<Option<(String, Value)>>,
}

const PI_TOOL_CALL_LIMIT: usize = 128;

/// A later assistant message's text starts a new paragraph instead of running on
/// from the previous message ("…searching for TODOs.Steps 1–2 complete").
fn pi_reply_delta(shared: &PiShared, turn: Option<&str>, delta: &str) -> String {
    let (Some(turn), Ok(mut reply)) = (turn, shared.reply_text.lock()) else {
        return delta.to_owned();
    };
    let paragraph = matches!(reply.as_ref(), Some((current, true)) if current == turn);
    *reply = Some((turn.to_owned(), false));
    if paragraph { format!("\n\n{delta}") } else { delta.to_owned() }
}

type PiStatsCallback = Box<dyn FnOnce(Result<Value, ProviderError>) + Send>;

trait PiStatsRequester: Send + Sync {
    fn request_stats(&self, callback: PiStatsCallback) -> Result<(), ProviderError>;
}

impl PiStatsRequester for JsonLineRequester {
    fn request_stats(&self, callback: PiStatsCallback) -> Result<(), ProviderError> {
        self.request_async_latest("pi.context", "get_session_stats", json!({}), Duration::from_secs(10), callback).map(|_| ())
    }
}

#[derive(Clone)]
struct PiToolCall {
    name: String,
    args: Value,
}

#[derive(Default)]
struct PiToolCalls {
    owner: Option<String>,
    calls: HashMap<String, PiToolCall>,
}

#[derive(Default)]
struct PiControl {
    responder: Option<JsonLineResponder>,
    queued_ui: Vec<Value>,
}

struct PiInteraction {
    turn_id: String,
    data: Value,
    state: super::approval::PendingApprovalState,
}

#[derive(Default)]
struct PiUi {
    state: Option<Value>,
    models: Vec<Value>,
    thinking_levels: Vec<String>,
    commands: Vec<Value>,
    /// Pi's `get_state` does not report auto-retry, so the adapter tracks the
    /// last value it set (Pi enables it by default).
    auto_retry: Option<bool>,
    trust: Option<Value>,
    roundtable_tools: Option<Value>,
}

struct PiChat {
    session_id: String,
    shared: Arc<PiShared>,
    events: ScopedProviderEvents,
    process: JsonLineProcess,
    retired: bool,
}

impl PiChat {
    fn native(&self) -> Option<String> {
        self.shared
            .native_id
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn active_turn(&self) -> Option<String> {
        self.shared
            .active_turn
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    /// Settles the current turn at most once, whichever path observes it first.
    fn finish_turn(&self, stop_reason: &str, elapsed_ms: Option<u64>) {
        pi_finish_turn(&self.events, &self.session_id, &self.shared, stop_reason, elapsed_ms);
    }

    fn drain_interactions(&self, turn_id: Option<&str>) {
        pi_drain_interactions(
            &self.events,
            &self.session_id,
            self.native().as_deref(),
            &self.shared,
            turn_id,
        );
    }

    /// Re-reads the durable identity and the live option snapshot. Called after
    /// open and after any model/thinking change, because pi clamps and re-scopes
    /// these per model.
    fn refresh_ui(&self) {
        let state = self.process.request("get_state", json!({})).ok();
        let models = self
            .process
            .request("get_available_models", json!({}))
            .ok()
            .and_then(|value| value.get("models").and_then(Value::as_array).cloned());
        let levels = self
            .process
            .request("get_available_thinking_levels", json!({}))
            .ok()
            .and_then(|value| value.get("levels").and_then(Value::as_array).cloned());
        let commands = self
            .process
            .request("get_commands", json!({}))
            .ok()
            .and_then(|value| value.get("commands").and_then(Value::as_array).cloned());
        if let Some(state) = &state {
            if let Some(id) = state.get("sessionId").and_then(Value::as_str) {
                if let Ok(mut value) = self.shared.native_id.lock() {
                    *value = Some(id.to_owned());
                }
            }
        }
        if let Ok(mut ui) = self.shared.ui.lock() {
            if let Some(state) = state {
                ui.state = Some(state);
            }
            if let Some(models) = models {
                ui.models = models;
            }
            if let Some(levels) = levels {
                ui.thinking_levels = levels
                    .iter()
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect();
            }
            if let Some(commands) = commands {
                ui.commands = merge_builtin_commands(commands);
            }
        }
        // Other open views (and a change made by a Pi slash command) learn the
        // new state only from this event; without it the model chip stayed stale.
        let mut data = self.ui_state();
        data["sessionId"] = json!(self.session_id);
        emit(&self.events, "pi", &self.session_id, self.native().as_deref(), None, "chat.ui", data);
    }

    /// Publishes a locally-handled slash command as one complete text turn.
    fn reply_local(&self, operation_id: &str, text: &str) {
        let native = self.native();
        emit(
            &self.events,
            "pi",
            &self.session_id,
            native.as_deref(),
            Some(operation_id),
            "chat.turn.started",
            pi_turn_start(&self.shared),
        );
        emit(
            &self.events,
            "pi",
            &self.session_id,
            native.as_deref(),
            Some(operation_id),
            "chat.item",
            json!({"parts":[{"type":"text","text":text,"status":"complete"}]}),
        );
        emit(
            &self.events,
            "pi",
            &self.session_id,
            native.as_deref(),
            Some(operation_id),
            "chat.turn.completed",
            json!({"result":{"stopReason":"end_turn"}}),
        );
    }

    /// Executes pi's TUI-level slash commands, which `prompt` cannot run. A
    /// name the adapter does not own returns `None` and flows through `prompt`
    /// so extension, prompt-template, and skill commands keep working.
    fn dispatch_slash(
        &self,
        text: &str,
        operation_id: &str,
    ) -> Result<Option<Value>, ProviderError> {
        let Some((name, args)) = parse_slash(text) else {
            return Ok(None);
        };
        let reply = match name {
            "help" => PI_BUILTIN_COMMANDS
                .iter()
                .map(|(name, description)| format!("/{name} - {description}"))
                .collect::<Vec<_>>()
                .join("\n"),
            "compact" => {
                let params = if args.is_empty() {
                    json!({})
                } else {
                    json!({"customInstructions":args})
                };
                let data = self.process.request("compact", params)?;
                pi_reset_context(&self.events, &self.session_id, &self.shared);
                match (
                    data.get("tokensBefore").and_then(Value::as_u64),
                    data.get("estimatedTokensAfter").and_then(Value::as_u64),
                ) {
                    (Some(before), Some(after)) => {
                        format!("Compacted the context: {before} -> {after} tokens (estimated).")
                    }
                    _ => "Compacted the context.".to_owned(),
                }
            }
            "thinking" => {
                if args.is_empty() {
                    self.refresh_ui();
                    let (current, levels) = {
                        let ui = self.shared.ui.lock().map_err(|_| {
                            ProviderError::new("provider_internal", "Pi UI lock poisoned")
                        })?;
                        (
                            ui.state
                                .as_ref()
                                .and_then(|state| state.get("thinkingLevel"))
                                .and_then(Value::as_str)
                                .unwrap_or("off")
                                .to_owned(),
                            ui.thinking_levels.join(", "),
                        )
                    };
                    format!("Thinking level: {current}. Available: {levels}.")
                } else {
                    self.process
                        .request("set_thinking_level", json!({"level":args}))?;
                    self.refresh_ui();
                    format!("Thinking level set to {args}.")
                }
            }
            "model" => {
                self.refresh_ui();
                let (current, models) = {
                    let ui = self.shared.ui.lock().map_err(|_| {
                        ProviderError::new("provider_internal", "Pi UI lock poisoned")
                    })?;
                    (
                        ui.state
                            .as_ref()
                            .and_then(|state| state.get("model"))
                            .and_then(|model| model.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        ui.models.clone(),
                    )
                };
                if args.is_empty() {
                    let mut lines = vec![format!("Current model: {current}")];
                    for model in &models {
                        if let Some(id) = model.get("id").and_then(Value::as_str) {
                            let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
                            let provider = model
                                .get("provider")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            lines.push(format!("- {name} ({provider}/{id})"));
                        }
                    }
                    lines.join("\n")
                } else if let Some(model) = models.iter().find(|model| {
                    model.get("id").and_then(Value::as_str) == Some(args)
                        || model.get("name").and_then(Value::as_str) == Some(args)
                        || pi_model_value(model).as_deref() == Some(args)
                }) {
                    let provider = model
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let id = model
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let name = model
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_owned();
                    let mut params = json!({"modelId":id});
                    if !provider.is_empty() {
                        params["provider"] = json!(provider);
                    }
                    self.process.request("set_model", params)?;
                    self.refresh_ui();
                    format!("Model set to {name}.")
                } else {
                    format!("No configured model matches '{args}'.")
                }
            }
            "name" => {
                if args.is_empty() {
                    "Usage: /name <session name>".to_owned()
                } else {
                    self.process
                        .request("set_session_name", json!({"name":args}))?;
                    format!("Session renamed to {args}.")
                }
            }
            "session" => {
                let data = self.process.request("get_session_stats", json!({}))?;
                let mut parts = vec![format!(
                    "Messages: {} user / {} assistant",
                    data.get("userMessages")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    data.get("assistantMessages")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                )];
                if let Some(tokens) = data.pointer("/tokens/total").and_then(Value::as_u64) {
                    parts.push(format!("Tokens: {tokens}"));
                }
                if let (Some(tokens), Some(window)) = (
                    data.pointer("/contextUsage/tokens").and_then(Value::as_u64),
                    data.pointer("/contextUsage/contextWindow")
                        .and_then(Value::as_u64),
                ) {
                    parts.push(format!("Context: {tokens}/{window}"));
                }
                if let Some(cost) = data.get("cost").and_then(Value::as_f64) {
                    parts.push(format!("Cost: ${cost:.4}"));
                }
                parts.join("\n")
            }
            "export" => {
                let data = self.process.request("export_html", json!({}))?;
                match data.get("path").and_then(Value::as_str) {
                    Some(path) => format!("Exported the session to {path}."),
                    None => "Exported the session.".to_owned(),
                }
            }
            "new" => {
                let previous = self.native();
                let data = self.process.request("new_session", json!({}))?;
                if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
                    "New session was cancelled.".to_owned()
                } else {
                    self.refresh_ui();
                    let native = self.native();
                    if previous != native {
                        emit(&self.events, "pi", &self.session_id, native.as_deref(), None,
                            "chat.session.replaced", json!({"previousNativeId":previous}));
                    }
                    pi_reset_context(&self.events, &self.session_id, &self.shared);
                    "Started a fresh session.".to_owned()
                }
            }
            _ => return Ok(None),
        };
        self.reply_local(operation_id, &reply);
        Ok(Some(json!({"turnId":operation_id})))
    }
}

impl ChatSession for PiChat {
    fn native_id(&self) -> Option<String> {
        self.native()
    }

    fn is_alive(&self) -> bool {
        !self.retired && self.process.is_alive()
    }

    fn validate_send(&self, _text: &str) -> Result<(), ProviderError> {
        if self.retired {
            return Err(ProviderError::new(
                "provider_disconnected",
                "Pi is reconnecting",
            ));
        }
        Ok(())
    }

    fn validate_restart(&self) -> Result<(), ProviderError> {
        if self.retired {
            return Err(ProviderError::new(
                "provider_disconnected",
                "Pi is reconnecting",
            ));
        }
        if self.active_turn().is_some() {
            return Err(ProviderError::new(
                "turn_in_progress",
                "Pi cannot reconnect during an active turn",
            ));
        }
        Ok(())
    }

    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        self.validate_send(text)?;
        validate_native_id(operation_id)?;
        if self.active_turn().is_some() {
            return Err(ProviderError::new(
                "turn_in_progress",
                "This Pi session already has an active turn",
            ));
        }
        if let Some(result) = self.dispatch_slash(text, operation_id)? {
            return Ok(result);
        }
        {
            let mut active =
                self.shared.active_turn.lock().map_err(|_| {
                    ProviderError::new("provider_internal", "Pi turn lock poisoned")
                })?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "This Pi session already has an active turn",
                ));
            }
            if let Ok(mut calls) = self.shared.tool_calls.lock() {
                calls.owner = Some(operation_id.to_owned());
                calls.calls.clear();
            }
            *active = Some(operation_id.to_owned());
            if let Ok(mut sequence) = self.shared.context_sequence.lock() {
                *sequence += 1;
            }
        }
        if let Ok(mut started) = self.shared.started.lock() {
            *started = Some(Instant::now());
        }
        emit(
            &self.events,
            "pi",
            &self.session_id,
            self.native().as_deref(),
            Some(operation_id),
            "chat.turn.started",
            pi_turn_start(&self.shared),
        );
        match self.process.request("prompt", json!({"message":text})) {
            Ok(data) => {
                let disposition = data
                    .get("disposition")
                    .and_then(Value::as_str)
                    .unwrap_or("started");
                if disposition == "handled" {
                    // A handled prompt starts no run, so settle it immediately.
                    self.finish_turn("handled", None);
                }
                Ok(json!({"turnId":operation_id}))
            }
            Err(error) => {
                pi_clear_active_turn(&self.shared, operation_id);
                self.drain_interactions(Some(operation_id));
                emit(
                    &self.events,
                    "pi",
                    &self.session_id,
                    self.native().as_deref(),
                    Some(operation_id),
                    "chat.error",
                    json!({"code":error.code,"message":error.message}),
                );
                Err(error)
            }
        }
    }

    fn validate_steer(&self, text: &str, images: &[String]) -> Result<(), ProviderError> {
        for image in images {
            pi_steer_image(image)?;
        }
        if text.trim().is_empty() && images.is_empty() {
            return Err(ProviderError::new("invalid_message", "invalid_message"));
        }
        Ok(())
    }
    fn steer_turn_ready(&self, turn_id: &str) -> Result<(), ProviderError> {
        if self.active_turn().as_deref() == Some(turn_id) {
            Ok(())
        } else {
            Err(ProviderError::new(
                "turn_changed",
                crate::providers::STEER_TURN_ENDED,
            ))
        }
    }
    fn steer(
        &mut self,
        turn_id: &str,
        text: &str,
        images: &[String],
        _operation_id: &str,
    ) -> Result<Value, ProviderError> {
        self.steer_turn_ready(turn_id)?;
        let mut params = json!({"message":text});
        if !images.is_empty() {
            let converted = images
                .iter()
                .map(|image| pi_steer_image(image))
                .collect::<Result<Vec<_>, _>>()?;
            params["images"] = json!(converted);
        }
        // The active turn stays owned by the prompt that started it.
        match self.process.request("steer", params) {
            Ok(data) => {
                let disposition = match data.get("disposition").and_then(Value::as_str) {
                    Some("handled") => "delivered",
                    Some("queued") => "queued",
                    _ => {
                        return Err(ProviderError::new(
                            "provider_error",
                            "Pi steer returned an unknown disposition",
                        ))
                    }
                };
                Ok(json!({"disposition":disposition}))
            }
            Err(error) if pi_steer_rejected(&error) => Err(ProviderError::new(
                "turn_changed",
                crate::providers::STEER_TURN_ENDED,
            )),
            Err(error) => Err(error),
        }
    }
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        if self.active_turn().as_deref() != Some(turn_id) {
            return Err(ProviderError::new(
                "turn_not_active",
                "The requested Pi turn is not active",
            ));
        }
        self.process.request("abort", json!({}))?;
        // `agent_settled` normally closes the turn; settle here when the
        // process confirms idle without emitting one.
        if self.active_turn().as_deref() == Some(turn_id) {
            let elapsed = self
                .shared
                .started
                .lock()
                .ok()
                .and_then(|value| *value)
                .map(|started| started.elapsed().as_millis() as u64);
            self.finish_turn("cancelled", elapsed);
        }
        Ok(())
    }

    fn approve(
        &mut self,
        _turn_id: &str,
        _approval_id: &str,
        _choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::new(
            "approval_unsupported",
            "Pi runs its tools without an interactive approval channel",
        ))
    }

    fn answer(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        use crate::{
            chat_questions::{answer_summary, validate_response},
            providers::approval::{validate_turn, write_failed_not_sent},
        };
        // Resolve transport ownership before taking the turn lock. Extension
        // callbacks take `control` before reaching this path, so keeping this
        // order avoids a control/turn lock inversion.
        let responder = pi_responder(&self.shared)?;
        let active = self
            .shared
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "Pi turn lock poisoned"))?;
        let mut interactions =
            self.shared.interactions.lock().map_err(|_| {
                ProviderError::new("provider_internal", "Pi interaction lock poisoned")
            })?;
        let interaction = interactions.get_mut(approval_id).ok_or_else(|| {
            ProviderError::new(
                "approval_not_pending",
                "Pi dialog is unknown or already resolved",
            )
        })?;
        validate_turn(Some(&interaction.turn_id), active.as_deref(), turn_id)?;
        // Pi input/editor prompts are optional. The card may omit an untouched
        // optional value, while Pi still expects `value` for a submitted
        // response; submit the documented empty string in that case.
        let normalized_response = if matches!(
            interaction.data.get("piMethod").and_then(Value::as_str),
            Some("input" | "editor")
        ) && response.get("action").and_then(Value::as_str)
            == Some("submit")
            && response.get("values").is_none_or(Value::is_object)
            && response.pointer("/values/value").is_none()
        {
            let mut normalized = response.clone();
            if normalized.get("values").is_none() {
                normalized["values"] = json!({});
            }
            normalized["values"]["value"] = json!("");
            Some(normalized)
        } else {
            None
        };
        let response = normalized_response.as_ref().unwrap_or(response);
        validate_response(&interaction.data, response)?;
        // Do all fallible conversion before claiming the interaction. In
        // particular, optional Pi input fields still need a concrete value
        // when the user submits rather than dismisses.
        let frame = pi_extension_response(approval_id, &interaction.data, response)?;
        let status = if response.get("action").and_then(Value::as_str) == Some("dismiss") {
            "dismissed"
        } else {
            "answered"
        };
        let summary = answer_summary(&interaction.data, response);
        match interaction.state.begin_submit(operation_id) {
            Ok(()) => {}
            Err(error) if error.code == "approval_duplicate" => return Ok(()),
            Err(error) => return Err(error),
        }
        drop(interactions);
        drop(active);
        let result = responder.notification("extension_ui_response", frame);
        let mut interactions =
            self.shared.interactions.lock().map_err(|_| {
                ProviderError::new("provider_internal", "Pi interaction lock poisoned")
            })?;
        match result {
            Ok(()) => {
                interactions.remove(approval_id);
                pi_remember_resolved(&self.shared, approval_id);
                emit(
                    &self.events,
                    "pi",
                    &self.session_id,
                    self.native().as_deref(),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":status,"outcome":"submitted","answerSummary":summary}),
                );
                Ok(())
            }
            Err(error) if write_failed_not_sent(&error) => {
                if let Some(interaction) = interactions.get_mut(approval_id) {
                    interaction.state.clear_submit();
                }
                Err(error)
            }
            Err(error) => {
                if let Some(interaction) = interactions.get_mut(approval_id) {
                    interaction.state.mark_unknown();
                }
                emit(
                    &self.events,
                    "pi",
                    &self.session_id,
                    self.native().as_deref(),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":"outcomeUnknown","outcome":"unknown"}),
                );
                Err(ProviderError::new(
                    "approval_outcome_unknown",
                    error.message,
                ))
            }
        }
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        self.retired = true;
        let active = self.active_turn();
        if active.is_some() {
            let _ = self.process.request("abort", json!({}));
        }
        self.drain_interactions(active.as_deref());
        self.process.terminate()
    }

    fn ui_state(&self) -> Value {
        match self.shared.ui.lock() {
            Ok(ui) => pi_ui_state(&ui),
            Err(_) => json!({"options":[],"commands":[]}),
        }
    }

    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        match option_id {
            "model" => {
                let (provider, model_id) = match value.split_once(PI_MODEL_SEPARATOR) {
                    Some((provider, model)) => (provider.to_owned(), model.to_owned()),
                    None => (String::new(), value.to_owned()),
                };
                let mut params = json!({"modelId":model_id});
                if !provider.is_empty() {
                    params["provider"] = json!(provider);
                }
                self.process.request("set_model", params)?;
                // The new model can change the supported thinking levels and
                // clamp the current level, so re-read the whole snapshot.
                self.refresh_ui();
            }
            "thinking" => {
                self.process
                    .request("set_thinking_level", json!({"level":value}))?;
                self.refresh_ui();
            }
            "auto-compaction" => {
                let enabled = pi_boolean(value)?;
                self.process
                    .request("set_auto_compaction", json!({"enabled":enabled}))?;
                self.refresh_ui();
            }
            "auto-retry" => {
                let enabled = pi_boolean(value)?;
                self.process
                    .request("set_auto_retry", json!({"enabled":enabled}))?;
                if let Ok(mut ui) = self.shared.ui.lock() {
                    ui.auto_retry = Some(enabled);
                }
            }
            "steering" => {
                pi_queue_mode(value)?;
                self.process
                    .request("set_steering_mode", json!({"mode":value}))?;
                self.refresh_ui();
            }
            "follow-up" => {
                pi_queue_mode(value)?;
                self.process
                    .request("set_follow_up_mode", json!({"mode":value}))?;
                self.refresh_ui();
            }
            other => {
                return Err(ProviderError::new(
                    "chat_option_unknown",
                    format!("Pi has no chat option named {other}"),
                ))
            }
        }
        Ok(self.ui_state())
    }
}

fn pi_responder(shared: &PiShared) -> Result<JsonLineResponder, ProviderError> {
    shared
        .control
        .lock()
        .map_err(|_| ProviderError::new("provider_internal", "Pi control lock poisoned"))?
        .responder
        .clone()
        .ok_or_else(|| {
            ProviderError::new("provider_disconnected", "Pi RPC responder is unavailable")
        })
}

fn pi_interaction_resolved(shared: &PiShared, id: &str) -> bool {
    shared
        .resolved_interactions
        .lock()
        .map(|ids| ids.iter().any(|resolved| resolved == id))
        // Failing closed avoids reopening a card when duplicate fencing state
        // cannot be inspected.
        .unwrap_or(true)
}

/// Call while holding the interaction lock when removal and fencing must be
/// atomic with respect to a duplicate extension request.
fn pi_remember_resolved(shared: &PiShared, id: &str) {
    let Ok(mut ids) = shared.resolved_interactions.lock() else {
        return;
    };
    if ids.iter().any(|resolved| resolved == id) {
        return;
    }
    ids.push_back(id.to_owned());
    if ids.len() > RESOLVED_UI_IDS {
        ids.pop_front();
    }
}

fn pi_extension_data(raw: &Value) -> Option<Value> {
    let method = raw.get("method").and_then(Value::as_str)?;
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Pi extension request");
    let message = raw.get("message").and_then(Value::as_str).unwrap_or(title);
    let data = match method {
        "select" => {
            let options = raw.get("options").and_then(Value::as_array)?;
            let options = options
                .iter()
                .filter_map(Value::as_str)
                .map(|label| json!({"label":label}))
                .collect::<Vec<_>>();
            if options.is_empty() {
                return None;
            }
            json!({"interaction":"question","answerable":true,"form":{"kind":"questions","questions":[{
                "id":"value","header":title,"question":message,"options":options,
                "multiSelect":false,"allowOther":false,"secret":false
            }]}})
        }
        "confirm" => {
            json!({"interaction":"question","answerable":true,"form":{"kind":"form","message":message,"fields":[{
                "id":"value","title":title,"description":message,"type":"boolean","required":true,"default":false,
                "minimum":null,"maximum":null,"minLength":null,"maxLength":null,"format":null,"minItems":null,"maxItems":null
            }]}})
        }
        "input" | "editor" => {
            json!({"interaction":"question","answerable":true,"form":{"kind":"form","message":message,"fields":[{
                "id":"value","title":title,"description":raw.get("placeholder").or_else(|| raw.get("prefill")).and_then(Value::as_str),
                "type":"string","required":false,"default":raw.get("prefill").cloned().unwrap_or_else(|| json!("")),"multiline":method == "editor",
                "minimum":null,"maximum":null,"minLength":null,"maxLength":null,"format":null,"minItems":null,"maxItems":null
            }]}})
        }
        _ => return None,
    };
    Some(data)
}

fn pi_extension_response(id: &str, data: &Value, response: &Value) -> Result<Value, ProviderError> {
    if response.get("action").and_then(Value::as_str) == Some("dismiss") {
        return Ok(json!({"id":id,"cancelled":true}));
    }
    let value = response
        .pointer("/values/value")
        .ok_or_else(|| ProviderError::new("answer_invalid", "Pi dialog response has no value"))?;
    let method = data
        .get("piMethod")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderError::new("provider_internal", "Pi dialog method is unavailable")
        })?;
    match method {
        "select" => {
            let selected = value
                .as_array()
                .and_then(|values| values.first())
                .and_then(Value::as_str)
                .ok_or_else(|| ProviderError::new("answer_invalid", "Pi select needs one value"))?;
            Ok(json!({"id":id,"value":selected}))
        }
        "confirm" => value
            .as_bool()
            .map(|confirmed| json!({"id":id,"confirmed":confirmed}))
            .ok_or_else(|| ProviderError::new("answer_invalid", "Pi confirm needs a boolean")),
        "input" | "editor" => value
            .as_str()
            .map(|value| json!({"id":id,"value":value}))
            .ok_or_else(|| ProviderError::new("answer_invalid", "Pi input needs text")),
        _ => Err(ProviderError::new(
            "provider_internal",
            "unsupported Pi dialog method",
        )),
    }
}

fn pi_extension_request(
    events: &ScopedProviderEvents,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    shared: &PiShared,
    responder: &JsonLineResponder,
    raw: Value,
) {
    let Some(id) = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return;
    };
    if pi_interaction_resolved(shared, id) {
        return;
    }
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(mut data) = pi_extension_data(&raw) else {
        if matches!(
            method,
            "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"
        ) {
            let text = raw
                .get("message")
                .or_else(|| raw.get("statusText"))
                .or_else(|| raw.get("title"))
                .or_else(|| raw.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("Pi extension update");
            emit(
                events,
                "pi",
                session_id,
                native_id,
                turn_id,
                "chat.item",
                json!({"parts":[{"type":"text","text":text,"status":"complete"}],"raw":raw}),
            );
        } else {
            // Unknown UI methods may be blocking in a newer Pi. Refuse them on
            // their original id so an unrecognized extension cannot stall a turn.
            let _ =
                responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
        }
        return;
    };
    let Some(turn_id) = turn_id else {
        let _ = responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
        return;
    };
    data["approvalId"] = json!(id);
    data["provider"] = json!("pi");
    data["requestType"] = json!("extension_ui_request");
    data["title"] = raw
        .get("title")
        .cloned()
        .unwrap_or_else(|| json!("Pi extension request"));
    data["turnId"] = json!(turn_id);
    data["raw"] = raw.clone();
    data["piMethod"] = json!(method);
    // The event dispatcher observes an active turn before calling us, but a
    // settle/cancel event can win the race before this request is published.
    // Hold the turn guard through insertion and emission, using the shared
    // active-turn -> interactions ordering, so draining cannot leave a stale
    // question card behind a completed turn.
    let active = match shared.active_turn.lock() {
        Ok(active) => active,
        Err(_) => {
            let _ =
                responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
            return;
        }
    };
    if active.as_deref() != Some(turn_id) {
        drop(active);
        let _ = responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
        return;
    }
    let inserted = match shared.interactions.lock() {
        Ok(mut interactions) => {
            // Recheck under the same lock used by resolution/removal. The early
            // check alone can race an answer between lookup and publication.
            if interactions.contains_key(id) || pi_interaction_resolved(shared, id) {
                false
            } else {
                interactions.insert(
                    id.to_owned(),
                    PiInteraction {
                        turn_id: turn_id.to_owned(),
                        data: data.clone(),
                        state: Default::default(),
                    },
                );
                true
            }
        }
        Err(_) => {
            drop(active);
            let _ =
                responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
            return;
        }
    };
    if !inserted {
        return;
    }
    emit(
        events,
        "pi",
        session_id,
        native_id,
        Some(turn_id),
        "chat.approval",
        json!({
            "approvalId":id,"request":raw,"choices":[],
            "part":{"type":"approval","approvalId":id,"status":"pending","data":data}
        }),
    );
}

fn pi_drain_interactions(
    events: &ScopedProviderEvents,
    session_id: &str,
    native_id: Option<&str>,
    shared: &PiShared,
    turn_id: Option<&str>,
) {
    let drained = match shared.interactions.lock() {
        Ok(mut interactions) => match shared.resolved_interactions.lock() {
            Ok(mut resolved) => {
                let ids = interactions
                    .iter()
                    .filter(|(_, interaction)| {
                        interaction.state.submitting_operation.is_none()
                            && !interaction.state.outcome_unknown
                            && turn_id.is_none_or(|turn| interaction.turn_id == turn)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| {
                        interactions.remove(&id).map(|interaction| {
                            if !resolved.iter().any(|known| known == &id) {
                                resolved.push_back(id.clone());
                                if resolved.len() > RESOLVED_UI_IDS {
                                    resolved.pop_front();
                                }
                            }
                            (id, interaction.turn_id)
                        })
                    })
                    .collect::<Vec<_>>()
            }
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let responder = pi_responder(shared).ok();
    for (id, interaction_turn) in drained {
        if let Some(responder) = &responder {
            let _ =
                responder.notification("extension_ui_response", json!({"id":id,"cancelled":true}));
        }
        emit(
            events,
            "pi",
            session_id,
            native_id,
            Some(&interaction_turn),
            "chat.approval.resolved",
            json!({"approvalId":id,"status":"expired","outcome":"cancelled"}),
        );
    }
}

fn pi_clear_active_turn(shared: &PiShared, expected_turn: &str) -> bool {
    let Ok(mut active) = shared.active_turn.lock() else {
        return false;
    };
    if active.as_deref() != Some(expected_turn) {
        return false;
    }
    if let Ok(mut calls) = shared.tool_calls.lock() {
        if calls.owner.as_deref() == Some(expected_turn) {
            calls.owner = None;
            calls.calls.clear();
        }
    }
    *active = None;
    true
}

fn pi_take_active_turn(shared: &PiShared) -> Option<(String, u64)> {
    let Ok(mut active) = shared.active_turn.lock() else {
        return None;
    };
    let turn = active.take()?;
    if let Ok(mut calls) = shared.tool_calls.lock() {
        if calls.owner.as_deref() == Some(&turn) {
            calls.owner = None;
            calls.calls.clear();
        }
    }
    let sequence = {
        let mut sequence = shared.context_sequence.lock().ok()?;
        *sequence += 1;
        *sequence
    };
    Some((turn, sequence))
}

/// `chat.turn.started` data naming the model the turn starts on: the footer's
/// model. Pi's own model value (`provider\u{1f}id`) is not a display name.
fn pi_turn_start(shared: &PiShared) -> Value {
    shared.ui.lock().ok()
        .and_then(|ui| ui.state.as_ref()?.pointer("/model/id")?.as_str().map(ToOwned::to_owned))
        .map_or_else(|| json!({}), |model| json!({"model":model}))
}

fn pi_finish_turn(events: &ScopedProviderEvents, session_id: &str, shared: &PiShared, stop_reason: &str, elapsed_ms: Option<u64>) {
    let Some((turn, sequence)) = pi_take_active_turn(shared) else { return; };
    let native = shared.native_id.lock().ok().and_then(|id| id.clone());
    pi_drain_interactions(events, session_id, native.as_deref(), shared, Some(&turn));
    let usage = shared.turn_usage.lock().ok().and_then(|mut slot| slot.take()).filter(|(owner, _)| *owner == turn);
    let turn_usage = usage.as_ref().map(|(_, usage)| usage.clone());
    let pending = shared.pending_error.lock().ok().and_then(|mut slot| slot.take());
    if stop_reason != "cancelled" {
        if let Some(mut error) = pending {
            if let Some(usage) = turn_usage.as_ref() { error["turnUsage"] = usage.clone(); }
            emit(events, "pi", session_id, native.as_deref(), Some(&turn), "chat.error", error);
        }
    }
    let mut data = json!({"result":{"stopReason":stop_reason}});
    if let Some(elapsed) = elapsed_ms { data["elapsedMs"] = json!(elapsed); }
    if let Some(usage) = turn_usage { data["turnUsage"] = usage; }
    emit(events, "pi", session_id, native.as_deref(), Some(&turn), "chat.turn.completed", data);
    pi_refresh_turn_context(events, session_id, shared, sequence, usage);
}

/// Adds one assistant message's `usage` (input/output/cacheRead/cacheWrite/
/// totalTokens) to its turn's footer total.
fn pi_add_turn_usage(shared: &PiShared, turn: &str, message: &Value) {
    let Some(usage) = message.get("usage").filter(|usage| usage.is_object()) else { return; };
    let Ok(mut slot) = shared.turn_usage.lock() else { return; };
    if slot.as_ref().is_none_or(|(owner, _)| owner != turn) {
        *slot = Some((turn.to_owned(), json!({})));
    }
    let Some((_, total)) = slot.as_mut() else { return; };
    for (source, target) in [("input", "inputTokens"), ("output", "outputTokens"), ("cacheRead", "cacheReadTokens"), ("cacheWrite", "cacheWriteTokens"), ("totalTokens", "totalTokens")] {
        if let Some(value) = usage.get(source).and_then(Value::as_u64) {
            total[target] = json!(total.get(target).and_then(Value::as_u64).unwrap_or(0) + value);
        }
    }
}

#[cfg(test)]
fn pi_publish_context(events: &ScopedProviderEvents, session_id: &str, native: Option<&str>, sequence: &Mutex<u64>, expected: u64, usage: Value) {
    pi_publish_turn_context(events, session_id, native, sequence, expected, usage, None);
}

/// A settled turn's stats read also carries that turn's footer usage.
fn pi_publish_turn_context(events: &ScopedProviderEvents, session_id: &str, native: Option<&str>, sequence: &Mutex<u64>, expected: u64, usage: Value, turn: Option<(String, Value)>) {
    let Ok(current) = sequence.lock() else { return; };
    if *current == expected {
        match turn {
            Some((turn, turn_usage)) => emit(events, "pi", session_id, native, Some(&turn), "chat.context", json!({"usage":usage,"turnUsage":turn_usage})),
            None => emit(events, "pi", session_id, native, None, "chat.context", json!({"usage":usage})),
        }
    }
}

fn pi_refresh_context(events: &ScopedProviderEvents, session_id: &str, shared: &PiShared, expected: u64) {
    pi_refresh_turn_context(events, session_id, shared, expected, None);
}

fn pi_refresh_turn_context(events: &ScopedProviderEvents, session_id: &str, shared: &PiShared, expected: u64, turn: Option<(String, Value)>) {
    let requester = shared.requester.lock().ok().and_then(|slot| slot.clone());
    let Some(requester) = requester else { return; };
    let Ok(current) = shared.context_sequence.lock() else { return; };
    if *current != expected { return; }
    let callback_events = events.clone();
    let callback_session = session_id.to_owned();
    let callback_native = shared.native_id.lock().ok().and_then(|id| id.clone());
    let sequence = Arc::clone(&shared.context_sequence);
    let _ = requester.request_stats(Box::new(move |result| {
        if let Ok(data) = result {
            if let Some(usage) = pi_context_usage(&data) {
                pi_publish_turn_context(&callback_events, &callback_session, callback_native.as_deref(), &sequence, expected, usage, turn);
            }
        }
    }));
}

/// Compaction and new-session mutations invalidate outstanding reads and clear
/// old pressure immediately, even if the following stats response is lost.
fn pi_reset_context(events: &ScopedProviderEvents, session_id: &str, shared: &PiShared) {
    let expected = {
        let Ok(mut sequence) = shared.context_sequence.lock() else { return; };
        *sequence += 1;
        let native = shared.native_id.lock().ok().and_then(|id| id.clone());
        emit(events, "pi", session_id, native.as_deref(), None, "chat.context", json!({"usage":{}}));
        *sequence
    };
    pi_refresh_context(events, session_id, shared, expected);
}

/// Projects one Pi tool frame only while its captured turn still owns the
/// active cache. Holding active_turn then tool_calls through emit prevents an
/// old reader callback from appending data to a new turn that reused a call ID.
fn pi_emit_tool_call(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    shared: &PiShared,
    turn_id: &str,
    mut raw: Value,
) {
    let kind = raw
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let Some(tool_id) = raw
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let status = if kind == "tool_execution_end" {
        if raw.get("isError").and_then(Value::as_bool) == Some(true) {
            "failed"
        } else {
            "complete"
        }
    } else {
        "running"
    };
    let incoming_name = raw
        .get("toolName")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let incoming_args = raw.get("args").cloned();
    let mut name = incoming_name.clone();
    let Ok(active) = shared.active_turn.lock() else {
        return;
    };
    if active.as_deref() != Some(turn_id) {
        return;
    }
    let Ok(mut calls) = shared.tool_calls.lock() else {
        return;
    };
    if calls.owner.as_deref() != Some(turn_id) {
        return;
    }
    if let Some(previous) = calls.calls.get(&tool_id) {
        if name.is_none() {
            name = Some(previous.name.clone());
        }
        if incoming_args.is_none() {
            if let Some(object) = raw.as_object_mut() {
                object.insert("args".into(), previous.args.clone());
            }
        }
    }
    if kind == "tool_execution_end" {
        calls.calls.remove(&tool_id);
    } else if let (Some(name), Some(args)) = (name.clone(), raw.get("args").cloned()) {
        if calls.calls.contains_key(&tool_id) || calls.calls.len() < PI_TOOL_CALL_LIMIT {
            calls
                .calls
                .insert(tool_id.clone(), PiToolCall { name, args });
        }
    }
    let mut part = json!({
        "type":"tool",
        "toolId":tool_id,
        "status":status,
        "data":raw
    });
    if let Some(name) = name {
        part["toolName"] = json!(name);
    }
    crate::file_references::enrich_tool_part(&mut part, None);
    emit(
        events,
        provider,
        session_id,
        native_id,
        Some(turn_id),
        "chat.item",
        json!({"item":{"id":tool_id},"merge":true,"part":part}),
    );
}

/// Normalizes `get_session_stats` into the shared context-usage shape. Session
/// totals become the token counters; `contextUsage` supplies the current
/// window and percentage. `null` context fields right after compaction are
/// dropped, so the ring falls back to its tokens-only state.
fn pi_context_usage(data: &Value) -> Option<Value> {
    let number = |value: Option<&Value>, key: &str| {
        value
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
    };
    let tokens = data.get("tokens");
    let input = number(tokens, "input");
    let output = number(tokens, "output");
    let cache_read = number(tokens, "cacheRead");
    let cache_write = number(tokens, "cacheWrite");
    let total = number(tokens, "total");
    let context = data.get("contextUsage");
    let used = number(context, "tokens");
    let window = number(context, "contextWindow").filter(|window| *window > 0);
    let percent = context
        .and_then(|context| context.get("percent"))
        .and_then(Value::as_f64)
        .or_else(|| used.zip(window).map(|(used, window)| percent_used(used, window)));
    if input.is_none()
        && output.is_none()
        && cache_read.is_none()
        && cache_write.is_none()
        && total.is_none()
        && used.is_none()
        && window.is_none()
    {
        return None;
    }
    let mut usage = serde_json::Map::new();
    let mut put = |key: &str, value: Option<u64>| {
        if let Some(value) = value {
            usage.insert(key.to_owned(), json!(value));
        }
    };
    put("inputTokens", input);
    put("outputTokens", output);
    put("cacheReadTokens", cache_read);
    put("cacheWriteTokens", cache_write);
    put("totalTokens", total);
    put("usedTokens", used);
    put("windowTokens", window);
    if let Some(percent) = percent {
        usage.insert("percent".into(), json!(percent.clamp(0.0, 100.0)));
    }
    Some(Value::Object(usage))
}

/// Translates one `pi --mode rpc` record into provider events.
fn pi_event(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    shared: &PiShared,
    raw: Value,
) {
    let native_id = shared.native_id.lock().ok().and_then(|value| value.clone());
    let turn_id = shared
        .active_turn
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let emit = |kind: &str, data: Value| {
        emit(
            events,
            provider,
            session_id,
            native_id.as_deref(),
            turn_id.as_deref(),
            kind,
            data,
        );
    };
    let record_type = raw.get("type").and_then(Value::as_str).unwrap_or_default();
    // Pi may flush stdout after a turn has settled (notably after accepting a
    // cancellation response). Those records no longer have an owning turn;
    // projecting them makes the chat layer create a phantom current assistant
    // item and can carry an old error into the next turn.
    if turn_id.is_none()
        && matches!(
            record_type,
            "agent_start"
                | "message_update"
                | "message_end"
                | "tool_execution_start"
                | "tool_execution_update"
                | "tool_execution_end"
                | "error"
        )
    {
        return;
    }
    match record_type {
        "extension_ui_request" => {
            let responder = {
                let mut control = match shared.control.lock() {
                    Ok(control) => control,
                    Err(_) => return,
                };
                let Some(responder) = control.responder.clone() else {
                    control.queued_ui.push(raw);
                    return;
                };
                responder
            };
            pi_extension_request(
                events,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                shared,
                &responder,
                raw,
            );
        }
        "session" => {
            if let Some(id) = raw.get("id").and_then(Value::as_str) {
                if let Ok(mut value) = shared.native_id.lock() {
                    *value = Some(id.to_owned());
                }
            }
        }
        "message_update" => {
            let update = raw
                .get("assistantMessageEvent")
                .cloned()
                .unwrap_or(Value::Null);
            if update.get("type").and_then(Value::as_str) == Some("error") {
                let message = update
                    .get("error")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| "The Pi turn failed".to_owned());
                if let Ok(mut slot) = shared.pending_error.lock() {
                    *slot = Some(json!({"code":"provider_error","message":message}));
                }
                return;
            }
            let (part_type, delta) = match update.get("type").and_then(Value::as_str) {
                Some("text_delta") => ("text", update.get("delta").and_then(Value::as_str)),
                Some("thinking_delta") => ("thinking", update.get("delta").and_then(Value::as_str)),
                _ => ("", None),
            };
            if let Some(delta) = delta.filter(|value| !value.is_empty()) {
                let delta = if part_type == "text" {
                    pi_reply_delta(shared, turn_id.as_deref(), delta)
                } else {
                    delta.to_owned()
                };
                emit(
                    "chat.delta",
                    json!({"part":{"type":part_type,"text":delta,"status":"streaming"},"raw":raw}),
                );
            }
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            let Some(turn_id) = turn_id.as_deref() else {
                return;
            };
            pi_emit_tool_call(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                shared,
                turn_id,
                raw,
            );
        }
        "message_end" => {
            let message = raw.get("message").cloned().unwrap_or(Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            if let (Some(turn), Ok(mut reply)) = (turn_id.as_deref(), shared.reply_text.lock()) {
                if let Some((current, paragraph)) = reply.as_mut() {
                    *paragraph = current == turn;
                }
            }
            if let Some(turn) = turn_id.as_deref() {
                pi_add_turn_usage(shared, turn, &message);
            }
            let stop_reason = message
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn");
            // A failed attempt may still be retried, so record it instead of
            // publishing a permanent error. `agent_settled` publishes it only
            // when the turn truly ends in that state; a later success clears it.
            let pending = if stop_reason == "error" {
                let text = pi_message_text(&message).0;
                let message_text = if !text.is_empty() {
                    text
                } else {
                    message
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| "The Pi turn failed".to_owned())
                };
                Some(json!({"code":"provider_error","message":message_text}))
            } else {
                None
            };
            if let Ok(mut slot) = shared.pending_error.lock() {
                *slot = pending;
            }
            // New Pi versions may include the persisted entry coordinate on
            // the final event. It is the only live coordinate we accept; do
            // not mistake a provider message id for a session-tree entry id.
            if let (Some(source), Some(entry_id)) = (
                native_id.as_deref(),
                raw.get("entryId").and_then(Value::as_str).filter(|id| !id.is_empty()),
            ) {
                emit(
                    "chat.item",
                    json!({"merge":true,"forkAnchor":{"nativeId":source,"entryId":entry_id}}),
                );
            }
        }
        "agent_settled" => {
            let aborted = raw.get("aborted").and_then(Value::as_bool) == Some(true);
            let elapsed = shared.started.lock().ok().and_then(|value| *value)
                .map(|started| started.elapsed().as_millis() as u64);
            pi_finish_turn(events, session_id, shared, if aborted { "cancelled" } else { "end_turn" }, elapsed);
        }
        "error" => {
            let message = raw
                .get("message")
                .or_else(|| raw.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("The Pi runtime reported an error")
                .to_owned();
            if let Ok(mut slot) = shared.pending_error.lock() {
                *slot = Some(json!({"code":"provider_error","message":message}));
            }
        }
        "thinking_level_changed" => {
            if let Some(level) = raw.get("level").and_then(Value::as_str) {
                if let Ok(mut ui) = shared.ui.lock() {
                    if let Some(state) = ui.state.as_mut() {
                        state["thinkingLevel"] = json!(level);
                    }
                }
            }
        }
        _ => {}
    }
}

fn pi_steer_image(url: &str) -> Result<Value, ProviderError> {
    let invalid = || {
        ProviderError::new(
            "images_unsupported",
            "Pi steer images must be base64 data URLs. / Pi 插入图片必须使用 base64 data URL。",
        )
    };
    let Some(rest) = url.strip_prefix("data:") else {
        return Err(invalid());
    };
    let Some((meta, data)) = rest.split_once(";base64,") else {
        return Err(invalid());
    };
    if !meta.starts_with("image/") || data.is_empty() {
        return Err(invalid());
    }
    Ok(json!({"type":"image","data":data,"mimeType":meta}))
}

fn pi_steer_rejected(error: &ProviderError) -> bool {
    if error.code == "provider_timeout" {
        return false;
    }
    let message = error.message.to_ascii_lowercase();
    message.contains("no active turn")
        || message.contains("not active")
        || message.contains("turn_changed")
}

/// Builds the `ChatUiState` payload. The protocol requires `value` and
/// `choices` on every option and forbids additional properties.
fn pi_ui_state(ui: &PiUi) -> Value {
    let current_model = ui
        .state
        .as_ref()
        .and_then(|state| state.get("model"))
        .and_then(pi_model_choice)
        .and_then(|choice| {
            choice
                .get("value")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let mut options = vec![json!({
        "id":"model",
        "name":"Model",
        "value":current_model,
        "choices":ui.models.iter().filter_map(pi_model_choice).collect::<Vec<_>>()
    })];
    if !ui.thinking_levels.is_empty() {
        let current = ui
            .state
            .as_ref()
            .and_then(|state| state.get("thinkingLevel"))
            .and_then(Value::as_str)
            .unwrap_or("off");
        let choices = ui
            .thinking_levels
            .iter()
            .map(|level| json!({"value":level,"name":level}))
            .collect::<Vec<_>>();
        options.push(json!({
            "id":"thinking",
            "name":"Thinking",
            "value":current,
            "choices":choices
        }));
    }
    let state = ui.state.as_ref();
    let boolean = |enabled: bool| if enabled { "true" } else { "false" };
    let auto_compaction = state
        .and_then(|state| state.get("autoCompactionEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    options.push(json!({
        "id":"auto-compaction",
        "name":"Auto-compaction",
        "kind":"boolean",
        "value":boolean(auto_compaction),
        "choices":[{"value":"true","name":"On"},{"value":"false","name":"Off"}]
    }));
    let auto_retry = ui.auto_retry.unwrap_or(true);
    options.push(json!({
        "id":"auto-retry",
        "name":"Auto-retry",
        "kind":"boolean",
        "value":boolean(auto_retry),
        "choices":[{"value":"true","name":"On"},{"value":"false","name":"Off"}]
    }));
    let steering = state
        .and_then(|state| state.get("steeringMode"))
        .and_then(Value::as_str)
        .unwrap_or("one-at-a-time");
    options.push(json!({
        "id":"steering",
        "name":"Steering mode",
        "value":steering,
        "choices":[{"value":"all","name":"All"},{"value":"one-at-a-time","name":"One at a time"}]
    }));
    let follow_up = state
        .and_then(|state| state.get("followUpMode"))
        .and_then(Value::as_str)
        .unwrap_or("one-at-a-time");
    options.push(json!({
        "id":"follow-up",
        "name":"Follow-up mode",
        "value":follow_up,
        "choices":[{"value":"all","name":"All"},{"value":"one-at-a-time","name":"One at a time"}]
    }));
    let commands = ui
        .commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            Some(json!({
                "name":name,
                "description":command.get("description").and_then(Value::as_str).unwrap_or("")
            }))
        })
        .collect::<Vec<_>>();
    // Only commands whose `source` is `skill` are skills (docs/rpc-commands.md);
    // `prompt` expands their `/<name>` invocation. Ordinary commands and
    // built-ins stay out of the Skills group.
    let skills = ui
        .commands
        .iter()
        .filter(|command| command.get("source").and_then(Value::as_str) == Some("skill"))
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() || name.chars().any(char::is_whitespace) {
                return None;
            }
            Some(json!({
                "name":name,
                "description":command.get("description").and_then(Value::as_str).unwrap_or(""),
                "invocation":format!("/{name}")
            }))
        })
        .collect::<Vec<_>>();
    let mut state = json!({"options":options,"commands":commands,"inputCapabilities":{"steer":"native"},"skills":skills});
    if let Some(trust) = &ui.trust {
        state["piTrust"] = trust.clone();
    }
    if let Some(report) = &ui.roundtable_tools {
        state["roundtableToolsReport"] = report.clone();
    }
    state
}

fn pi_boolean(value: &str) -> Result<bool, ProviderError> {
    match value {
        "true" | "on" => Ok(true),
        "false" | "off" => Ok(false),
        _ => Err(ProviderError::new(
            "chat_option_invalid",
            format!("{value} is not a boolean option value"),
        )),
    }
}

fn pi_queue_mode(value: &str) -> Result<(), ProviderError> {
    match value {
        "all" | "one-at-a-time" => Ok(()),
        _ => Err(ProviderError::new(
            "chat_option_invalid",
            format!("{value} is not a Pi queue mode"),
        )),
    }
}

fn parse_slash(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix('/')?;
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some(match rest.split_once(char::is_whitespace) {
        Some((name, args)) => (name, args.trim()),
        None => (rest, ""),
    })
}

/// Adds pi's TUI-only commands to the adapter-advertised list without hiding a
/// same-named extension/prompt/skill command reported by `get_commands`.
fn merge_builtin_commands(mut commands: Vec<Value>) -> Vec<Value> {
    for (name, description) in PI_BUILTIN_COMMANDS {
        if !commands
            .iter()
            .any(|command| command.get("name").and_then(Value::as_str) == Some(*name))
        {
            commands.push(json!({"name":name,"description":description}));
        }
    }
    commands
}

/// Encodes a model choice value as `provider<US>id`, or the bare id when pi
/// reports no provider.
fn pi_model_value(model: &Value) -> Option<String> {
    let id = model.get("id").and_then(Value::as_str)?;
    match model
        .get("provider")
        .and_then(Value::as_str)
        .filter(|provider| !provider.is_empty())
    {
        Some(provider) => Some(format!("{provider}{PI_MODEL_SEPARATOR}{id}")),
        None => Some(id.to_owned()),
    }
}

fn pi_model_choice(model: &Value) -> Option<Value> {
    let id = model.get("id").and_then(Value::as_str)?;
    let value = pi_model_value(model)?;
    let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
    Some(json!({"value":value,"name":name}))
}

/// Extracts text and thinking from one Pi message payload.
fn pi_message_text(message: &Value) -> (String, String) {
    let content = message.get("content").unwrap_or(message);
    let mut text = String::new();
    let mut thinking = String::new();
    if let Some(value) = content.as_str() {
        text.push_str(value);
    } else if let Some(blocks) = content.as_array() {
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(value);
                    }
                }
                Some("thinking") => {
                    if let Some(value) = block.get("thinking").and_then(Value::as_str) {
                        if !thinking.is_empty() {
                            thinking.push('\n');
                        }
                        thinking.push_str(value);
                    }
                }
                _ => {}
            }
        }
    }
    (text, thinking)
}

/// Starts an isolated Pi control process resumed at `native_id`. Pi's native
/// fork commands mutate the selected session, so this must not share the
/// process used by the visible Chat session.
fn pi_fork_control(cwd: &str, native_id: &str) -> Result<JsonLineProcess, ProviderError> {
    let spec = CommandSpec::provider("pi", &["--mode", "rpc", "--session", native_id])?;
    JsonLineProcess::spawn(
        "pi-fork",
        &spec,
        Some(cwd),
        &[],
        EnvelopeStyle::Pi,
        Arc::new(|_| {}),
    )
}

/// Returns the next user entry on the current active branch after an assistant
/// reply. `get_entries` deliberately includes abandoned branches, therefore a
/// selected reply must be on the ancestry of the reported leaf before it can
/// be used as a native fork coordinate.
/// `Some(None)` means the reply is the active leaf and can clone; `None`
/// means it is absent, malformed, or belongs to an abandoned branch.
fn pi_fork_target(entries: &Value, reply_entry_id: &str) -> Option<Option<String>> {
    let leaf_id = entries.get("leafId").and_then(Value::as_str)?;
    let rows = entries.get("entries")?.as_array()?;
    let indexed = rows
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(|id| (id, entry)))
        .collect::<HashMap<_, _>>();
    let mut active_reverse = Vec::new();
    let mut current = leaf_id;
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            return None;
        }
        let entry = indexed.get(current)?;
        active_reverse.push(*entry);
        match entry.get("parentId").and_then(Value::as_str) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    active_reverse.reverse();
    let reply_index = active_reverse.iter().position(|entry| {
        entry.get("id").and_then(Value::as_str) == Some(reply_entry_id)
            && entry.get("type").and_then(Value::as_str) == Some("message")
            && entry.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
    })?;
    for entry in &active_reverse[reply_index + 1..] {
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        match entry.pointer("/message/role").and_then(Value::as_str) {
            // A second assistant message means the durable native branch has
            // advanced beyond the selected reply (for example a tool loop).
            // Pi can only fork before a user message, so never silently carry
            // that later assistant output into a selected-reply fork.
            Some("assistant") => return None,
            Some("user") => {
                return entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| Some(id.to_owned()));
            }
            _ => {}
        }
    }
    Some(None)
}

#[cfg(test)]
fn pi_next_user_after_reply(entries: &Value, reply_entry_id: &str) -> Option<String> {
    pi_fork_target(entries, reply_entry_id).flatten()
}

fn pi_transcript(text: &str, native_id: &str) -> Vec<Value> {
    let entries = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect::<Vec<_>>();
    let entries = pi_active_branch(entries);
    let mut out = Vec::new();
    for (index, value) in entries.into_iter().enumerate() {
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = value.get("message").cloned().unwrap_or(Value::Null);
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let (text, thinking) = pi_message_text(&message);
        let mut parts = Vec::new();
        if !thinking.is_empty() {
            parts.push(json!({"type":"thinking","text":thinking}));
        }
        if !text.is_empty() {
            parts.push(json!({"type":"text","text":text}));
        }
        if parts.is_empty() {
            continue;
        }
        let mut item = json!({
            "id":format!("pi-{index}"),
            "role":role,
            "parts":parts,
            "createdAt":value.get("timestamp").and_then(Value::as_str).unwrap_or_default()
        });
        // History entries are Pi's only documented durable message coordinate.
        // Preserve it exactly so a later Fork from here can choose the next
        // user entry on this same active branch.
        if role == "assistant" {
            if let Some(entry_id) = value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                item["forkAnchor"] = json!({"nativeId":native_id,"entryId":entry_id});
            }
            // Native history is eligible for a point fork only when Pi wrote a
            // terminal stop reason. Do not infer completion from timestamps or
            // a persisted assistant entry.
            if let Some(status) = pi_history_turn_status(message.get("stopReason").and_then(Value::as_str)) {
                item["turnStatus"] = json!(status);
            }
        }
        out.push(item);
    }
    out
}

fn pi_history_turn_status(stop_reason: Option<&str>) -> Option<&'static str> {
    match stop_reason {
        Some("end_turn" | "stop") => Some("completed"),
        Some("error") => Some("failed"),
        Some("aborted" | "cancelled" | "canceled") => Some("interrupted"),
        _ => None,
    }
}

/// Pi v2+ sessions are append-only trees. The session manager restores the
/// last appended entry as its active leaf, then follows `parentId` to root.
/// Legacy entries without a complete id chain remain linear.
fn pi_active_branch(entries: Vec<Value>) -> Vec<Value> {
    let indexed = entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), entry.clone()))
        })
        .collect::<HashMap<_, _>>();
    let Some(leaf) = entries
        .iter()
        .rev()
        .find(|entry| entry.get("type").and_then(Value::as_str) != Some("session"))
    else {
        return Vec::new();
    };
    let Some(mut id) = leaf
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return entries;
    };
    let mut branch = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(id.clone()) {
            return Vec::new();
        }
        let Some(entry) = indexed.get(&id).cloned() else {
            // A modern session with a missing parent must not silently import
            // every branch. Pi itself cannot reconstruct this active path.
            return Vec::new();
        };
        let parent = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        branch.push(entry);
        let Some(parent) = parent else {
            break;
        };
        id = parent;
    }
    branch.reverse();
    branch
}

/// `~/.pi/agent`, honouring the documented environment override.
fn pi_agent_dir() -> Option<PathBuf> {
    pi_project_trust::agent_dir_for(
        pi_launch_env("PI_CODING_AGENT_DIR") ,
        pi_launch_env("USERPROFILE").or_else(|| pi_launch_env("HOME")),
        None,
    )
}

/// Read the environment that the managed Pi child receives, not only the
/// long-lived runtime's startup environment.
fn pi_launch_env(name: &str) -> Option<std::ffi::OsString> {
    let environment =
        crate::environment::for_terminal().unwrap_or_else(|| std::env::vars_os().collect());
    pi_environment_value(&environment, name)
}

fn pi_environment_value(
    environment: &crate::environment::Vars,
    name: &str,
) -> Option<std::ffi::OsString> {
    environment.iter().find_map(|(key, value)| {
        key.to_string_lossy().eq_ignore_ascii_case(name)
            .then(|| value.clone())
    })
}

fn pi_sessions_dir() -> Result<PathBuf, ProviderError> {
    let agent = pi_agent_dir().ok_or_else(|| {
        ProviderError::new(
            "provider_unavailable",
            "The Pi configuration directory could not be resolved",
        )
    })?;
    Ok(pi_sessions_dir_for(
        &agent,
        std::env::var_os("PI_CODING_AGENT_SESSION_DIR"),
    ))
}

fn pi_sessions_dir_for(agent: &Path, override_dir: Option<std::ffi::OsString>) -> PathBuf {
    if let Some(directory) = override_dir.filter(|directory| !directory.is_empty()) {
        return PathBuf::from(directory);
    }
    pi_settings_session_dir(agent).unwrap_or_else(|| agent.join("sessions"))
}

fn pi_settings_session_dir(agent: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(agent.join("settings.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let configured = value.get("sessionDir").and_then(Value::as_str)?.trim();
    if configured.is_empty() {
        return None;
    }
    let path = PathBuf::from(configured);
    Some(if path.is_absolute() {
        path
    } else {
        agent.join(path)
    })
}

fn walk_jsonl(directory: &Path, out: &mut Vec<PathBuf>, budget: usize) {
    if out.len() >= budget {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= budget {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk_jsonl(&path, out, budget);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn read_bounded(path: &Path, maximum: u64, tail: bool) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    if tail {
        let length = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(maximum)))
            .ok()?;
    }
    let mut buffer = Vec::new();
    file.take(maximum).read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// Whether Pi has written the session file for `native_id`. An unreadable
/// session directory counts as saved, which keeps the strict `--session` path.
fn pi_session_saved(native_id: &str) -> bool {
    let Ok(directory) = pi_sessions_dir() else {
        return true;
    };
    pi_session_saved_in(&directory, native_id)
}

fn pi_session_saved_in(directory: &Path, native_id: &str) -> bool {
    let mut files = Vec::new();
    walk_jsonl(directory, &mut files, MAX_SESSION_FILES);
    let suffix = format!("_{native_id}.jsonl");
    files.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&suffix))
    }) || files
        .iter()
        .any(|path| pi_session_identity(path).is_some_and(|(id, _)| id == native_id))
}

fn pi_resume_flag(saved: bool) -> &'static str {
    if saved {
        "--session"
    } else {
        "--session-id"
    }
}

fn pi_terminal_args(
    resume_id: Option<&str>,
    assign_id: Option<&str>,
    session_saved: impl FnOnce(&str) -> bool,
) -> Result<Vec<String>, ProviderError> {
    if let Some(id) = resume_id {
        validate_native_id(id)?;
        // Pi writes the session JSONL only after its first user or assistant
        // message. Retain a preassigned but unpersisted terminal identity by
        // asking Pi to create it under this same id.
        return Ok(vec![pi_resume_flag(session_saved(id)).to_owned(), id.to_owned()]);
    }
    if let Some(id) = assign_id {
        validate_native_id(id)?;
        return Ok(vec!["--session-id".to_owned(), id.to_owned()]);
    }
    Ok(Vec::new())
}

fn pi_session_identity(path: &Path) -> Option<(String, String)> {
    let head = read_bounded(path, HEAD_BYTES, false)?;
    let line = head.lines().next()?;
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?.to_owned();
    let cwd = value.get("cwd").and_then(Value::as_str)?.to_owned();
    Some((id, cwd))
}

fn pi_tail_title(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            if let Some(name) = value.get("name").and_then(Value::as_str) {
                if !name.trim().is_empty() {
                    return Some(name.trim().to_owned());
                }
            }
        }
    }
    None
}

fn pi_tail_updated_at(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                return Some(timestamp.to_owned());
            }
        }
    }
    None
}

fn file_timestamp(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| SystemTime::now().into())
        .to_rfc3339()
}

#[cfg(not(windows))]
fn same_path(left: &str, right: &str) -> bool {
    left == right
}

#[cfg(windows)]
fn same_path(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CreateSession, Database};
    use crate::provider_events::tap_channel;
    use tempfile::tempdir;

    #[derive(Default)]
    struct StatsReplies(Mutex<Vec<PiStatsCallback>>);

    impl PiStatsRequester for StatsReplies {
        fn request_stats(&self, callback: PiStatsCallback) -> Result<(), ProviderError> {
            self.0.lock().unwrap().push(callback);
            Ok(())
        }
    }

    fn stats_reader(shared: &PiShared) -> Arc<StatsReplies> {
        let reader = Arc::new(StatsReplies::default());
        *shared.requester.lock().unwrap() = Some(reader.clone());
        reader
    }

    fn scoped() -> (
        ScopedProviderEvents,
        tokio::sync::broadcast::Receiver<super::super::ProviderEvent>,
    ) {
        let (sender, receiver) = tap_channel(16);
        (ScopedProviderEvents::new(sender, "worker"), receiver)
    }

    #[test]
    fn unverified_roundtable_marker_adds_no_pi_flags() {
        let permissions = json!([{"id":"roundtable-tools","value":"read,grep,find,ls"}]);
        let unsupported = super::super::ChatStartupOptions {
            project_trust: None,
            permissions: &permissions,
            pi_read_only_tools: false,
        };
        assert_eq!(
            pi_staged_read_only_tools(&unsupported),
            Some("read,grep,find,ls")
        );
        let selected = unsupported
            .pi_read_only_tools
            .then(|| pi_staged_read_only_tools(&unsupported))
            .flatten();
        assert!(selected.is_none());
        assert!(pi_read_only_args(None).is_empty());
        let verified = super::super::ChatStartupOptions {
            pi_read_only_tools: true,
            ..unsupported
        };
        assert_eq!(
            pi_read_only_args(
                verified
                    .pi_read_only_tools
                    .then(|| pi_staged_read_only_tools(&verified))
                    .flatten()
            ),
            vec!["--no-mcp", "--no-extensions", "--tools", "read,grep,find,ls"]
        );
    }

    #[test]
    fn text_and_thinking_deltas_stream_as_chat_parts() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}),
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Hmm"}}),
        );
        let text = receiver.try_recv().unwrap();
        assert_eq!(text.kind, "chat.delta");
        assert_eq!(text.data["part"]["type"], "text");
        assert_eq!(text.data["part"]["text"], "Hello");
        assert_eq!(text.turn_id.as_deref(), Some("turn-1"));
        let thinking = receiver.try_recv().unwrap();
        assert_eq!(thinking.data["part"]["type"], "thinking");
    }

    #[test]
    fn a_later_assistant_message_starts_a_new_paragraph() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let text = |shared: &PiShared, delta: &str| pi_event(&events, "pi", "session", shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":delta}}));
        let end = |shared: &PiShared| pi_event(&events, "pi", "session", shared,
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"toolUse","content":[]}}));
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        text(&shared, "Reading the README.");
        end(&shared);
        text(&shared, "Steps 1-2 complete.");
        text(&shared, " Next.");
        *shared.active_turn.lock().unwrap() = Some("turn-2".into());
        end(&shared);
        text(&shared, "Fresh turn.");
        let deltas = std::iter::from_fn(|| receiver.try_recv().ok())
            .filter(|event| event.kind == "chat.delta")
            .map(|event| event.data["part"]["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(deltas, ["Reading the README.", "\n\nSteps 1-2 complete.", " Next.", "Fresh turn."]);
    }

    #[test]
    fn empty_and_unknown_updates_do_not_emit() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":""}}),
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"start"}}),
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn late_turn_scoped_records_do_not_project_or_poison_the_next_turn() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        for record in [
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"late"}}),
            json!({"type":"tool_execution_start","toolCallId":"late-tool","toolName":"bash"}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"late failure"}}),
            json!({"type":"error","message":"late runtime failure"}),
        ] {
            pi_event(&events, "pi", "session", &shared, record);
        }
        assert!(receiver.try_recv().is_err());
        assert!(shared.pending_error.lock().unwrap().is_none());
    }

    #[test]
    fn superseded_context_reads_cannot_publish_in_reverse_order() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let reader = stats_reader(&shared);
        for turn in ["turn-1", "turn-2"] {
            *shared.active_turn.lock().unwrap() = Some(turn.into());
            pi_event(&events, "pi", "session", &shared, json!({"type":"agent_settled"}));
            assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.completed");
        }
        let mut replies = reader.0.lock().unwrap();
        replies.pop().unwrap()(Ok(json!({"tokens":{"total":20}})));
        replies.pop().unwrap()(Ok(json!({"tokens":{"total":10}})));
        assert_eq!(receiver.try_recv().unwrap().data["usage"]["totalTokens"], 20);
        assert!(receiver.try_recv().is_err());
        // Starting another turn invalidates a read even before its replacement
        // response exists; an older turn cannot paint over that running turn.
        *shared.context_sequence.lock().unwrap() = 3;
        pi_publish_context(&events, "session", None, &shared.context_sequence, 2, json!({"totalTokens":20}));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn a_settled_turn_reports_its_summed_usage_with_the_stats_read() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let reader = stats_reader(&shared);
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        for (input, output) in [(1200, 40), (300, 25)] {
            // Pi 1.1 assistant message usage.
            pi_event(&events, "pi", "session", &shared, json!({"type":"message_end","message":{"role":"assistant","model":"deepseek/deepseek-v4.1-flash",
                "content":[],"usage":{"input":input,"output":output,"cacheRead":1000,"cacheWrite":0,"totalTokens":input + output + 1000,"cost":{"total":0}}}}));
        }
        pi_event(&events, "pi", "session", &shared, json!({"type":"agent_settled"}));
        let terminal: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
        let completed = terminal.iter().find(|event| event.kind == "chat.turn.completed").unwrap();
        assert_eq!(completed.data["turnUsage"]["outputTokens"], 65);
        reader.0.lock().unwrap().pop().unwrap()(Ok(json!({"tokens":{"total":20}})));
        let context = receiver.try_recv().unwrap();
        assert_eq!((context.kind.as_str(), context.turn_id.as_deref()), ("chat.context", Some("turn-1")));
        assert_eq!(context.data["usage"]["totalTokens"], 20);
        assert_eq!(context.data["turnUsage"], json!({"inputTokens":1500,"outputTokens":65,"cacheReadTokens":2000,"cacheWriteTokens":0,"totalTokens":3565}));
        let mut speed = crate::turn_speed::TurnSpeed::new(0);
        speed.observe("chat.delta", &json!({"part":{"type":"text","text":"streamed"}}), 100);
        speed.observe(&context.kind, &context.data, 400);
        assert_eq!(speed.usage(1000).unwrap()["outputTokens"], 65);
        assert_eq!(speed.usage(1000).unwrap()["outputTokensEstimated"], false);
        assert!(shared.turn_usage.lock().unwrap().is_none());
    }

    #[test]
    fn cancel_fallback_and_native_settlement_share_one_refresh_generation() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let reader = stats_reader(&shared);
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        pi_finish_turn(&events, "session", &shared, "cancelled", Some(20));
        pi_event(&events, "pi", "session", &shared, json!({"type":"agent_settled","aborted":true}));
        assert_eq!(*shared.context_sequence.lock().unwrap(), 1);
        assert_eq!(reader.0.lock().unwrap().len(), 1, "abort fallback refreshes once despite late settlement");
        assert_eq!(receiver.try_recv().unwrap().data["result"]["stopReason"], "cancelled");
        assert!(receiver.try_recv().is_err());
        *shared.active_turn.lock().unwrap() = Some("turn-2".into());
        pi_event(&events, "pi", "session", &shared, json!({"type":"agent_settled"}));
        pi_finish_turn(&events, "session", &shared, "cancelled", None);
        assert_eq!(*shared.context_sequence.lock().unwrap(), 2);
        assert_eq!(reader.0.lock().unwrap().len(), 2, "native settlement wins over fallback without a duplicate read");
        assert_eq!(receiver.try_recv().unwrap().data["result"]["stopReason"], "end_turn");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn context_mutations_clear_pressure_and_fence_pre_mutation_reads() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let reader = stats_reader(&shared);
        *shared.context_sequence.lock().unwrap() = 1;
        for (index, native) in ["compacted-session", "new-session"].iter().enumerate() {
            *shared.native_id.lock().unwrap() = Some((*native).into());
            pi_reset_context(&events, "session", &shared);
            let reset = receiver.try_recv().unwrap();
            assert_eq!(reset.kind, "chat.context");
            assert_eq!(reset.native_id.as_deref(), Some(*native));
            assert_eq!(reset.data["usage"].as_object().unwrap().len(), 1);
            chrono::DateTime::parse_from_rfc3339(reset.data["usage"]["updatedAt"].as_str().unwrap()).unwrap();
            assert_eq!(reader.0.lock().unwrap().len(), index + 1, "each mutation requests fresh stats once");
            pi_publish_context(&events, "session", None, &shared.context_sequence, 1, json!({"percent":90}));
            assert!(receiver.try_recv().is_err());
        }
    }

    #[test]
    fn slash_mutations_and_abort_fallback_refresh_context_over_the_rpc_transport() {
        let root = tempdir().unwrap();
        let script = root.path().join("context-pi.cjs");
        fs::write(&script, r#"
for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];
let native = 'native-old', total = 90, stats = 0;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const cmd = JSON.parse(line);
  let data = {};
  switch (cmd.type) {
    case 'compact': total = 10; data = {tokensBefore:90,estimatedTokensAfter:10}; break;
    case 'new_session': native = 'native-new'; total = 0; break;
    case 'get_state': data = {sessionId:native}; break;
    case 'get_available_models': data = {models:[]}; break;
    case 'get_available_thinking_levels': data = {levels:[]}; break;
    case 'get_commands': data = {commands:[]}; break;
    case 'prompt': total = 5; data = {disposition:'started'}; break;
    case 'abort': break; // Acknowledgement only: exercise the runtime fallback.
    case 'get_session_stats':
      data = {tokens:{total,output:++stats},contextUsage:{tokens:total,contextWindow:100}}; break;
    default: throw new Error('Unexpected fake command: ' + cmd.type);
  }
  out({id:cmd.id,type:'response',command:cmd.type,success:true,data});
});
"#).unwrap();
        // Launch this exact synthetic script through Node, never the installed
        // Pi CLI. No PATH mutation in the test process or model turn is needed.
        let spec = CommandSpec::provider("node", &[script.to_str().unwrap()]).unwrap();
        let (events, mut receiver) = scoped();
        let shared = Arc::new(PiShared::default());
        *shared.native_id.lock().unwrap() = Some("native-old".into());
        let callback_events = events.clone();
        let callback_shared = Arc::clone(&shared);
        let on_message = Arc::new(move |raw| pi_event(&callback_events, "pi", "session", &callback_shared, raw));
        let process = JsonLineProcess::spawn("fake-pi-context", &spec, Some(root.path().to_str().unwrap()), &[], EnvelopeStyle::Pi, on_message).unwrap();
        *shared.requester.lock().unwrap() = Some(Arc::new(process.requester()));
        let mut chat = PiChat { session_id: "session".into(), shared, events, process, retired: false };
        let mut read_snapshot = |total: u64, reads: u64| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut observed = Vec::new();
            loop {
                while let Ok(event) = receiver.try_recv() {
                    let matches = event.kind == "chat.context" && event.data["usage"]["totalTokens"] == total;
                    if matches {
                        assert_eq!(event.data["usage"]["outputTokens"], reads, "one stats read per completed action");
                        chrono::DateTime::parse_from_rfc3339(event.data["usage"]["updatedAt"].as_str().unwrap()).unwrap();
                        observed.push(event);
                        return observed;
                    }
                    observed.push(event);
                }
                assert!(Instant::now() < deadline, "context refresh did not arrive");
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        chat.send("/compact", "compact").unwrap();
        read_snapshot(10, 1);
        chat.send("/new", "new").unwrap();
        let new_events = read_snapshot(0, 2);
        let replacement = new_events.iter().position(|event| event.kind == "chat.session.replaced").unwrap();
        let clear = new_events.iter().position(|event| event.kind == "chat.context").unwrap();
        assert!(replacement < clear, "new identity must bind before its context is cleared");
        assert_eq!(new_events[replacement].data["previousNativeId"], "native-old");
        assert_eq!(new_events[replacement].native_id.as_deref(), Some("native-new"));
        chat.send("cancel me", "cancel").unwrap();
        chat.cancel("cancel").unwrap();
        read_snapshot(5, 3);
        let sequence = *chat.shared.context_sequence.lock().unwrap();
        pi_event(&chat.events, "pi", "session", &chat.shared, json!({"type":"agent_settled","aborted":true}));
        assert_eq!(*chat.shared.context_sequence.lock().unwrap(), sequence);
    }

    #[test]
    fn agent_settled_completes_the_active_turn_once() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"agent_settled"}),
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"agent_settled"}),
        );
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.kind, "chat.turn.completed");
        assert_eq!(completed.data["result"]["stopReason"], "end_turn");
        assert!(
            receiver.try_recv().is_err(),
            "a settled turn must not complete twice"
        );
        assert!(shared.active_turn.lock().unwrap().is_none());
    }

    #[test]
    fn aborted_agent_settled_reports_a_cancelled_turn() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"agent_settled","aborted":true}),
        );
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.data["result"]["stopReason"], "cancelled");
    }

    #[test]
    fn context_usage_maps_pi_session_stats_and_hides_missing_values() {
        let usage = pi_context_usage(&json!({
            "tokens":{"input":50000,"output":10000,"cacheRead":40000,"cacheWrite":5000,"total":105000},
            "contextUsage":{"tokens":60000,"contextWindow":200000,"percent":30}
        }))
        .expect("session stats map");
        assert_eq!(usage["inputTokens"], 50000);
        assert_eq!(usage["outputTokens"], 10000);
        assert_eq!(usage["cacheReadTokens"], 40000);
        assert_eq!(usage["cacheWriteTokens"], 5000);
        assert_eq!(usage["totalTokens"], 105000);
        assert_eq!(usage["usedTokens"], 60000);
        assert_eq!(usage["windowTokens"], 200000);
        assert_eq!(usage["percent"], 30.0);

        // Compaction nulls the context fields: tokens survive, window does not.
        let compacted = pi_context_usage(&json!({
            "tokens":{"total":10},
            "contextUsage":{"tokens":null,"contextWindow":200000,"percent":null}
        }))
        .unwrap();
        assert_eq!(compacted["totalTokens"], 10);
        assert!(compacted.get("usedTokens").is_none());
        assert!(compacted.get("percent").is_none());

        assert!(pi_context_usage(&json!({})).is_none());
    }

    #[test]
    fn tool_execution_projection_retains_pi_args_and_result_across_updates() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("tool-projection.sqlite");
        let database = Database::open(&database_path).unwrap();
        let session = database
            .create_session(CreateSession {
                project_id: None,
                title: Some("Pi tool projection"),
                provider: "pi",
                mode: "chat",
                native_id: None,
                operation_id: "create-pi-tool-projection",
            })
            .unwrap();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        shared.tool_calls.lock().unwrap().owner = Some("turn-1".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"ls"}}),
        );
        let running = receiver.try_recv().unwrap();
        assert_eq!(running.kind, "chat.item");
        assert_eq!(running.data["part"]["status"], "running");
        assert_eq!(running.data["part"]["toolName"], "bash");
        assert_eq!(running.data["item"]["id"], "call-1");
        crate::chat_projection::record(
            &database,
            &session.id,
            running.turn_id.as_deref(),
            &running.kind,
            &running.data,
        )
        .unwrap();
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_update","toolCallId":"call-1","toolName":"bash","args":{"command":"ls"},"partialResult":{"content":[{"type":"text","text":"listing"}]}}),
        );
        let update = receiver.try_recv().unwrap();
        assert_eq!(update.data["part"]["status"], "running");
        assert_eq!(update.data["part"]["data"]["args"]["command"], "ls");
        assert_eq!(
            update.data["part"]["data"]["partialResult"]["content"][0]["text"],
            "listing"
        );
        crate::chat_projection::record(
            &database,
            &session.id,
            update.turn_id.as_deref(),
            &update.kind,
            &update.data,
        )
        .unwrap();
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":{"content":[{"type":"text","text":"done"}]},"isError":false}),
        );
        let complete = receiver.try_recv().unwrap();
        assert_eq!(complete.data["part"]["status"], "complete");
        assert_eq!(complete.data["part"]["toolName"], "bash");
        assert_eq!(complete.data["part"]["data"]["args"]["command"], "ls");
        assert_eq!(
            complete.data["part"]["data"]["result"]["content"][0]["text"],
            "done"
        );
        crate::chat_projection::record(
            &database,
            &session.id,
            complete.turn_id.as_deref(),
            &complete.kind,
            &complete.data,
        )
        .unwrap();
        let persisted = database.chat_items(&session.id).unwrap().pop().unwrap();
        assert_eq!(persisted.parts[0]["toolName"], "bash");
        assert_eq!(persisted.parts[0]["data"]["args"]["command"], "ls");
        assert_eq!(
            persisted.parts[0]["data"]["result"]["content"][0]["text"],
            "done"
        );
    }

    #[test]
    fn sparse_or_late_tool_frames_cannot_cross_pi_turn_ownership() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("old".into());
        shared.tool_calls.lock().unwrap().owner = Some("old".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_start","toolCallId":"reused","toolName":"bash","args":{"command":"old"}}),
        );
        assert_eq!(
            receiver.try_recv().unwrap().data["part"]["data"]["args"]["command"],
            "old"
        );
        assert!(pi_clear_active_turn(&shared, "old"));
        {
            let mut active = shared.active_turn.lock().unwrap();
            let mut calls = shared.tool_calls.lock().unwrap();
            calls.owner = Some("new".into());
            *active = Some("new".into());
        }
        pi_emit_tool_call(
            &events,
            "pi",
            "session",
            None,
            &shared,
            "old",
            json!({"type":"tool_execution_end","toolCallId":"reused","result":{"content":[{"type":"text","text":"old result"}]},"isError":true}),
        );
        assert!(
            receiver.try_recv().is_err(),
            "a late old-turn result must be fenced"
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_start","toolCallId":"reused","toolName":"bash","args":{"command":"new"}}),
        );
        let new_start = receiver.try_recv().unwrap();
        assert_eq!(new_start.data["part"]["data"]["args"]["command"], "new");
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_update","toolCallId":"reused","partialResult":{"content":[{"type":"text","text":"progress"}]}}),
        );
        let sparse = receiver.try_recv().unwrap();
        assert_eq!(sparse.data["part"]["toolName"], "bash");
        assert_eq!(sparse.data["part"]["data"]["args"]["command"], "new");
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"tool_execution_end","toolCallId":"reused","result":{"content":[{"type":"text","text":"failed output"}]},"isError":true}),
        );
        let failed = receiver.try_recv().unwrap();
        assert_eq!(failed.data["part"]["status"], "failed");
        assert_eq!(failed.data["part"]["toolName"], "bash");
        assert_eq!(failed.data["part"]["data"]["args"]["command"], "new");
        assert_eq!(
            failed.data["part"]["data"]["result"]["content"][0]["text"],
            "failed output"
        );
        assert!(shared.tool_calls.lock().unwrap().calls.is_empty());
    }

    #[test]
    fn pi_tool_cache_is_bounded_per_active_turn() {
        let (sender, mut receiver) = tap_channel(PI_TOOL_CALL_LIMIT + 1);
        let events = ScopedProviderEvents::new(sender, "worker");
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn".into());
        shared.tool_calls.lock().unwrap().owner = Some("turn".into());
        for index in 0..=PI_TOOL_CALL_LIMIT {
            let id = format!("call-{index}");
            pi_emit_tool_call(
                &events,
                "pi",
                "session",
                None,
                &shared,
                "turn",
                json!({"type":"tool_execution_start","toolCallId":id,"toolName":"bash","args":{"command":"echo"}}),
            );
        }
        assert_eq!(
            shared.tool_calls.lock().unwrap().calls.len(),
            PI_TOOL_CALL_LIMIT
        );
        let mut emitted = 0;
        while receiver.try_recv().is_ok() {
            emitted += 1;
        }
        assert_eq!(
            emitted,
            PI_TOOL_CALL_LIMIT + 1,
            "cache pressure must not hide tool calls"
        );
        assert!(pi_clear_active_turn(&shared, "turn"));
        assert!(shared.tool_calls.lock().unwrap().calls.is_empty());
    }

    #[test]
    fn failed_assistant_message_reports_the_error_only_when_the_turn_settles() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"401 invalid key","content":[]}}),
        );
        // A retry may still follow, so nothing is published yet.
        assert!(receiver.try_recv().is_err());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"agent_settled"}),
        );
        let error = receiver.try_recv().unwrap();
        assert_eq!(error.kind, "chat.error");
        assert_eq!(error.data["message"], "401 invalid key");
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.kind, "chat.turn.completed");
    }

    #[test]
    fn a_successful_retry_discards_the_earlier_failure() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        // First attempt times out...
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Request timed out.","content":[]}}),
        );
        // ...then the retry streams and succeeds.
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}),
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"end_turn","content":[{"type":"text","text":"ok"}]}}),
        );
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"agent_settled"}),
        );
        let mut kinds = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            kinds.push(event.kind);
        }
        assert!(
            !kinds.iter().any(|kind| kind == "chat.error"),
            "recovered retries must not leave an error: {kinds:?}"
        );
        assert!(kinds.iter().any(|kind| kind == "chat.turn.completed"));
    }

    #[test]
    fn session_header_binds_the_native_id() {
        let (events, _receiver) = scoped();
        let shared = PiShared::default();
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"session","id":"native-9"}),
        );
        assert_eq!(
            shared.native_id.lock().unwrap().as_deref(),
            Some("native-9")
        );
    }

    #[test]
    fn completed_live_reply_uses_only_the_reported_pi_entry_id_as_fork_anchor() {
        let (events, mut receiver) = scoped();
        let shared = PiShared::default();
        *shared.native_id.lock().unwrap() = Some("native-9".to_owned());
        *shared.active_turn.lock().unwrap() = Some("turn-9".to_owned());
        pi_event(
            &events,
            "pi",
            "session",
            &shared,
            json!({"type":"message_end","entryId":"entry-9","message":{"role":"assistant","id":"provider-message","content":"done"}}),
        );
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.kind, "chat.item");
        assert_eq!(event.data["forkAnchor"], json!({"nativeId":"native-9","entryId":"entry-9"}));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn transcript_reads_text_and_thinking_from_message_entries() {
        let source = [
            json!({"type":"session","id":"s","cwd":"/w"}).to_string(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}).to_string(),
            json!({"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"done"}]}}).to_string(),
            json!({"type":"session_info","name":"named"}).to_string(),
        ]
        .join("\n");
        let transcript = pi_transcript(&source, "s");
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0]["role"], "user");
        assert_eq!(transcript[0]["parts"][0]["text"], "hi");
        assert_eq!(transcript[1]["parts"][0]["type"], "thinking");
        assert_eq!(transcript[1]["parts"][1]["text"], "done");
        assert_eq!(pi_tail_title(&source).as_deref(), Some("named"));
        assert_eq!(
            pi_tail_updated_at(&source).as_deref(),
            Some("2026-01-01T00:00:01Z")
        );
    }

    #[test]
    fn transcript_follows_pi_active_branch_instead_of_importing_abandoned_messages() {
        let source = [
            json!({"type":"session","version":3,"id":"s","cwd":"/w"}),
            json!({"type":"message","id":"root","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"root"}}),
            json!({"type":"message","id":"old","parentId":"root","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"abandoned"}]}}),
            json!({"type":"message","id":"new","parentId":"root","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"active"}]}}),
        ]
        .into_iter()
        .map(|entry| entry.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let transcript = pi_transcript(&source, "s");
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0]["parts"][0]["text"], "root");
        assert_eq!(transcript[1]["parts"][0]["text"], "active");
    }

    #[test]
    fn broken_pi_parent_chain_fails_closed_instead_of_importing_other_branches() {
        let entries = vec![
            json!({"type":"message","id":"root","parentId":null}),
            json!({"type":"message","id":"other","parentId":"root"}),
            json!({"type":"message","id":"broken","parentId":"missing"}),
        ];
        assert!(pi_active_branch(entries).is_empty());
    }

    #[test]
    fn pi_fork_target_uses_next_user_on_the_active_branch_only() {
        let entries = json!({"leafId":"user-next","entries":[
            {"type":"message","id":"root","parentId":null,"message":{"role":"user"}},
            {"type":"message","id":"old-reply","parentId":"root","message":{"role":"assistant"}},
            {"type":"message","id":"reply","parentId":"root","message":{"role":"assistant"}},
            {"type":"message","id":"user-next","parentId":"reply","message":{"role":"user"}}
        ]});
        assert_eq!(pi_next_user_after_reply(&entries, "reply").as_deref(), Some("user-next"));
        assert_eq!(pi_next_user_after_reply(&entries, "old-reply"), None);
        assert_eq!(pi_next_user_after_reply(&entries, "root"), None);
        let tip = json!({"leafId":"reply","entries":[
            {"type":"message","id":"root","parentId":null,"message":{"role":"user"}},
            {"type":"message","id":"reply","parentId":"root","message":{"role":"assistant"}}
        ]});
        assert_eq!(pi_fork_target(&tip, "reply"), Some(None));

        for leaf_id in ["later-assistant", "next-user"] {
            let advanced = json!({"leafId":leaf_id,"entries":[
                {"type":"message","id":"root","parentId":null,"message":{"role":"user"}},
                {"type":"message","id":"reply","parentId":"root","message":{"role":"assistant"}},
                {"type":"toolResult","id":"tool-result","parentId":"reply"},
                {"type":"message","id":"later-assistant","parentId":"tool-result","message":{"role":"assistant"}},
                {"type":"message","id":"next-user","parentId":"later-assistant","message":{"role":"user"}}
            ]});
            assert_eq!(pi_fork_target(&advanced, "reply"), None, "leaf {leaf_id}");
        }
    }

    #[test]
    fn pi_history_replies_keep_the_exact_entry_fork_anchor() {
        let source = [
            json!({"type":"session","id":"source","cwd":"/w"}),
            json!({"type":"message","id":"user-1","parentId":null,"message":{"role":"user","content":"hi"}}),
            json!({"type":"message","id":"assistant-1","parentId":"user-1","message":{"role":"assistant","stopReason":"end_turn","content":"done"}}),
        ].into_iter().map(|row| row.to_string()).collect::<Vec<_>>().join("\n");
        let transcript = pi_transcript(&source, "source");
        assert_eq!(transcript[1]["forkAnchor"], json!({"nativeId":"source","entryId":"assistant-1"}));
        assert_eq!(transcript[1]["turnStatus"], "completed");
    }

    #[test]
    fn only_a_written_session_file_counts_as_saved() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("--C--work--");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("2026-10-14T01-00-00-000Z_saved-id.jsonl"), "{\"type\":\"session\",\"id\":\"saved-id\",\"cwd\":\"C:\\\\work\"}\n").unwrap();
        fs::write(project.join("renamed.jsonl"), "{\"type\":\"session\",\"id\":\"renamed-id\",\"cwd\":\"C:\\\\work\"}\n").unwrap();
        assert!(pi_session_saved_in(root.path(), "saved-id"));
        assert!(pi_session_saved_in(root.path(), "renamed-id"), "the session header also identifies a file");
        assert!(!pi_session_saved_in(root.path(), "never-sent-id"));
    }

    #[test]
    fn pi_history_status_requires_a_native_terminal_stop_reason() {
        assert_eq!(pi_history_turn_status(Some("end_turn")), Some("completed"));
        assert_eq!(pi_history_turn_status(Some("stop")), Some("completed"));
        assert_eq!(pi_history_turn_status(Some("error")), Some("failed"));
        assert_eq!(pi_history_turn_status(Some("cancelled")), Some("interrupted"));
        assert_eq!(pi_history_turn_status(None), None);
        assert_eq!(pi_history_turn_status(Some("pending")), None);
    }

    #[test]
    fn configured_session_directory_takes_priority_without_process_environment_mutation() {
        let agent = Path::new("C:/pi-agent");
        assert_eq!(
            pi_sessions_dir_for(
                agent,
                Some(std::ffi::OsString::from("D:/isolated-sessions"))
            ),
            PathBuf::from("D:/isolated-sessions")
        );
    }

    #[test]
    fn extension_dialogs_use_question_contract_and_preserve_native_ids() {
        let select = json!({"type":"extension_ui_request","id":"select-1","method":"select","title":"Pick","options":["Allow","Block"]});
        let mut data = pi_extension_data(&select).unwrap();
        data["piMethod"] = json!("select");
        assert_eq!(data["interaction"], "question");
        assert_eq!(data["form"]["questions"][0]["options"][1]["label"], "Block");
        assert_eq!(
            pi_extension_response(
                "select-1",
                &data,
                &json!({"action":"submit","values":{"value":["Allow"]}})
            )
            .unwrap(),
            json!({"id":"select-1","value":"Allow"})
        );
        assert_eq!(
            pi_extension_response("select-1", &data, &json!({"action":"dismiss"})).unwrap(),
            json!({"id":"select-1","cancelled":true})
        );

        for (method, value, expected) in [
            (
                "confirm",
                json!(true),
                json!({"id":"confirm-1","confirmed":true}),
            ),
            (
                "input",
                json!("typed"),
                json!({"id":"input-1","value":"typed"}),
            ),
            (
                "editor",
                json!("multi\nline"),
                json!({"id":"editor-1","value":"multi\nline"}),
            ),
        ] {
            let raw = json!({"type":"extension_ui_request","id":format!("{method}-1"),"method":method,"title":"Need input"});
            let mut data = pi_extension_data(&raw).unwrap();
            data["piMethod"] = json!(method);
            assert_eq!(data["form"]["kind"], "form");
            if matches!(method, "input" | "editor") {
                assert_eq!(data["form"]["fields"][0]["default"], "");
                assert_eq!(data["form"]["fields"][0]["multiline"], method == "editor");
            }
            assert_eq!(
                pi_extension_response(
                    &format!("{method}-1"),
                    &data,
                    &json!({"action":"submit","values":{"value":value}})
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn terminal_mapping_preserves_pi_resume_and_preassigned_identity_contracts() {
        let (sender, _receiver) = tap_channel(8);
        let adapter = PiAdapter::new(sender);
        assert_eq!(pi_resume_flag(true), "--session");
        assert_eq!(pi_resume_flag(false), "--session-id");
        assert_eq!(
            pi_terminal_args(Some("session-9"), None, |_| true).unwrap(),
            vec!["--session", "session-9"]
        );
        assert_eq!(
            pi_terminal_args(Some("session-9"), None, |_| false).unwrap(),
            vec!["--session-id", "session-9"]
        );
        let fresh = adapter.terminal_command(None, Some("assigned-9")).unwrap();
        assert_eq!(fresh.args, vec!["--session-id", "assigned-9"]);
        assert_eq!(adapter.terminal_capture(), TerminalCapture::PreAssigned);
        assert!(adapter.prepare_terminal(".").unwrap().is_some());
        assert_eq!(
            adapter
                .terminal_command(Some("one"), Some("two"))
                .unwrap_err()
                .code,
            "provider_invalid_request"
        );
        assert_eq!(
            adapter
                .terminal_command(Some("bad id"), None)
                .unwrap_err()
                .code,
            "invalid_native_id"
        );
    }

    #[test]
    fn model_choice_qualifies_the_value_with_the_provider() {
        let choice =
            pi_model_choice(&json!({"id":"m1","provider":"anthropic","name":"Claude"})).unwrap();
        assert_eq!(choice["value"], format!("anthropic{PI_MODEL_SEPARATOR}m1"));
        assert_eq!(choice["name"], "Claude");
        let bare = pi_model_choice(&json!({"id":"m1"})).unwrap();
        assert_eq!(bare["value"], "m1");
        // A model id that itself contains `/` still round-trips.
        let nested =
            pi_model_choice(&json!({"id":"stealth/ox-alpha","provider":"cc-switch-open-router"}))
                .unwrap();
        assert_eq!(
            nested["value"],
            format!("cc-switch-open-router{PI_MODEL_SEPARATOR}stealth/ox-alpha")
        );
    }

    #[test]
    fn ui_state_matches_the_protocol_option_shape() {
        let ui = PiUi {
            state: Some(json!({"model":{"id":"m","provider":"p"},"thinkingLevel":"high","autoCompactionEnabled":true,"steeringMode":"all","followUpMode":"one-at-a-time"})),
            models: vec![json!({"id":"m","provider":"p","name":"M"})],
            thinking_levels: vec!["off".to_owned(), "high".to_owned()],
            commands: vec![
                json!({"name":"demo","description":"Demo"}),
                json!({"name":"skill:review","description":"Review","source":"skill"}),
                json!({"name":"fix-tests","description":"Prompt","source":"prompt"}),
            ],
            auto_retry: Some(false),
            trust: Some(json!({"effective":"skipped"})),
            roundtable_tools: None,
        };
        let value = pi_ui_state(&ui);
        // Required ChatSessionOption fields, and no extraneous ones.
        assert_eq!(value["options"][0]["id"], "model");
        assert_eq!(
            value["options"][0]["value"],
            format!("p{PI_MODEL_SEPARATOR}m")
        );
        assert_eq!(
            value["options"][0]["choices"][0]["value"],
            format!("p{PI_MODEL_SEPARATOR}m")
        );
        assert_eq!(value["options"][1]["value"], "high");
        let option = |id: &str| {
            value["options"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == id)
                .unwrap()
        };
        assert_eq!(option("auto-compaction")["kind"], "boolean");
        assert_eq!(option("auto-compaction")["value"], "true");
        assert_eq!(option("auto-retry")["kind"], "boolean");
        assert_eq!(option("auto-retry")["value"], "false");
        assert_eq!(option("steering")["value"], "all");
        assert_eq!(option("follow-up")["value"], "one-at-a-time");
        assert!(value["options"][0].get("currentValue").is_none());
        assert!(value["options"][0].get("options").is_none());
        assert_eq!(value["commands"][0]["name"], "demo");
        // Only source:skill commands are published as skills, with /<name>.
        assert_eq!(value["skills"].as_array().unwrap().len(), 1);
        assert_eq!(value["skills"][0]["name"], "skill:review");
        assert_eq!(value["skills"][0]["invocation"], "/skill:review");
        assert_eq!(value["skills"][0]["description"], "Review");
        assert!(value["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command["name"] == "fix-tests"));
        assert_eq!(value["piTrust"]["effective"], "skipped");
    }

    #[test]
    fn slash_parsing_and_builtin_merging_are_stable() {
        assert_eq!(parse_slash("/compact now"), Some(("compact", "now")));
        assert_eq!(parse_slash("  /help  "), Some(("help", "")));
        assert_eq!(
            parse_slash("/model deepseek-flash"),
            Some(("model", "deepseek-flash"))
        );
        assert_eq!(parse_slash("hello"), None);
        assert_eq!(parse_slash("/"), None);
        assert_eq!(parse_slash("//nope"), None);
        let merged = merge_builtin_commands(vec![json!({"name":"compact","description":"user"})]);
        assert_eq!(
            merged
                .iter()
                .filter(|command| command["name"] == "compact")
                .count(),
            1
        );
        assert!(merged.iter().any(|command| command["name"] == "thinking"));
        assert!(merged.iter().any(|command| command["name"] == "help"));
    }

    /// Verifies the Pi envelope against the real CLI without invoking a model.
    #[test]
    #[ignore = "requires the pi CLI on PATH"]
    fn real_pi_rpc_round_trips_state_and_thinking_levels() {
        let spec = CommandSpec::provider(
            "pi",
            &[
                "--mode",
                "rpc",
                "--no-session",
                "--session-id",
                "00000000-0000-4000-8000-000000000000",
            ],
        )
        .unwrap();
        let on_message: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(|_| {});
        let process =
            JsonLineProcess::spawn("pi-test", &spec, None, &[], EnvelopeStyle::Pi, on_message)
                .unwrap();
        let state = process.request("get_state", json!({})).unwrap();
        assert_eq!(
            state.get("sessionId").and_then(Value::as_str),
            Some("00000000-0000-4000-8000-000000000000")
        );
        let levels = process
            .request("get_available_thinking_levels", json!({}))
            .unwrap();
        assert!(levels.get("levels").and_then(Value::as_array).is_some());
    }

    /// Verifies the real open-chat path, not only a raw RPC round trip.
    #[test]
    #[ignore = "requires the pi CLI on PATH"]
    fn real_pi_open_chat_returns_a_live_native_session() {
        let (sender, _receiver) = tap_channel(64);
        let adapter = PiAdapter::new(sender);
        let cwd = std::env::temp_dir();
        let chat = adapter
            .open_chat_scoped("sess-1", cwd.to_str().unwrap(), None, "worker")
            .expect("open_chat must succeed");
        assert!(
            chat.native_id().is_some(),
            "the native id must be bound before the first turn"
        );
        assert!(chat.is_alive());
    }

    /// Full chat turn against the real CLI: open, send, stream, complete.
    #[test]
    #[ignore = "requires the pi CLI and a configured model"]
    fn real_pi_chat_turn_streams_and_completes() {
        use std::time::{Duration, Instant};
        let (sender, mut receiver) = tap_channel(256);
        let adapter = PiAdapter::new(sender);
        let cwd = std::env::temp_dir();
        let mut chat = adapter
            .open_chat_scoped("sess-e2e", cwd.to_str().unwrap(), None, "worker")
            .expect("open_chat");
        let result = chat
            .send("Reply with exactly the single word: pong", "turn-e2e")
            .expect("send");
        eprintln!("send -> {result}");
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut saw_delta = false;
        let mut kinds = Vec::new();
        while Instant::now() < deadline {
            match receiver.try_recv() {
                Ok(event) => {
                    kinds.push(event.kind.clone());
                    if event.kind == "chat.delta" {
                        saw_delta = true;
                        eprintln!("delta: {}", event.data["part"]["text"]);
                    }
                    if event.kind == "chat.error" {
                        panic!("chat.error: {}", event.data);
                    }
                    if event.kind == "chat.turn.completed" {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => panic!("event stream failed: {error}"),
            }
        }
        assert!(kinds.iter().any(|kind| kind == "chat.turn.started"));
        assert!(
            kinds.iter().any(|kind| kind == "chat.turn.completed"),
            "kinds: {kinds:?}"
        );
        assert!(saw_delta, "kinds: {kinds:?}");
    }

    /// Deterministic end-to-end turn through the real adapter and transport,
    /// driven by a fake `pi --mode rpc` executable on PATH.
    #[cfg(windows)]
    #[test]
    #[ignore = "mutates PATH; run alone with --test-threads=1"]
    fn fake_pi_chat_turn_streams_and_completes() {
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("fake-pi.cjs"),
            r#"const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const rl = readline.createInterface({ input: process.stdin });
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let prompts = 0;
let forked = false;
if (process.argv.includes('--version')) { console.log('1.1.0'); process.exit(0); }
rl.on('line', line => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  const id = cmd.id;
  switch (cmd.type) {
    case 'get_state': return out({id,type:'response',command:'get_state',success:true,data:{sessionId:forked?'forked-session':'fake-session',model:{id:'fake-model',name:'Fake',provider:'fake'},thinkingLevel:'off',isStreaming:false}});
    case 'get_entries': return out({id,type:'response',command:'get_entries',success:true,data:{leafId:'next-user',entries:[{type:'message',id:'first-user',parentId:null,message:{role:'user'}},{type:'message',id:'reply',parentId:'first-user',message:{role:'assistant'}},{type:'message',id:'next-user',parentId:'reply',message:{role:'user'}}]}});
    case 'fork': fs.appendFileSync(path.join(__dirname,'fork-requests.jsonl'),JSON.stringify(cmd)+'\n'); forked=true; return out({id,type:'response',command:'fork',success:true,data:{cancelled:false}});
    case 'clone': fs.appendFileSync(path.join(__dirname,'fork-requests.jsonl'),JSON.stringify(cmd)+'\n'); forked=true; return out({id,type:'response',command:'clone',success:true,data:{cancelled:false}});
    case 'get_available_models': return out({id,type:'response',command:'get_available_models',success:true,data:{models:[{id:'fake-model',name:'Fake',provider:'fake'}]}});
    case 'get_available_thinking_levels': return out({id,type:'response',command:'get_available_thinking_levels',success:true,data:{levels:['off','high']}});
    case 'get_commands': return out({id,type:'response',command:'get_commands',success:true,data:{commands:[{name:'demo',description:'Demo'}]}});
    case 'prompt':
      prompts++;
      out({id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
      setTimeout(() => {
        out({type:'agent_start'});
        const request = {type:'extension_ui_request',id:prompts === 1 ? 'dialog-1' : 'dialog-2',method:'select',title:'Choose',message:'Continue?',options:['Allow','Block']};
        out(request);
        out(request); // Pi extensions can replay a request; it must remain one card.
      }, 20);
      return;
    case 'extension_ui_response':
      if (cmd.id === 'dialog-1' && cmd.value === 'Allow') {
        // A replay after the native answer must not reopen the resolved card.
        out({type:'extension_ui_request',id:'dialog-1',method:'select',title:'Choose',message:'Continue?',options:['Allow','Block']});
        out({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'pong'}});
        out({type:'message_end',message:{role:'assistant',stopReason:'end_turn',content:[{type:'text',text:'pong'}]}});
        out({type:'agent_settled',aborted:false});
      }
      if (cmd.id === 'dialog-2' && cmd.cancelled === true) {
        fs.writeFileSync(path.join(__dirname, 'cancel-received.json'), JSON.stringify(cmd));
        out({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'cancelled'}});
        out({type:'agent_settled',aborted:true});
      }
      return;
    case 'abort': return out({id,type:'response',command:'abort',success:true});
    case 'set_model': return out({id,type:'response',command:'set_model',success:true,data:{id:'fake-model'}});
    case 'set_thinking_level': return out({id,type:'response',command:'set_thinking_level',success:true});
    default: return out({id,type:'response',command:cmd.type,success:false,error:'unknown command'});
  }
});
"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("pi.cmd"),
            "@echo off\r\nnode \"%~dp0fake-pi.cjs\" %*\r\n",
        )
        .unwrap();
        let previous = std::env::var("PATH").unwrap_or_default();
        std::env::set_var(
            "PATH",
            format!("{};{previous}", dir.path().to_string_lossy()),
        );

        let (sender, mut receiver) = tap_channel(256);
        let adapter = PiAdapter::new(sender);
        let cwd = std::env::temp_dir();
        let mut chat = adapter
            .open_chat_scoped("sess-fake", cwd.to_str().unwrap(), None, "worker")
            .expect("open_chat");
        assert_eq!(chat.native_id().as_deref(), Some("fake-session"));
        assert_eq!(
            chat.ui_state()["options"][0]["value"],
            format!("fake{PI_MODEL_SEPARATOR}fake-model")
        );
        chat.send("hello", "turn-fake").expect("send");

        let deadline = Instant::now() + Duration::from_secs(30);
        let mut text = String::new();
        let mut completed = false;
        let mut approvals = 0;
        let mut resolved = 0;
        let mut answered = false;
        while Instant::now() < deadline {
            match receiver.try_recv() {
                Ok(event) => match event.kind.as_str() {
                    "chat.approval" => {
                        approvals += 1;
                        assert_eq!(event.data["approvalId"], "dialog-1");
                        if !answered {
                            chat.answer(
                                "turn-fake",
                                "dialog-1",
                                &json!({"action":"submit","values":{"value":["Allow"]}}),
                                "reply-1",
                            )
                            .expect("answer Pi dialog");
                            answered = true;
                        }
                    }
                    "chat.approval.resolved" => resolved += 1,
                    "chat.delta" => {
                        if let Some(delta) = event.data["part"]["text"].as_str() {
                            text.push_str(delta);
                        }
                    }
                    "chat.turn.completed" => {
                        completed = true;
                        break;
                    }
                    "chat.error" => panic!("chat.error: {}", event.data),
                    _ => {}
                },
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("event stream failed: {error}"),
            }
        }
        assert!(completed, "the fake turn never completed");
        assert_eq!(text, "pong");
        assert_eq!(approvals, 1, "duplicate Pi request made more than one card");
        assert_eq!(resolved, 1, "dialog should resolve exactly once");

        // A second pending dialog is cancelled through the native Pi protocol
        // when the ThreadTerm turn is stopped. The fake only emits its final
        // event after receiving that exact cancellation frame.
        chat.send("cancel", "turn-cancel")
            .expect("send cancel turn");
        let cancel_deadline = Instant::now() + Duration::from_secs(10);
        let mut cancel_cards = 0;
        let mut cancel_resolved = 0;
        let mut cancel_completed = false;
        let mut cancellation_sent = false;
        let mut saw_late_delta = false;
        while Instant::now() < cancel_deadline {
            match receiver.try_recv() {
                Ok(event) => match event.kind.as_str() {
                    "chat.approval" => {
                        cancel_cards += 1;
                        assert_eq!(event.data["approvalId"], "dialog-2");
                        if !cancellation_sent {
                            chat.cancel("turn-cancel").expect("cancel Pi dialog turn");
                            cancellation_sent = true;
                        }
                    }
                    "chat.approval.resolved" => {
                        if event.data["approvalId"] == "dialog-2" {
                            cancel_resolved += 1;
                            assert_eq!(event.data["status"], "expired");
                        }
                    }
                    "chat.delta" => {
                        if event.data["part"]["text"] == "cancelled" {
                            saw_late_delta = true;
                        }
                    }
                    "chat.turn.completed" => {
                        cancel_completed = true;
                    }
                    "chat.error" => panic!("chat.error: {}", event.data),
                    _ => {}
                },
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("event stream failed: {error}"),
            }
            if cancel_completed && dir.path().join("cancel-received.json").is_file() {
                // Give the fake's immediate post-cancellation stdout records a
                // chance to be processed before asserting they were dropped.
                std::thread::sleep(Duration::from_millis(25));
                while let Ok(event) = receiver.try_recv() {
                    if event.kind == "chat.delta" && event.data["part"]["text"] == "cancelled" {
                        saw_late_delta = true;
                    }
                }
                break;
            }
        }
        assert!(
            cancellation_sent,
            "the test never stopped the pending Pi dialog"
        );
        let receipt: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("cancel-received.json"))
                .expect("the fake never received Pi cancellation"),
        )
        .expect("fake cancellation receipt is JSON");
        assert_eq!(
            receipt,
            json!({"type":"extension_ui_response","id":"dialog-2","cancelled":true})
        );
        assert!(!saw_late_delta, "late cancellation output must not project");
        assert!(cancel_completed, "cancelled turn never settled");
        assert_eq!(
            cancel_cards, 1,
            "duplicate cancel request made more than one card"
        );
        assert_eq!(cancel_resolved, 1, "cancelled dialog should resolve once");

        // A locally-handled slash command answers without the model.
        chat.send("/help", "turn-help").expect("send /help");
        let mut help_text = String::new();
        let mut help_done = false;
        let help_deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < help_deadline {
            match receiver.try_recv() {
                Ok(event) => match event.kind.as_str() {
                    "chat.item" => {
                        if let Some(parts) = event.data["parts"].as_array() {
                            for part in parts {
                                if let Some(value) = part["text"].as_str() {
                                    help_text.push_str(value);
                                }
                            }
                        }
                    }
                    "chat.turn.completed" => {
                        help_done = true;
                        break;
                    }
                    "chat.error" => panic!("chat.error: {}", event.data),
                    _ => {}
                },
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("event stream failed: {error}"),
            }
        }
        assert!(help_done, "/help never completed");
        assert!(help_text.contains("/thinking"), "help text: {help_text}");

        // Native forks run through an independent resumed RPC worker. The
        // fake records the actual wire frames, so this checks more than the
        // branch-selection helper and keeps the original chat usable.
        let forked = adapter
            .fork_session(
                cwd.to_str().unwrap(),
                "fake-session",
                Some(&NativeForkAnchor {
                    native_id: "fake-session".to_owned(),
                    turn_id: None,
                    message_id: None,
                    entry_id: Some("reply".to_owned()),
                }),
                false,
        )
        .expect("fork request")
        .expect("native fork id");
        assert_eq!(forked, "forked-session");
        // A stale service-side "latest" classification must not clone past a
        // durable anchored reply when Pi has a later active user entry.
        let stale_latest = adapter
            .fork_session(
                cwd.to_str().unwrap(),
                "fake-session",
                Some(&NativeForkAnchor {
                    native_id: "fake-session".to_owned(),
                    turn_id: None,
                    message_id: None,
                    entry_id: Some("reply".to_owned()),
                }),
                true,
            )
            .expect("stale latest fork request")
            .expect("native fork id");
        assert_eq!(stale_latest, "forked-session");
        let cloned = adapter
            .fork_session(cwd.to_str().unwrap(), "fake-session", None, true)
            .expect("clone request")
            .expect("native clone id");
        assert_eq!(cloned, "forked-session");
        let wire = std::fs::read_to_string(dir.path().join("fork-requests.jsonl")).unwrap();
        assert_eq!(wire.lines().filter(|line| serde_json::from_str::<Value>(line).ok().is_some_and(|frame| frame["type"] == "fork" && frame["entryId"] == "next-user")).count(), 2, "wire: {wire}");
        assert!(wire.lines().any(|line| serde_json::from_str::<Value>(line).ok().is_some_and(|frame| frame["type"] == "clone")), "wire: {wire}");
        assert!(chat.is_alive(), "temporary fork control must not replace the source worker");
        std::env::set_var("PATH", previous);
    }

    /// Pi `steer` keeps the prompt's turn id and maps handled/queued once.
    #[test]
    fn steer_uses_the_pi_command_and_keeps_the_active_turn() {
        let Some(node) = crate::providers::common::find_executable("node") else {
            eprintln!("node is unavailable; skipping Pi steer fixture");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("requests.jsonl");
        let script = dir.path().join("fake-pi-steer.mjs");
        let log_json = serde_json::to_string(&log.to_string_lossy().replace('\\', "/")).unwrap();
        std::fs::write(
            &script,
            format!(
                r#"import {{ appendFileSync }} from 'node:fs';
import {{ createInterface }} from 'node:readline';
const log = {log_json};
createInterface({{ input: process.stdin, crlfDelay: Infinity }}).on('line', line => {{
  if (!line.trim()) return;
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\n');
  if (request.type !== 'steer') return;
  if (request.message === 'reject-me') {{
    process.stdout.write(JSON.stringify({{ id: request.id, type: 'response', command: 'steer', success: false, error: 'no active turn' }}) + '\n');
    return;
  }}
  if (request.message === 'unknown-me') {{
    process.stdout.write(JSON.stringify({{ id: request.id, type: 'response', command: 'steer', success: true, data: {{ disposition: 'later' }} }}) + '\n');
    return;
  }}
  const disposition = request.message === 'queue-me' ? 'queued' : 'handled';
  process.stdout.write(JSON.stringify({{ id: request.id, type: 'response', command: 'steer', success: true, data: {{ disposition }} }}) + '\n');
}});
"#
            ),
        )
        .unwrap();
        let spec = CommandSpec::from_path(node, vec![script.to_string_lossy().into_owned()]).unwrap();
        let (sender, _receiver) = tap_channel(8);
        let events = ScopedProviderEvents::new(sender, "steer-worker");
        let shared = Arc::new(PiShared::default());
        *shared.active_turn.lock().unwrap() = Some("turn-1".into());
        let process = JsonLineProcess::spawn(
            "fake-pi-steer",
            &spec,
            None,
            &[],
            EnvelopeStyle::Pi,
            Arc::new(|_| {}),
        )
        .unwrap();
        let mut chat = PiChat {
            session_id: "pi-chat".into(),
            shared: Arc::clone(&shared),
            events,
            process,
            retired: false,
        };
        let image = "data:image/png;base64,aGVsbG8=";
        let delivered = chat
            .steer("turn-1", "while you work", &[image.to_owned()], "steer-op")
            .unwrap();
        assert_eq!(delivered["disposition"], "delivered");
        let queued = chat.steer("turn-1", "queue-me", &[], "steer-queue").unwrap();
        assert_eq!(queued["disposition"], "queued");
        let rejected = chat.steer("turn-1", "reject-me", &[], "steer-reject").unwrap_err();
        assert_eq!(rejected.code, "turn_changed");
        assert_eq!(rejected.message, crate::providers::STEER_TURN_ENDED);
        let unknown = chat.steer("turn-1", "unknown-me", &[], "steer-unknown").unwrap_err();
        assert_eq!(unknown.code, "provider_error");
        let missed = chat.steer("other-turn", "nope", &[], "steer-miss").unwrap_err();
        assert_eq!(missed.code, "turn_changed");
        assert!(chat.validate_steer("x", &["https://example.test/a.png".into()]).is_err());
        assert_eq!(
            shared.active_turn.lock().unwrap().as_deref(),
            Some("turn-1"),
            "steer must not replace the prompt turn"
        );
        let lines: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 4, "a local turn mismatch must not reach Pi: {lines:?}");
        assert_eq!(lines[0]["type"], "steer");
        assert_eq!(lines[0]["message"], "while you work");
        assert_eq!(
            lines[0]["images"],
            json!([{"type":"image","data":"aGVsbG8=","mimeType":"image/png"}])
        );
        assert_eq!(lines[1]["message"], "queue-me");
        assert!(lines[1].get("images").is_none());
        assert_eq!(lines[2]["message"], "reject-me");
        assert_eq!(lines[3]["message"], "unknown-me");
    }
}
