//! Saved-command dependency graph validation without launching any terminals.
use super::*;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

fn database() -> (tempfile::TempDir, Arc<Database>) {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    crate::workspace_services::initialize(&db).unwrap();
    crate::session_configs::initialize(&db).unwrap();
    crate::retry_scheduler::initialize(&db).unwrap();
    (root, db)
}

fn project(db: &Database, root: &Path, operation: &str) -> String {
    db.add_project(&root.to_string_lossy(), Some("Dependency graph"), operation).unwrap().id
}

fn save(db: &Arc<Database>, project_id: &str, name: &str, depends_on: &[&str], operation: &str) -> Result<Value> {
    dispatch(
        db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.save",
        &json!({"projectId":project_id,"name":name,"command":"echo ready","shell":"cmd","cwd":"","kind":"service","env":[],"dependsOn":depends_on,"operationId":operation}),
    )
}

fn update(db: &Arc<Database>, project_id: &str, command: &Value, depends_on: &[&str], operation: &str) -> Result<Value> {
    dispatch(
        db,
        &PtyManager::new(Arc::new(crate::output::OutputStore::default())),
        "quickLaunch.save",
        &json!({"projectId":project_id,"id":command["id"],"expectedRevision":command["revision"],"name":command["name"],"command":"echo ready","shell":"cmd","cwd":"","kind":"service","env":[],"dependsOn":depends_on,"operationId":operation}),
    )
}

#[test]
fn saved_dependencies_keep_their_requested_order() {
    let (root, db) = database();
    let project_id = project(&db, root.path(), "depends-order-project");
    let db_command = save(&db, &project_id, "db", &[], "depends-order-db").unwrap();
    let api = save(&db, &project_id, "api", &[], "depends-order-api").unwrap();
    let web = save(&db, &project_id, "web", &[db_command["id"].as_str().unwrap(), api["id"].as_str().unwrap()], "depends-order-web").unwrap();
    assert_eq!(web["dependsOn"], json!([db_command["id"],api["id"]]));
}

#[test]
fn dependency_graph_rejects_self_nested_cycle_and_cross_project_edges() {
    let (root, db) = database();
    let one = project(&db, root.path(), "depends-one");
    let other_root = tempfile::tempdir().unwrap();
    let two = project(&db, other_root.path(), "depends-two");
    let a = save(&db, &one, "a", &[], "depends-a").unwrap();
    let b = save(&db, &one, "b", &[], "depends-b").unwrap();
    let foreign = save(&db, &two, "foreign", &[], "depends-foreign").unwrap();
    assert_eq!(update(&db, &one, &a, &[a["id"].as_str().unwrap()], "depends-self").unwrap_err().to_string(), "invalid_depends_on");
    let a = update(&db, &one, &a, &[b["id"].as_str().unwrap()], "depends-a-b").unwrap();
    assert_eq!(update(&db, &one, &b, &[a["id"].as_str().unwrap()], "depends-cycle").unwrap_err().to_string(), "invalid_depends_on");
    assert_eq!(save(&db, &one, "cross", &[foreign["id"].as_str().unwrap()], "depends-cross").unwrap_err().to_string(), "invalid_depends_on");
    assert_eq!(save(&db, &one, "nested", &[a["id"].as_str().unwrap()], "depends-nested").unwrap_err().to_string(), "nested_depends_on");
}

#[test]
fn dependency_graph_caps_saved_edges_at_eight() {
    let (root, db) = database();
    let project_id = project(&db, root.path(), "depends-cap");
    let ids = (0..9).map(|index| save(&db, &project_id, &format!("dependency-{index}"), &[], &format!("depends-cap-{index}")).unwrap()["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(save(&db, &project_id, "target", &ids.iter().map(String::as_str).collect::<Vec<_>>(), "depends-cap-target").unwrap_err().to_string(), "invalid_request");
}

#[test]
fn referenced_command_deletion_names_dependents_until_their_edges_are_removed() {
    let (root,db) = database();
    let project_id = project(&db,root.path(),"delete-reference-project");
    let dependency = save(&db,&project_id,"Database",&[],"delete-reference-db").unwrap();
    let dependent = save(&db,&project_id,"API",&[dependency["id"].as_str().unwrap()],"delete-reference-api").unwrap();
    let pty = PtyManager::new(Arc::new(crate::output::OutputStore::default()));
    let params = json!({"id":dependency["id"],"expectedRevision":1,"operationId":"delete-reference-attempt"});
    assert_eq!(dispatch(&db,&pty,"quickLaunch.delete",&params).unwrap_err().to_string(),"command_has_dependents: API");
    assert!(read_command(&db,dependency["id"].as_str().unwrap()).is_ok());
    assert!(db.operation("delete-reference-attempt").unwrap().is_none());
    update(&db,&project_id,&dependent,&[],"delete-reference-repair").unwrap();
    dispatch(&db,&pty,"quickLaunch.delete",&params).unwrap();
    assert_eq!(read_command(&db,dependency["id"].as_str().unwrap()).unwrap_err().to_string(),"command_not_found");
}
