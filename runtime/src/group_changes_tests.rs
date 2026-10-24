use super::*;

fn tool(fixture: &Fixture, sent: &Sent, id: &str, name: &str, data: Value) {
    fixture.db.record_provider_event(&sent.session,Some(&sent.turn),"chat.item",&json!({"merge":true,"part":{"type":"tool","toolId":id,"toolName":name,"status":"completed","data":data}})).unwrap();
}
fn replies(fixture: &Fixture, id: &str) -> Vec<Value> {
    fixture.read(id)["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["author"] == "member")
        .cloned()
        .collect()
}
fn done(fixture: &Fixture) {
    wait_for(|| {
        fixture
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM group_jobs WHERE state!='done'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .unwrap()
            == 0
    });
}

#[test]
fn opaque_shell_add_modify_delete_are_found_from_git_folder() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fs::write(fixture.repo.join("remove.txt"), "remove").unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"opaque writer","to":["all"],"operationId":"opaque"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fs::write(fixture.repo.join("made.txt"), "made").unwrap();
    fs::write(fixture.repo.join("base.txt"), "modified").unwrap();
    fs::remove_file(fixture.repo.join("remove.txt")).unwrap();
    tool(
        &fixture,
        &sent,
        "shell",
        "commandExecution",
        json!({"command":"python gen.py","exitCode":0}),
    );
    fixture.complete(&sent, "Done.");
    done(&fixture);
    let output = replies(&fixture, id)[0]["outputs"].clone();
    assert_eq!(
        output["changed"],
        json!(["base.txt", "made.txt", "remove.txt"])
    );
    assert_eq!(
        output["changedDetails"],
        json!([
            {"path":"base.txt","status":"modified","evidence":"folder"},
            {"path":"made.txt","status":"added","evidence":"folder"},
            {"path":"remove.txt","status":"deleted","evidence":"folder"}
        ])
    );
}

#[test]
fn completed_concurrent_shell_turns_reconcile_both_replies() {
    let fixture = Fixture::new();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"parallel","to":["all"],"operationId":"parallel"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    let sent = fixture.script.lock().unwrap().sent.clone();
    for (i, turn) in sent.iter().enumerate() {
        tool(
            &fixture,
            turn,
            &format!("shell-{i}"),
            "commandExecution",
            json!({"command":"python gen.py","exitCode":0}),
        );
    }
    fs::write(fixture.repo.join("shared.txt"), "shared").unwrap();
    fixture.complete(&sent[0], "First done.");
    done(&fixture);
    fixture.complete(&sent[1], "Second done.");
    done(&fixture);
    for reply in replies(&fixture, id) {
        assert_eq!(reply["outputs"]["changed"], json!([]));
        assert_eq!(reply["outputs"]["possiblyChanged"], json!(["shared.txt"]));
    }
}

#[test]
fn non_git_powershell_variable_gets_confirmed_folder_evidence() {
    let fixture = Fixture::new();
    fs::remove_dir_all(fixture.repo.join(".git")).unwrap();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    assert_eq!(group["filesCheck"]["state"], "on");
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"variable writer","to":["all"],"operationId":"variable"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fs::write(fixture.repo.join("page.html"), "<main>done</main>").unwrap();
    tool(
        &fixture,
        &sent,
        "shell",
        "commandExecution",
        json!({"command":"$p = 'page.html'; Set-Content -Path $p -Value '<main>done</main>'","exitCode":0}),
    );
    fixture.complete(&sent, "Saved page.html");
    done(&fixture);
    let output = replies(&fixture, id)[0]["outputs"].clone();
    assert_eq!(output["changed"], json!(["page.html"]));
    assert_eq!(
        output["changedDetails"],
        json!([{"path":"page.html","status":"added","evidence":"folder"}])
    );
}

#[test]
fn reused_case_folder_reports_modified_while_a_fresh_page_is_added() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.repo.join("pages/codex")).unwrap();
    // The former live harness reused the file made by its preceding non-Git case.
    fs::write(fixture.repo.join("pages/codex/index.html"), "previous case").unwrap();
    let group = fixture.create(2);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"create own page","to":["all"],"operationId":"fresh-pages"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 2);
    let sent = fixture.script.lock().unwrap().sent.clone();
    for (index, path) in ["pages/codex/index.html", "pages/claude/index.html"]
        .iter()
        .enumerate()
    {
        fs::create_dir_all(fixture.repo.join(path).parent().unwrap()).unwrap();
        fs::write(fixture.repo.join(path), "new page").unwrap();
        tool(
            &fixture,
            &sent[index],
            &format!("write-{index}"),
            "commandExecution",
            json!({"command":format!("$p = '{path}'; Set-Content -Path $p -Value 'new page'"),"exitCode":0}),
        );
    }
    for turn in &sent {
        fixture.complete(turn, "Created my page.");
    }
    done(&fixture);
    let outputs = replies(&fixture, id);
    for (index, expected) in ["modified", "added"].iter().enumerate() {
        let reply = outputs
            .iter()
            .find(|reply| reply["sessionId"] == sent[index].session)
            .unwrap();
        assert_eq!(reply["outputs"]["changedDetails"][0]["status"], *expected);
        assert_eq!(reply["outputs"]["changed"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn threadterm_editor_saves_stay_possible_instead_of_members_own_changes() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"work","to":["all"],"operationId":"work"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fs::write(fixture.repo.join("base.txt"), "user saved").unwrap();
    fixture
        .db
        .transaction(|tx| {
            crate::group_chat::editor_saved(tx, &group["cwd"].as_str().unwrap(), "base.txt")
        })
        .unwrap();
    tool(
        &fixture,
        &sent,
        "shell",
        "commandExecution",
        json!({"command":"python inspect.py","exitCode":0}),
    );
    fixture.complete(&sent, "Done.");
    done(&fixture);
    let output = replies(&fixture, id)[0]["outputs"].clone();
    assert_eq!(output["changed"], json!([]));
    assert_eq!(output["possiblyChanged"], json!(["base.txt"]));
    assert_eq!(output["possiblyChangedWith"], json!(["you"]));
}

#[test]
fn complete_chat_review_pair_is_reused_and_rebased_to_group_folder() {
    let fixture = Fixture::new();
    crate::review::initialize(&fixture.db).unwrap();
    let session = fixture.standalone_chat("review pair");
    let session = session["id"].as_str().unwrap();
    fs::create_dir(fixture.repo.join("nested")).unwrap();
    let checkpoint =
        crate::review::capture_before_turn(&fixture.db, session, "review-before", "write").unwrap();
    crate::review::attach_turn(&fixture.db, &checkpoint, Some("review-turn"));
    fs::write(fixture.repo.join("nested/page.html"), "<main>page</main>").unwrap();
    fs::write(fixture.repo.join("outside.txt"), "outside group folder").unwrap();
    crate::review::capture_after_turn(&fixture.db, session, "review-turn").unwrap();
    fs::write(
        fixture.repo.join("nested/later.txt"),
        "after immutable pair",
    )
    .unwrap();
    let changes = crate::review::completed_group_turn_changes(
        &fixture.db,
        session,
        "review-turn",
        &fixture.repo.join("nested").to_string_lossy(),
    )
    .unwrap();
    assert_eq!(
        changes,
        vec![json!({"path":"page.html","status":"added","evidence":"folder"})]
    );
}

#[test]
fn failed_send_closes_the_window_and_discards_its_baseline() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"fail send","to":["all"],"operationId":"fail-send"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fixture.db.transaction(|tx|{
        let queue:String=tx.query_row("SELECT queue_id FROM group_deliveries WHERE session_id=?",[&sent.session],|row|row.get(0))?;
        group_chat::send_failed(tx,&sent.session,&queue,"failed transport")?;
        let finished:bool=tx.query_row("SELECT ended_at IS NOT NULL AND compared_at IS NOT NULL AND before_json IS NULL FROM group_change_turns WHERE session_id=?",[&sent.session],|row|row.get(0))?;
        assert!(finished);Ok(())
    }).unwrap();
}

#[test]
fn retention_invalidation_keeps_only_claims_and_does_not_recreate_folder_evidence() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"write files","to":["all"],"operationId":"invalidated-context"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE group_change_turns SET before_json=? WHERE session_id=?",
                params![r#"{"attributionIncomplete":true}"#, sent.session],
            )?;
            Ok(())
        })
        .unwrap();
    fs::write(fixture.repo.join("own.txt"), "own").unwrap();
    fs::write(fixture.repo.join("unclaimed.txt"), "other").unwrap();
    tool(
        &fixture,
        &sent,
        "own-edit",
        "Write",
        json!({"path":"own.txt"}),
    );
    fixture.complete(&sent, "Done.");
    done(&fixture);
    let output = replies(&fixture, id)[0]["outputs"].clone();
    assert_eq!(output["changed"], json!(["own.txt"]));
    assert_eq!(
        output["changedDetails"],
        json!([{"path":"own.txt","status":"changed","evidence":"tool"}])
    );
    assert_eq!(output["changedIncomplete"], true);
    fixture
        .db
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM group_change_turns", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM group_editor_saves", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn the_next_delivery_prunes_failed_send_context_without_needing_a_completion() {
    let fixture = Fixture::new();
    let group = fixture.create(1);
    let id = group["id"].as_str().unwrap();
    fixture.db.transaction(|tx| {
        tx.execute("INSERT INTO group_change_turns(id,delivery_id,group_id,session_id,cwd,handle,read_only,started_at,ended_at,compared_at) VALUES('failed-context','failed',?,'old-session',?,'member',0,'01','02','02')", params![id,group["cwd"].as_str().unwrap()])?;
        Ok(())
    }).unwrap();
    fixture.dispatch(
        "group.send",
        json!({"id":id,"text":"next delivery","to":["all"],"operationId":"prune-failed-context"}),
    );
    wait_for(|| fixture.script.lock().unwrap().sent.len() == 1);
    fixture
        .db
        .transaction(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM group_change_turns WHERE id='failed-context'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    let sent = fixture.script.lock().unwrap().sent[0].clone();
    fixture.complete(&sent, "Done.");
    done(&fixture);
}
