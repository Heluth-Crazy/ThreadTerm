//! Persisted, revision-fenced launch specifications for explicit session reruns.
use crate::db::Database;
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

const MAX_ARGS: usize = 256;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub provider: String,
    pub mode: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub session_id: String,
    pub revision: i64,
    #[serde(flatten)]
    pub launch: LaunchSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
}

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS session_launch_configs (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, cwd TEXT NOT NULL, project_id TEXT, title TEXT, executable TEXT, args_json TEXT NOT NULL, source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL);")?;
        Ok(())
    })
}

pub fn save_new(
    db: &Database,
    session_id: &str,
    launch: &LaunchSpec,
    source_session_id: Option<&str>,
) -> Result<SessionConfig> {
    validate(launch)?;
    db.transaction(|tx| {
        let config = SessionConfig { session_id: session_id.to_owned(), revision: 1, launch: launch.clone(), source_session_id: source_session_id.map(str::to_owned) };
        tx.execute("INSERT INTO session_launch_configs(session_id,revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id) VALUES(?,?,?,?,?,?,?,?,?,?)", params![config.session_id,config.revision,config.launch.provider,config.launch.mode,config.launch.cwd,config.launch.project_id,config.launch.title,config.launch.executable,serde_json::to_string(&config.launch.args)?,config.source_session_id])?;
        Ok(config)
    })
}

pub fn read(db: &Database, session_id: &str) -> Result<Option<SessionConfig>> {
    db.transaction(|tx| read_tx(tx, session_id))
}
pub fn link_source(db: &Database, session_id: &str, source_session_id: &str) -> Result<()> {
    db.transaction(|tx| {
        let source_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?)",
            [source_session_id],
            |row| row.get(0),
        )?;
        if !source_exists {
            return Err(anyhow!("source_session_missing"));
        }
        if tx.execute(
            "UPDATE session_launch_configs SET source_session_id=? WHERE session_id=?",
            params![source_session_id, session_id],
        )? != 1
        {
            return Err(anyhow!("launch_config_missing"));
        }
        Ok(())
    })
}

pub fn dispatch(db: &Database, method: &str, params_value: &Value) -> Result<Option<Value>> {
    if !matches!(method, "session.config.read" | "session.config.save") {
        return Ok(None);
    }
    let params = params_value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let session_id = string(params, "sessionId")?;
    match method {
        "session.config.read" => Ok(Some(serde_json::to_value(
            read(db, session_id)?.ok_or_else(|| anyhow!("launch_config_missing"))?,
        )?)),
        "session.config.save" => {
            let operation_id = string(params, "operationId")?;
            if let Some(result) = db.operation(operation_id)? {
                return Ok(Some(result));
            }
            let expected = params
                .get("expectedRevision")
                .and_then(Value::as_i64)
                .filter(|revision| *revision >= 0)
                .ok_or_else(|| anyhow!("invalid_revision"))?;
            let launch = launch_from(params)?;
            validate(&launch)?;
            let config = db.transaction(|tx| {
                let existing = read_tx(tx, session_id)?.ok_or_else(|| anyhow!("launch_config_missing"))?;
                if existing.revision != expected { return Err(anyhow!("revision_conflict")); }
                let updated = SessionConfig { session_id: existing.session_id, revision: expected + 1, launch, source_session_id: existing.source_session_id };
                tx.execute("UPDATE session_launch_configs SET revision=?,provider=?,mode=?,cwd=?,project_id=?,title=?,executable=?,args_json=? WHERE session_id=?", params![updated.revision,updated.launch.provider,updated.launch.mode,updated.launch.cwd,updated.launch.project_id,updated.launch.title,updated.launch.executable,serde_json::to_string(&updated.launch.args)?,updated.session_id])?;
                complete(tx, operation_id, method, &serde_json::to_value(&updated)?)?;
                Ok(updated)
            })?;
            Ok(Some(serde_json::to_value(config)?))
        }
        _ => unreachable!(),
    }
}

fn read_tx(tx: &Transaction<'_>, session_id: &str) -> Result<Option<SessionConfig>> {
    tx.query_row("SELECT revision,provider,mode,cwd,project_id,title,executable,args_json,source_session_id FROM session_launch_configs WHERE session_id=?", [session_id], |row| {
        let args: String = row.get(7)?;
        Ok(SessionConfig { session_id: session_id.to_owned(), revision: row.get(0)?, launch: LaunchSpec { provider: row.get(1)?, mode: row.get(2)?, cwd: row.get(3)?, project_id: row.get(4)?, title: row.get(5)?, executable: row.get(6)?, args: serde_json::from_str(&args).map_err(|error| rusqlite::Error::FromSqlConversionFailure(args.len(), rusqlite::types::Type::Text, Box::new(error)))? }, source_session_id: row.get(8)? })
    }).optional().map_err(Into::into)
}
fn launch_from(params: &serde_json::Map<String, Value>) -> Result<LaunchSpec> {
    let values = match params.get("args") {
        None => &[][..],
        Some(Value::Array(values)) => values.as_slice(),
        Some(_) => return Err(anyhow!("invalid_args")),
    };
    let args = values
        .iter()
        .map(|arg| {
            arg.as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("invalid_args"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(LaunchSpec {
        provider: string(params, "provider")?.to_owned(),
        mode: string(params, "mode")?.to_owned(),
        cwd: string(params, "cwd")?.to_owned(),
        project_id: optional_string(params, "projectId"),
        title: optional_string(params, "title"),
        executable: optional_string(params, "executable"),
        args,
    })
}
fn optional_string(params: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn string<'a>(params: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn validate(launch: &LaunchSpec) -> Result<()> {
    if !matches!(
        launch.provider.as_str(),
        "codex" | "claude" | "kimi" | "gemini" | "opencode" | "shell" | "grok" | "custom"
    ) || !matches!(launch.mode.as_str(), "terminal" | "chat")
        || !Path::new(&launch.cwd).is_absolute()
        || launch.args.len() > MAX_ARGS
        || launch.args.iter().any(|arg| arg.len() > MAX_ARGUMENT_BYTES)
    {
        return Err(anyhow!("invalid_launch_config"));
    }
    Ok(())
}
fn complete(tx: &Transaction<'_>, operation_id: &str, method: &str, result: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            operation_id,
            method,
            serde_json::to_string(result)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}',?)",
        [Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use serde_json::json;
    fn spec(cwd: &str) -> LaunchSpec {
        LaunchSpec {
            provider: "shell".into(),
            mode: "terminal".into(),
            cwd: cwd.into(),
            project_id: None,
            title: Some("saved".into()),
            executable: Some("cmd.exe".into()),
            args: vec!["/Q".into()],
        }
    }
    #[test]
    fn stores_edits_and_preserves_rerun_lineage() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        initialize(&db).unwrap();
        let source = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "source",
            })
            .unwrap();
        let first = save_new(&db, &source.id, &spec(temp.path().to_str().unwrap()), None).unwrap();
        assert_eq!(first.revision, 1);
        let rerun = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "rerun",
            })
            .unwrap();
        save_new(&db, &rerun.id, &first.launch, Some(&source.id)).unwrap();
        assert_eq!(
            read(&db, &rerun.id).unwrap().unwrap().source_session_id,
            Some(source.id.clone())
        );
        let saved=dispatch(&db,"session.config.save",&json!({"sessionId":source.id,"provider":"shell","mode":"terminal","cwd":temp.path(),"title":"edited","executable":"cmd.exe","args":["/D"],"expectedRevision":1,"operationId":"edit"})).unwrap().unwrap();
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["title"], "edited");
        assert!(dispatch(&db,"session.config.save",&json!({"sessionId":source.id,"provider":"shell","mode":"terminal","cwd":temp.path(),"expectedRevision":1,"operationId":"stale"})).is_err());
    }
}
