use super::*;
use rusqlite::Connection;

#[test]
fn existing_setup_rows_migrate_before_sequence_indexes_are_created() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE projects(id TEXT PRIMARY KEY);
         CREATE TABLE sessions(id TEXT PRIMARY KEY);
         CREATE TABLE operations(id TEXT PRIMARY KEY,method TEXT,result TEXT);
         CREATE TABLE operation_requests(id TEXT PRIMARY KEY,method TEXT,params TEXT);
         CREATE TABLE quick_launch_setup_runs (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root TEXT NOT NULL,
           command_ids_json TEXT NOT NULL, names_json TEXT NOT NULL, snapshots_json TEXT NOT NULL,
           step INTEGER NOT NULL, state TEXT NOT NULL, session_ids_json TEXT NOT NULL,
           exit_code INTEGER, trigger TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE UNIQUE INDEX quick_launch_setup_active ON quick_launch_setup_runs(project_id,root) WHERE state='running';
         INSERT INTO quick_launch_setup_runs VALUES('old','project','root','[]','[]','[]',0,'completed','[]',0,'manual','then','then');"
    ).unwrap();
    initialize_connection(&conn).unwrap();
    initialize_connection(&conn).unwrap();
    let row: (String, Option<String>, Option<String>) = conn.query_row(
        "SELECT state,target_command_id,started_by FROM quick_launch_setup_runs WHERE id='old'", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(row, ("completed".into(), None, None));
}

fn command(id: &str) -> QuickLaunchCommand {
    QuickLaunchCommand {
        id: id.into(),
        project_id: "project".into(),
        revision: 1,
        name: id.into(),
        command: "node app --port ${port}".into(),
        shell: "cmd".into(),
        cwd: String::new(),
        kind: "service".into(),
        env: vec![EnvVar { name: "PORT".into(), value: "${port}".into() }],
        depends_on: Vec::new(),
        preview_url: Some("http://localhost:${port}/".into()),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn port_resolution_keeps_the_template_and_detected_entries_untouched() {
    let saved = command("saved");
    let resolved = resolve_port(&saved, Some(43210)).unwrap();
    assert_eq!(resolved.command, "node app --port 43210");
    assert_eq!(resolved.env[0].value, "43210");
    assert_eq!(resolved.preview_url.as_deref(), Some("http://localhost:43210/"));
    assert!(saved.command.contains("${port}"));

    let repo = command("repo:api");
    assert!(!saved_port_template(&repo));
    assert_eq!(resolve_port(&repo, None).unwrap(), repo);

    let mut private = saved.clone();
    private.env.push(EnvVar { name: "TOKEN".into(), value: "\0threadterm-local-secret".into() });
    // Only the runtime-owned exact reference is accepted by template resolution.
    let resolved = resolve_port(&private, Some(43210)).unwrap();
    assert_eq!(resolved.env[1], private.env[1]);

    let mut detected = command("detected:node:dev");
    assert!(!saved_port_template(&detected));
    assert_eq!(resolve_port(&detected, None).unwrap(), detected);
    detected.env[0].value = "x".repeat(8_193);
    assert_eq!(resolve_port(&detected, Some(43210)).unwrap_err().to_string(), "invalid_command");
}

#[test]
fn allocated_port_ignores_other_listeners_until_its_own_port_listens() {
    assert!(readiness::candidate_ports(Some(41000), &[41001]).is_empty());
    assert_eq!(readiness::candidate_ports(Some(41000), &[41001, 41000]), vec![41000]);
    assert_eq!(readiness::candidate_ports(None, &[41001]), vec![41001]);
}

fn dependency_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE quick_launch_commands(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,depends_on_json TEXT NOT NULL);
         INSERT INTO quick_launch_commands VALUES
           ('a','project','[]'),('b','project','[]'),('nested','project','[\"a\"]'),('other','elsewhere','[]');",
    ).unwrap();
    conn
}

#[test]
fn depends_on_rejects_cap_self_cross_project_nested_and_cycle() {
    let mut conn = dependency_db();
    let tx = conn.transaction().unwrap();
    assert_eq!(validate_depends_on(&tx, "project", Some("a"), &["a".into()]).unwrap_err().to_string(), "invalid_depends_on");
    assert_eq!(validate_depends_on(&tx, "project", Some("a"), &["other".into()]).unwrap_err().to_string(), "invalid_depends_on");
    assert_eq!(validate_depends_on(&tx, "project", Some("b"), &["nested".into()]).unwrap_err().to_string(), "nested_depends_on");
    tx.execute("UPDATE quick_launch_commands SET depends_on_json='[\"a\"]' WHERE id='b'", []).unwrap();
    assert_eq!(validate_depends_on(&tx, "project", Some("a"), &["b".into()]).unwrap_err().to_string(), "invalid_depends_on");
    let too_many = (0..9).map(|index| format!("id-{index}")).collect::<Vec<_>>();
    assert!(!valid_depends_on(&too_many));
}
