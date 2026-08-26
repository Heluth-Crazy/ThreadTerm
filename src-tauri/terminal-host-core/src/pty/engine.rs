use std::{
    collections::{HashMap, VecDeque},
    fmt,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, Weak},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use terminal_host_protocol::{ExitBehavior, Placement, Presentation};
use thiserror::Error;
use uuid::Uuid;

use crate::catalog::{
    Catalog, CatalogCommand, CatalogError, CatalogLookup, CatalogResult, CatalogSelector,
    ClaimDisposition, CreateClaim, PresentationTarget, RequestDigest, RuntimeIdentity,
    RuntimeReconciliation, TerminalRecord, TerminalState, TransitionResult,
};

use super::{
    emulator::CanonicalEmulator,
    event::{EventQueue, EventSubscription, ResyncReason, RuntimeEvent, StreamIdentity},
    writer::PriorityWriter,
};

const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_PTY_ROWS: u16 = 1_000;
const MAX_PTY_COLS: u16 = 1_000;

#[derive(Clone, Copy, Debug)]
pub struct PtyRuntimeConfig {
    pub max_sessions: usize,
    pub max_registered_sessions: usize,
    pub max_attachments_per_session: usize,
    pub output_queue_capacity: usize,
    pub writer_high_capacity: usize,
    pub writer_input_capacity: usize,
    pub raw_replay_bytes: usize,
    pub scrollback_lines: usize,
}

impl Default for PtyRuntimeConfig {
    fn default() -> Self {
        Self {
            max_sessions: 128,
            max_registered_sessions: 256,
            max_attachments_per_session: 32,
            output_queue_capacity: 64,
            writer_high_capacity: 16,
            writer_input_capacity: 64,
            raw_replay_bytes: 8 * 1024 * 1024,
            scrollback_lines: 3_000,
        }
    }
}

#[derive(Clone)]
pub struct CreatePtyRequest {
    pub request_id: String,
    pub digest: RequestDigest,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub rows: u16,
    pub cols: u16,
    pub title: Option<String>,
    pub target: PresentationTarget,
    pub presentation: Presentation,
    pub exit_behavior: ExitBehavior,
}

impl fmt::Debug for CreatePtyRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CreatePtyRequest")
            .field("request_id", &"[redacted]")
            .field("digest", &self.digest)
            .field("executable", &"[redacted]")
            .field("args", &"[redacted]")
            .field("cwd", &"[redacted]")
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .field("title_present", &self.title.is_some())
            .field("target", &self.target)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreateDisposition {
    Created,
    Reused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatePtyResult {
    pub identity: StreamIdentity,
    pub child_pid: Option<u32>,
    pub disposition: CreateDisposition,
}

#[derive(Clone, Eq, PartialEq)]
pub struct PtySnapshot {
    pub content: Vec<u8>,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
}

impl fmt::Debug for PtySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PtySnapshot")
            .field("content_bytes", &self.content.len())
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .field("cursor_row", &self.cursor_row)
            .field("cursor_col", &self.cursor_col)
            .finish()
    }
}

#[derive(Debug)]
pub struct AttachResult {
    pub identity: StreamIdentity,
    pub attach_id: String,
    pub barrier_seq: u64,
    pub snapshot: PtySnapshot,
    pub subscription: EventSubscription,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseMode {
    Graceful { timeout: Duration },
    Force { timeout: Duration },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseOutcome {
    Exited,
    Pending,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ReplayChunk {
    pub seq: u64,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for ReplayChunk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReplayChunk")
            .field("seq", &self.seq)
            .field("byte_count", &self.bytes.len())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayResult {
    Chunks(Vec<ReplayChunk>),
    ResyncRequired { current_seq: u64 },
}

#[derive(Debug, Error)]
pub enum PtyRuntimeError {
    #[error("invalid terminal runtime configuration")]
    InvalidConfiguration,
    #[error("invalid terminal request")]
    InvalidRequest,
    #[error("terminal registry is full")]
    RegistryFull,
    #[error("terminal session was not found")]
    SessionNotFound,
    #[error("terminal attachment is stale or invalid")]
    StaleAttachment,
    #[error("terminal attachment limit was reached")]
    AttachmentLimit,
    #[error("terminal acknowledgement is invalid")]
    InvalidAcknowledgement,
    #[error("terminal runtime queue is full")]
    QueueFull,
    #[error("terminal process could not be spawned")]
    SpawnFailed,
    #[error("terminal runtime I/O failed")]
    Io,
    #[error("terminal catalog operation failed: {0}")]
    Catalog(#[from] CatalogError),
}

#[derive(Clone)]
pub struct DaemonPtyEngine {
    inner: Arc<EngineInner>,
}

struct EngineInner {
    runtime_id: String,
    catalog: Arc<Catalog>,
    config: PtyRuntimeConfig,
    create_gate: Mutex<()>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    attachments: Mutex<HashMap<String, Weak<Session>>>,
}

struct Session {
    identity: StreamIdentity,
    child_pid: Option<u32>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    reader: Mutex<Option<Box<dyn Read + Send>>>,
    writer: PriorityWriter,
    commit: Mutex<CommitState>,
    exit: (Mutex<Option<Option<i32>>>, Condvar),
    drained: (Mutex<bool>, Condvar),
}

struct CommitState {
    seq: u64,
    rows: u16,
    cols: u16,
    raw_bytes: usize,
    replay: VecDeque<ReplayChunk>,
    emulator: CanonicalEmulator,
    attachments: HashMap<String, Attachment>,
    exited: bool,
}

struct Attachment {
    client_id: String,
    queue: Arc<EventQueue>,
    acked_seq: u64,
    last_delivered_seq: u64,
    dirty: bool,
}

impl DaemonPtyEngine {
    pub fn open(
        catalog_path: impl AsRef<Path>,
        identity: RuntimeIdentity,
        config: PtyRuntimeConfig,
    ) -> Result<(Self, RuntimeReconciliation), PtyRuntimeError> {
        validate_config(config)?;
        let runtime_id = identity.runtime_id.clone();
        let (catalog, reconciliation) = Catalog::open(catalog_path, identity)?;
        Ok((
            Self {
                inner: Arc::new(EngineInner {
                    runtime_id,
                    catalog: Arc::new(catalog),
                    config,
                    create_gate: Mutex::new(()),
                    sessions: Mutex::new(HashMap::new()),
                    attachments: Mutex::new(HashMap::new()),
                }),
            },
            reconciliation,
        ))
    }

    pub fn create(&self, request: CreatePtyRequest) -> Result<CreatePtyResult, PtyRuntimeError> {
        validate_create(&request)?;
        let _create = self
            .inner
            .create_gate
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?;
        if !self.has_create_capacity()? {
            return self.reuse_at_capacity(&request);
        }
        let stream_id = Uuid::new_v4().simple().to_string();
        let claim = CreateClaim {
            request_id: request.request_id.clone(),
            digest: request.digest.clone(),
            stream_id,
            title: request.title.clone(),
            target: request.target.clone(),
            presentation: request.presentation.clone(),
            exit_behavior: request.exit_behavior.clone(),
            now_ms: now_ms(),
        };
        let result = match self.inner.catalog.execute(CatalogCommand::Claim(claim))? {
            CatalogResult::Claim(result) => result,
            _ => return Err(PtyRuntimeError::Io),
        };
        if result.disposition == ClaimDisposition::Reused {
            let sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| PtyRuntimeError::Io)?;
            if let Some(session) = sessions.get(&result.claim.handle) {
                return Ok(CreatePtyResult {
                    identity: session.identity.clone(),
                    child_pid: live_child_pid(session)?,
                    disposition: CreateDisposition::Reused,
                });
            }
            let terminal = result.terminal.ok_or(PtyRuntimeError::SessionNotFound)?;
            return Ok(CreatePtyResult {
                identity: StreamIdentity {
                    runtime_id: terminal.runtime_id,
                    handle: terminal.handle,
                    stream_id: terminal.stream_id,
                },
                child_pid: None,
                disposition: CreateDisposition::Reused,
            });
        }
        if !self.has_create_capacity()? {
            let _ = self.inner.catalog.execute(CatalogCommand::ReconcileClosed {
                handle: result.claim.handle,
                now_ms: now_ms(),
            });
            return Err(PtyRuntimeError::RegistryFull);
        }

        let handle = result.claim.handle;
        let stream_id = result
            .terminal
            .as_ref()
            .map(|record| record.stream_id.clone())
            .ok_or(PtyRuntimeError::Io)?;
        match self.spawn_session(&handle, &stream_id, &request) {
            Ok(session) => {
                self.inner
                    .sessions
                    .lock()
                    .map_err(|_| PtyRuntimeError::Io)?
                    .insert(handle.clone(), Arc::clone(&session));
                if let Err(error) = self.inner.catalog.execute(CatalogCommand::MarkRunning {
                    handle: handle.clone(),
                    now_ms: now_ms(),
                }) {
                    let _ = session.child.lock().map(|mut child| child.kill());
                    self.inner
                        .sessions
                        .lock()
                        .map_err(|_| PtyRuntimeError::Io)?
                        .remove(&handle);
                    return Err(error.into());
                }
                if let Err(error) = self.start_session_threads(Arc::clone(&session)) {
                    terminate_process_tree(&session);
                    self.inner
                        .sessions
                        .lock()
                        .map_err(|_| PtyRuntimeError::Io)?
                        .remove(&handle);
                    let _ = self.inner.catalog.execute(CatalogCommand::ReconcileClosed {
                        handle,
                        now_ms: now_ms(),
                    });
                    return Err(error);
                }
                Ok(CreatePtyResult {
                    identity: session.identity.clone(),
                    child_pid: session.child_pid,
                    disposition: CreateDisposition::Created,
                })
            }
            Err(error) => {
                let _ = self.inner.catalog.execute(CatalogCommand::ReconcileClosed {
                    handle,
                    now_ms: now_ms(),
                });
                Err(error)
            }
        }
    }

    pub fn lookup(&self, selector: CatalogSelector) -> Result<CatalogLookup, PtyRuntimeError> {
        match self
            .inner
            .catalog
            .execute(CatalogCommand::Lookup(selector))?
        {
            CatalogResult::Lookup(result) => Ok(result),
            _ => Err(PtyRuntimeError::Io),
        }
    }

    pub fn list_page(&self, limit: u32) -> Result<crate::CatalogListPage, PtyRuntimeError> {
        match self
            .inner
            .catalog
            .execute(CatalogCommand::ListPage { limit })?
        {
            CatalogResult::ListPage(result) => Ok(result),
            _ => Err(PtyRuntimeError::Io),
        }
    }

    /// Returns the catalog record that is authoritative for presentation and
    /// lifecycle state. Process details remain owned only by this engine.
    pub fn authoritative_lookup(&self, handle: &str) -> Result<TerminalRecord, PtyRuntimeError> {
        match self
            .inner
            .catalog
            .execute(CatalogCommand::Lookup(CatalogSelector::Handle(
                handle.to_owned(),
            )))? {
            CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => {
                Ok(*terminal)
            }
            CatalogResult::Lookup(CatalogLookup::Collected(_)) => {
                Err(PtyRuntimeError::SessionNotFound)
            }
            _ => Err(PtyRuntimeError::Io),
        }
    }

    /// Returns a PID only while this runtime still owns a live child. The PID
    /// is deliberately not persisted because it is not a durable identity.
    pub fn live_child_pid(&self, handle: &str) -> Result<Option<u32>, PtyRuntimeError> {
        match self.session(handle) {
            Ok(session) => live_child_pid(&session),
            Err(PtyRuntimeError::SessionNotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn set_desired_presentation(
        &self,
        handle: &str,
        target: PresentationTarget,
        presentation: Presentation,
        expected_revision: u64,
    ) -> Result<TransitionResult, PtyRuntimeError> {
        let placement = target.placement();
        let workspace_target = target.workspace_target().map(ToOwned::to_owned);
        match self
            .inner
            .catalog
            .execute(CatalogCommand::SetDesiredPresentation {
                handle: handle.to_owned(),
                placement,
                workspace_target,
                presentation,
                expected_revision,
                now_ms: now_ms(),
            })? {
            CatalogResult::Transition(result) => Ok(result),
            _ => Err(PtyRuntimeError::Io),
        }
    }

    pub fn set_surface_hidden(
        &self,
        handle: &str,
        expected_revision: u64,
    ) -> Result<TransitionResult, PtyRuntimeError> {
        match self
            .inner
            .catalog
            .execute(CatalogCommand::SetSurfaceHidden {
                handle: handle.to_owned(),
                hidden: true,
                expected_revision,
                now_ms: now_ms(),
            })? {
            CatalogResult::Transition(result) => Ok(result),
            _ => Err(PtyRuntimeError::Io),
        }
    }

    pub fn attach(&self, handle: &str, client_id: &str) -> Result<AttachResult, PtyRuntimeError> {
        if client_id.trim().is_empty() {
            return Err(PtyRuntimeError::InvalidRequest);
        }
        let session = self.session(handle)?;
        let attach_id = Uuid::new_v4().simple().to_string();
        let queue = Arc::new(EventQueue::new(self.inner.config.output_queue_capacity));
        let (barrier_seq, snapshot) = {
            let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
            if commit.exited {
                return Err(PtyRuntimeError::SessionNotFound);
            }
            if commit.attachments.len() >= self.inner.config.max_attachments_per_session {
                return Err(PtyRuntimeError::AttachmentLimit);
            }
            let barrier_seq = commit.seq;
            let snapshot = snapshot_from_commit(&commit);
            let mut attachments = self
                .inner
                .attachments
                .lock()
                .map_err(|_| PtyRuntimeError::Io)?;
            commit.attachments.insert(
                attach_id.clone(),
                Attachment {
                    client_id: client_id.to_owned(),
                    queue: Arc::clone(&queue),
                    acked_seq: barrier_seq,
                    last_delivered_seq: barrier_seq,
                    dirty: false,
                },
            );
            attachments.insert(attach_id.clone(), Arc::downgrade(&session));
            (barrier_seq, snapshot)
        };
        Ok(AttachResult {
            identity: session.identity.clone(),
            attach_id: attach_id.clone(),
            barrier_seq,
            snapshot,
            subscription: EventSubscription { attach_id, queue },
        })
    }

    pub fn input(
        &self,
        attach_id: &str,
        stream_id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), PtyRuntimeError> {
        if bytes.is_empty() {
            return Err(PtyRuntimeError::InvalidRequest);
        }
        let session = self.attached_session(attach_id, stream_id)?;
        session.writer.send_input(bytes).map_err(map_writer_error)
    }

    pub fn protocol_write(
        &self,
        attach_id: &str,
        stream_id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), PtyRuntimeError> {
        if bytes.is_empty() {
            return Err(PtyRuntimeError::InvalidRequest);
        }
        let session = self.attached_session(attach_id, stream_id)?;
        session
            .writer
            .send_protocol(bytes)
            .map_err(map_writer_error)
    }

    pub fn resize(
        &self,
        attach_id: &str,
        stream_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<bool, PtyRuntimeError> {
        if !valid_dimensions(rows, cols) {
            return Err(PtyRuntimeError::InvalidRequest);
        }
        let session = self.attached_session(attach_id, stream_id)?;
        let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        if (commit.rows, commit.cols) == (rows, cols) {
            return Ok(false);
        }
        let master = session.master.lock().map_err(|_| PtyRuntimeError::Io)?;
        master
            .as_ref()
            .ok_or(PtyRuntimeError::SessionNotFound)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| PtyRuntimeError::Io)?;
        commit.rows = rows;
        commit.cols = cols;
        commit.emulator.resize(rows, cols);
        Ok(true)
    }

    pub fn acknowledge(
        &self,
        attach_id: &str,
        stream_id: &str,
        through_seq: u64,
    ) -> Result<bool, PtyRuntimeError> {
        let session = self.attached_session(attach_id, stream_id)?;
        let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        let attachment = commit
            .attachments
            .get_mut(attach_id)
            .ok_or(PtyRuntimeError::StaleAttachment)?;
        if through_seq <= attachment.acked_seq {
            return Ok(false);
        }
        if through_seq > attachment.last_delivered_seq {
            return Err(PtyRuntimeError::InvalidAcknowledgement);
        }
        attachment.acked_seq = through_seq;
        Ok(true)
    }

    pub fn resync(
        &self,
        attach_id: &str,
        stream_id: &str,
    ) -> Result<(u64, PtySnapshot), PtyRuntimeError> {
        let session = self.attached_session(attach_id, stream_id)?;
        let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        let barrier = commit.seq;
        let snapshot = snapshot_from_commit(&commit);
        let attachment = commit
            .attachments
            .get_mut(attach_id)
            .ok_or(PtyRuntimeError::StaleAttachment)?;
        attachment.queue.reset_output();
        attachment.acked_seq = barrier;
        attachment.last_delivered_seq = barrier;
        attachment.dirty = false;
        Ok((barrier, snapshot))
    }

    pub fn detach(&self, attach_id: &str, stream_id: &str) -> Result<bool, PtyRuntimeError> {
        let session = match self.attached_session(attach_id, stream_id) {
            Ok(session) => session,
            Err(PtyRuntimeError::StaleAttachment) => return Ok(false),
            Err(error) => return Err(error),
        };
        let removed = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        let (removed, should_reap) = {
            let mut commit = removed;
            let removed = commit.attachments.remove(attach_id);
            let should_reap = commit.exited && commit.attachments.is_empty();
            (removed, should_reap)
        };
        self.inner
            .attachments
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?
            .remove(attach_id);
        if let Some(attachment) = &removed {
            attachment.queue.close();
        }
        if should_reap {
            reap_exited_if_unattached(&self.inner, &session)?;
        }
        Ok(removed.is_some())
    }

    pub fn detach_all(&self, client_id: &str) -> Result<usize, PtyRuntimeError> {
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut removed_ids = Vec::new();
        let mut reap_sessions = Vec::new();
        for session in sessions {
            let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
            let ids = commit
                .attachments
                .iter()
                .filter_map(|(id, attachment)| {
                    (attachment.client_id == client_id).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            for id in ids {
                if let Some(attachment) = commit.attachments.remove(&id) {
                    attachment.queue.close();
                    removed_ids.push(id);
                }
            }
            if commit.exited && commit.attachments.is_empty() {
                reap_sessions.push(Arc::clone(&session));
            }
        }
        let mut index = self
            .inner
            .attachments
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?;
        for id in &removed_ids {
            index.remove(id);
        }
        drop(index);
        for session in reap_sessions {
            reap_exited_if_unattached(&self.inner, &session)?;
        }
        Ok(removed_ids.len())
    }

    pub fn replay(&self, handle: &str, after_seq: u64) -> Result<ReplayResult, PtyRuntimeError> {
        let session = self.session(handle)?;
        let commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        Ok(replay_from_commit(&commit, after_seq))
    }

    pub fn close(&self, handle: &str, mode: CloseMode) -> Result<CloseOutcome, PtyRuntimeError> {
        let transition = match self.inner.catalog.execute(CatalogCommand::RequestClose {
            handle: handle.to_owned(),
            now_ms: now_ms(),
        })? {
            CatalogResult::Transition(result) => result,
            _ => return Err(PtyRuntimeError::Io),
        };
        let session = match self.session(handle) {
            Ok(session) => session,
            Err(PtyRuntimeError::SessionNotFound)
                if matches!(
                    transition.record.state,
                    TerminalState::Exited | TerminalState::Closed | TerminalState::Lost
                ) =>
            {
                return Ok(CloseOutcome::Exited);
            }
            Err(error) => return Err(error),
        };
        if transition.changed {
            publish_state(
                &session,
                transition.record.state,
                transition.record.revision,
            );
        }
        if transition.record.state == TerminalState::Closed {
            self.finalize_closed(handle, &session)?;
            return Ok(CloseOutcome::Exited);
        }
        let deadline = Instant::now()
            + match mode {
                CloseMode::Graceful { timeout } | CloseMode::Force { timeout } => timeout,
            };
        match mode {
            CloseMode::Graceful { .. } => {
                session
                    .writer
                    .send_protocol(vec![0x03])
                    .map_err(map_writer_error)?;
            }
            CloseMode::Force { .. } => {
                terminate_process_tree(&session);
            }
        }
        Ok(
            if wait_for_exit_until(&session, deadline) && wait_for_drain_until(&session, deadline) {
                self.finalize_closed(handle, &session)?;
                CloseOutcome::Exited
            } else {
                CloseOutcome::Pending
            },
        )
    }

    pub fn session_count(&self) -> usize {
        let Ok(sessions) = self.inner.sessions.lock() else {
            return usize::MAX;
        };
        let mut live = 0usize;
        for session in sessions.values() {
            let Ok(commit) = session.commit.lock() else {
                return usize::MAX;
            };
            live = live.saturating_add(usize::from(!commit.exited));
        }
        live
    }

    fn session(&self, handle: &str) -> Result<Arc<Session>, PtyRuntimeError> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?
            .get(handle)
            .cloned()
            .ok_or(PtyRuntimeError::SessionNotFound)
    }

    fn reuse_at_capacity(
        &self,
        request: &CreatePtyRequest,
    ) -> Result<CreatePtyResult, PtyRuntimeError> {
        let lookup =
            self.inner
                .catalog
                .execute(CatalogCommand::Lookup(CatalogSelector::RequestId(
                    request.request_id.clone(),
                )));
        let (claim, terminal) = match lookup {
            Ok(CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { claim, terminal })) => {
                (claim, Some(terminal))
            }
            Ok(CatalogResult::Lookup(CatalogLookup::Collected(claim))) => (claim, None),
            Err(CatalogError::TerminalNotFound) => return Err(PtyRuntimeError::RegistryFull),
            Err(error) => return Err(error.into()),
            _ => return Err(PtyRuntimeError::Io),
        };
        if claim.digest != request.digest {
            return Err(CatalogError::RequestConflict.into());
        }
        if let Ok(session) = self.session(&claim.handle) {
            return Ok(CreatePtyResult {
                identity: session.identity.clone(),
                child_pid: live_child_pid(&session)?,
                disposition: CreateDisposition::Reused,
            });
        }
        let terminal = terminal.ok_or(PtyRuntimeError::SessionNotFound)?;
        Ok(CreatePtyResult {
            identity: StreamIdentity {
                runtime_id: terminal.runtime_id,
                handle: terminal.handle,
                stream_id: terminal.stream_id,
            },
            child_pid: None,
            disposition: CreateDisposition::Reused,
        })
    }

    fn has_create_capacity(&self) -> Result<bool, PtyRuntimeError> {
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?;
        if sessions.len() >= self.inner.config.max_registered_sessions {
            return Ok(false);
        }
        let mut live = 0usize;
        for session in sessions.values() {
            let commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
            live = live.saturating_add(usize::from(!commit.exited));
        }
        Ok(live < self.inner.config.max_sessions)
    }

    fn attached_session(
        &self,
        attach_id: &str,
        stream_id: &str,
    ) -> Result<Arc<Session>, PtyRuntimeError> {
        let session = self
            .inner
            .attachments
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?
            .get(attach_id)
            .and_then(Weak::upgrade)
            .ok_or(PtyRuntimeError::StaleAttachment)?;
        if session.identity.stream_id != stream_id
            || !session
                .commit
                .lock()
                .map_err(|_| PtyRuntimeError::Io)?
                .attachments
                .contains_key(attach_id)
        {
            return Err(PtyRuntimeError::StaleAttachment);
        }
        Ok(session)
    }

    fn spawn_session(
        &self,
        handle: &str,
        stream_id: &str,
        request: &CreatePtyRequest,
    ) -> Result<Arc<Session>, PtyRuntimeError> {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| PtyRuntimeError::SpawnFailed)?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| PtyRuntimeError::SpawnFailed)?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| PtyRuntimeError::SpawnFailed)?;
        let writer = PriorityWriter::start(
            writer,
            self.inner.config.writer_high_capacity,
            self.inner.config.writer_input_capacity,
        )
        .map_err(|_| PtyRuntimeError::SpawnFailed)?;
        let mut command = CommandBuilder::new(&request.executable);
        command.args(&request.args);
        command.cwd(&request.cwd);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| PtyRuntimeError::SpawnFailed)?;
        drop(pair.slave);
        let child_pid = child.process_id();
        let session = Arc::new(Session {
            identity: StreamIdentity {
                runtime_id: self.inner.runtime_id.clone(),
                handle: handle.to_owned(),
                stream_id: stream_id.to_owned(),
            },
            child_pid,
            child: Mutex::new(child),
            master: Mutex::new(Some(pair.master)),
            reader: Mutex::new(Some(reader)),
            writer,
            commit: Mutex::new(CommitState {
                seq: 0,
                rows: request.rows,
                cols: request.cols,
                raw_bytes: 0,
                replay: VecDeque::new(),
                emulator: CanonicalEmulator::new(
                    request.rows,
                    request.cols,
                    self.inner.config.scrollback_lines,
                ),
                attachments: HashMap::new(),
                exited: false,
            }),
            exit: (Mutex::new(None), Condvar::new()),
            drained: (Mutex::new(false), Condvar::new()),
        });
        Ok(session)
    }

    fn start_session_threads(&self, session: Arc<Session>) -> Result<(), PtyRuntimeError> {
        let monitor_session = Arc::clone(&session);
        thread::Builder::new()
            .name("terminal-host-child-monitor".to_owned())
            .spawn(move || child_monitor(monitor_session))
            .map_err(|_| PtyRuntimeError::Io)?;

        let reader = session
            .reader
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?
            .take()
            .ok_or(PtyRuntimeError::Io)?;
        let weak_engine = Arc::downgrade(&self.inner);
        let reader_session = Arc::clone(&session);
        thread::Builder::new()
            .name("terminal-host-pty-reader".to_owned())
            .spawn(move || reader_main(reader, reader_session, weak_engine))
            .map_err(|_| PtyRuntimeError::Io)?;
        Ok(())
    }

    fn finalize_closed(&self, handle: &str, session: &Session) -> Result<(), PtyRuntimeError> {
        let attach_ids = {
            let mut commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
            commit
                .attachments
                .drain()
                .map(|(id, attachment)| {
                    attachment.queue.finish();
                    id
                })
                .collect::<Vec<_>>()
        };
        let mut index = self
            .inner
            .attachments
            .lock()
            .map_err(|_| PtyRuntimeError::Io)?;
        for id in attach_ids {
            index.remove(&id);
        }
        drop(index);
        remove_session_if_current(&self.inner, handle, session)?;
        let _ = self
            .inner
            .catalog
            .execute(CatalogCommand::ReconcileClosed {
                handle: handle.to_owned(),
                now_ms: now_ms(),
            })?;
        Ok(())
    }
}

fn reader_main(mut reader: Box<dyn Read + Send>, session: Arc<Session>, engine: Weak<EngineInner>) {
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => commit_output(&session, &buffer[..count], &engine),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let exit_code = wait_for_recorded_exit(&session);
    commit_exit(&session, exit_code, engine);
}

fn child_monitor(session: Arc<Session>) {
    loop {
        let result = match session.child.lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => {
                record_child_exit(&session, None);
                return;
            }
        };
        match result {
            Ok(Some(status)) => {
                record_child_exit(&session, i32::try_from(status.exit_code()).ok());
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                // A failed status query means the owner can no longer prove
                // liveness. Close the master and finalize the stream as an
                // unknown exit instead of leaking the monitor and reader.
                record_child_exit(&session, None);
                return;
            }
        }
    }
}

fn record_child_exit(session: &Session, code: Option<i32>) {
    // On Windows a live master clone can keep ConPTY's reader open after the
    // direct child exits. Close it only after exit/liveness-loss proof, then
    // let the reader drain and own the final commit.
    if let Ok(mut master) = session.master.lock() {
        master.take();
    }
    let (exit, ready) = &session.exit;
    if let Ok(mut exit) = exit.lock() {
        *exit = Some(code);
        ready.notify_all();
    }
}

fn commit_output(session: &Session, bytes: &[u8], engine: &Weak<EngineInner>) {
    let Some(engine) = engine.upgrade() else {
        return;
    };
    let Ok(mut commit) = session.commit.lock() else {
        return;
    };
    if commit.exited {
        return;
    }
    commit_bytes(
        &session.identity,
        &mut commit,
        bytes,
        engine.config.raw_replay_bytes,
    );
}

fn commit_bytes(
    identity: &StreamIdentity,
    commit: &mut CommitState,
    bytes: &[u8],
    raw_replay_bytes: usize,
) {
    commit.seq = commit.seq.saturating_add(1);
    let seq = commit.seq;
    commit.emulator.advance(bytes);
    commit.raw_bytes = commit.raw_bytes.saturating_add(bytes.len());
    commit.replay.push_back(ReplayChunk {
        seq,
        bytes: bytes.to_vec(),
    });
    while commit.raw_bytes > raw_replay_bytes {
        let Some(removed) = commit.replay.pop_front() else {
            break;
        };
        commit.raw_bytes = commit.raw_bytes.saturating_sub(removed.bytes.len());
    }
    for (attach_id, attachment) in &mut commit.attachments {
        if attachment.dirty {
            continue;
        }
        let event = RuntimeEvent::Output {
            identity: identity.clone(),
            attach_id: attach_id.clone(),
            seq,
            bytes: bytes.to_vec(),
        };
        if attachment.queue.push_output(event) {
            attachment.last_delivered_seq = seq;
        } else {
            attachment.dirty = true;
            attachment.queue.push_control(RuntimeEvent::ResyncRequired {
                identity: identity.clone(),
                attach_id: attach_id.clone(),
                last_delivered_seq: attachment.last_delivered_seq,
                current_seq: seq,
                reason: ResyncReason::QueueOverflow,
            });
        }
    }
}

fn commit_exit(session: &Session, exit_code: Option<i32>, engine: Weak<EngineInner>) {
    let Some(engine) = engine.upgrade() else {
        mark_reader_drained(session);
        return;
    };
    let transition = match engine.catalog.execute(CatalogCommand::MarkExited {
        handle: session.identity.handle.clone(),
        exit_code: exit_code.unwrap_or(-1),
        now_ms: now_ms(),
    }) {
        Ok(CatalogResult::Transition(result)) => Some(result),
        _ => None,
    };
    let revision = transition
        .as_ref()
        .map_or(0, |result| result.record.revision);
    let mut has_attachments = true;
    if let Ok(mut commit) = session.commit.lock() {
        commit.exited = true;
        for attachment in commit.attachments.values() {
            if let Some(transition) = &transition {
                attachment.queue.push_control(RuntimeEvent::State {
                    identity: session.identity.clone(),
                    revision: transition.record.revision,
                    state: transition.record.state,
                });
            }
            attachment.queue.push_terminal(RuntimeEvent::Exit {
                identity: session.identity.clone(),
                revision,
                exit_code,
            });
            attachment.queue.finish();
        }
        has_attachments = !commit.attachments.is_empty();
    }
    if !has_attachments {
        let _ = remove_session_if_current(&engine, &session.identity.handle, session);
    }
    mark_reader_drained(session);
}

fn live_child_pid(session: &Session) -> Result<Option<u32>, PtyRuntimeError> {
    let commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
    Ok((!commit.exited).then_some(session.child_pid).flatten())
}

fn reap_exited_if_unattached(
    engine: &EngineInner,
    session: &Arc<Session>,
) -> Result<bool, PtyRuntimeError> {
    let should_reap = {
        let commit = session.commit.lock().map_err(|_| PtyRuntimeError::Io)?;
        commit.exited && commit.attachments.is_empty()
    };
    if !should_reap {
        return Ok(false);
    }
    remove_session_if_current(engine, &session.identity.handle, session.as_ref())
}

fn remove_session_if_current(
    engine: &EngineInner,
    handle: &str,
    session: &Session,
) -> Result<bool, PtyRuntimeError> {
    let mut sessions = engine.sessions.lock().map_err(|_| PtyRuntimeError::Io)?;
    let is_current = sessions
        .get(handle)
        .is_some_and(|current| std::ptr::eq(current.as_ref(), session));
    if is_current {
        sessions.remove(handle);
    }
    Ok(is_current)
}

fn terminate_process_tree(session: &Session) {
    let Ok(mut child) = session.child.lock() else {
        return;
    };
    #[cfg(windows)]
    if let Some(pid) = child.process_id() {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn snapshot_from_commit(commit: &CommitState) -> PtySnapshot {
    let snapshot = commit.emulator.snapshot();
    PtySnapshot {
        content: snapshot.content,
        rows: commit.rows,
        cols: commit.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
    }
}

fn wait_for_recorded_exit(session: &Session) -> Option<i32> {
    let (exit, ready) = &session.exit;
    let mut value = exit.lock().ok()?;
    while value.is_none() {
        value = ready.wait(value).ok()?;
    }
    value.flatten()
}

fn wait_for_exit_until(session: &Session, deadline: Instant) -> bool {
    let (exit, ready) = &session.exit;
    let Ok(mut value) = exit.lock() else {
        return false;
    };
    while value.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let Ok((next, result)) = ready.wait_timeout(value, remaining) else {
            return false;
        };
        value = next;
        if result.timed_out() && value.is_none() {
            return false;
        }
    }
    true
}

fn wait_for_drain_until(session: &Session, deadline: Instant) -> bool {
    let (drained, ready) = &session.drained;
    let Ok(mut value) = drained.lock() else {
        return false;
    };
    while !*value {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let Ok((next, result)) = ready.wait_timeout(value, remaining) else {
            return false;
        };
        value = next;
        if result.timed_out() && !*value {
            return false;
        }
    }
    true
}

fn mark_reader_drained(session: &Session) {
    let (drained, ready) = &session.drained;
    if let Ok(mut value) = drained.lock() {
        *value = true;
        ready.notify_all();
    }
}

fn publish_state(session: &Session, state: TerminalState, revision: u64) {
    if let Ok(commit) = session.commit.lock() {
        for attachment in commit.attachments.values() {
            attachment.queue.push_control(RuntimeEvent::State {
                identity: session.identity.clone(),
                revision,
                state,
            });
        }
    }
}

fn replay_from_commit(commit: &CommitState, after_seq: u64) -> ReplayResult {
    if after_seq >= commit.seq {
        return ReplayResult::Chunks(Vec::new());
    }
    let Some(first) = commit.replay.front().map(|chunk| chunk.seq) else {
        return ReplayResult::ResyncRequired {
            current_seq: commit.seq,
        };
    };
    if after_seq.saturating_add(1) < first {
        return ReplayResult::ResyncRequired {
            current_seq: commit.seq,
        };
    }
    ReplayResult::Chunks(
        commit
            .replay
            .iter()
            .filter(|chunk| chunk.seq > after_seq)
            .cloned()
            .collect(),
    )
}

fn validate_config(config: PtyRuntimeConfig) -> Result<(), PtyRuntimeError> {
    (config.max_sessions > 0
        && config.max_registered_sessions >= config.max_sessions
        && config.max_attachments_per_session > 0
        && config.output_queue_capacity > 0
        && config.writer_high_capacity > 0
        && config.writer_input_capacity > 0
        && config.raw_replay_bytes > 0
        && config.scrollback_lines >= 3_000)
        .then_some(())
        .ok_or(PtyRuntimeError::InvalidConfiguration)
}

fn validate_create(request: &CreatePtyRequest) -> Result<(), PtyRuntimeError> {
    (!request.request_id.trim().is_empty()
        && !request.executable.as_os_str().is_empty()
        && !request.cwd.as_os_str().is_empty()
        && valid_dimensions(request.rows, request.cols))
    .then_some(())
    .ok_or(PtyRuntimeError::InvalidRequest)
}

fn valid_dimensions(rows: u16, cols: u16) -> bool {
    (1..=MAX_PTY_ROWS).contains(&rows) && (1..=MAX_PTY_COLS).contains(&cols)
}

fn map_writer_error(error: io::Error) -> PtyRuntimeError {
    if error.kind() == io::ErrorKind::WouldBlock {
        PtyRuntimeError::QueueFull
    } else {
        PtyRuntimeError::Io
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[allow(dead_code)]
fn _catalog_state_is_terminal(state: TerminalState) -> bool {
    matches!(
        state,
        TerminalState::Exited | TerminalState::Closed | TerminalState::Lost
    )
}

#[allow(dead_code)]
fn _placement_is_supported(placement: Placement) -> bool {
    matches!(placement, Placement::Workspace | Placement::Window)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        sync::{Arc, Barrier, Mutex},
        thread,
        time::Duration,
    };

    use super::{
        commit_bytes, replay_from_commit, snapshot_from_commit, Attachment, CanonicalEmulator,
        CommitState, EventQueue, EventSubscription, ReplayResult, ResyncReason, RuntimeEvent,
        StreamIdentity,
    };

    fn identity(handle: &str) -> StreamIdentity {
        StreamIdentity {
            runtime_id: "runtime".to_owned(),
            handle: handle.to_owned(),
            stream_id: format!("stream-{handle}"),
        }
    }

    fn commit_state() -> CommitState {
        CommitState {
            seq: 0,
            rows: 24,
            cols: 80,
            raw_bytes: 0,
            replay: VecDeque::new(),
            emulator: CanonicalEmulator::new(24, 80, 3_000),
            attachments: HashMap::new(),
            exited: false,
        }
    }

    fn attach(commit: &mut CommitState, capacity: usize) -> EventSubscription {
        let attach_id = "attach".to_owned();
        let queue = Arc::new(EventQueue::new(capacity));
        commit.attachments.insert(
            attach_id.clone(),
            Attachment {
                client_id: "client".to_owned(),
                queue: Arc::clone(&queue),
                acked_seq: commit.seq,
                last_delivered_seq: commit.seq,
                dirty: false,
            },
        );
        EventSubscription { attach_id, queue }
    }

    #[test]
    fn attach_output_race_has_one_atomic_barrier() {
        let identity = identity("race");
        let commit = Arc::new(Mutex::new(commit_state()));
        let start = Arc::new(Barrier::new(2));
        let output_commit = Arc::clone(&commit);
        let output_start = Arc::clone(&start);
        let output_identity = identity.clone();
        let output = thread::spawn(move || {
            output_start.wait();
            let mut commit = output_commit.lock().unwrap();
            commit_bytes(&output_identity, &mut commit, b"RACE", 1024);
        });
        start.wait();
        let (barrier, snapshot, subscription) = {
            let mut commit = commit.lock().unwrap();
            let subscription = attach(&mut commit, 4);
            (commit.seq, snapshot_from_commit(&commit), subscription)
        };
        output.join().unwrap();

        let in_snapshot = String::from_utf8_lossy(&snapshot.content).contains("RACE");
        let in_delta = matches!(
            subscription.recv_timeout(Duration::from_millis(50)),
            Some(RuntimeEvent::Output { seq: 1, .. })
        );
        assert_ne!(in_snapshot, in_delta);
        assert_eq!(barrier, u64::from(in_snapshot));
    }

    #[test]
    fn interleaved_sessions_keep_independent_sequences() {
        let mut first = commit_state();
        let mut second = commit_state();
        for index in 0..20 {
            commit_bytes(&identity("a"), &mut first, &[index], 1024);
            commit_bytes(&identity("b"), &mut second, &[index], 1024);
        }
        assert_eq!(first.seq, 20);
        assert_eq!(second.seq, 20);
        assert_eq!(first.replay.front().unwrap().seq, 1);
        assert_eq!(second.replay.front().unwrap().seq, 1);
    }

    #[test]
    fn queue_overflow_marks_dirty_and_emits_resync_once() {
        let identity = identity("overflow");
        let mut commit = commit_state();
        let subscription = attach(&mut commit, 1);
        for bytes in [b"one".as_slice(), b"two", b"three"] {
            commit_bytes(&identity, &mut commit, bytes, 1024);
        }
        assert!(commit.attachments["attach"].dirty);
        assert!(matches!(
            subscription.recv_timeout(Duration::ZERO),
            Some(RuntimeEvent::ResyncRequired {
                reason: ResyncReason::QueueOverflow,
                current_seq: 2,
                ..
            })
        ));
        assert!(matches!(
            subscription.recv_timeout(Duration::ZERO),
            Some(RuntimeEvent::Output { seq: 1, .. })
        ));
        assert_eq!(subscription.recv_timeout(Duration::ZERO), None);

        let attachment = commit.attachments.get_mut("attach").unwrap();
        attachment.queue.reset_output();
        attachment.acked_seq = commit.seq;
        attachment.last_delivered_seq = commit.seq;
        attachment.dirty = false;
        commit_bytes(&identity, &mut commit, b"recovered", 1024);
        assert!(matches!(
            subscription.recv_timeout(Duration::ZERO),
            Some(RuntimeEvent::Output {
                seq: 4,
                bytes,
                ..
            }) if bytes == b"recovered"
        ));
    }

    #[test]
    fn cumulative_ack_watermarks_are_idempotent_and_bounded() {
        let mut commit = commit_state();
        let _subscription = attach(&mut commit, 4);
        commit_bytes(&identity("ack"), &mut commit, b"1", 1024);
        let attachment = commit.attachments.get_mut("attach").unwrap();
        assert_eq!(attachment.acked_seq, 0);
        assert_eq!(attachment.last_delivered_seq, 1);
        attachment.acked_seq = 1;
        assert!(1 <= attachment.acked_seq, "an older ACK is a no-op");
        assert!(2 > attachment.last_delivered_seq, "future ACK is rejected");
    }

    #[test]
    fn empty_replay_window_requires_resync_when_sequence_advanced() {
        let mut commit = commit_state();
        commit.seq = 7;
        assert_eq!(
            replay_from_commit(&commit, 6),
            ReplayResult::ResyncRequired { current_seq: 7 }
        );
    }

    #[test]
    fn output_debug_is_redacted() {
        let sentinel = b"SECRET-TERMINAL-OUTPUT";
        let event = RuntimeEvent::Output {
            identity: identity("debug"),
            attach_id: "secret-attachment".to_owned(),
            seq: 1,
            bytes: sentinel.to_vec(),
        };
        let replay = super::ReplayChunk {
            seq: 1,
            bytes: sentinel.to_vec(),
        };
        let snapshot = super::PtySnapshot {
            content: sentinel.to_vec(),
            rows: 1,
            cols: 1,
            cursor_row: 1,
            cursor_col: 1,
        };
        for rendered in [
            format!("{event:?}"),
            format!("{replay:?}"),
            format!("{snapshot:?}"),
        ] {
            assert!(!rendered.contains("SECRET-TERMINAL-OUTPUT"));
            assert!(!rendered.contains("secret-attachment"));
        }
    }
}
