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
        .add_project(
            &root.to_string_lossy(),
            Some("Proposals"),
            "proposal-project",
        )
        .unwrap()
        .id;
    (dir, db, project, root)
}

fn root_key(root: &std::path::Path) -> String {
    root.canonicalize().unwrap().to_string_lossy().into_owned()
}

fn register_worktree(db: &Database, project: &str, id: &str, root: &std::path::Path) {
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES(?,?,?,'test','head',0,0)",
            params![id, project, root.to_string_lossy()],
        )?;
        Ok(())
    })
    .unwrap();
}

fn input(request_id: &str) -> Value {
    json!({
        "name":"Suggested server","command":"node server.mjs","reason":"Start the local API",
        "shell":"cmd","cwd":"","kind":"service","env":[],"requestId":request_id
    })
}

fn suggest(
    db: &Database,
    project: &str,
    root: &std::path::Path,
    session: &str,
    request_id: &str,
) -> Value {
    propose(db, session, project, &root_key(root), &input(request_id)).unwrap()
}

fn save(db: &Database, project: &str, operation_id: &str) -> Value {
    save_value(
        db,
        &json!({
            "projectId":project,"name":"Current server","command":"node current.mjs","shell":"cmd",
            "cwd":"","kind":"service","env":[{"name":"PORT","value":"3000"}],
            "previewUrl":"http://localhost:3000","operationId":operation_id
        }),
    )
    .unwrap()
}

fn proposal_effect_counts(db: &Database) -> (i64, i64, i64) {
    db.transaction(|tx| {
        Ok((
            tx.query_row("SELECT COUNT(*) FROM run_proposals", [], |r| r.get(0))?,
            tx.query_row(
                "SELECT COUNT(*) FROM operations WHERE method='chat.tool.run.propose'",
                [],
                |r| r.get(0),
            )?,
            tx.query_row("SELECT COUNT(*) FROM quick_launch_runs", [], |r| r.get(0))?,
        ))
    })
    .unwrap()
}

#[test]
fn propose_uses_the_same_command_invariants_and_bounds_as_save() {
    let (_dir, db, project, root) = fixture();
    let cases = [
        (
            "empty name",
            json!({"name":"","command":"node app.mjs","reason":"why","requestId":"one"}),
            "invalid_request",
        ),
        (
            "cmd newline",
            json!({"name":"Name","command":"node app.mjs\nwhoami","reason":"why","requestId":"two"}),
            "detected_command_unprintable",
        ),
        (
            "bad cwd",
            json!({"name":"Name","command":"node app.mjs","reason":"why","cwd":"../outside","requestId":"three"}),
            "invalid_request",
        ),
        (
            "long reason",
            json!({"name":"Name","command":"node app.mjs","reason":"x".repeat(2001),"requestId":"four"}),
            "invalid_request",
        ),
    ];
    for (label, value, expected) in cases {
        assert_eq!(
            propose(&db, "chat", &project, &root_key(&root), &value)
                .unwrap_err()
                .to_string(),
            expected,
            "{label}"
        );
    }
    let mut duplicate_env = input("duplicate-env");
    duplicate_env["env"] = json!([
        {"name":"Path","value":"one"},
        {"name":"PATH","value":"two"},
    ]);
    assert!(propose(&db, "chat", &project, &root_key(&root), &duplicate_env).is_err());
    let mut unknown = input("unknown");
    unknown["unexpected"] = json!(true);
    assert!(propose(&db, "chat", &project, &root_key(&root), &unknown).is_err());
    for field in ["id", "cwd", "shell", "kind", "env", "previewUrl"] {
        let mut null = input(&format!("null-{field}"));
        null[field] = Value::Null;
        assert_eq!(
            propose(&db, "chat", &project, &root_key(&root), &null)
                .unwrap_err()
                .to_string(),
            "invalid_request",
            "{field} must be omitted rather than null"
        );
    }
}

#[test]
fn propose_rejects_unprintable_text_in_every_reviewed_field_before_any_effect() {
    let (_dir, db, project, root) = fixture();
    let root = root_key(&root);
    for field in [
        "name",
        "command",
        "reason",
        "shell",
        "cwd",
        "kind",
        "previewUrl",
    ] {
        let mut value = input(&format!("format-{field}"));
        value[field] = json!(format!("safe\u{200B}{field}"));
        assert_eq!(
            propose(&db, "chat", &project, &root, &value)
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable",
            "format character in {field}",
        );
        assert_eq!(
            proposal_effect_counts(&db),
            (0, 0, 0),
            "{field} creates no proposal, receipt, or run"
        );
    }
    for (field, character) in [
        ("command", '\u{001B}'),
        ("reason", '\u{2028}'),
        ("name", '\u{2029}'),
    ] {
        let mut value = input(&format!("control-{field}"));
        value[field] = json!(format!("safe{character}text"));
        assert_eq!(
            propose(&db, "chat", &project, &root, &value)
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable",
            "unprintable character in {field}",
        );
        assert_eq!(proposal_effect_counts(&db), (0, 0, 0));
    }
    for (field, item_key) in [("env-name", "name"), ("env-value", "value")] {
        let mut value = input(&format!("{field}-format"));
        value["env"] = if item_key == "name" {
            json!([{"name":format!("safe\u{200B}{field}"),"value":"safe"}])
        } else {
            json!([{"name":"SAFE","value":format!("safe\u{200B}{field}")}])
        };
        assert_eq!(
            propose(&db, "chat", &project, &root, &value)
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable",
            "format character in {field}",
        );
        assert_eq!(proposal_effect_counts(&db), (0, 0, 0));
    }
}

#[test]
fn propose_preserves_powershell_crlf_but_rejects_multiline_cmd_and_other_fields() {
    let (_dir, db, project, root) = fixture();
    let root = root_key(&root);
    let mut powershell = input("powershell-crlf");
    powershell["shell"] = json!("powershell");
    powershell["command"] = json!("Write-Host one\r\nWrite-Host two");
    let pending = propose(&db, "chat", &project, &root, &powershell).unwrap();
    let row = db
        .transaction(|tx| read(tx, pending["proposalId"].as_str().unwrap()))
        .unwrap();
    assert_eq!(
        row["command"], powershell["command"],
        "CRLF bytes survive review storage"
    );
    let effects_after_powershell = proposal_effect_counts(&db);

    let mut cmd = input("cmd-crlf");
    cmd["command"] = json!("echo one\r\necho two");
    assert_eq!(
        propose(&db, "chat", &project, &root, &cmd)
            .unwrap_err()
            .to_string(),
        "detected_command_unprintable"
    );
    assert_eq!(proposal_effect_counts(&db), effects_after_powershell);
    let mut reason = input("reason-crlf");
    reason["reason"] = json!("safe\r\ntext");
    assert_eq!(
        propose(&db, "chat", &project, &root, &reason)
            .unwrap_err()
            .to_string(),
        "detected_command_unprintable"
    );
    assert_eq!(proposal_effect_counts(&db), effects_after_powershell);
}

#[test]
fn propose_rejects_unprintable_inherited_target_fields_before_a_pending_row_or_receipt() {
    for (column, value) in [
        ("cwd", "safe\u{200B}"),
        ("shell", "cmd\u{200B}"),
        ("kind", "service\u{200B}"),
        ("preview_url", "http://local\u{200B}host"),
    ] {
        let (_dir, db, project, root) = fixture();
        let target = save(&db, &project, &format!("target-{column}"));
        db.transaction(|tx| {
            tx.execute(
                &format!("UPDATE quick_launch_commands SET {column}=? WHERE id=?"),
                params![value, target["id"].as_str().unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
        let mut update = input(&format!("inherit-{column}"));
        update["id"] = target["id"].clone();
        update.as_object_mut().unwrap().remove(match column {
            "preview_url" => "previewUrl",
            value => value,
        });
        assert_eq!(
            propose(&db, "chat", &project, &root_key(&root), &update)
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable",
            "{column}"
        );
        assert_eq!(
            proposal_effect_counts(&db),
            (0, 0, 0),
            "{column} creates no proposal, receipt, or run"
        );
    }
    let (_dir, db, project, root) = fixture();
    let target = save(&db, &project, "target-env");
    db.transaction(|tx| {
        tx.execute(
            "UPDATE quick_launch_commands SET env_json=? WHERE id=?",
            params![
                r#"[{"name":"SAFE","value":"value\u200B"}]"#,
                target["id"].as_str().unwrap()
            ],
        )?;
        Ok(())
    })
    .unwrap();
    let mut update = input("inherit-env");
    update["id"] = target["id"].clone();
    update.as_object_mut().unwrap().remove("env");
    assert_eq!(
        propose(&db, "chat", &project, &root_key(&root), &update)
            .unwrap_err()
            .to_string(),
        "detected_command_unprintable"
    );
    assert_eq!(proposal_effect_counts(&db), (0, 0, 0));
}

#[test]
fn pending_cap_is_project_wide_across_worktrees() {
    let (dir, db, project, root) = fixture();
    let other = dir.path().join("other-worktree");
    std::fs::create_dir_all(&other).unwrap();
    let first_root = root_key(&root);
    let other_root = root_key(&other);
    for index in 0..20 {
        let root = if index % 2 == 0 {
            &first_root
        } else {
            &other_root
        };
        let mut proposal = input(&format!("request-{index}"));
        proposal["name"] = json!(format!("Suggestion {index}"));
        let result = propose(&db, "same-chat", &project, root, &proposal).unwrap();
        assert_eq!(result["state"], "pending");
    }
    assert_eq!(
        propose(&db, "overflow", &project, &first_root, &input("overflow"))
            .unwrap_err()
            .to_string(),
        "too_many_proposals"
    );
}

#[test]
fn a_newer_proposal_supersedes_and_old_pending_proposals_expire_with_worktree_scope() {
    let (dir, db, project, root) = fixture();
    let other = dir.path().join("other-worktree");
    std::fs::create_dir_all(&other).unwrap();
    register_worktree(&db, &project, "other-worktree", &other);
    let target = save(&db, &project, "save-target");
    let mut first_input = input("first");
    first_input["id"] = target["id"].clone();
    let first = propose(&db, "chat", &project, &root_key(&root), &first_input).unwrap();
    first_input["requestId"] = json!("second");
    let second = propose(&db, "chat", &project, &root_key(&root), &first_input).unwrap();
    assert_ne!(first["proposalId"], second["proposalId"]);
    let root_value = root_key(&root);
    let first_state = db
        .transaction(|tx| Ok(read(tx, first["proposalId"].as_str().unwrap())?["state"].clone()))
        .unwrap();
    assert_eq!(first_state, "superseded");
    let scoped = list(
        &db,
        &json!({"projectId":project,"cwd":root.to_string_lossy()}),
    )
    .unwrap();
    assert_eq!(scoped["pending"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["pending"][0]["id"], second["proposalId"]);
    assert_eq!(scoped["pending"][0]["root"], root_value);
    assert!(list(
        &db,
        &json!({"projectId":project,"cwd":other.to_string_lossy()})
    )
    .unwrap()["pending"]
        .as_array()
        .unwrap()
        .is_empty());
    db.transaction(|tx| {
        tx.execute(
            "UPDATE run_proposals SET created_at=? WHERE id=?",
            params![
                (Utc::now() - ChronoDuration::days(8)).to_rfc3339(),
                second["proposalId"].as_str().unwrap()
            ],
        )?;
        Ok(())
    })
    .unwrap();
    let expired = list(
        &db,
        &json!({"projectId":project,"cwd":root.to_string_lossy()}),
    )
    .unwrap();
    assert!(expired["pending"].as_array().unwrap().is_empty());
    assert_eq!(expired["decided"][0]["id"], second["proposalId"]);
    assert_eq!(expired["decided"][0]["state"], "expired");
}

#[test]
fn accept_creates_a_command_and_applies_human_edits_with_a_replay_receipt() {
    let (_dir, db, project, root) = fixture();
    let proposed = suggest(&db, &project, &root, "chat", "create");
    let accept_value = json!({
        "proposalId":proposed["proposalId"],"operationId":"accept-create",
        "edits":{"name":"Human server","command":"node human.mjs","kind":"task",
            "env":[{"name":"PORT","value":"4100"}],"previewUrl":""}
    });
    let accepted = accept(&db, &accept_value).unwrap();
    assert_eq!(accepted["name"], "Human server");
    assert_eq!(accepted["command"], "node human.mjs");
    assert_eq!(accepted["kind"], "task");
    assert_eq!(accepted["env"], json!([{"name":"PORT","value":"4100"}]));
    assert!(
        accepted.get("previewUrl").is_none(),
        "an empty human edit clears the URL"
    );
    assert_eq!(
        accept(&db, &accept_value).unwrap(),
        accepted,
        "accept is idempotent"
    );
    let proposal = db
        .transaction(|tx| read(tx, proposed["proposalId"].as_str().unwrap()))
        .unwrap();
    assert_eq!(proposal["state"], "accepted");
    assert_eq!(proposal["decidedCommandId"], accepted["id"]);
}

#[test]
fn accept_updates_at_the_proposed_revision_and_stale_or_rejected_proposals_never_change_a_command()
{
    let (dir, db, project, root) = fixture();
    let original = save(&db, &project, "save-original");
    let mut update = input("update");
    update["id"] = original["id"].clone();
    update["name"] = json!("Agent update");
    update["command"] = json!("node proposed.mjs");
    update.as_object_mut().unwrap().remove("env");
    let proposed = propose(&db, "chat", &project, &root_key(&root), &update).unwrap();
    let accepted = accept(
        &db,
        &json!({"proposalId":proposed["proposalId"],"operationId":"accept-update"}),
    )
    .unwrap();
    assert_eq!(accepted["id"], original["id"]);
    assert_eq!(accepted["revision"], 2);
    assert_eq!(accepted["command"], "node proposed.mjs");
    assert_eq!(
        accepted["env"],
        json!([{"name":"PORT","value":"3000"}]),
        "an update omitting env keeps its target value"
    );
    assert_eq!(
        accepted["previewUrl"], "http://localhost:3000",
        "an update omitting previewUrl keeps its target value"
    );

    let mut stale = input("stale");
    stale["id"] = accepted["id"].clone();
    stale["command"] = json!("node stale.mjs");
    let stale_proposal = propose(&db, "chat", &project, &root_key(&root), &stale).unwrap();
    let current = save_value(
        &db,
        &json!({
            "projectId":project,"id":accepted["id"],"expectedRevision":2,"name":"Human current",
            "command":"node current.mjs","shell":"cmd","cwd":"","kind":"service","env":[],"operationId":"human-change"
        }),
    ).unwrap();
    assert_eq!(current["revision"], 3);
    assert_eq!(
        accept(
            &db,
            &json!({"proposalId":stale_proposal["proposalId"],"operationId":"accept-stale"})
        )
        .unwrap_err()
        .to_string(),
        "revision_conflict"
    );
    assert_eq!(
        saved_commands(&db, &project)
            .unwrap()
            .into_iter()
            .find(|command| command.id == accepted["id"])
            .unwrap()
            .command,
        "node current.mjs"
    );

    let rejected = suggest(&db, &project, &root, "other-chat", "reject");
    assert_eq!(
        reject(
            &db,
            &json!({"proposalId":rejected["proposalId"],"operationId":"human-reject"})
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        reject(
            &db,
            &json!({"proposalId":rejected["proposalId"],"operationId":"human-reject"})
        )
        .unwrap(),
        Value::Null,
        "reject is idempotent"
    );
    let rejected_row = db
        .transaction(|tx| read(tx, rejected["proposalId"].as_str().unwrap()))
        .unwrap();
    assert_eq!(rejected_row["state"], "rejected");

    let other_root = dir.path().join("other-project");
    std::fs::create_dir_all(&other_root).unwrap();
    let other_project = db
        .add_project(
            &other_root.to_string_lossy(),
            Some("Other"),
            "other-project",
        )
        .unwrap()
        .id;
    let mut foreign_target = input("foreign-target");
    foreign_target["id"] = accepted["id"].clone();
    assert_eq!(
        propose(
            &db,
            "other-chat",
            &other_project,
            &root_key(&other_root),
            &foreign_target
        )
        .unwrap_err()
        .to_string(),
        "run_not_found"
    );
}

#[test]
fn proposal_identifiers_cannot_hide_format_characters() {
    let (_dir, db, project, root) = fixture();
    for field in ["requestId", "id"] {
        let mut value = input("identity");
        value[field] = json!("identity\u{200b}");
        assert_eq!(
            propose(&db, "chat", &project, &root_key(&root), &value)
                .unwrap_err()
                .to_string(),
            "detected_command_unprintable"
        );
    }
}
