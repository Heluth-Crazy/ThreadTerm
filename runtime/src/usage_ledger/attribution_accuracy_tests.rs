use super::{discovery, facts::Fact, ledger_db, queries, scanner, store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, sync::atomic::AtomicBool};

fn ledger() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage-ledger-attribution.sqlite");
    let database = crate::db::Database::open(&path).unwrap();
    drop(database);
    (dir, ledger_db::test_connection(&path).unwrap())
}

fn threadterm_session(conn: &Connection, id: &str, provider: &str, native_id: &str) {
    ledger_db::fixture_main(conn)
        .execute(
            "INSERT INTO sessions(
                id,project_id,worktree_path,title,provider,mode,status,
                created_at,updated_at,native_id,followed,read_only)
             VALUES(?,NULL,NULL,?,?,'chat','idle',
                    '2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',?,0,0)",
            params![id, format!("Fixture {id}"), provider, native_id],
        )
        .unwrap();
}

fn claude_line(session: &str, message: &str, request: &str, input: i64) -> String {
    format!(
        "{}\n",
        json!({
            "sessionId": session,
            "requestId": request,
            "timestamp": "2026-10-02T12:00:00Z",
            "message": {"id": message, "model": "fixture-model", "usage": {"input_tokens": input}}
        })
    )
}

fn claude_sidechain_line(
    parent: &str,
    agent: &str,
    message: &str,
    request: &str,
    input: i64,
) -> String {
    format!(
        "{}\n",
        json!({
            "sessionId": parent,
            "agentId": agent,
            "isSidechain": true,
            "requestId": request,
            "timestamp": "2026-10-02T12:00:01Z",
            "message": {"id": message, "model": "fixture-model", "usage": {"input_tokens": input}}
        })
    )
}

fn total(conn: &Connection, scope: &str) -> i64 {
    queries::query(
        conn,
        "usage.ledger.summary",
        &json!({"filters":{"scope":scope}}),
    )
    .unwrap()["tokens"]["total"]
        .as_i64()
        .unwrap()
}

// The pre-inheritance release used this metadata-only fingerprint. Persisting
// it after the parent binding simulates an old ledger whose native files did
// not change, so a reconciliation-algorithm revision must invalidate it.
fn legacy_attribution_revision(conn: &Connection) -> String {
    let mut hash = Sha256::new();
    for sql in [
        "SELECT id,provider,COALESCE(native_id,''),COALESCE(project_id,''),COALESCE(worktree_path,'') FROM sessions ORDER BY id",
        "SELECT id,name,path FROM projects ORDER BY id",
    ] {
        let mut statement = conn.prepare(sql).unwrap();
        let count = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for index in 0..count {
                let value: String = row.get(index).unwrap();
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
        }
    }
    format!("{:x}", hash.finalize())
}

fn native_fact(
    native_id: &str,
    key: &str,
    parent_native_session_id: Option<&str>,
    subagent: bool,
) -> Fact {
    let mut fact = Fact::new("claude", native_id, key, "2026-10-02T12:00:00Z");
    fact.buckets.input = Some(1);
    fact.source = format!("native:{key}@0");
    fact.parent_native_session_id = parent_native_session_id.map(str::to_owned);
    fact.subagent = subagent;
    fact
}

#[test]
fn only_exact_subagent_parent_chains_inherit_and_cycles_stay_outside() {
    let (_dir, conn) = ledger();
    threadterm_session(&conn, "threadterm-parent", "claude", "bound-parent");
    store::upsert_facts(
        &conn,
        &[
            native_fact("fork-child", "fork", Some("bound-parent"), false),
            native_fact("cycle-a", "cycle-a", Some("cycle-b"), true),
            native_fact("cycle-b", "cycle-b", Some("cycle-a"), true),
            native_fact("nested-child", "nested-child", Some("nested-parent"), true),
            native_fact("nested-parent", "nested-parent", Some("bound-parent"), true),
        ],
    )
    .unwrap();
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());
    for key in ["claude:fork", "claude:cycle-a", "claude:cycle-b"] {
        let scope: String = conn
            .query_row(
                "SELECT scope FROM usage_facts WHERE fact_key=?",
                [key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scope, "outside");
    }
    let nested_scope: String = conn
        .query_row(
            "SELECT scope FROM usage_facts WHERE fact_key='claude:nested-child'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(nested_scope, "threadterm");
}

#[test]
fn later_native_parent_discovery_and_removal_refresh_existing_descendant_membership() {
    let (_dir, conn) = ledger();
    let cancel = AtomicBool::new(false);
    threadterm_session(&conn, "bound-session", "claude", "bound-root");
    store::upsert_fact(
        &conn,
        &native_fact("grandchild", "grandchild", Some("late-parent"), true),
    )
    .unwrap();
    store::refresh_attributions(&conn, &cancel).unwrap();
    assert_eq!(total(&conn, "outside"), 1);

    store::upsert_fact(
        &conn,
        &native_fact("late-parent", "late-parent", Some("bound-root"), true),
    )
    .unwrap();
    store::refresh_attributions(&conn, &cancel).unwrap();
    assert_eq!(
        total(&conn, "threadterm"),
        2,
        "a new native edge must reclassify existing descendants"
    );
    assert_eq!(total(&conn, "outside"), 0);

    store::remove_source(&conn, "native:late-parent@").unwrap();
    store::refresh_attributions(&conn, &cancel).unwrap();
    assert_eq!(total(&conn, "threadterm"), 0);
    assert_eq!(
        total(&conn, "outside"),
        1,
        "removing the intermediate edge must invalidate inheritance"
    );
}

#[test]
fn claude_native_sidechain_inherits_exact_parent_membership_and_suppresses_live_duplicate() {
    let (dir, conn) = ledger();
    let history = dir.path().join("claude-history");
    let subagents = history.join("subagents");
    fs::create_dir_all(&subagents).unwrap();
    let parent = "claude-parent";
    let child = "claude-parent:agent:worker";

    // Exercise discovery, scanner, and the Claude reader with the persisted
    // sidechain shape. The child file itself retains the parent session ID.
    fs::write(
        history.join("parent.jsonl"),
        claude_line(parent, "parent-message", "parent-request", 2),
    )
    .unwrap();
    fs::write(
        subagents.join("agent-worker.jsonl"),
        claude_sidechain_line(parent, "worker", "child-message", "child-request", 5),
    )
    .unwrap();

    // An equally-shaped native-only parent and child must remain Outside.
    let outside_parent = "outside-parent";
    fs::write(
        history.join("outside-parent.jsonl"),
        claude_line(
            outside_parent,
            "outside-parent-message",
            "outside-parent-request",
            3,
        ),
    )
    .unwrap();
    fs::write(
        subagents.join("agent-outside-worker.jsonl"),
        claude_sidechain_line(
            outside_parent,
            "outside-worker",
            "outside-child-message",
            "outside-child-request",
            7,
        ),
    )
    .unwrap();

    let root = discovery::Root {
        provider: "claude".into(),
        path: history.clone(),
        trees: vec![history],
    };
    let stats = scanner::scan(&root, &conn, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
    assert_eq!(stats.facts, 4);
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());

    // No native file changes occur below this point. Binding only the parent
    // in the main database must move its exact subagent chain on the normal
    // reconciliation path, while the similarly shaped unbound chain remains
    // Outside.
    assert_eq!(total(&conn, "all"), 17);
    assert_eq!(total(&conn, "threadterm"), 0);
    assert_eq!(total(&conn, "outside"), 17);
    threadterm_session(&conn, "threadterm-parent", "claude", parent);
    let old_revision = legacy_attribution_revision(&conn);
    conn.execute(
        "INSERT INTO usage_ledger_state(key,value) VALUES('attribution-revision',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [old_revision],
    )
    .unwrap();
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());

    // Native authority chooses the 5-token child fact, never the 11-token live row.
    assert_eq!(total(&conn, "all"), 17);
    assert_eq!(total(&conn, "threadterm"), 7);
    assert_eq!(total(&conn, "outside"), 10);

    // The persisted revision may skip the second call, but must retain the
    // inherited attribution without rescanning or rebuilding native files.
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());
    assert_eq!(total(&conn, "threadterm"), 7);
    drop(conn);
    let conn =
        ledger_db::test_connection(&dir.path().join("usage-ledger-attribution.sqlite")).unwrap();
    assert!(store::refresh_attributions(&conn, &AtomicBool::new(false)).unwrap());
    assert_eq!(total(&conn, "threadterm"), 7);

    // A later live observation for the same native child must not affect the
    // native-only ownership decision or be added to native-authoritative totals.
    let mut live_child = Fact::new(
        "claude",
        child,
        "live-child-request",
        "2026-10-02T12:00:02Z",
    );
    live_child.model = Some("fixture-model".into());
    live_child.buckets.input = Some(11);
    live_child.source = "live:threadterm-parent:child".into();
    live_child.threadterm_session_id = Some("threadterm-parent".into());
    store::upsert_fact(&conn, &live_child).unwrap();
    assert_eq!(total(&conn, "all"), 17);
    assert_eq!(total(&conn, "threadterm"), 7);
    assert_eq!(total(&conn, "outside"), 10);

    let detail: Value = queries::query(
        &conn,
        "usage.ledger.session",
        &json!({
            "filters":{"scope":"threadterm"},
            "provider":"claude",
            "nativeSessionId":parent
        }),
    )
    .unwrap();
    assert_eq!(detail["tokens"]["total"], 2);
    let children = detail["subagents"].as_array().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["nativeSessionId"], child);
    assert_eq!(children[0]["tokens"]["total"], 5);
}
