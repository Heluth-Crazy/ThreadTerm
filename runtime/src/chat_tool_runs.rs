//! Caller-scoped `chat.tool.run.*` tools.
//!
//! Every tool works only on the caller Chat's own project and worktree root, so a run
//! that belongs to another worktree or project is reported as `run_not_found` instead
//! of revealing that it exists. Saved entries start directly; a detected entry is
//! re-detected here and its text is shown to the user in an `ask_user` card before the
//! exact snapshot that was shown is launched.
//!
//! The approval wait never holds the chat-tools state lock, a provider lock, the
//! database connection or Quick Launch's admission: the caller of `prepare_run` drops
//! its own gates, waits in `await_run`, and re-enters `execute_run` afterwards.

use super::*;
use crate::{pty::PtyManager, quick_launch::QuickLaunchCommand};

const MAX_ENTRY_ID: usize = 512;
const MAX_RUN_ID: usize = 128;
const DEFAULT_LOG_LINES: usize = 200;
const MAX_LOG_LINES: usize = 2_000;
const MAX_LOG_BYTES: usize = 64 * 1024;
/// How far back a log read scans before the tail is cut; the text cap is smaller.
const LOG_SCAN_BYTES: usize = 1024 * 1024;
const MAX_FINISHED_RUNS: usize = 10;
/// Only the card's path labels may be shortened; the command is shown in full or refused.
const CARD_PATH_CHARS: usize = 300;

/// The caller's project and canonical worktree root. `root_key` is the exact string
/// stored on `quick_launch_runs.root`, so scope checks are plain equality.
struct RunScope {
    project_id: String,
    root: PathBuf,
    root_key: String,
}

/// One run row joined with its session state.
struct RunRow {
    session_id: String,
    command_id: String,
    name: String,
    state: String,
    readiness: Option<String>,
    url: Option<String>,
    port: Option<u16>,
    exit_code: Option<i32>,
    started_at: String,
    started_by: Option<String>,
}

impl RunRow {
    fn active(&self) -> bool {
        matches!(
            self.state.as_str(),
            "starting" | "running" | "idle" | "waiting"
        )
    }
}

pub(crate) enum RunKind {
    Start {
        operation_id: String,
        snapshot: QuickLaunchCommand,
    },
    Restart {
        operation_id: String,
        run_id: String,
        /// The re-detected entry the user just approved, or `None` for a saved entry.
        approved: Option<QuickLaunchCommand>,
    },
    /// An instance of this entry is already active: never ask, never launch a second.
    Existing {
        run_id: String,
        operation_id: String,
        snapshot: QuickLaunchCommand,
        /// The detected entry's source file, when this entry asks before starting.
        source_file: Option<String>,
    },
    /// The request id already has a receipt for this tool: replay it, do not ask again.
    Ready(Value),
}

/// Returned by `ChatTools::prepare_run`: nothing waits, or one approval does.
pub(crate) enum RunPlan {
    Launch(AuthorizedRun),
    Approval {
        waiter: AskWaiter,
        run: AuthorizedRun,
    },
}

/// What still has to launch, with the identity to re-check after a wait.
pub(crate) struct AuthorizedRun {
    session_id: String,
    token: String,
    kind: RunKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunListRequest {
    caller_session_id: String,
    caller_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunIdRequest {
    caller_session_id: String,
    caller_token: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunLogsRequest {
    caller_session_id: String,
    caller_token: String,
    run_id: String,
    lines: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunStartRequest {
    caller_session_id: String,
    caller_token: String,
    /// A saved command id, or `detected:<key>`.
    id: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunRestartRequest {
    caller_session_id: String,
    caller_token: String,
    run_id: String,
    request_id: String,
}

/// An agent suggestion is deliberately separate from a launch: this request can only
/// create a pending proposal. The caller identity remains runtime-injected, like the
/// other run tools, and is removed before the proposal payload reaches its storage
/// boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunProposeRequest {
    caller_session_id: String,
    caller_token: String,
    name: String,
    command: String,
    reason: String,
    id: Option<String>,
    cwd: Option<String>,
    kind: Option<String>,
    shell: Option<String>,
    env: Option<Value>,
    preview_url: Option<String>,
    request_id: String,
}

const RUN_COLUMNS: &str = "q.session_id,q.command_id,q.snapshot_json,q.url,q.readiness,q.ready_port,q.started_at,q.started_by,q.stop_requested,s.status,s.exit_code";
const ACTIVE_STATES: &str = "('starting','running','idle','waiting')";

impl ChatTools {
    pub(crate) fn run_list(&self, providers: &Providers, params: &Value) -> Result<Value> {
        let request: RunListRequest = parse(params)?;
        let caller = request.caller_session_id.clone();
        let scope = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| self.run_scope(&request.caller_session_id),
        )?;
        // Detection is a bounded file scan: it runs after the provider fence, never
        // while the chat-tools state lock is held.
        let runs = self.scope_runs(&scope)?;
        let saved = crate::quick_launch::saved_commands(&self.db, &scope.project_id)?;
        let detection = crate::run_detect::detect(&scope.root);
        let active = |entry: &str| {
            runs.iter()
                .find(|run| run.active() && run.command_id == entry)
                .map(|run| json!(run.session_id))
        };
        let mut entries = Vec::with_capacity(saved.len() + detection.entries.len());
        for command in saved {
            let mut entry = json!({
                "id":command.id,"name":command.name,"command":command.command,"cwd":command.cwd,
                "kind":command.kind,"source":"saved","approved":true,
            });
            if let Some(run) = active(&command.id) {
                entry["activeRunId"] = run;
            }
            entries.push(entry);
        }
        for entry in detection.entries {
            let id = format!("detected:{}", entry.key);
            let mut value = json!({
                "id":id,"name":entry.name,"command":entry.command,"cwd":entry.cwd,
                "kind":entry.kind,"source":"detected","approved":false,
            });
            if let Some(tool) = entry.missing_tool {
                value["missingTool"] = json!(tool);
            }
            if let Some(run) = active(&id) {
                value["activeRunId"] = run;
            }
            entries.push(value);
        }
        let mut values = Vec::new();
        let mut finished = 0;
        for run in &runs {
            if !run.active() {
                if finished == MAX_FINISHED_RUNS {
                    continue;
                }
                finished += 1;
            }
            values.push(run_list_value(run, &caller));
        }
        // A chat can see only its own suggestions and their decisions. This is
        // intentionally a read of proposal storage, never a path that can apply one.
        let proposals = crate::quick_launch::run_proposals::list_for_session(
            &self.db,
            &scope.project_id,
            &scope.root_key,
            &caller,
        )?;
        Ok(json!({
            "worktree":scope.root_key,
            "entries":entries,
            "runs":values,
            "proposals":proposals,
            "truncated":detection.truncated,
        }))
    }

    pub(crate) fn run_propose(&self, providers: &Providers, params: &Value) -> Result<Value> {
        // Serde maps JSON null onto Option::None. These optionals mean "omitted",
        // not "erase a target field", so reject explicit null before deserializing.
        if ["id", "cwd", "kind", "shell", "env", "previewUrl"]
            .iter()
            .any(|key| params.get(*key).is_some_and(Value::is_null))
        {
            return Err(anyhow!("invalid_request"));
        }
        let request: RunProposeRequest = parse(params)?;
        if request.request_id.is_empty() || request.request_id.chars().count() > MAX_RUN_ID {
            return Err(anyhow!("invalid_request"));
        }
        let scope = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| {
                // Do the scope and write check before looking up an optional target.
                // A read-only delegate must not learn whether a command exists.
                let scope = self.run_scope(&request.caller_session_id)?;
                require_run_writes(&self.db, &request.caller_session_id)?;
                if let Some(id) = request.id.as_deref() {
                    if id.is_empty() || id.chars().count() > MAX_ENTRY_ID {
                        return Err(anyhow!("run_not_found"));
                    }
                    // Storage checks project ownership after replay lookup, so a retry
                    // still returns its first proposal if the target has since disappeared.
                }
                Ok(scope)
            },
        )?;
        // Storage owns the same command-field validation as quickLaunch.save. Strip
        // the injected credentials, then namespace the idempotency key per chat so
        // two agents can safely use the same requestId.
        let mut proposal = json!({
            "name":request.name,
            "command":request.command,
            "reason":request.reason,
            "requestId":run_operation_id(&request.caller_session_id, "chat.tool.run.propose", &request.request_id),
        });
        if let Some(id) = request.id {
            proposal["id"] = json!(id);
        }
        if let Some(cwd) = request.cwd {
            proposal["cwd"] = json!(cwd);
        }
        if let Some(kind) = request.kind {
            proposal["kind"] = json!(kind);
        }
        if let Some(shell) = request.shell {
            proposal["shell"] = json!(shell);
        }
        if let Some(env) = request.env {
            proposal["env"] = env;
        }
        if let Some(preview_url) = request.preview_url {
            proposal["previewUrl"] = json!(preview_url);
        }
        crate::quick_launch::run_proposals::propose(
            &self.db,
            &request.caller_session_id,
            &scope.project_id,
            &scope.root_key,
            &proposal,
        )
    }

    pub(crate) fn run_status(&self, providers: &Providers, params: &Value) -> Result<Value> {
        let request: RunIdRequest = parse(params)?;
        let run = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| self.scoped_run(&request.caller_session_id, &request.run_id),
        )?;
        Ok(status_value(&run, &request.caller_session_id))
    }

    pub(crate) fn run_logs(&self, providers: &Providers, params: &Value) -> Result<Value> {
        let request: RunLogsRequest = parse(params)?;
        let run = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| self.scoped_run(&request.caller_session_id, &request.run_id),
        )?;
        let lines = request
            .lines
            .map(|lines| (lines as usize).clamp(1, MAX_LOG_LINES))
            .unwrap_or(DEFAULT_LOG_LINES);
        // Reading the tail takes the database connection for one bounded window only,
        // after the provider fence is released.
        let (_, total, scanned, data) =
            self.db.read_output_window(&run.0, None, true, LOG_SCAN_BYTES)?;
        let (text, cut) = plain_tail(&data, lines);
        Ok(json!({
            "runId":run.0,
            "entryId":run.1.command_id,
            "name":run.1.name,
            "text":text,
            "truncated":scanned || cut,
            "totalBytes":total,
        }))
    }

    pub(crate) fn run_stop(
        &self,
        providers: &Providers,
        pty: &PtyManager,
        params: &Value,
    ) -> Result<Value> {
        let request: RunIdRequest = parse(params)?;
        let (run_id, run) = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| {
                let run = self.scoped_run(&request.caller_session_id, &request.run_id)?;
                require_run_writes(&self.db, &request.caller_session_id)?;
                Ok(run)
            },
        )?;
        let state = run.state;
        // The user's Stop: mark the intent (a later exit reads as "Stopped", not a
        // failure) and then stop the session's process tree, outside every lock.
        crate::quick_launch::request_stop(&self.db, &run_id)?;
        match pty.stop(&self.db, &run_id, true) {
            Ok(()) => {}
            // Its reader may already be finalizing an exit.
            Err(error) if error.to_string() == "session has no live PTY" => {}
            Err(error) => return Err(error),
        }
        Ok(json!({"runId":run_id,"entryId":run.command_id,"name":run.name,"state":state,"stopRequested":true}))
    }

    pub(crate) fn prepare_run(
        &self,
        providers: &Providers,
        method: &str,
        params: &Value,
    ) -> Result<RunPlan> {
        match method {
            "chat.tool.run.start" => self.prepare_run_start(providers, parse(params)?),
            "chat.tool.run.restart" => self.prepare_run_restart(providers, parse(params)?),
            _ => Err(anyhow!("unknown_method")),
        }
    }

    fn prepare_run_start(
        &self,
        providers: &Providers,
        request: RunStartRequest,
    ) -> Result<RunPlan> {
        if request.request_id.is_empty() || request.request_id.chars().count() > MAX_RUN_ID {
            return Err(anyhow!("invalid_request"));
        }
        let scope = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| {
                // Scope first, so a read-only delegate learns nothing from the
                // authority error about worktrees it may not touch.
                let scope = self.run_scope(&request.caller_session_id)?;
                require_run_writes(&self.db, &request.caller_session_id)?;
                Ok(scope)
            },
        )?;
        // The receipt is keyed by caller and method: two agents that both say "start-1"
        // never replay each other, and a raw request id cannot address another tool.
        let operation_id = run_operation_id(
            &request.caller_session_id,
            "chat.tool.run.start",
            &request.request_id,
        );
        // A retried request replays its recorded launch instead of asking the user a
        // second time for a run that already started.
        if let Some(result) =
            crate::quick_launch::replayed_operation(&self.db, &operation_id, "chat.tool.run.start")?
        {
            return Ok(RunPlan::Launch(AuthorizedRun {
                session_id: request.caller_session_id,
                token: request.caller_token,
                kind: RunKind::Ready(launch_value(&result)?),
            }));
        }
        let (snapshot, source_file) = match request.id.strip_prefix("detected:") {
            Some(key) => {
                if key.is_empty() || key.chars().count() > MAX_ENTRY_ID {
                    return Err(anyhow!("invalid_request"));
                }
                let detection = crate::run_detect::detect(&scope.root);
                let entry = detection
                    .entries
                    .into_iter()
                    .find(|entry| entry.key == key)
                    .ok_or_else(|| anyhow!("detected_entry_not_found"))?;
                let source_file = entry.source.file.clone();
                let snapshot = crate::quick_launch::detected_command(&scope.project_id, entry)?;
                (snapshot, Some(source_file))
            }
            None => {
                if request.id.is_empty() || request.id.chars().count() > MAX_ENTRY_ID {
                    return Err(anyhow!("invalid_request"));
                }
                let snapshot =
                    crate::quick_launch::scoped_command(&self.db, &scope.project_id, &request.id)?;
                (snapshot, None)
            }
        };
        // One query answers both questions: whether the user has to be asked, and
        // whether this call returns an active instance or starts one. Two queries could
        // see the instance exit in between and launch a detected entry unasked.
        let active = self.active_run(&scope, &snapshot.id)?;
        let question = match (&active, &source_file) {
            (None, Some(source_file)) => {
                Some(approval_question(&snapshot, source_file, &scope.root_key)?)
            }
            _ => None,
        };
        let kind = match active {
            Some(run_id) => RunKind::Existing {
                run_id,
                operation_id,
                snapshot,
                source_file,
            },
            None => RunKind::Start {
                operation_id,
                snapshot,
            },
        };
        let run = AuthorizedRun {
            session_id: request.caller_session_id,
            token: request.caller_token,
            kind,
        };
        match question {
            None => Ok(RunPlan::Launch(run)),
            Some(question) => {
                let waiter = self.prepare_ask_value(
                    providers,
                    run.session_id.clone(),
                    run.token.clone(),
                    vec![question],
                    Capability::Run,
                )?;
                Ok(RunPlan::Approval { waiter, run })
            }
        }
    }

    fn prepare_run_restart(
        &self,
        providers: &Providers,
        request: RunRestartRequest,
    ) -> Result<RunPlan> {
        if request.request_id.is_empty() || request.request_id.chars().count() > MAX_RUN_ID {
            return Err(anyhow!("invalid_request"));
        }
        let scope = self.with_authorized(
            providers,
            &request.caller_session_id,
            &request.caller_token,
            Capability::Run,
            |_| {
                let scope = self.run_scope(&request.caller_session_id)?;
                require_run_writes(&self.db, &request.caller_session_id)?;
                Ok(scope)
            },
        )?;
        let (run_id, run) = self.scoped_run_in(&scope, &request.run_id)?;
        // Namespaced per caller and method, like `run_start`: a shared request id never
        // replays another agent's restart.
        let operation_id = run_operation_id(
            &request.caller_session_id,
            "chat.tool.run.restart",
            &request.request_id,
        );
        // A retried restart replays its receipt rather than asking again.
        if let Some(result) = crate::quick_launch::replayed_operation(
            &self.db,
            &operation_id,
            "chat.tool.run.restart",
        )? {
            return Ok(RunPlan::Launch(AuthorizedRun {
                session_id: request.caller_session_id,
                token: request.caller_token,
                kind: RunKind::Ready(launch_value(&result)?),
            }));
        }
        // Only a detected entry needs consent again: its text comes from files that
        // may have changed since the run started.
        let Some(key) = run.command_id.strip_prefix("detected:") else {
            return Ok(RunPlan::Launch(AuthorizedRun {
                session_id: request.caller_session_id,
                token: request.caller_token,
                kind: RunKind::Restart {
                    operation_id,
                    run_id,
                    approved: None,
                },
            }));
        };
        let key = key.to_owned();
        let detection = crate::run_detect::detect(&scope.root);
        let entry = detection
            .entries
            .into_iter()
            .find(|entry| entry.key == key)
            .ok_or_else(|| anyhow!("detected_entry_not_found"))?;
        let source_file = entry.source.file.clone();
        let snapshot = crate::quick_launch::detected_command(&scope.project_id, entry)?;
        let question = approval_question(&snapshot, &source_file, &scope.root_key)?;
        let run = AuthorizedRun {
            session_id: request.caller_session_id,
            token: request.caller_token,
            kind: RunKind::Restart {
                operation_id,
                run_id,
                approved: Some(snapshot),
            },
        };
        let waiter = self.prepare_ask_value(
            providers,
            run.session_id.clone(),
            run.token.clone(),
            vec![question],
            Capability::Run,
        )?;
        Ok(RunPlan::Approval { waiter, run })
    }

    /// Settle an approval and return what to run. Nothing is locked here: the caller
    /// has already dropped its gates and the user may take minutes to decide.
    ///
    /// An active instance that ended while we were deciding sends the entry through
    /// the normal approval path, so a detected command is never launched unasked.
    pub(crate) fn await_run(
        &self,
        providers: &Providers,
        plan: RunPlan,
    ) -> Result<AuthorizedRun> {
        match plan {
            RunPlan::Launch(run) => {
                let AuthorizedRun {
                    session_id,
                    token,
                    kind,
                } = run;
                let RunKind::Existing {
                    run_id,
                    operation_id,
                    snapshot,
                    source_file,
                } = kind
                else {
                    return Ok(AuthorizedRun {
                        session_id,
                        token,
                        kind,
                    });
                };
                let scope = self.run_scope(&session_id)?;
                if self.scoped_run_in(&scope, &run_id)?.1.active() {
                    return Ok(AuthorizedRun {
                        session_id,
                        token,
                        kind: RunKind::Existing {
                            run_id,
                            operation_id,
                            snapshot,
                            source_file,
                        },
                    });
                }
                let Some(source_file) = source_file else {
                    // A saved entry never asks: relaunch it like a fresh start.
                    return Ok(AuthorizedRun {
                        session_id,
                        token,
                        kind: RunKind::Start {
                            operation_id,
                            snapshot,
                        },
                    });
                };
                let waiter = self.prepare_ask_value(
                    providers,
                    session_id.clone(),
                    token.clone(),
                    vec![approval_question(&snapshot, &source_file, &scope.root_key)?],
                    Capability::Run,
                )?;
                if !approved_answer(&waiter.wait()?) {
                    return Err(anyhow!("run_declined"));
                }
                Ok(AuthorizedRun {
                    session_id,
                    token,
                    kind: RunKind::Start {
                        operation_id,
                        snapshot,
                    },
                })
            }
            RunPlan::Approval { waiter, run } => {
                if !approved_answer(&waiter.wait()?) {
                    return Err(anyhow!("run_declined"));
                }
                Ok(run)
            }
        }
    }

    /// Perform the launch the user approved. The grant is checked again because a
    /// reconnect or close during the wait must not let a stale worker start a run.
    pub(crate) fn execute_run(
        &self,
        providers: &Providers,
        pty: &PtyManager,
        run: AuthorizedRun,
    ) -> Result<Value> {
        self.with_authorized(
            providers,
            &run.session_id,
            &run.token,
            Capability::Run,
            |_| Ok(()),
        )?;
        let scope = self.run_scope(&run.session_id)?;
        match run.kind {
            RunKind::Ready(value) => Ok(value),
            // `await_run` re-checks that the instance is still active; this reads the
            // row once more so the reported state is the one the caller can see.
            RunKind::Existing { run_id, .. } => {
                let (run_id, run) = self.scoped_run_in(&scope, &run_id)?;
                Ok(json!({
                    "runId":run_id,
                    "existing":true,
                    "state":run.state,
                    "entryId":run.command_id,
                    "name":run.name,
                }))
            }
            RunKind::Start {
                operation_id,
                snapshot,
            } => {
                verify_detected(&scope, &snapshot)?;
                crate::quick_launch::start_entry(
                    &self.db,
                    pty,
                    &snapshot,
                    &scope.root_key,
                    &operation_id,
                    &run.session_id,
                )
                .and_then(|value| launch_value(&value))
            }
            RunKind::Restart {
                operation_id,
                run_id,
                approved,
            } => {
                // The run must still be inside this scope: another worktree's or a
                // relocated run is never stopped.
                self.scoped_run_in(&scope, &run_id)?;
                if let Some(approved) = approved.as_ref() {
                    verify_detected(&scope, approved)?;
                }
                crate::quick_launch::restart_entry(
                    &self.db,
                    pty,
                    &run_id,
                    &operation_id,
                    approved.as_ref(),
                    "chat.tool.run.restart",
                    Some(&run.session_id),
                )
                .and_then(|value| launch_value(&value))
            }
        }
    }

    /// The caller's project and worktree root, through the same validation a run gets.
    fn run_scope(&self, session_id: &str) -> Result<RunScope> {
        let session = self
            .db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow!("session_not_found"))?;
        let project_id = session
            .project_id
            .clone()
            .ok_or_else(|| anyhow!("run_not_found"))?;
        let cwd = crate::session_configs::read(&self.db, &session.id)?
            .map(|config| config.launch.cwd)
            .or(session.worktree_path)
            .ok_or_else(|| anyhow!("cwd_missing"))?;
        let root = crate::quick_launch::root_for_setup(&self.db, &project_id, &cwd)?;
        Ok(RunScope {
            project_id,
            root_key: root.to_string_lossy().into_owned(),
            root,
        })
    }

    /// One run of the caller's scope: `run_not_found` for anything else, so another
    /// worktree's or project's run is never revealed as "forbidden".
    fn scoped_run(&self, session_id: &str, run_id: &str) -> Result<(String, RunRow)> {
        let scope = self.run_scope(session_id)?;
        self.scoped_run_in(&scope, run_id)
    }

    fn scoped_run_in(&self, scope: &RunScope, run_id: &str) -> Result<(String, RunRow)> {
        if run_id.is_empty() || run_id.chars().count() > MAX_RUN_ID {
            return Err(anyhow!("run_not_found"));
        }
        let run = self.db.transaction(|tx| {
            Ok(tx
                .query_row(
                    &format!(
                        "SELECT {RUN_COLUMNS} FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id \
                         WHERE q.session_id=? AND q.project_id=? AND q.root=?"
                    ),
                    params![run_id, scope.project_id, scope.root_key],
                    run_row,
                )
                .optional()?)
        })?;
        run.ok_or_else(|| anyhow!("run_not_found"))
            .map(|run| (run_id.to_owned(), run))
    }

    fn scope_runs(&self, scope: &RunScope) -> Result<Vec<RunRow>> {
        self.db.transaction(|tx| {
            let mut statement = tx.prepare(&format!(
                "SELECT {RUN_COLUMNS} FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id \
                 WHERE q.project_id=? AND q.root=? ORDER BY q.started_at DESC,q.rowid DESC"
            ))?;
            let rows = statement
                .query_map(params![scope.project_id, scope.root_key], run_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    fn active_run(&self, scope: &RunScope, command_id: &str) -> Result<Option<String>> {
        Ok(self.db.transaction(|tx| {
            Ok(tx
                .query_row(
                    &format!(
                        "SELECT q.session_id FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id \
                         WHERE q.command_id=? AND q.project_id=? AND q.root=? AND s.status IN {ACTIVE_STATES} LIMIT 1"
                    ),
                    params![command_id, scope.project_id, scope.root_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })?)
    }
}

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    let raw: String = row.get(2)?;
    let name = crate::quick_launch::snapshot_name(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(RunRow {
        session_id: row.get(0)?,
        command_id: row.get(1)?,
        name,
        url: row.get(3)?,
        readiness: row.get(4)?,
        port: row
            .get::<_, Option<i64>>(5)?
            .and_then(|port| u16::try_from(port).ok()),
        started_at: row.get(6)?,
        started_by: row.get(7)?,
        state: row.get(9)?,
        exit_code: row.get(10)?,
    })
}

fn run_list_value(run: &RunRow, caller: &str) -> Value {
    let mut value = json!({
        "runId":run.session_id,
        "entryId":run.command_id,
        "name":run.name,
        "state":run.state,
        "startedAt":run.started_at,
        "startedBy":if run.started_by.is_some() { "agent" } else { "user" },
        "startedBySelf":run.started_by.as_deref() == Some(caller),
    });
    copy_run_details(&mut value, run);
    value
}

fn status_value(run: &(String, RunRow), caller: &str) -> Value {
    let (run_id, run) = run;
    let mut value = json!({
        "runId":run_id,
        "entryId":run.command_id,
        "name":run.name,
        "state":run.state,
        "startedAt":run.started_at,
        "uptimeSeconds":uptime_seconds(&run.started_at),
        "startedBy":if run.started_by.is_some() { "agent" } else { "user" },
        "startedBySelf":run.started_by.as_deref() == Some(caller),
    });
    copy_run_details(&mut value, run);
    value
}

fn copy_run_details(value: &mut Value, run: &RunRow) {
    if let Some(readiness) = &run.readiness {
        value["readiness"] = json!(readiness);
    }
    if let Some(url) = &run.url {
        value["url"] = json!(url);
    }
    if let Some(port) = run.port {
        value["port"] = json!(port);
    }
    if let Some(exit_code) = run.exit_code {
        value["exitCode"] = json!(exit_code);
    }
}

fn uptime_seconds(started_at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(started_at)
        .map(|started| {
            (Utc::now() - started.with_timezone(&Utc))
                .num_seconds()
                .max(0)
        })
        .unwrap_or(0)
}

/// Maps the shared Quick Launch result (`{session, existing}`) onto the run tool shape.
fn launch_value(value: &Value) -> Result<Value> {
    let session = value
        .get("session")
        .ok_or_else(|| anyhow!("session_not_found"))?;
    Ok(json!({
        "runId":session["id"],
        "existing":value["existing"].as_bool().unwrap_or(false),
        "state":session["status"],
        "entryId":session.pointer("/run/commandId"),
        "name":session.pointer("/run/name"),
    }))
}

/// A read-only delegate and a read-only session may look but not launch, stop or
/// restart; the check runs before any effect.
fn require_run_writes(db: &Database, session_id: &str) -> Result<()> {
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow!("session_not_found"))?;
    let read_only_delegate = session
        .delegation
        .as_ref()
        .and_then(|delegation| delegation.authority.as_deref())
        == Some("read_only");
    if session.read_only || read_only_delegate {
        return Err(anyhow!("run_not_permitted"));
    }
    Ok(())
}

/// The card text comes from the re-detected entry, never from the agent. The command is
/// shown in full on its own line (it may contain backticks), so what the user reads is
/// exactly what launches; only the file and worktree labels may be shortened. A command
/// that does not fit the card, or that contains characters a card cannot show faithfully
/// (invisible format characters, other controls except tab, line/paragraph separators),
/// is refused instead of shown as a harmless-looking prefix.
fn approval_question(
    snapshot: &QuickLaunchCommand,
    source_file: &str,
    worktree: &str,
) -> Result<Question> {
    if snapshot.command.chars().any(unprintable) {
        return Err(anyhow!("detected_command_unprintable"));
    }
    let question = format!(
        "Run this detected command from `{}` in `{}`?\n{}",
        shorten(source_file, CARD_PATH_CHARS),
        shorten(worktree, CARD_PATH_CHARS),
        snapshot.command,
    );
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(anyhow!("detected_command_too_long"));
    }
    Ok(Question {
        header: Some("Run".to_owned()),
        question,
        options: vec![
            QuestionOption {
                label: "Run once".to_owned(),
                description: Some("Start this detected entry once. Nothing is saved.".to_owned()),
            },
            QuestionOption {
                label: "Don't run".to_owned(),
                description: None,
            },
        ],
        multi_select: false,
        allow_other: false,
        presentation: Some("command".to_owned()),
        command: Some(snapshot.command.clone()),
    })
}

/// True for a character the approval card cannot render unambiguously: Unicode format
/// characters (zero-width, bidi embeddings/overrides/isolates, BOM), control characters
/// other than tab, and line/paragraph separators. `node safe\u{200B}.js` otherwise reads as
/// `node safe.js` while running something else, and bidi controls can reorder the text.
pub(crate) fn unprintable(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}') || (c.is_control() && c != '\t') || format_character(c)
}

/// General category Cf. Kept as an explicit list so the check needs no Unicode database.
fn format_character(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
            | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
            | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F
    )
}

/// The operation id of one tool call: namespaced by caller session and method so two
/// agents that both say "start-1" keep separate receipts, and a raw request id can
/// never address another tool's recorded work.
fn run_operation_id(caller: &str, method: &str, request_id: &str) -> String {
    format!("{method}:{caller}:{request_id}")
}

fn shorten(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let mut text: String = value.chars().take(max).collect();
    text.push('…');
    text
}

/// Only "Run once" launches. Dismissal, cancellation and "Don't run" all decline.
fn approved_answer(outcome: &Value) -> bool {
    outcome
        .pointer("/answers")
        .and_then(Value::as_object)
        .and_then(|answers| answers.values().next())
        .and_then(Value::as_str)
        == Some("Run once")
}

/// A detected snapshot is launched only if re-detection still produces the same text.
fn verify_detected(scope: &RunScope, snapshot: &QuickLaunchCommand) -> Result<()> {
    let Some(key) = snapshot.id.strip_prefix("detected:") else {
        return Ok(());
    };
    let detection = crate::run_detect::detect(&scope.root);
    let entry = detection
        .entries
        .into_iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| anyhow!("detected_entry_not_found"))?;
    let current = crate::quick_launch::detected_command(&scope.project_id, entry)?;
    if current.command != snapshot.command
        || current.name != snapshot.name
        || current.cwd != snapshot.cwd
        || current.shell != snapshot.shell
        || current.kind != snapshot.kind
    {
        return Err(anyhow!("detected_entry_changed"));
    }
    Ok(())
}

/// Plain text for the last `lines` lines of a bounded tail: ANSI/CSI/OSC sequences are
/// stripped, carriage-return overwrites collapse, and the result stays within 64 KiB.
fn plain_tail(bytes: &[u8], lines: usize) -> (String, bool) {
    let mut plain = Vec::with_capacity(bytes.len());
    let mut escape = crate::quick_launch::Escape::default();
    for &byte in bytes {
        if escape.advance(byte) {
            plain.push(byte);
        }
    }
    let decoded = String::from_utf8_lossy(&plain);
    let mut truncated = false;
    let mut text = decoded.as_ref();
    if text.len() > MAX_LOG_BYTES {
        let mut start = text.len() - MAX_LOG_BYTES;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text = &text[start..];
        truncated = true;
    }
    let text = text.strip_suffix('\n').unwrap_or(text);
    let mut lines_vec = text.split('\n').collect::<Vec<_>>();
    if lines_vec.len() > lines {
        lines_vec.drain(..lines_vec.len() - lines);
        truncated = true;
    }
    let mut out = String::new();
    for (index, line) in lines_vec.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&collapse_cr(line));
    }
    (out, truncated)
}

/// The terminal overwrites a line from its start after a bare `\r`, so the visible
/// text is every segment written over the previous one.
fn collapse_cr(line: &str) -> String {
    if !line.contains('\r') {
        return line.to_owned();
    }
    let mut out: Vec<char> = Vec::new();
    for segment in line.split('\r') {
        for (index, ch) in segment.chars().enumerate() {
            if index < out.len() {
                out[index] = ch;
            } else {
                out.push(ch);
            }
        }
    }
    out.into_iter().collect()
}
