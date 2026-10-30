//! Recent runs of one worktree: bounded, temporary, and the source of "Keep".
//!
//! Every launch is already recorded in `quick_launch_runs`; this module only reads that
//! table back in the Run view's own vocabulary. Nothing is stored or pruned here: a run
//! disappears when its session is deleted, and older rows are simply not listed, so
//! deleting them stays with the existing session lifecycle.

use super::*;
use chrono::{DateTime, Duration as ChronoDuration};

/// The window and the cap the product agreed on: the last 7 days, at most 20 runs.
const RECENT_DAYS: i64 = 7;
const RECENT_LIMIT: i64 = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recent {
    project_id: String,
    cwd: String,
}

pub(crate) fn validate(value: &Value) -> Result<()> {
    let p: Recent = serde_json::from_value(value.clone())?;
    required(&p.project_id)?;
    required(&p.cwd)?;
    Ok(())
}

/// `quickLaunch.recent {projectId, cwd}`: the latest runs of the worktree whose root is `cwd`.
pub(crate) fn dispatch(db: &Database, value: &Value) -> Result<Value> {
    let p: Recent = serde_json::from_value(value.clone())?;
    let root = root_for_setup(db, &p.project_id, &p.cwd)?;
    let root_key = root.to_string_lossy().into_owned();
    let now = Utc::now();
    // The bound is applied twice on purpose: the SQL cut keeps the scan small, and the
    // parsed comparison below is the authority on the 7-day rule.
    let cutoff = (now - ChronoDuration::days(RECENT_DAYS)).to_rfc3339();
    let rows = db.transaction(|tx| {
        let mut statement = tx.prepare(&format!(
            "SELECT q.session_id,q.command_id,q.snapshot_json,q.url,q.readiness,q.ready_port,q.started_at,q.started_by,\
             q.stop_requested,q.kept_command_id,s.status,s.exit_code,s.updated_at,EXISTS(SELECT 1 FROM quick_launch_commands c WHERE c.id=q.command_id AND c.project_id=q.project_id) \
             FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id \
             WHERE q.project_id=? AND q.root=? AND q.started_at>=? \
             ORDER BY q.started_at DESC,q.rowid DESC LIMIT ?"
        ))?;
        let collected = statement
            .query_map(
                params![p.project_id, root_key, cutoff, RECENT_LIMIT],
                Row::from,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(collected)
    })?;
    let mut runs = Vec::new();
    for row in rows {
        // A row recorded with a timestamp this runtime cannot parse is not "recent".
        let Some(started) = DateTime::parse_from_rfc3339(&row.started_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
        else {
            continue;
        };
        if started < now - ChronoDuration::days(RECENT_DAYS) {
            continue;
        }
        let active = matches!(
            row.status.as_str(),
            "starting" | "running" | "idle" | "waiting"
        );
        let source = if row.command_id.starts_with("detected:") {
            "detected"
        } else if row.saved {
            "saved"
        } else {
            // The saved command behind this run is gone; the snapshot is all that is left,
            // and Keep still promotes it.
            "adhoc"
        };
        let state = run_state(
            &row.status,
            row.readiness.as_deref(),
            row.exit_code,
            row.stopped,
            &row.snapshot.kind,
        );
        let mut value = json!({
            "runId":row.session_id,
            "entryId":row.command_id,
            "name":row.snapshot.name,
            "command":row.snapshot.command,
            "source":source,
            "startedAt":row.started_at,
            "state":state,
            "stopped":row.stopped,
            "snapshot":row.snapshot,
        });
        if !active {
            value["endedAt"] = json!(row.updated_at);
        }
        if let Some(exit_code) = row.exit_code {
            value["exitCode"] = json!(exit_code);
        }
        if let Some(started_by) = row.started_by {
            value["startedBy"] = json!(started_by);
        }
        if let Some(command_id) = row.kept_command_id {
            value["kept"] = json!({"commandId":command_id});
        }
        runs.push(value);
    }
    Ok(json!({"runs":runs}))
}

/// One recent-run row, already decoded from its snapshot.
struct Row {
    session_id: String,
    command_id: String,
    snapshot: QuickLaunchCommand,
    readiness: Option<String>,
    started_at: String,
    started_by: Option<String>,
    stopped: bool,
    kept_command_id: Option<String>,
    status: String,
    exit_code: Option<i32>,
    updated_at: String,
    /// Whether the saved command this run names still exists in its project.
    saved: bool,
}

impl Row {
    fn from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
        let raw: String = row.get(2)?;
        let (snapshot, _) = super::setup::decode_snapshot(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(Row {
            session_id: row.get(0)?,
            command_id: row.get(1)?,
            snapshot,
            readiness: row.get(4)?,
            started_at: row.get(6)?,
            started_by: row.get(7)?,
            stopped: row.get::<_, i64>(8)? != 0,
            kept_command_id: row.get(9)?,
            status: row.get(10)?,
            exit_code: row.get(11)?,
            updated_at: row.get(12)?,
            saved: row.get::<_, i64>(13)? != 0,
        })
    }
}

/// The Run view's vocabulary, decided once so a recent row and a Running row cannot disagree.
fn run_state(
    status: &str,
    readiness: Option<&str>,
    exit_code: Option<i32>,
    stopped: bool,
    kind: &str,
) -> &'static str {
    match status {
        "starting" => "starting",
        // A watched service that has not listened yet is still Starting.
        "running" | "idle" | "waiting" => match readiness {
            Some("waiting") => "starting",
            Some("ready") => "ready",
            _ => "running",
        },
        _ if stopped => "stopped",
        "interrupted" => "interrupted",
        "error" => "failed",
        _ => match exit_code {
            Some(0) if kind == "task" => "completed",
            Some(0) | None => "exited",
            Some(_) => "failed",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_value(db: &Database, value: &Value) -> Result<Value> {
        super::super::validate("quickLaunch.save", value)?;
        super::super::save(db, serde_json::from_value(value.clone())?)
    }

    fn fixture() -> (tempfile::TempDir, Arc<Database>, String, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        std::fs::create_dir_all(&root).unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        let project = db
            .add_project(&root.to_string_lossy(), Some("Recent"), "recent-project")
            .unwrap()
            .id;
        (dir, db, project, root)
    }

    fn command(db: &Database, project: &str, name: &str, kind: &str) -> QuickLaunchCommand {
        save_value(
            db,
            &json!({
                "projectId":project,"name":name,"command":"node app.mjs","shell":"cmd","cwd":"",
                "kind":kind,"env":[],"operationId":format!("save-{name}")
            }),
        )
        .unwrap();
        saved_commands(db, project)
            .unwrap()
            .into_iter()
            .find(|command| command.name == name)
            .unwrap()
    }

    /// One run row without launching a process: exactly the columns a real launch writes.
    fn insert_run(
        db: &Database,
        project: &str,
        root: &str,
        command: &QuickLaunchCommand,
        session: &str,
        status: &str,
        started_at: &str,
        started_by: Option<&str>,
    ) {
        let now = Utc::now().to_rfc3339();
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,followed) VALUES(?,?,?,?,'custom','terminal',?,?,?,0)", params![session, project, root, command.name, status, started_at, now])?;
            tx.execute("INSERT INTO session_activity(session_id,state,revision) VALUES(?,'unknown',1)", [session])?;
            tx.execute("INSERT INTO quick_launch_runs(session_id,command_id,project_id,root,snapshot_json,url,url_source,stop_requested,started_at,started_by) VALUES(?,?,?,?,?,NULL,NULL,0,?,?)", params![session, command.id, project, root, serde_json::to_string(command).unwrap(), started_at, started_by])?;
            Ok(())
        })
        .unwrap();
    }

    fn recent(db: &Database, project: &str, root: &std::path::Path) -> Value {
        dispatch(
            db,
            &json!({"projectId":project,"cwd":root.to_string_lossy()}),
        )
        .unwrap()
    }

    #[test]
    fn recent_lists_the_latest_twenty_runs_within_seven_days_of_one_worktree() {
        let (_dir, db, project, root) = fixture();
        let saved = command(&db, &project, "server", "service");
        let root_key = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let now = Utc::now();
        // 25 runs, newest first: only the newest 20 may be listed.
        for index in 0..25 {
            let started = (now - ChronoDuration::minutes(index)).to_rfc3339();
            insert_run(
                &db,
                &project,
                &root_key,
                &saved,
                &format!("run-{index}"),
                "exited",
                &started,
                None,
            );
        }
        // An older run than the window, and one of another worktree: never listed.
        insert_run(
            &db,
            &project,
            &root_key,
            &saved,
            "old-run",
            "exited",
            &(now - ChronoDuration::days(8)).to_rfc3339(),
            None,
        );
        let other = _dir.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('w2',?,?,'b','h',0,0)", params![project, other.to_string_lossy()])?;
            Ok(())
        })
        .unwrap();
        insert_run(
            &db,
            &project,
            &other.canonicalize().unwrap().to_string_lossy(),
            &saved,
            "other-run",
            "exited",
            &now.to_rfc3339(),
            None,
        );
        let value = recent(&db, &project, &root);
        let runs = value["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 20, "at most 20 runs");
        assert_eq!(runs[0]["runId"], "run-0", "newest first");
        assert_eq!(runs[19]["runId"], "run-19");
        assert!(!runs.iter().any(|run| run["runId"] == "old-run"));
        assert!(!runs.iter().any(|run| run["runId"] == "other-run"));
        assert_eq!(runs[0]["source"], "saved");
        assert_eq!(runs[0]["snapshot"]["id"], saved.id);
        assert_eq!(runs[0]["state"], "exited");
        assert!(runs[0]["endedAt"].is_string(), "an ended run has an end");
    }

    #[test]
    fn a_recent_run_reports_its_source_attribution_and_stop_intent() {
        let (_dir, db, project, root) = fixture();
        let saved = command(&db, &project, "server", "service");
        let root_key = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let now = Utc::now().to_rfc3339();
        insert_run(
            &db,
            &project,
            &root_key,
            &saved,
            "saved-run",
            "running",
            &now,
            Some("chat-1"),
        );
        // A detected run, whose entry is never a saved command.
        let detected = QuickLaunchCommand {
            id: "detected:node:package.json:dev".into(),
            ..saved.clone()
        };
        insert_run(
            &db,
            &project,
            &root_key,
            &detected,
            "detected-run",
            "running",
            &now,
            None,
        );
        // A run of a command that no longer exists: adhoc, and the snapshot still says what ran.
        let gone = QuickLaunchCommand {
            id: "deleted-command".into(),
            name: "Old server".into(),
            ..saved.clone()
        };
        insert_run(
            &db,
            &project,
            &root_key,
            &gone,
            "adhoc-run",
            "exited",
            &now,
            None,
        );
        db.set_session_status("adhoc-run", "exited", Some(1))
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE quick_launch_runs SET stop_requested=1 WHERE session_id='adhoc-run'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let value = recent(&db, &project, &root);
        let runs = value["runs"].as_array().unwrap();
        let by_id = |id: &str| runs.iter().find(|run| run["runId"] == id).unwrap();
        assert_eq!(by_id("saved-run")["source"], "saved");
        assert_eq!(by_id("saved-run")["startedBy"], "chat-1");
        assert!(
            by_id("saved-run").get("endedAt").is_none(),
            "an active run has no end"
        );
        assert_eq!(by_id("saved-run")["state"], "running");
        assert_eq!(by_id("detected-run")["source"], "detected");
        assert!(by_id("detected-run").get("startedBy").is_none());
        assert_eq!(by_id("adhoc-run")["source"], "adhoc");
        assert_eq!(by_id("adhoc-run")["name"], "Old server");
        assert_eq!(by_id("adhoc-run")["exitCode"], 1);
        assert_eq!(by_id("adhoc-run")["stopped"], true);
        assert_eq!(
            by_id("adhoc-run")["state"],
            "stopped",
            "a stopped run reads as Stopped"
        );
    }

    #[test]
    fn keeping_a_run_records_the_saved_command_and_the_run_leaves_when_its_session_does() {
        let (_dir, db, project, root) = fixture();
        let saved = command(&db, &project, "server", "service");
        let root_key = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let now = Utc::now().to_rfc3339();
        insert_run(
            &db, &project, &root_key, &saved, "kept-run", "exited", &now, None,
        );
        assert_eq!(
            recent(&db, &project, &root)["runs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // Keep is a normal save that names the run it came from.
        let kept = save_value(
            &db,
            &json!({
                "projectId":project,"name":"Kept server","command":"node server.mjs","shell":"cmd","cwd":"",
                "kind":"service","env":[],"runId":"kept-run","operationId":"keep-run"
            }),
        )
        .unwrap();
        let value = recent(&db, &project, &root);
        let run = &value["runs"][0];
        assert_eq!(run["kept"]["commandId"], kept["id"]);
        // A run id from another project changes nothing.
        save_value(
            &db,
            &json!({
                "projectId":project,"name":"Second","command":"node second.mjs","shell":"cmd","cwd":"",
                "kind":"service","env":[],"runId":"absent-run","operationId":"keep-absent"
            }),
        )
        .unwrap();
        assert_eq!(
            recent(&db, &project, &root)["runs"][0]["kept"]["commandId"],
            kept["id"]
        );
        // Deleting the session deletes the row: the view says nothing about it any more.
        db.transaction(|tx| {
            tx.execute("DELETE FROM sessions WHERE id='kept-run'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(recent(&db, &project, &root)["runs"], json!([]));
    }

    #[test]
    fn a_service_and_a_task_report_the_state_the_run_view_shows() {
        let (_dir, db, project, root) = fixture();
        let service = command(&db, &project, "server", "service");
        let task = command(&db, &project, "build", "task");
        let root_key = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let now = Utc::now().to_rfc3339();
        insert_run(
            &db, &project, &root_key, &service, "waiting", "running", &now, None,
        );
        db.transaction(|tx| {
            tx.execute(
                "UPDATE quick_launch_runs SET readiness='waiting' WHERE session_id='waiting'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        insert_run(
            &db, &project, &root_key, &task, "done", "exited", &now, None,
        );
        db.set_session_status("done", "exited", Some(0)).unwrap();
        insert_run(
            &db, &project, &root_key, &task, "broken", "exited", &now, None,
        );
        db.set_session_status("broken", "exited", Some(2)).unwrap();
        insert_run(
            &db,
            &project,
            &root_key,
            &service,
            "interrupted",
            "interrupted",
            &now,
            None,
        );
        let value = recent(&db, &project, &root);
        let runs = value["runs"].as_array().unwrap();
        let state = |id: &str| {
            runs.iter().find(|run| run["runId"] == id).unwrap()["state"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(state("waiting"), "starting");
        assert_eq!(state("done"), "completed");
        assert_eq!(state("broken"), "failed");
        assert_eq!(state("interrupted"), "interrupted");
    }

    #[test]
    fn recent_requires_a_project_and_a_registered_worktree_root() {
        let (_dir, db, project, root) = fixture();
        for params in [
            json!({"cwd":root.to_string_lossy()}),
            json!({"projectId":project,"cwd":""}),
            json!({"projectId":project,"cwd":root.to_string_lossy(),"extra":1}),
        ] {
            assert!(validate(&params).is_err(), "{params}");
        }
        assert!(dispatch(
            &db,
            &json!({"projectId":project,"cwd":_dir.path().join("outside").to_string_lossy()})
        )
        .is_err());
        assert_eq!(recent(&db, &project, &root)["runs"], json!([]));
    }
}
