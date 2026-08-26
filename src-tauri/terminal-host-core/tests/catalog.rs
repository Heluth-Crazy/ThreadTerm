use std::{
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

use rusqlite::Connection;
use tempfile::TempDir;
use terminal_host_core::{
    Catalog, CatalogCommand, CatalogError, CatalogLookup, CatalogOptions, CatalogResult,
    CatalogSelector, ClaimDisposition, CreateClaim, PresentationTarget, RequestDigest,
    RuntimeIdentity, TerminalState, APPLICATION_ID, MAX_LIST_PAGE_SIZE, SCHEMA_VERSION,
};
use terminal_host_protocol::{ExitBehavior, Placement, Presentation};

fn identity(runtime: &str, nonce: &str) -> RuntimeIdentity {
    RuntimeIdentity {
        runtime_id: runtime.to_owned(),
        launch_nonce: nonce.to_owned(),
    }
}

fn create(request_id: &str, digest_byte: u8, now_ms: i64) -> CreateClaim {
    CreateClaim {
        request_id: request_id.to_owned(),
        digest: RequestDigest::new([digest_byte; 32]),
        stream_id: "stream-1".to_owned(),
        title: Some("safe title".to_owned()),
        target: PresentationTarget::Workspace {
            normalized_path: "C:\\permitted-workspace".to_owned(),
        },
        presentation: Presentation::Background,
        exit_behavior: ExitBehavior::Keep,
        now_ms,
    }
}

fn claim(catalog: &Catalog, request: CreateClaim) -> terminal_host_core::ClaimResult {
    match catalog.execute(CatalogCommand::Claim(request)).unwrap() {
        CatalogResult::Claim(result) => result,
        result => panic!("unexpected result: {result:?}"),
    }
}

fn transition(catalog: &Catalog, command: CatalogCommand) -> terminal_host_core::TransitionResult {
    match catalog.execute(command).unwrap() {
        CatalogResult::Transition(result) => result,
        result => panic!("unexpected result: {result:?}"),
    }
}

fn list_page(catalog: &Catalog, limit: u32) -> terminal_host_core::CatalogListPage {
    match catalog.execute(CatalogCommand::ListPage { limit }).unwrap() {
        CatalogResult::ListPage(page) => page,
        result => panic!("unexpected result: {result:?}"),
    }
}

#[test]
fn initializes_schema_and_durability_pragmas() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, reconciliation) = Catalog::open(&path, identity("runtime-a", "nonce-a")).unwrap();
    assert_eq!(reconciliation.generation, 1);
    assert!(reconciliation.lost_handles.is_empty());
    catalog.shutdown().unwrap();

    let connection = Connection::open(path).unwrap();
    let application_id: u32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .unwrap();
    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let synchronous: u32 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    assert_eq!(application_id, APPLICATION_ID);
    assert_eq!(user_version, SCHEMA_VERSION);
    assert_eq!(journal_mode, "wal");
    assert_eq!(synchronous, 2, "SQLite FULL synchronous mode");
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info('terminal_records')")
        .unwrap();
    let columns = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for forbidden in ["executable", "args", "cwd", "secret", "terminal_body"] {
        assert!(!columns.iter().any(|column| column == forbidden));
    }
}

#[test]
fn refuses_wrong_application_id_and_newer_schema() {
    for (application_id, user_version, expected) in [
        (123_u32, 0_u32, CatalogError::WrongApplicationId),
        (
            APPLICATION_ID,
            SCHEMA_VERSION + 1,
            CatalogError::SchemaTooNew {
                found: SCHEMA_VERSION + 1,
                supported: SCHEMA_VERSION,
            },
        ),
    ] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("runtime.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "application_id", application_id)
            .unwrap();
        connection
            .pragma_update(None, "user_version", user_version)
            .unwrap();
        drop(connection);
        assert_eq!(
            Catalog::open(&path, identity("runtime", "nonce"))
                .err()
                .unwrap(),
            expected
        );
    }
}

#[test]
fn migration_failure_rolls_back_every_schema_change() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    connection
        .execute_batch("CREATE TABLE terminal_records (handle TEXT PRIMARY KEY);")
        .unwrap();
    drop(connection);

    assert_eq!(
        Catalog::open(&path, identity("runtime", "nonce"))
            .err()
            .unwrap(),
        CatalogError::Migration
    );
    let connection = Connection::open(path).unwrap();
    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let created_tables: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE type = 'table' AND name IN ('runtime_meta', 'idempotency_claims')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(user_version, 0);
    assert_eq!(created_tables, 0);
}

#[test]
fn corrupt_database_fails_closed() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    std::fs::write(&path, b"not a sqlite database").unwrap();
    assert!(Catalog::open(path, identity("runtime", "nonce")).is_err());
}

#[test]
fn semantically_corrupt_persisted_rows_fail_closed() {
    for (column, value) in [
        ("stream_id", "''"),
        ("runtime_id", "''"),
        ("launch_nonce", "''"),
        ("title", "'   '"),
        ("created_at_ms", "-1"),
    ] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("runtime.sqlite");
        let (catalog, _) = Catalog::open(&path, identity("runtime", "nonce")).unwrap();
        let handle = claim(&catalog, create("corrupt/request", 9, 10))
            .claim
            .handle;
        catalog.shutdown().unwrap();

        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        connection
            .execute(
                &format!("UPDATE terminal_records SET {column} = {value} WHERE handle = ?1"),
                [&handle],
            )
            .unwrap();
        drop(connection);

        let (catalog, _) = Catalog::open(&path, identity("runtime", "nonce")).unwrap();
        assert_eq!(
            catalog.execute(CatalogCommand::Lookup(CatalogSelector::Handle(handle))),
            Err(CatalogError::Database),
            "corrupt {column} must not materialize as a terminal record"
        );
        catalog.shutdown().unwrap();
    }
}

#[test]
fn concurrent_identical_claims_create_once_and_conflicts_are_rejected() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(path, identity("runtime", "nonce")).unwrap();
    let catalog = Arc::new(catalog);
    let barrier = Arc::new(Barrier::new(16));
    let workers = (0..16)
        .map(|_| {
            let catalog = Arc::clone(&catalog);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                claim(&catalog, create("consumer/workspace/request-1", 7, 100))
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| result.disposition == ClaimDisposition::Created)
            .count(),
        1
    );
    assert!(results
        .iter()
        .all(|result| result.claim.handle == results[0].claim.handle));
    assert_eq!(
        catalog
            .execute(CatalogCommand::Claim(create(
                "consumer/workspace/request-1",
                8,
                101
            )))
            .unwrap_err(),
        CatalogError::RequestConflict
    );
    Arc::try_unwrap(catalog).ok().unwrap().shutdown().unwrap();
}

#[test]
fn list_page_is_strictly_bounded_and_reports_more_records() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(&path, identity("runtime", "nonce")).unwrap();
    let handles = (0..5)
        .map(|index| {
            claim(
                &catalog,
                create(&format!("list/request-{index}"), index as u8, 10 + index),
            )
            .claim
            .handle
        })
        .collect::<Vec<_>>();

    let page = list_page(&catalog, 2);
    assert_eq!(page.records.len(), 2);
    assert!(page.has_more);
    assert_eq!(page.records[0].handle, handles[0]);
    assert_eq!(page.records[1].handle, handles[1]);

    let page = list_page(&catalog, 5);
    assert_eq!(page.records.len(), 5);
    assert!(!page.has_more);
    catalog.shutdown().unwrap();
}

#[test]
fn list_page_validates_limits_and_does_not_deserialize_beyond_limit_plus_one() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(&path, identity("runtime", "nonce")).unwrap();
    let handles = (0..4)
        .map(|index| {
            claim(
                &catalog,
                create(&format!("bounded/request-{index}"), index as u8, 10 + index),
            )
            .claim
            .handle
        })
        .collect::<Vec<_>>();

    for limit in [0, MAX_LIST_PAGE_SIZE + 1] {
        assert_eq!(
            catalog
                .execute(CatalogCommand::ListPage { limit })
                .unwrap_err(),
            CatalogError::InvalidInput("invalid list page limit")
        );
    }

    let external = Connection::open(&path).unwrap();
    external
        .pragma_update(None, "ignore_check_constraints", "ON")
        .unwrap();
    external
        .execute(
            "UPDATE terminal_records SET state = 'invalid-test-state' WHERE handle = ?1",
            [&handles[3]],
        )
        .unwrap();
    drop(external);

    let page = list_page(&catalog, 2);
    assert_eq!(page.records.len(), 2);
    assert!(page.has_more);
    assert_eq!(
        catalog
            .execute(CatalogCommand::ListPage { limit: 4 })
            .unwrap_err(),
        CatalogError::Database,
        "the sentinel row is observed only when it enters LIMIT + 1"
    );
    catalog.shutdown().unwrap();
}

#[test]
fn superseded_actor_cannot_mutate_new_runtime_generation() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (old_actor, first) = Catalog::open(&path, identity("runtime-a", "nonce-a")).unwrap();
    assert_eq!(first.generation, 1);
    let (new_actor, second) = Catalog::open(&path, identity("runtime-b", "nonce-b")).unwrap();
    assert_eq!(second.generation, 2);

    assert_eq!(
        old_actor
            .execute(CatalogCommand::Claim(create("stale/request", 1, 10)))
            .unwrap_err(),
        CatalogError::StaleRuntime
    );
    assert_eq!(
        claim(&new_actor, create("new/request", 2, 11)).disposition,
        ClaimDisposition::Created
    );
    old_actor.shutdown().unwrap();
    new_actor.shutdown().unwrap();
}

#[test]
fn runtime_change_marks_live_records_lost_exactly_once() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (first, _) = Catalog::open(&path, identity("runtime-a", "nonce-a")).unwrap();
    let handle = claim(&first, create("loss/request", 3, 10)).claim.handle;
    let running = transition(
        &first,
        CatalogCommand::MarkRunning {
            handle: handle.clone(),
            now_ms: 11,
        },
    );
    assert_eq!(running.record.revision, 2);
    first.shutdown().unwrap();

    let (second, reconciliation) = Catalog::open(&path, identity("runtime-b", "nonce-b")).unwrap();
    assert_eq!(reconciliation.lost_handles, vec![handle.clone()]);
    let lost = match second
        .execute(CatalogCommand::Lookup(CatalogSelector::Handle(
            handle.clone(),
        )))
        .unwrap()
    {
        CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => terminal,
        result => panic!("unexpected result: {result:?}"),
    };
    assert_eq!(lost.state, TerminalState::Lost);
    assert_eq!(lost.revision, 3);
    second.shutdown().unwrap();

    let (third, reconciliation) = Catalog::open(&path, identity("runtime-c", "nonce-c")).unwrap();
    assert!(reconciliation.lost_handles.is_empty());
    let still_lost = match third
        .execute(CatalogCommand::Lookup(CatalogSelector::Handle(handle)))
        .unwrap()
    {
        CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => terminal,
        result => panic!("unexpected result: {result:?}"),
    };
    assert_eq!(still_lost.state, TerminalState::Lost);
    assert_eq!(still_lost.revision, 3);
    third.shutdown().unwrap();
}

#[test]
fn close_reconciliation_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let handle = claim(&catalog, create("close/request", 4, 10)).claim.handle;
    let close = transition(
        &catalog,
        CatalogCommand::RequestClose {
            handle: handle.clone(),
            now_ms: 11,
        },
    );
    assert!(close.changed);
    assert_eq!(close.record.state, TerminalState::Closing);
    let duplicate = transition(
        &catalog,
        CatalogCommand::RequestClose {
            handle: handle.clone(),
            now_ms: 12,
        },
    );
    assert!(!duplicate.changed);
    assert_eq!(duplicate.record.revision, close.record.revision);

    let closed = transition(
        &catalog,
        CatalogCommand::ReconcileClosed {
            handle: handle.clone(),
            now_ms: 13,
        },
    );
    assert!(closed.changed);
    assert_eq!(closed.record.state, TerminalState::Closed);
    let duplicate = transition(
        &catalog,
        CatalogCommand::ReconcileClosed { handle, now_ms: 14 },
    );
    assert!(!duplicate.changed);
    assert_eq!(duplicate.record.revision, closed.record.revision);
    catalog.shutdown().unwrap();
}

#[test]
fn tombstone_gc_retains_claim_and_prevents_request_id_aba() {
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let request = create("durable/request", 5, 10);
    let original = claim(&catalog, request.clone());
    let handle = original.claim.handle.clone();
    transition(
        &catalog,
        CatalogCommand::ReconcileClosed {
            handle: handle.clone(),
            now_ms: 20,
        },
    );
    assert_eq!(
        catalog
            .execute(CatalogCommand::GcTombstones {
                older_than_ms: 21,
                limit: 100,
            })
            .unwrap(),
        CatalogResult::GarbageCollected(1)
    );
    for selector in [
        CatalogSelector::Handle(handle.clone()),
        CatalogSelector::RequestId(request.request_id.clone()),
    ] {
        assert!(matches!(
            catalog.execute(CatalogCommand::Lookup(selector)).unwrap(),
            CatalogResult::Lookup(CatalogLookup::Collected(_))
        ));
    }
    let replay = claim(&catalog, request);
    assert_eq!(replay.disposition, ClaimDisposition::Reused);
    assert_eq!(replay.claim.handle, handle);
    assert!(
        replay.terminal.is_none(),
        "a collected claim must never replay"
    );
    assert_eq!(
        catalog
            .execute(CatalogCommand::Claim(create("durable/request", 6, 30)))
            .unwrap_err(),
        CatalogError::RequestConflict
    );
    catalog.shutdown().unwrap();
}

#[test]
fn debug_output_redacts_digest_title_and_workspace_path() {
    let title_sentinel = "TOP-SECRET-TITLE";
    let path_sentinel = "C:\\TOP-SECRET-WORKSPACE";
    let mut request = create("debug/request", b'Z', 10);
    request.title = Some(title_sentinel.to_owned());
    request.target = PresentationTarget::Workspace {
        normalized_path: path_sentinel.to_owned(),
    };
    let rendered_command = format!("{:?}", CatalogCommand::Claim(request.clone()));
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let rendered_result = format!(
        "{:?}",
        catalog.execute(CatalogCommand::Claim(request)).unwrap()
    );
    catalog.shutdown().unwrap();
    for rendered in [&rendered_command, &rendered_result] {
        assert!(!rendered.contains(title_sentinel));
        assert!(!rendered.contains(path_sentinel));
        assert!(!rendered.contains("ZZZZZZZZ"));
        assert!(rendered.contains("title_present"));
    }
    assert!(rendered_command.contains("normalized_path_present"));
    assert!(rendered_result.contains("workspace_target_present"));
}

#[test]
fn desired_presentation_debug_redacts_workspace_target() {
    let path_sentinel = "C:\\TOP-SECRET-PRESENTATION";
    let rendered = format!(
        "{:?}",
        CatalogCommand::SetDesiredPresentation {
            handle: "handle".to_owned(),
            placement: Placement::Workspace,
            workspace_target: Some(path_sentinel.to_owned()),
            presentation: Presentation::Focused,
            expected_revision: 2,
            now_ms: 10,
        }
    );
    assert!(!rendered.contains(path_sentinel));
    assert!(rendered.contains("workspace_target_present: true"));
}

#[test]
fn shutdown_is_bounded_and_releases_database() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(&path, identity("runtime-a", "nonce-a")).unwrap();
    let started = Instant::now();
    catalog.shutdown().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    let (catalog, _) = Catalog::open(path, identity("runtime-b", "nonce-b")).unwrap();
    catalog.shutdown().unwrap();
}

#[test]
fn initialization_timeout_cannot_reconcile_after_the_caller_has_returned() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(&path, identity("seed", "seed-nonce")).unwrap();
    let handle = claim(&catalog, create("live/request", 8, 10)).claim.handle;
    transition(
        &catalog,
        CatalogCommand::MarkRunning {
            handle: handle.clone(),
            now_ms: 11,
        },
    );
    catalog.shutdown().unwrap();

    let mut lock = Connection::open(&path).unwrap();
    let transaction = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Exclusive)
        .unwrap();
    let result = Catalog::open_with_options(
        &path,
        identity("timed-out", "timed-out-nonce"),
        CatalogOptions {
            queue_capacity: 1,
            request_timeout: Duration::from_millis(1),
            shutdown_timeout: Duration::from_millis(10),
        },
    );
    assert_eq!(result.err().unwrap(), CatalogError::Timeout);
    transaction.rollback().unwrap();

    let (catalog, reconciliation) = Catalog::open(&path, identity("final", "final-nonce"))
        .expect("the cancelled actor must not retain database ownership");
    assert_eq!(reconciliation.generation, 2);
    assert_eq!(reconciliation.lost_handles, vec![handle]);
    catalog.shutdown().unwrap();
}

#[test]
fn desired_presentation_is_compare_and_set_and_rejects_stale_writers() {
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let handle = claim(&catalog, create("present/request", 1, 10))
        .claim
        .handle;
    let running = transition(
        &catalog,
        CatalogCommand::MarkRunning {
            handle: handle.clone(),
            now_ms: 11,
        },
    );
    let presented = transition(
        &catalog,
        CatalogCommand::SetDesiredPresentation {
            handle: handle.clone(),
            placement: Placement::Window,
            workspace_target: None,
            presentation: Presentation::Focused,
            expected_revision: running.record.revision,
            now_ms: 12,
        },
    );
    assert!(presented.changed);
    assert_eq!(presented.record.revision, running.record.revision + 1);
    assert_eq!(presented.record.placement, Placement::Window);
    assert!(!presented.record.surface_hidden);

    assert_eq!(
        catalog.execute(CatalogCommand::SetDesiredPresentation {
            handle: handle.clone(),
            placement: Placement::Workspace,
            workspace_target: Some("C:\\other".to_owned()),
            presentation: Presentation::Background,
            expected_revision: running.record.revision,
            now_ms: 13,
        }),
        Err(CatalogError::StalePresentation)
    );
    let current = match catalog
        .execute(CatalogCommand::Lookup(CatalogSelector::Handle(handle)))
        .unwrap()
    {
        CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => terminal,
        result => panic!("unexpected result: {result:?}"),
    };
    assert_eq!(*current, presented.record);
    catalog.shutdown().unwrap();
}

#[test]
fn desired_presentation_transfers_are_monotonic_and_validate_targets() {
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let handle = claim(&catalog, create("transfer/request", 2, 10))
        .claim
        .handle;
    let mut revision = transition(
        &catalog,
        CatalogCommand::MarkRunning {
            handle: handle.clone(),
            now_ms: 11,
        },
    )
    .record
    .revision;
    for index in 0..20 {
        let workspace = index % 2 == 0;
        let result = transition(
            &catalog,
            CatalogCommand::SetDesiredPresentation {
                handle: handle.clone(),
                placement: if workspace {
                    Placement::Workspace
                } else {
                    Placement::Window
                },
                workspace_target: workspace.then(|| format!("C:\\workspace-{index}")),
                presentation: Presentation::Background,
                expected_revision: revision,
                now_ms: 12 + i64::from(index),
            },
        );
        assert_eq!(result.record.revision, revision + 1);
        revision = result.record.revision;
    }
    assert_eq!(
        catalog.execute(CatalogCommand::SetDesiredPresentation {
            handle,
            placement: Placement::Window,
            workspace_target: Some("C:\\must-not-be-kept".to_owned()),
            presentation: Presentation::Focused,
            expected_revision: revision,
            now_ms: 40,
        }),
        Err(CatalogError::InvalidInput("invalid workspace target"))
    );
    catalog.shutdown().unwrap();
}

#[test]
fn surface_hidden_is_a_revision_guarded_idempotent_transition() {
    let temp = TempDir::new().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        identity("runtime", "nonce"),
    )
    .unwrap();
    let handle = claim(&catalog, create("hidden/request", 3, 10))
        .claim
        .handle;
    let created = match catalog
        .execute(CatalogCommand::Lookup(CatalogSelector::Handle(
            handle.clone(),
        )))
        .unwrap()
    {
        CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => terminal,
        result => panic!("unexpected result: {result:?}"),
    };
    let hidden = transition(
        &catalog,
        CatalogCommand::SetSurfaceHidden {
            handle: handle.clone(),
            hidden: true,
            expected_revision: created.revision,
            now_ms: 11,
        },
    );
    assert!(hidden.changed);
    assert!(hidden.record.surface_hidden);
    let idempotent = transition(
        &catalog,
        CatalogCommand::SetSurfaceHidden {
            handle: handle.clone(),
            hidden: true,
            expected_revision: hidden.record.revision,
            now_ms: 12,
        },
    );
    assert!(!idempotent.changed);
    assert_eq!(idempotent.record.revision, hidden.record.revision);
    assert_eq!(
        catalog.execute(CatalogCommand::SetSurfaceHidden {
            handle,
            hidden: true,
            expected_revision: created.revision,
            now_ms: 13,
        }),
        Err(CatalogError::StalePresentation)
    );
    catalog.shutdown().unwrap();
}

#[test]
fn presentation_rejects_exited_and_stale_runtime_without_mutation() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let (old, _) = Catalog::open(&path, identity("old", "old-nonce")).unwrap();
    let handle = claim(&old, create("lifecycle/request", 4, 10)).claim.handle;
    let running = transition(
        &old,
        CatalogCommand::MarkRunning {
            handle: handle.clone(),
            now_ms: 11,
        },
    );
    let (new, _) = Catalog::open(&path, identity("new", "new-nonce")).unwrap();
    assert_eq!(
        old.execute(CatalogCommand::SetDesiredPresentation {
            handle: handle.clone(),
            placement: Placement::Window,
            workspace_target: None,
            presentation: Presentation::Focused,
            expected_revision: running.record.revision,
            now_ms: 12,
        }),
        Err(CatalogError::StaleRuntime)
    );
    let lost = match new
        .execute(CatalogCommand::Lookup(CatalogSelector::Handle(
            handle.clone(),
        )))
        .unwrap()
    {
        CatalogResult::Lookup(CatalogLookup::ActiveOrTombstone { terminal, .. }) => terminal,
        result => panic!("unexpected result: {result:?}"),
    };
    assert_eq!(lost.state, TerminalState::Lost);
    assert_eq!(
        new.execute(CatalogCommand::SetDesiredPresentation {
            handle,
            placement: Placement::Window,
            workspace_target: None,
            presentation: Presentation::Focused,
            expected_revision: lost.revision,
            now_ms: lost.updated_at_ms,
        }),
        Err(CatalogError::InvalidTransition)
    );
    old.shutdown().unwrap();
    new.shutdown().unwrap();
}
