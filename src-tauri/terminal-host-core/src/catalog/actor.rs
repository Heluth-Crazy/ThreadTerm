use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use terminal_host_protocol::{is_valid_request_id, ExitBehavior, Placement, Presentation};
use uuid::Uuid;

use super::{
    migrations::open_and_initialize, CatalogCommand, CatalogError, CatalogListPage, CatalogLookup,
    CatalogResult, CatalogSelector, ClaimDisposition, ClaimResult, CreateClaim, DurableClaim,
    RequestDigest, RuntimeIdentity, RuntimeReconciliation, TerminalRecord, TerminalState,
    TransitionResult, MAX_LIST_PAGE_SIZE,
};

const DEFAULT_QUEUE_CAPACITY: usize = 64;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const INITIALIZATION_PENDING: u8 = 0;
const INITIALIZATION_CANCELLED: u8 = 1;
const INITIALIZATION_COMMITTING: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub struct CatalogOptions {
    pub queue_capacity: usize,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
}

impl Default for CatalogOptions {
    fn default() -> Self {
        Self {
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        }
    }
}

enum ActorMessage {
    Execute {
        command: CatalogCommand,
        reply: SyncSender<Result<CatalogResult, CatalogError>>,
    },
    Shutdown {
        reply: SyncSender<()>,
    },
}

pub struct Catalog {
    sender: SyncSender<ActorMessage>,
    join: Option<JoinHandle<()>>,
    request_timeout: Duration,
    shutdown_timeout: Duration,
}

impl Catalog {
    pub fn open(
        path: impl AsRef<Path>,
        identity: RuntimeIdentity,
    ) -> Result<(Self, RuntimeReconciliation), CatalogError> {
        Self::open_with_options(path, identity, CatalogOptions::default())
    }

    pub fn open_with_options(
        path: impl AsRef<Path>,
        identity: RuntimeIdentity,
        options: CatalogOptions,
    ) -> Result<(Self, RuntimeReconciliation), CatalogError> {
        if options.queue_capacity == 0
            || options.request_timeout.is_zero()
            || options.shutdown_timeout.is_zero()
        {
            return Err(CatalogError::InvalidInput("invalid actor options"));
        }

        let (sender, receiver) = mpsc::sync_channel(options.queue_capacity);
        let (initialized_sender, initialized_receiver) = mpsc::sync_channel(1);
        let initialization = Arc::new(AtomicU8::new(INITIALIZATION_PENDING));
        let path = PathBuf::from(path.as_ref());
        let actor_initialization = Arc::clone(&initialization);
        let join = thread::Builder::new()
            .name("terminal-host-catalog".to_owned())
            .spawn(move || {
                actor_main(
                    path,
                    identity,
                    receiver,
                    initialized_sender,
                    actor_initialization,
                )
            })
            .map_err(|_| CatalogError::ActorStopped)?;

        let reconciliation = match initialized_receiver.recv_timeout(options.request_timeout) {
            Ok(Ok(reconciliation)) => reconciliation,
            Ok(Err(error)) => {
                let _ = join.join();
                return Err(error);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                match initialization.compare_exchange(
                    INITIALIZATION_PENDING,
                    INITIALIZATION_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => return Err(CatalogError::Timeout),
                    Err(INITIALIZATION_COMMITTING) => initialized_receiver
                        .recv()
                        .map_err(|_| CatalogError::ActorStopped)??,
                    Err(INITIALIZATION_CANCELLED) => return Err(CatalogError::Timeout),
                    Err(_) => return Err(CatalogError::ActorStopped),
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(CatalogError::ActorStopped),
        };
        Ok((
            Self {
                sender,
                join: Some(join),
                request_timeout: options.request_timeout,
                shutdown_timeout: options.shutdown_timeout,
            },
            reconciliation,
        ))
    }

    pub fn execute(&self, command: CatalogCommand) -> Result<CatalogResult, CatalogError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(ActorMessage::Execute { command, reply })
            .map_err(|error| match error {
                TrySendError::Full(_) => CatalogError::QueueFull,
                TrySendError::Disconnected(_) => CatalogError::ActorStopped,
            })?;
        receiver
            .recv_timeout(self.request_timeout)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => CatalogError::Timeout,
                mpsc::RecvTimeoutError::Disconnected => CatalogError::ActorStopped,
            })?
    }

    pub fn shutdown(mut self) -> Result<(), CatalogError> {
        self.shutdown_inner()
    }

    fn shutdown_inner(&mut self) -> Result<(), CatalogError> {
        let Some(join) = self.join.take() else {
            return Ok(());
        };
        let (reply, receiver) = mpsc::sync_channel(1);
        send_with_deadline(
            &self.sender,
            ActorMessage::Shutdown { reply },
            self.shutdown_timeout,
        )?;
        receiver
            .recv_timeout(self.shutdown_timeout)
            .map_err(|_| CatalogError::Timeout)?;
        join.join().map_err(|_| CatalogError::ActorStopped)
    }
}

impl Drop for Catalog {
    fn drop(&mut self) {
        let _ = self.shutdown_inner();
    }
}

fn send_with_deadline(
    sender: &SyncSender<ActorMessage>,
    mut message: ActorMessage,
    timeout: Duration,
) -> Result<(), CatalogError> {
    let deadline = Instant::now() + timeout;
    loop {
        match sender.try_send(message) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Disconnected(_)) => return Err(CatalogError::ActorStopped),
            Err(TrySendError::Full(returned)) => {
                if Instant::now() >= deadline {
                    return Err(CatalogError::Timeout);
                }
                message = returned;
                thread::yield_now();
            }
        }
    }
}

fn actor_main(
    path: PathBuf,
    identity: RuntimeIdentity,
    receiver: Receiver<ActorMessage>,
    initialized: SyncSender<Result<RuntimeReconciliation, CatalogError>>,
    initialization: Arc<AtomicU8>,
) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let (mut connection, reconciliation) =
        match open_and_initialize(&path, &identity, now_ms, &initialization) {
            Ok(value) => value,
            Err(error) => {
                let _ = initialized.send(Err(error));
                return;
            }
        };
    if initialized.send(Ok(reconciliation.clone())).is_err() {
        return;
    }

    while let Ok(message) = receiver.recv() {
        match message {
            ActorMessage::Execute { command, reply } => {
                let _ = reply.send(handle_command(
                    &mut connection,
                    &identity,
                    reconciliation.generation,
                    command,
                ));
            }
            ActorMessage::Shutdown { reply } => {
                let _ = reply.send(());
                return;
            }
        }
    }
}

fn handle_command(
    connection: &mut Connection,
    identity: &RuntimeIdentity,
    generation: u64,
    command: CatalogCommand,
) -> Result<CatalogResult, CatalogError> {
    match command {
        CatalogCommand::Claim(request) => {
            claim_terminal(connection, identity, generation, request).map(CatalogResult::Claim)
        }
        CatalogCommand::Lookup(selector) => lookup(connection, selector).map(CatalogResult::Lookup),
        CatalogCommand::ListPage { limit } => {
            list_page(connection, limit).map(CatalogResult::ListPage)
        }
        CatalogCommand::MarkRunning { handle, now_ms } => transition(
            connection,
            &handle,
            now_ms,
            identity,
            generation,
            Transition::MarkRunning,
        )
        .map(CatalogResult::Transition),
        CatalogCommand::MarkExited {
            handle,
            exit_code,
            now_ms,
        } => transition(
            connection,
            &handle,
            now_ms,
            identity,
            generation,
            Transition::MarkExited(exit_code),
        )
        .map(CatalogResult::Transition),
        CatalogCommand::RequestClose { handle, now_ms } => transition(
            connection,
            &handle,
            now_ms,
            identity,
            generation,
            Transition::RequestClose,
        )
        .map(CatalogResult::Transition),
        CatalogCommand::ReconcileClosed { handle, now_ms } => transition(
            connection,
            &handle,
            now_ms,
            identity,
            generation,
            Transition::ReconcileClosed,
        )
        .map(CatalogResult::Transition),
        CatalogCommand::SetDesiredPresentation {
            handle,
            placement,
            workspace_target,
            presentation,
            expected_revision,
            now_ms,
        } => set_desired_presentation(
            connection,
            &handle,
            placement,
            workspace_target.as_deref(),
            presentation,
            expected_revision,
            now_ms,
            identity,
            generation,
        )
        .map(CatalogResult::Transition),
        CatalogCommand::SetSurfaceHidden {
            handle,
            hidden,
            expected_revision,
            now_ms,
        } => set_surface_hidden(
            connection,
            &handle,
            hidden,
            expected_revision,
            now_ms,
            identity,
            generation,
        )
        .map(CatalogResult::Transition),
        CatalogCommand::GcTombstones {
            older_than_ms,
            limit,
        } => gc_tombstones(connection, older_than_ms, limit, identity, generation)
            .map(CatalogResult::GarbageCollected),
    }
}

enum Transition {
    MarkRunning,
    MarkExited(i32),
    RequestClose,
    ReconcileClosed,
}

fn claim_terminal(
    connection: &mut Connection,
    identity: &RuntimeIdentity,
    generation: u64,
    request: CreateClaim,
) -> Result<ClaimResult, CatalogError> {
    validate_create(&request)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    assert_runtime_owner(&transaction, identity, generation)?;
    if let Some(claim) = query_claim_by_request(&transaction, &request.request_id)? {
        if claim.digest != request.digest {
            return Err(CatalogError::RequestConflict);
        }
        let terminal = query_record(&transaction, &claim.handle)?;
        transaction.commit().map_err(|_| CatalogError::Database)?;
        return Ok(ClaimResult {
            disposition: ClaimDisposition::Reused,
            claim,
            terminal,
        });
    }

    let handle = Uuid::new_v4().simple().to_string();
    let claim = DurableClaim {
        request_id: request.request_id.clone(),
        digest: request.digest.clone(),
        handle: handle.clone(),
        created_at_ms: request.now_ms,
    };
    let placement = placement_to_str(&request.target.placement());
    let presentation = presentation_to_str(&request.presentation);
    let exit_behavior = exit_behavior_to_str(&request.exit_behavior);
    transaction
        .execute(
            "INSERT INTO idempotency_claims (
                request_id, request_digest, handle, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                request.request_id,
                request.digest.as_bytes().as_slice(),
                handle,
                request.now_ms
            ],
        )
        .map_err(|_| CatalogError::Database)?;
    transaction
        .execute(
            "INSERT INTO terminal_records (
                handle, runtime_id, launch_nonce, generation, stream_id,
                state, revision, title, placement, presentation, exit_behavior,
                workspace_target, surface_hidden, created_at_ms, updated_at_ms,
                exited_at_ms, tombstoned_at_ms, exit_code
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, 'creating', 1, ?6, ?7, ?8, ?9,
                ?10, 0, ?11, ?11, NULL, NULL, NULL
             )",
            params![
                handle,
                identity.runtime_id,
                identity.launch_nonce,
                generation,
                request.stream_id,
                request.title,
                placement,
                presentation,
                exit_behavior,
                request.target.workspace_target(),
                request.now_ms
            ],
        )
        .map_err(|_| CatalogError::Database)?;
    let terminal =
        query_record(&transaction, &claim.handle)?.ok_or(CatalogError::TerminalNotFound)?;
    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(ClaimResult {
        disposition: ClaimDisposition::Created,
        claim,
        terminal: Some(terminal),
    })
}

fn validate_create(request: &CreateClaim) -> Result<(), CatalogError> {
    if request.now_ms < 0 {
        return Err(CatalogError::InvalidInput("negative timestamp"));
    }
    if !is_valid_request_id(&request.request_id) {
        return Err(CatalogError::InvalidInput("invalid request id"));
    }
    if request.stream_id.trim().is_empty() || request.stream_id.len() > 256 {
        return Err(CatalogError::InvalidInput("invalid stream id"));
    }
    if request
        .title
        .as_ref()
        .is_some_and(|title| title.trim().is_empty() || title.len() > 4096)
    {
        return Err(CatalogError::InvalidInput("title is too long"));
    }
    validate_presentation_target(
        &request.target.placement(),
        request.target.workspace_target(),
    )
}

fn validate_presentation_target(
    placement: &Placement,
    workspace_target: Option<&str>,
) -> Result<(), CatalogError> {
    match (placement, workspace_target) {
        (Placement::Workspace, Some(target))
            if !target.trim().is_empty() && target.len() <= 32_768 =>
        {
            Ok(())
        }
        (Placement::Window, None) => Ok(()),
        _ => Err(CatalogError::InvalidInput("invalid workspace target")),
    }
}

fn lookup(
    connection: &Connection,
    selector: CatalogSelector,
) -> Result<CatalogLookup, CatalogError> {
    let claim = match selector {
        CatalogSelector::Handle(handle) => {
            if handle.trim().is_empty() || handle.len() > 128 {
                return Err(CatalogError::InvalidInput("invalid handle"));
            }
            query_claim_by_handle(connection, &handle)?
        }
        CatalogSelector::RequestId(request_id) => {
            if !is_valid_request_id(&request_id) {
                return Err(CatalogError::InvalidInput("invalid request id"));
            }
            query_claim_by_request(connection, &request_id)?
        }
    }
    .ok_or(CatalogError::TerminalNotFound)?;
    match query_record(connection, &claim.handle)? {
        Some(terminal) => Ok(CatalogLookup::ActiveOrTombstone {
            claim,
            terminal: Box::new(terminal),
        }),
        None => Ok(CatalogLookup::Collected(claim)),
    }
}

fn list_page(connection: &Connection, limit: u32) -> Result<CatalogListPage, CatalogError> {
    if limit == 0 || limit > MAX_LIST_PAGE_SIZE {
        return Err(CatalogError::InvalidInput("invalid list page limit"));
    }
    let fetch_limit = i64::from(limit) + 1;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM terminal_records
             ORDER BY created_at_ms, handle LIMIT ?1",
            RECORD_COLUMNS
        ))
        .map_err(|_| CatalogError::Database)?;
    let records = statement
        .query_map([fetch_limit], read_record)
        .map_err(|_| CatalogError::Database)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CatalogError::Database)?;
    let has_more = records.len() > limit as usize;
    let mut records = records;
    records.truncate(limit as usize);
    Ok(CatalogListPage { records, has_more })
}

fn transition(
    connection: &mut Connection,
    handle: &str,
    now_ms: i64,
    identity: &RuntimeIdentity,
    generation: u64,
    transition: Transition,
) -> Result<TransitionResult, CatalogError> {
    validate_handle(handle)?;
    if now_ms < 0 {
        return Err(CatalogError::InvalidInput("negative timestamp"));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    assert_runtime_owner(&transaction, identity, generation)?;
    let current = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    if now_ms < current.updated_at_ms {
        return Err(CatalogError::InvalidInput("stale timestamp"));
    }
    let changed = match transition {
        Transition::MarkRunning if current.state == TerminalState::Creating => {
            transaction
                .execute(
                    "UPDATE terminal_records SET state = 'running', revision = revision + 1,
                    updated_at_ms = ?2 WHERE handle = ?1 AND state = 'creating'",
                    params![handle, now_ms],
                )
                .map_err(|_| CatalogError::Database)?
                == 1
        }
        Transition::MarkRunning if current.state == TerminalState::Running => false,
        Transition::MarkRunning => return Err(CatalogError::InvalidTransition),
        Transition::MarkExited(exit_code)
            if matches!(
                current.state,
                TerminalState::Creating | TerminalState::Running | TerminalState::Closing
            ) =>
        {
            transaction
                .execute(
                    "UPDATE terminal_records SET state = 'exited', revision = revision + 1,
                        updated_at_ms = ?2, exited_at_ms = COALESCE(exited_at_ms, ?2),
                        tombstoned_at_ms = COALESCE(tombstoned_at_ms, ?2), exit_code = ?3
                     WHERE handle = ?1 AND state IN ('creating', 'running', 'closing')",
                    params![handle, now_ms, exit_code],
                )
                .map_err(|_| CatalogError::Database)?
                == 1
        }
        Transition::MarkExited(_) => false,
        Transition::RequestClose
            if matches!(
                current.state,
                TerminalState::Creating | TerminalState::Running
            ) =>
        {
            transaction
                .execute(
                    "UPDATE terminal_records SET state = 'closing', revision = revision + 1,
                        updated_at_ms = ?2
                     WHERE handle = ?1 AND state IN ('creating', 'running')",
                    params![handle, now_ms],
                )
                .map_err(|_| CatalogError::Database)?
                == 1
        }
        Transition::RequestClose if current.state == TerminalState::Exited => {
            transaction
                .execute(
                    "UPDATE terminal_records SET state = 'closed', revision = revision + 1,
                    updated_at_ms = ?2, tombstoned_at_ms = COALESCE(tombstoned_at_ms, ?2)
                 WHERE handle = ?1 AND state = 'exited'",
                    params![handle, now_ms],
                )
                .map_err(|_| CatalogError::Database)?
                == 1
        }
        Transition::RequestClose => false,
        Transition::ReconcileClosed
            if !matches!(current.state, TerminalState::Closed | TerminalState::Lost) =>
        {
            transaction
                .execute(
                    "UPDATE terminal_records SET state = 'closed', revision = revision + 1,
                        updated_at_ms = ?2, tombstoned_at_ms = COALESCE(tombstoned_at_ms, ?2)
                     WHERE handle = ?1 AND state NOT IN ('closed', 'lost')",
                    params![handle, now_ms],
                )
                .map_err(|_| CatalogError::Database)?
                == 1
        }
        Transition::ReconcileClosed => false,
    };
    let record = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(TransitionResult { changed, record })
}

fn set_surface_hidden(
    connection: &mut Connection,
    handle: &str,
    hidden: bool,
    expected_revision: u64,
    now_ms: i64,
    identity: &RuntimeIdentity,
    generation: u64,
) -> Result<TransitionResult, CatalogError> {
    validate_handle(handle)?;
    if now_ms < 0 {
        return Err(CatalogError::InvalidInput("negative timestamp"));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    assert_runtime_owner(&transaction, identity, generation)?;
    let current = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    if now_ms < current.updated_at_ms {
        return Err(CatalogError::InvalidInput("stale timestamp"));
    }
    if expected_revision != current.revision {
        return Err(CatalogError::StalePresentation);
    }
    if !hidden {
        return Err(CatalogError::InvalidInput("surface must be hidden"));
    }
    let changed = !current.surface_hidden;
    if changed {
        transaction
            .execute(
                "UPDATE terminal_records SET surface_hidden = ?2, revision = revision + 1,
                    updated_at_ms = ?3 WHERE handle = ?1 AND revision = ?4",
                params![handle, hidden, now_ms, expected_revision],
            )
            .map_err(|_| CatalogError::Database)?;
    }
    let record = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(TransitionResult { changed, record })
}

#[allow(clippy::too_many_arguments)]
fn set_desired_presentation(
    connection: &mut Connection,
    handle: &str,
    placement: Placement,
    workspace_target: Option<&str>,
    presentation: Presentation,
    expected_revision: u64,
    now_ms: i64,
    identity: &RuntimeIdentity,
    generation: u64,
) -> Result<TransitionResult, CatalogError> {
    validate_handle(handle)?;
    validate_presentation_target(&placement, workspace_target)?;
    if now_ms < 0 {
        return Err(CatalogError::InvalidInput("negative timestamp"));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    assert_runtime_owner(&transaction, identity, generation)?;
    let current = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    if now_ms < current.updated_at_ms {
        return Err(CatalogError::InvalidInput("stale timestamp"));
    }
    if expected_revision != current.revision {
        return Err(CatalogError::StalePresentation);
    }
    if !matches!(
        current.state,
        TerminalState::Creating | TerminalState::Running
    ) {
        return Err(CatalogError::InvalidTransition);
    }
    let changed = transaction
        .execute(
            "UPDATE terminal_records
             SET placement = ?2, workspace_target = ?3, presentation = ?4,
                 surface_hidden = 0, revision = revision + 1, updated_at_ms = ?5
             WHERE handle = ?1 AND revision = ?6 AND state IN ('creating', 'running')",
            params![
                handle,
                placement_to_str(&placement),
                workspace_target,
                presentation_to_str(&presentation),
                now_ms,
                expected_revision,
            ],
        )
        .map_err(|_| CatalogError::Database)?
        == 1;
    if !changed {
        // The actor serializes commands, so a failed compare-and-set means the
        // persisted state stopped being eligible while this transaction ran.
        return Err(CatalogError::StalePresentation);
    }
    let record = query_record(&transaction, handle)?.ok_or(CatalogError::TerminalNotFound)?;
    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(TransitionResult { changed, record })
}

fn gc_tombstones(
    connection: &mut Connection,
    older_than_ms: i64,
    limit: u32,
    identity: &RuntimeIdentity,
    generation: u64,
) -> Result<usize, CatalogError> {
    if older_than_ms < 0 || limit == 0 || limit > 1_000 {
        return Err(CatalogError::InvalidInput(
            "invalid garbage collection limit",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    assert_runtime_owner(&transaction, identity, generation)?;
    let deleted = transaction
        .execute(
            "DELETE FROM terminal_records WHERE handle IN (
                SELECT handle FROM terminal_records
                WHERE state IN ('exited', 'closed', 'lost')
                  AND tombstoned_at_ms IS NOT NULL AND tombstoned_at_ms < ?1
                ORDER BY tombstoned_at_ms, handle LIMIT ?2
             )",
            params![older_than_ms, limit],
        )
        .map_err(|_| CatalogError::Database)?;
    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(deleted)
}

fn validate_handle(handle: &str) -> Result<(), CatalogError> {
    if handle.trim().is_empty() || handle.len() > 128 {
        return Err(CatalogError::InvalidInput("invalid handle"));
    }
    Ok(())
}

fn assert_runtime_owner(
    transaction: &rusqlite::Transaction<'_>,
    identity: &RuntimeIdentity,
    generation: u64,
) -> Result<(), CatalogError> {
    let persisted: (String, String, i64) = transaction
        .query_row(
            "SELECT runtime_id, launch_nonce, generation
             FROM runtime_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| CatalogError::Corrupt("runtime metadata is missing"))?;
    let persisted_generation = u64::try_from(persisted.2)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(CatalogError::Corrupt("invalid runtime generation"))?;
    if persisted.0 != identity.runtime_id
        || persisted.1 != identity.launch_nonce
        || persisted_generation != generation
    {
        return Err(CatalogError::StaleRuntime);
    }
    Ok(())
}

const RECORD_COLUMNS: &str = "handle, runtime_id, launch_nonce, generation, stream_id, \
    state, revision, title, placement, presentation, exit_behavior, workspace_target, \
    surface_hidden, created_at_ms, updated_at_ms, exited_at_ms, tombstoned_at_ms, exit_code";

fn query_claim_by_request(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<DurableClaim>, CatalogError> {
    connection
        .query_row(
            "SELECT request_id, request_digest, handle, created_at_ms
             FROM idempotency_claims WHERE request_id = ?1",
            [request_id],
            read_claim,
        )
        .optional()
        .map_err(|_| CatalogError::Database)
}

fn query_claim_by_handle(
    connection: &Connection,
    handle: &str,
) -> Result<Option<DurableClaim>, CatalogError> {
    connection
        .query_row(
            "SELECT request_id, request_digest, handle, created_at_ms
             FROM idempotency_claims WHERE handle = ?1",
            [handle],
            read_claim,
        )
        .optional()
        .map_err(|_| CatalogError::Database)
}

fn read_claim(row: &Row<'_>) -> rusqlite::Result<DurableClaim> {
    let digest: Vec<u8> = row.get(1)?;
    let digest: [u8; 32] = digest.try_into().map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Blob,
            "persisted request digest has invalid length".into(),
        )
    })?;
    let claim = DurableClaim {
        request_id: row.get(0)?,
        digest: RequestDigest::new(digest),
        handle: row.get(2)?,
        created_at_ms: row.get(3)?,
    };
    if !is_valid_request_id(&claim.request_id) {
        return Err(conversion_error(
            0,
            CatalogError::Corrupt("invalid persisted request id"),
        ));
    }
    validate_handle(&claim.handle).map_err(|_| {
        conversion_error(
            2,
            CatalogError::Corrupt("invalid persisted terminal handle"),
        )
    })?;
    if claim.created_at_ms < 0 {
        return Err(conversion_error(
            3,
            CatalogError::Corrupt("negative persisted claim timestamp"),
        ));
    }
    Ok(claim)
}

fn query_record(
    connection: &Connection,
    handle: &str,
) -> Result<Option<TerminalRecord>, CatalogError> {
    connection
        .query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM terminal_records WHERE handle = ?1"),
            [handle],
            read_record,
        )
        .optional()
        .map_err(|_| CatalogError::Database)
}

fn read_record(row: &Row<'_>) -> rusqlite::Result<TerminalRecord> {
    let generation: i64 = row.get(3)?;
    let revision: i64 = row.get(6)?;
    let state: String = row.get(5)?;
    let placement: String = row.get(8)?;
    let presentation: String = row.get(9)?;
    let exit_behavior: String = row.get(10)?;
    let surface_hidden: i64 = row.get(12)?;
    let record = TerminalRecord {
        handle: row.get(0)?,
        runtime_id: row.get(1)?,
        launch_nonce: row.get(2)?,
        generation: positive_u64(generation, 3)?,
        stream_id: row.get(4)?,
        state: TerminalState::parse(&state).map_err(|error| conversion_error(5, error))?,
        revision: positive_u64(revision, 6)?,
        title: row.get(7)?,
        placement: parse_placement(&placement).ok_or_else(|| {
            conversion_error(8, CatalogError::Corrupt("invalid persisted placement"))
        })?,
        presentation: parse_presentation(&presentation).ok_or_else(|| {
            conversion_error(9, CatalogError::Corrupt("invalid persisted presentation"))
        })?,
        exit_behavior: parse_exit_behavior(&exit_behavior).ok_or_else(|| {
            conversion_error(10, CatalogError::Corrupt("invalid persisted exit behavior"))
        })?,
        workspace_target: row.get(11)?,
        surface_hidden: match surface_hidden {
            0 => false,
            1 => true,
            _ => {
                return Err(conversion_error(
                    12,
                    CatalogError::Corrupt("invalid persisted surface visibility"),
                ))
            }
        },
        created_at_ms: row.get(13)?,
        updated_at_ms: row.get(14)?,
        exited_at_ms: row.get(15)?,
        tombstoned_at_ms: row.get(16)?,
        exit_code: row.get(17)?,
    };
    validate_persisted_record(&record).map_err(|error| conversion_error(0, error))?;
    Ok(record)
}

fn validate_persisted_record(record: &TerminalRecord) -> Result<(), CatalogError> {
    validate_handle(&record.handle)
        .map_err(|_| CatalogError::Corrupt("invalid persisted terminal handle"))?;
    validate_persisted_identifier(&record.runtime_id, "runtime id")?;
    validate_persisted_identifier(&record.launch_nonce, "launch nonce")?;
    if record.stream_id.trim().is_empty() || record.stream_id.len() > 256 {
        return Err(CatalogError::Corrupt("invalid persisted stream id"));
    }
    if record
        .title
        .as_ref()
        .is_some_and(|title| title.trim().is_empty() || title.len() > 4_096)
    {
        return Err(CatalogError::Corrupt("invalid persisted title"));
    }
    match (&record.placement, &record.workspace_target) {
        (Placement::Workspace, Some(target))
            if !target.trim().is_empty() && target.len() <= 32_768 => {}
        (Placement::Window, None) => {}
        _ => return Err(CatalogError::Corrupt("invalid persisted workspace target")),
    }
    if record.created_at_ms < 0
        || record.updated_at_ms < record.created_at_ms
        || record
            .exited_at_ms
            .is_some_and(|value| value < record.created_at_ms || value > record.updated_at_ms)
        || record
            .tombstoned_at_ms
            .is_some_and(|value| value < record.created_at_ms || value > record.updated_at_ms)
    {
        return Err(CatalogError::Corrupt("invalid persisted timestamps"));
    }
    match record.state {
        TerminalState::Creating | TerminalState::Running | TerminalState::Closing
            if record.exited_at_ms.is_none()
                && record.tombstoned_at_ms.is_none()
                && record.exit_code.is_none() => {}
        TerminalState::Exited
            if record.exited_at_ms.is_some()
                && record.tombstoned_at_ms.is_some()
                && record.exit_code.is_some() => {}
        TerminalState::Closed
            if record.tombstoned_at_ms.is_some()
                && (record.exited_at_ms.is_some() == record.exit_code.is_some()) => {}
        TerminalState::Lost
            if record.tombstoned_at_ms.is_some()
                && record.exited_at_ms.is_none()
                && record.exit_code.is_none() => {}
        _ => {
            return Err(CatalogError::Corrupt(
                "invalid persisted terminal lifecycle",
            ))
        }
    }
    Ok(())
}

fn validate_persisted_identifier(value: &str, name: &'static str) -> Result<(), CatalogError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(CatalogError::Corrupt(match name {
            "runtime id" => "invalid persisted runtime id",
            "launch nonce" => "invalid persisted launch nonce",
            _ => "invalid persisted identifier",
        }));
    }
    Ok(())
}

fn positive_u64(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            conversion_error(
                column,
                CatalogError::Corrupt("invalid persisted positive integer"),
            )
        })
}

fn conversion_error(column: usize, error: CatalogError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn placement_to_str(value: &Placement) -> &'static str {
    match value {
        Placement::Workspace => "workspace",
        Placement::Window => "window",
    }
}

fn parse_placement(value: &str) -> Option<Placement> {
    match value {
        "workspace" => Some(Placement::Workspace),
        "window" => Some(Placement::Window),
        _ => None,
    }
}

fn presentation_to_str(value: &Presentation) -> &'static str {
    match value {
        Presentation::Background => "background",
        Presentation::Focused => "focused",
    }
}

fn parse_presentation(value: &str) -> Option<Presentation> {
    match value {
        "background" => Some(Presentation::Background),
        "focused" => Some(Presentation::Focused),
        _ => None,
    }
}

fn exit_behavior_to_str(value: &ExitBehavior) -> &'static str {
    match value {
        ExitBehavior::Keep => "keep",
        ExitBehavior::CloseOnSuccess => "close-on-success",
        ExitBehavior::CloseOnExit => "close-on-exit",
    }
}

fn parse_exit_behavior(value: &str) -> Option<ExitBehavior> {
    match value {
        "keep" => Some(ExitBehavior::Keep),
        "close-on-success" => Some(ExitBehavior::CloseOnSuccess),
        "close-on-exit" => Some(ExitBehavior::CloseOnExit),
        _ => None,
    }
}
