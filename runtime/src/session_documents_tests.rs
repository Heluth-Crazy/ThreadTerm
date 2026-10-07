use crate::{db::Database, session_documents};
use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    db: Database,
    root: PathBuf,
    session: String,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("worktree");
    fs::create_dir(&root).unwrap();
    let db = Database::open(&temp.path().join("state.sqlite")).unwrap();
    crate::workspace_services::initialize(&db).unwrap();
    session_documents::initialize(&db).unwrap();
    let project = db.add_project(root.to_str().unwrap(), Some("test"), "project-op").unwrap();
    db.transaction(|tx| {
        tx.execute("INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('session',?,'test','codex','chat','idle','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')", [&project.id])?;
        Ok(())
    }).unwrap();
    Fixture { _temp: temp, db, root, session: "session".into() }
}

fn call(fixture: &Fixture, method: &str, params: Value) -> Result<Value> {
    session_documents::dispatch(&fixture.db, method, &params).map(|value| value.unwrap())
}

fn pin(fixture: &Fixture, path: &str, operation_id: &str) -> Result<Value> {
    call(fixture, "session.documents.pin", json!({"sessionId":fixture.session,"path":path,"operationId":operation_id}))
}

#[test]
fn pin_normalizes_paths_extracts_titles_and_is_idempotent() {
    let fixture = fixture();
    fs::create_dir(fixture.root.join("docs")).unwrap();
    fs::write(fixture.root.join("docs/plan.md"), "---\ntitle: ignored\n---\n\n## A durable plan\n").unwrap();
    let first = pin(&fixture, "docs\\.\\plan.md", "pin-once").unwrap();
    assert_eq!(first[0]["path"], "docs/plan.md");
    assert_eq!(first[0]["title"], "A durable plan", "{first}");
    let replay = pin(&fixture, "docs/plan.md", "pin-once").unwrap();
    assert_eq!(replay, first);
    let repeated = pin(&fixture, "docs/plan.md", "pin-twice").unwrap();
    assert_eq!(repeated, first);
    let events = fixture.db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox WHERE data LIKE '%session.documents%'", [], |row| row.get::<_, i64>(0))?)).unwrap();
    assert_eq!(events, 1);
}

#[test]
fn pin_rejects_unsafe_and_non_regular_files() {
    let fixture = fixture();
    fs::write(fixture.root.join("file.txt"), "ok").unwrap();
    fs::create_dir(fixture.root.join("folder")).unwrap();
    for path in ["../file.txt", "/file.txt", "C:file.txt", "C:\\file.txt", "folder"] {
        assert_eq!(pin(&fixture, path, &format!("op-{path:?}")).unwrap_err().to_string(), if path == "folder" { "not_a_file" } else { "path_outside_root" });
    }
    assert_eq!(pin(&fixture, "missing.txt", "missing").unwrap_err().to_string(), "not_a_file");
}

#[test]
fn pin_rejects_large_files_and_enforces_the_limit() {
    let fixture = fixture();
    fs::write(fixture.root.join("large.txt"), vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    assert_eq!(pin(&fixture, "large.txt", "large").unwrap_err().to_string(), "file_too_large");
    for number in 0..20 {
        let path = format!("{number}.txt");
        fs::write(fixture.root.join(&path), "ok").unwrap();
        pin(&fixture, &path, &format!("pin-{number}")).unwrap();
    }
    assert_eq!(pin(&fixture, "0.txt", "pin-existing-at-limit").unwrap().as_array().unwrap().len(), 20);
    fs::write(fixture.root.join("one-more.txt"), "ok").unwrap();
    assert_eq!(pin(&fixture, "one-more.txt", "limit").unwrap_err().to_string(), "too_many_documents");
}

#[test]
fn list_marks_missing_and_unpin_is_idempotent() {
    let fixture = fixture();
    fs::write(fixture.root.join("notes.txt"), "notes").unwrap();
    pin(&fixture, "notes.txt", "pin").unwrap();
    fs::remove_file(fixture.root.join("notes.txt")).unwrap();
    assert_eq!(pin(&fixture, "notes.txt", "re-pin-missing").unwrap()[0]["path"], "notes.txt");
    let listed = call(&fixture, "session.documents.list", json!({"sessionId":fixture.session})).unwrap();
    assert_eq!(listed[0]["missing"], true);
    let first = call(&fixture, "session.documents.unpin", json!({"sessionId":fixture.session,"path":"notes.txt","operationId":"unpin"})).unwrap();
    let replay = call(&fixture, "session.documents.unpin", json!({"sessionId":fixture.session,"path":"notes.txt","operationId":"unpin"})).unwrap();
    assert_eq!(first, json!([]));
    assert_eq!(replay, first);
    let repeated = call(&fixture, "session.documents.unpin", json!({"sessionId":fixture.session,"path":"notes.txt","operationId":"unpin-again"})).unwrap();
    assert_eq!(repeated, first);
}

#[test]
fn markdown_title_rules_and_session_cascade_hold() {
    let fixture = fixture();
    fs::write(fixture.root.join("no-title.md"), "plain text\n").unwrap();
    fs::write(fixture.root.join("plain.txt"), "# not markdown\n").unwrap();
    fs::write(fixture.root.join("late.md"), format!("{}\n# too late", "x".repeat(64 * 1024))).unwrap();
    for path in ["no-title.md", "plain.txt", "late.md"] { pin(&fixture, path, &format!("op-{path}")).unwrap(); }
    let listed = call(&fixture, "session.documents.list", json!({"sessionId":fixture.session})).unwrap();
    assert!(listed.as_array().unwrap().iter().all(|document| document.get("title").is_none()));
    fixture.db.transaction(|tx| { tx.execute("DELETE FROM sessions WHERE id=?", [&fixture.session])?; Ok(()) }).unwrap();
    let count = fixture.db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM session_documents", [], |row| row.get::<_, i64>(0))?)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn uses_the_session_worktree_and_unknown_sessions_fail() {
    let fixture = fixture();
    let worktree = fixture.root.join("registered-worktree");
    fs::create_dir(&worktree).unwrap();
    fs::write(worktree.join("plan.md"), format!("# {}", "界".repeat(201))).unwrap();
    let canonical = worktree.canonicalize().unwrap().to_string_lossy().to_string();
    fixture.db.transaction(|tx| {
        let project: String = tx.query_row("SELECT project_id FROM sessions WHERE id=?", [&fixture.session], |row| row.get(0))?;
        tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('wt',?,?,'feature','head',0,0)", params![project, canonical])?;
        tx.execute("UPDATE sessions SET worktree_path=? WHERE id=?", params![canonical, fixture.session])?;
        Ok(())
    }).unwrap();
    let pinned = pin(&fixture, "plan.md", "worktree-pin").unwrap();
    assert_eq!(pinned[0]["title"].as_str().unwrap().chars().count(), 200);
    for method in ["session.documents.list", "session.documents.pin", "session.documents.unpin"] {
        let mut request = json!({"sessionId":"unknown"});
        if method != "session.documents.list" {
            request["path"] = json!("plan.md");
            request["operationId"] = json!(format!("unknown-{method}"));
        }
        assert_eq!(call(&fixture, method, request).unwrap_err().to_string(), "session_not_found");
    }
}

#[cfg(unix)]
#[test]
fn symlink_escape_is_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = fixture();
    let outside = fixture._temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    symlink(&outside, fixture.root.join("escape.txt")).unwrap();
    assert_eq!(pin(&fixture, "escape.txt", "escape").unwrap_err().to_string(), "path_outside_root");
}

#[cfg(windows)]
#[test]
fn junction_escape_is_rejected() {
    use std::process::Command;
    let fixture = fixture();
    let outside = fixture._temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.md"), "# outside").unwrap();
    let link = fixture.root.join("escape");
    let mut command = Command::new("cmd");
    command.args(["/C", "mklink", "/J", link.to_str().unwrap(), outside.to_str().unwrap()]);
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
    let status = command.status().unwrap();
    assert!(status.success());
    assert_eq!(pin(&fixture, "escape/secret.md", "junction-escape").unwrap_err().to_string(), "path_outside_root");
}
