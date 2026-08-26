use std::fmt;

use terminal_host_protocol::{ExitBehavior, Placement, Presentation};
use thiserror::Error;

pub const DIGEST_BYTES: usize = 32;
pub const MAX_LIST_PAGE_SIZE: u32 = 4_096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeIdentity {
    pub runtime_id: String,
    pub launch_nonce: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeReconciliation {
    pub generation: u64,
    pub lost_handles: Vec<String>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RequestDigest([u8; DIGEST_BYTES]);

impl RequestDigest {
    pub fn new(keyed_normalized_digest: [u8; DIGEST_BYTES]) -> Self {
        Self(keyed_normalized_digest)
    }

    pub fn as_bytes(&self) -> &[u8; DIGEST_BYTES] {
        &self.0
    }
}

impl fmt::Debug for RequestDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestDigest")
            .field("bytes", &DIGEST_BYTES)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum PresentationTarget {
    Workspace { normalized_path: String },
    Window,
}

impl PresentationTarget {
    pub(crate) fn placement(&self) -> Placement {
        match self {
            Self::Workspace { .. } => Placement::Workspace,
            Self::Window => Placement::Window,
        }
    }

    pub(crate) fn workspace_target(&self) -> Option<&str> {
        match self {
            Self::Workspace { normalized_path } => Some(normalized_path),
            Self::Window => None,
        }
    }
}

impl fmt::Debug for PresentationTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workspace { .. } => formatter
                .debug_struct("Workspace")
                .field("normalized_path_present", &true)
                .finish(),
            Self::Window => formatter.write_str("Window"),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CreateClaim {
    pub request_id: String,
    pub digest: RequestDigest,
    pub stream_id: String,
    pub title: Option<String>,
    pub target: PresentationTarget,
    pub presentation: Presentation,
    pub exit_behavior: ExitBehavior,
    pub now_ms: i64,
}

impl fmt::Debug for CreateClaim {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CreateClaim")
            .field("request_id", &self.request_id)
            .field("digest", &self.digest)
            .field("stream_id", &self.stream_id)
            .field("title_present", &self.title.is_some())
            .field("target", &self.target)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .field("now_ms", &self.now_ms)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalState {
    Creating,
    Running,
    Exited,
    Closing,
    Closed,
    Lost,
}

impl TerminalState {
    pub(crate) fn parse(value: &str) -> Result<Self, CatalogError> {
        match value {
            "creating" => Ok(Self::Creating),
            "running" => Ok(Self::Running),
            "exited" => Ok(Self::Exited),
            "closing" => Ok(Self::Closing),
            "closed" => Ok(Self::Closed),
            "lost" => Ok(Self::Lost),
            _ => Err(CatalogError::Corrupt("invalid persisted terminal state")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableClaim {
    pub request_id: String,
    pub digest: RequestDigest,
    pub handle: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TerminalRecord {
    pub handle: String,
    pub runtime_id: String,
    pub launch_nonce: String,
    pub generation: u64,
    pub stream_id: String,
    pub state: TerminalState,
    pub revision: u64,
    pub title: Option<String>,
    pub placement: Placement,
    pub presentation: Presentation,
    pub exit_behavior: ExitBehavior,
    pub workspace_target: Option<String>,
    pub surface_hidden: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub exited_at_ms: Option<i64>,
    pub tombstoned_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
}

impl fmt::Debug for TerminalRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalRecord")
            .field("handle", &self.handle)
            .field("runtime_id", &self.runtime_id)
            .field("launch_nonce", &self.launch_nonce)
            .field("generation", &self.generation)
            .field("stream_id", &self.stream_id)
            .field("state", &self.state)
            .field("revision", &self.revision)
            .field("title_present", &self.title.is_some())
            .field("placement", &self.placement)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .field("workspace_target_present", &self.workspace_target.is_some())
            .field("surface_hidden", &self.surface_hidden)
            .field("created_at_ms", &self.created_at_ms)
            .field("updated_at_ms", &self.updated_at_ms)
            .field("exited_at_ms", &self.exited_at_ms)
            .field("tombstoned_at_ms", &self.tombstoned_at_ms)
            .field("exit_code", &self.exit_code)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaimDisposition {
    Created,
    Reused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimResult {
    pub disposition: ClaimDisposition,
    pub claim: DurableClaim,
    pub terminal: Option<TerminalRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogLookup {
    ActiveOrTombstone {
        claim: DurableClaim,
        terminal: Box<TerminalRecord>,
    },
    Collected(DurableClaim),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogSelector {
    Handle(String),
    RequestId(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransitionResult {
    pub changed: bool,
    pub record: TerminalRecord,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogListPage {
    pub records: Vec<TerminalRecord>,
    pub has_more: bool,
}

#[derive(Clone, Eq, PartialEq)]
pub enum CatalogCommand {
    Claim(CreateClaim),
    Lookup(CatalogSelector),
    ListPage {
        limit: u32,
    },
    MarkRunning {
        handle: String,
        now_ms: i64,
    },
    MarkExited {
        handle: String,
        exit_code: i32,
        now_ms: i64,
    },
    RequestClose {
        handle: String,
        now_ms: i64,
    },
    ReconcileClosed {
        handle: String,
        now_ms: i64,
    },
    SetDesiredPresentation {
        handle: String,
        placement: Placement,
        workspace_target: Option<String>,
        presentation: Presentation,
        expected_revision: u64,
        now_ms: i64,
    },
    SetSurfaceHidden {
        handle: String,
        hidden: bool,
        expected_revision: u64,
        now_ms: i64,
    },
    GcTombstones {
        older_than_ms: i64,
        limit: u32,
    },
}

impl fmt::Debug for CatalogCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Claim(claim) => formatter.debug_tuple("Claim").field(claim).finish(),
            Self::Lookup(selector) => formatter.debug_tuple("Lookup").field(selector).finish(),
            Self::ListPage { limit } => formatter
                .debug_struct("ListPage")
                .field("limit", limit)
                .finish(),
            Self::MarkRunning { handle, now_ms } => formatter
                .debug_struct("MarkRunning")
                .field("handle", handle)
                .field("now_ms", now_ms)
                .finish(),
            Self::MarkExited {
                handle,
                exit_code,
                now_ms,
            } => formatter
                .debug_struct("MarkExited")
                .field("handle", handle)
                .field("exit_code", exit_code)
                .field("now_ms", now_ms)
                .finish(),
            Self::RequestClose { handle, now_ms } => formatter
                .debug_struct("RequestClose")
                .field("handle", handle)
                .field("now_ms", now_ms)
                .finish(),
            Self::ReconcileClosed { handle, now_ms } => formatter
                .debug_struct("ReconcileClosed")
                .field("handle", handle)
                .field("now_ms", now_ms)
                .finish(),
            Self::SetDesiredPresentation {
                handle,
                placement,
                workspace_target,
                presentation,
                expected_revision,
                now_ms,
            } => formatter
                .debug_struct("SetDesiredPresentation")
                .field("handle", handle)
                .field("placement", placement)
                .field("workspace_target_present", &workspace_target.is_some())
                .field("presentation", presentation)
                .field("expected_revision", expected_revision)
                .field("now_ms", now_ms)
                .finish(),
            Self::SetSurfaceHidden {
                handle,
                hidden,
                expected_revision,
                now_ms,
            } => formatter
                .debug_struct("SetSurfaceHidden")
                .field("handle", handle)
                .field("hidden", hidden)
                .field("expected_revision", expected_revision)
                .field("now_ms", now_ms)
                .finish(),
            Self::GcTombstones {
                older_than_ms,
                limit,
            } => formatter
                .debug_struct("GcTombstones")
                .field("older_than_ms", older_than_ms)
                .field("limit", limit)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogResult {
    Claim(ClaimResult),
    Lookup(CatalogLookup),
    ListPage(CatalogListPage),
    Transition(TransitionResult),
    GarbageCollected(usize),
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum CatalogError {
    #[error("catalog database is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("catalog application id is invalid")]
    WrongApplicationId,
    #[error("catalog schema {found} is newer than supported schema {supported}")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("catalog migration failed")]
    Migration,
    #[error("catalog operation failed")]
    Database,
    #[error("catalog input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("request id conflicts with an existing claim")]
    RequestConflict,
    #[error("terminal was not found")]
    TerminalNotFound,
    #[error("terminal state transition is invalid")]
    InvalidTransition,
    #[error("terminal presentation revision is stale")]
    StalePresentation,
    #[error("catalog actor no longer owns the active runtime identity")]
    StaleRuntime,
    #[error("catalog request queue is full")]
    QueueFull,
    #[error("catalog actor stopped")]
    ActorStopped,
    #[error("catalog operation timed out")]
    Timeout,
    #[error("catalog actor returned an unexpected result")]
    UnexpectedResult,
}
