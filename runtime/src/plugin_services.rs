use crate::{config::RuntimeConfig, db::Database, plugins::PluginRegistry, providers::Providers};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetEnabled {
    plugin_id: String,
    enabled: bool,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reload {
    operation_id: String,
}

pub(crate) fn validate(method: &str, value: &Value) -> Result<()> {
    if matches!(
        method,
        "plugin.list" | "plugin.setEnabled" | "plugin.reload"
    ) && !value.is_object()
    {
        return Err(anyhow!("plugin parameters must be an object"));
    }
    match method {
        "plugin.list" => {
            serde_json::from_value::<Empty>(value.clone())?;
        }
        "plugin.setEnabled" => {
            let p: SetEnabled = serde_json::from_value(value.clone())?;
            if p.plugin_id.is_empty() || p.operation_id.is_empty() {
                return Err(anyhow!("invalid plugin parameters"));
            }
        }
        "plugin.reload" => {
            let p: Reload = serde_json::from_value(value.clone())?;
            if p.operation_id.is_empty() {
                return Err(anyhow!("invalid operationId"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// The service holds both the plugin and settings gates; manifest I/O stays
/// outside the database transaction and never executes a discovered command.
pub(crate) fn dispatch(
    config: &RuntimeConfig,
    db: &Database,
    providers: &Providers,
    method: &str,
    value: &Value,
) -> Result<Value> {
    validate(method, value)?;
    if method == "plugin.list" {
        return serde_json::to_value(
            providers
                .plugin_list()
                .ok_or_else(|| anyhow!("plugin registry unavailable"))?,
        )
        .map_err(Into::into);
    }
    let operation_id = value["operationId"]
        .as_str()
        .ok_or_else(|| anyhow!("invalid operationId"))?;
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    let mut settings = db.settings_value()?;
    if method == "plugin.setEnabled" {
        let p: SetEnabled = serde_json::from_value(value.clone())?;
        let found = PluginRegistry::discover(&config.data_dir, &settings);
        if !found
            .list
            .plugins
            .iter()
            .any(|plugin| plugin.id == p.plugin_id)
        {
            return Err(anyhow!(
                "Plugin {} was not found; reload the plugins folder",
                p.plugin_id
            ));
        }
        if !settings["plugins"].is_object() {
            settings["plugins"] = json!({});
        }
        settings["plugins"][&p.plugin_id] = json!({"enabled":p.enabled});
    }
    let registry = PluginRegistry::discover(&config.data_dir, &settings);
    let result = serde_json::to_value(&registry.list)?;
    let previous = providers
        .plugin_registry()
        .unwrap_or_else(|| PluginRegistry {
            list: crate::plugins::PluginList {
                directory: config
                    .data_dir
                    .join("plugins")
                    .to_string_lossy()
                    .into_owned(),
                plugins: vec![],
            },
            agents: vec![],
        });
    let committed = db.transaction(|tx| {
        if method == "plugin.setEnabled" {
            write_enabled_settings(tx, &settings["plugins"])?;
        }
        tx.execute(
            "INSERT INTO operations(id,method,result,created_at) VALUES (?,?,?,?)",
            params![
                operation_id,
                method,
                serde_json::to_string(&result)?,
                Utc::now().to_rfc3339()
            ],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
            params![
                json!({"kind":"plugins"}).to_string(),
                Utc::now().to_rfc3339()
            ],
        )?;
        // Publish adapters before the connection lock releases the event to
        // the outbox pump, so event-driven snapshots observe the new registry.
        providers.rebuild_plugins(registry);
        Ok(())
    });
    if let Err(failure) = committed {
        providers.rebuild_plugins(previous);
        return Err(failure);
    }
    Ok(result)
}

fn write_enabled_settings(tx: &Transaction<'_>, plugins: &Value) -> Result<()> {
    // Imports can commit while discovery reads manifests. Change only this
    // machine's enablement map, preserving every other setting in the latest row.
    tx.execute(
        "UPDATE settings SET revision=revision+1,value=json_set(value,'$.plugins',json(?)) WHERE singleton=1",
        [serde_json::to_string(plugins)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enablement_write_preserves_settings_committed_since_discovery() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite")).unwrap();
        let mut discovered_settings = db.settings_value().unwrap();
        discovered_settings["plugins"] = json!({"echo-acp":{"enabled":true}});
        db.update_settings(
            &json!({"theme":"dark","language":"en"}),
            0,
            "concurrent-settings",
        )
        .unwrap();
        db.transaction(|tx| write_enabled_settings(tx, &discovered_settings["plugins"]))
            .unwrap();
        let current = db.settings_value().unwrap();
        assert_eq!(current["theme"], "dark");
        assert_eq!(current["language"], "en");
        assert_eq!(current["plugins"]["echo-acp"]["enabled"], true);
        assert_eq!(db.snapshot().unwrap().settings.revision, 2);
    }

    #[test]
    fn failed_plugin_commit_restores_the_registry_and_emits_no_event() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite")).unwrap();
        let providers = Providers::for_test(vec![]);
        providers.rebuild_plugins(PluginRegistry::bundled());
        db.transaction(|tx| {
            tx.execute_batch("CREATE TABLE commit_failure (session_id TEXT REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_plugin_commit AFTER INSERT ON outbox BEGIN INSERT INTO commit_failure(session_id) VALUES('missing'); END;")?;
            Ok(())
        }).unwrap();
        let config = RuntimeConfig {
            data_dir: root.path().to_owned(),
            database_path: root.path().join("db.sqlite"),
            credential_path: root.path().join("credential"),
            pipe_base: "plugin-commit-test".into(),
        };
        let result = dispatch(
            &config,
            &db,
            &providers,
            "plugin.setEnabled",
            &json!({"pluginId":"gemini","enabled":false,"operationId":"failing-disable"}),
        );
        assert!(result.is_err());
        assert!(providers.contains("gemini"));
        assert!(db.settings_value().unwrap().get("plugins").is_none());
        assert!(db.operation("failing-disable").unwrap().is_none());
        db.transaction(|tx| {
            let events: i64 = tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?;
            assert_eq!(events, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn plugin_parameters_are_strict() {
        assert!(validate("plugin.list", &json!({})).is_ok());
        for value in [json!(null), json!([]), json!({"operationId":"x"})] {
            assert!(validate("plugin.list", &value).is_err());
        }
        assert!(validate("plugin.reload", &json!({"operationId":"reload"})).is_ok());
        for value in [
            json!({}),
            json!({"operationId":""}),
            json!({"operationId":1}),
            json!({"operationId":"r","extra":1}),
        ] {
            assert!(validate("plugin.reload", &value).is_err());
        }
        assert!(validate(
            "plugin.setEnabled",
            &json!({"pluginId":"echo-acp","enabled":true,"operationId":"on"})
        )
        .is_ok());
        for value in [
            json!({"pluginId":"echo-acp","enabled":"true","operationId":"on"}),
            json!({"pluginId":"","enabled":true,"operationId":"on"}),
            json!({"pluginId":"echo-acp","operationId":"on"}),
            json!({"pluginId":"echo-acp","enabled":false,"operationId":"on","extra":1}),
        ] {
            assert!(validate("plugin.setEnabled", &value).is_err());
        }
    }
}
