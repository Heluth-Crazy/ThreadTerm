use std::{
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use super::{CatalogError, RuntimeIdentity, RuntimeReconciliation};

pub const APPLICATION_ID: u32 = 0x5454_4843; // "TTHC"
pub const SCHEMA_VERSION: u32 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);
const INITIALIZATION_PENDING: u8 = 0;
const INITIALIZATION_COMMITTING: u8 = 2;

const MIGRATION_V1: &str = r#"
CREATE TABLE runtime_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    runtime_id TEXT NOT NULL,
    launch_nonce TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    initialized_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE idempotency_claims (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    handle TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE terminal_records (
    handle TEXT PRIMARY KEY NOT NULL
        REFERENCES idempotency_claims(handle) ON DELETE RESTRICT,
    runtime_id TEXT NOT NULL,
    launch_nonce TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    stream_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('creating', 'running', 'exited', 'closing', 'closed', 'lost')
    ),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    title TEXT,
    placement TEXT NOT NULL CHECK (placement IN ('workspace', 'window')),
    presentation TEXT NOT NULL CHECK (presentation IN ('background', 'focused')),
    exit_behavior TEXT NOT NULL CHECK (
        exit_behavior IN ('keep', 'close-on-success', 'close-on-exit')
    ),
    workspace_target TEXT,
    surface_hidden INTEGER NOT NULL CHECK (surface_hidden IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    exited_at_ms INTEGER,
    tombstoned_at_ms INTEGER,
    exit_code INTEGER,
    CHECK (
        (placement = 'workspace' AND workspace_target IS NOT NULL
            AND length(workspace_target) > 0)
        OR (placement = 'window' AND workspace_target IS NULL)
    )
);

CREATE INDEX terminal_records_state_updated_idx
    ON terminal_records(state, updated_at_ms);
CREATE INDEX terminal_records_tombstone_idx
    ON terminal_records(tombstoned_at_ms)
    WHERE tombstoned_at_ms IS NOT NULL;
"#;

pub(crate) fn open_and_initialize(
    path: &Path,
    identity: &RuntimeIdentity,
    now_ms: i64,
    initialization: &Arc<AtomicU8>,
) -> Result<(Connection, RuntimeReconciliation), CatalogError> {
    validate_identity(identity)?;
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| CatalogError::Database)?;

    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|_| CatalogError::Database)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| CatalogError::Database)?;
    connection
        .pragma_update(None, "trusted_schema", "OFF")
        .map_err(|_| CatalogError::Database)?;
    verify_integrity(&connection)?;
    migrate(&mut connection)?;

    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|_| CatalogError::Database)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(CatalogError::Database);
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| CatalogError::Database)?;
    verify_integrity(&connection)?;

    let reconciliation = reconcile_runtime(&mut connection, identity, now_ms, initialization)?;
    Ok((connection, reconciliation))
}

fn validate_identity(identity: &RuntimeIdentity) -> Result<(), CatalogError> {
    if identity.runtime_id.trim().is_empty()
        || identity.launch_nonce.trim().is_empty()
        || identity.runtime_id.len() > 256
        || identity.launch_nonce.len() > 256
    {
        return Err(CatalogError::InvalidInput("invalid runtime identity"));
    }
    Ok(())
}

fn verify_integrity(connection: &Connection) -> Result<(), CatalogError> {
    let result: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| CatalogError::Corrupt("integrity check failed"))?;
    if result != "ok" {
        return Err(CatalogError::Corrupt("integrity check failed"));
    }
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), CatalogError> {
    let application_id: i64 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| CatalogError::Corrupt("application id is unreadable"))?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| CatalogError::Corrupt("schema version is unreadable"))?;

    if application_id != 0 && application_id != i64::from(APPLICATION_ID) {
        return Err(CatalogError::WrongApplicationId);
    }
    if user_version < 0 {
        return Err(CatalogError::Corrupt("negative schema version"));
    }
    let user_version =
        u32::try_from(user_version).map_err(|_| CatalogError::Corrupt("invalid schema version"))?;
    if user_version > SCHEMA_VERSION {
        return Err(CatalogError::SchemaTooNew {
            found: user_version,
            supported: SCHEMA_VERSION,
        });
    }

    if application_id == 0 {
        let has_user_schema: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM sqlite_master \
                 WHERE type IN ('table', 'index', 'view', 'trigger') \
                   AND name NOT LIKE 'sqlite_%' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| CatalogError::Corrupt("schema catalog is unreadable"))?;
        if has_user_schema.is_some() {
            return Err(CatalogError::WrongApplicationId);
        }
    }

    if user_version == SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Migration)?;
    if user_version == 0 {
        transaction
            .execute_batch(MIGRATION_V1)
            .map_err(|_| CatalogError::Migration)?;
    }
    transaction
        .pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(|_| CatalogError::Migration)?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|_| CatalogError::Migration)?;
    transaction.commit().map_err(|_| CatalogError::Migration)
}

fn reconcile_runtime(
    connection: &mut Connection,
    identity: &RuntimeIdentity,
    now_ms: i64,
    initialization: &Arc<AtomicU8>,
) -> Result<RuntimeReconciliation, CatalogError> {
    if now_ms < 0 {
        return Err(CatalogError::InvalidInput("negative timestamp"));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CatalogError::Database)?;
    initialization
        .compare_exchange(
            INITIALIZATION_PENDING,
            INITIALIZATION_COMMITTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| CatalogError::ActorStopped)?;
    let prior: Option<(String, String, i64)> = transaction
        .query_row(
            "SELECT runtime_id, launch_nonce, generation FROM runtime_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| CatalogError::Database)?;

    let (generation, lost_handles) = match prior {
        None => {
            transaction
                .execute(
                    "INSERT INTO runtime_meta (
                        singleton, runtime_id, launch_nonce, generation,
                        initialized_at_ms, updated_at_ms
                     ) VALUES (1, ?1, ?2, 1, ?3, ?3)",
                    (&identity.runtime_id, &identity.launch_nonce, now_ms),
                )
                .map_err(|_| CatalogError::Database)?;
            (1_u64, Vec::new())
        }
        Some((runtime_id, launch_nonce, prior_generation))
            if runtime_id == identity.runtime_id && launch_nonce == identity.launch_nonce =>
        {
            let generation = u64::try_from(prior_generation)
                .map_err(|_| CatalogError::Corrupt("invalid runtime generation"))?;
            (generation, Vec::new())
        }
        Some((_, _, prior_generation)) => {
            let generation = prior_generation
                .checked_add(1)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or(CatalogError::Corrupt("runtime generation overflow"))?;
            let mut statement = transaction
                .prepare(
                    "SELECT handle FROM terminal_records
                     WHERE state IN ('creating', 'running', 'closing')
                     ORDER BY handle",
                )
                .map_err(|_| CatalogError::Database)?;
            let lost_handles = statement
                .query_map([], |row| row.get(0))
                .map_err(|_| CatalogError::Database)?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|_| CatalogError::Database)?;
            drop(statement);
            transaction
                .execute(
                    "UPDATE terminal_records
                     SET state = 'lost', revision = revision + 1,
                         updated_at_ms = MAX(updated_at_ms, ?1),
                         tombstoned_at_ms = COALESCE(
                             tombstoned_at_ms, MAX(updated_at_ms, ?1)
                         )
                     WHERE state IN ('creating', 'running', 'closing')",
                    [now_ms],
                )
                .map_err(|_| CatalogError::Database)?;
            transaction
                .execute(
                    "UPDATE runtime_meta
                     SET runtime_id = ?1, launch_nonce = ?2, generation = ?3,
                         initialized_at_ms = ?4, updated_at_ms = MAX(updated_at_ms, ?4)
                     WHERE singleton = 1",
                    rusqlite::params![
                        identity.runtime_id,
                        identity.launch_nonce,
                        generation,
                        now_ms
                    ],
                )
                .map_err(|_| CatalogError::Database)?;
            (generation, lost_handles)
        }
    };

    transaction.commit().map_err(|_| CatalogError::Database)?;
    Ok(RuntimeReconciliation {
        generation,
        lost_handles,
    })
}
