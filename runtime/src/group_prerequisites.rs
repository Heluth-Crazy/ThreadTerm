//! On-demand admission guidance shared by creation and its prerequisite preview.
use crate::providers::{ProviderRuntime, Providers};
use serde_json::{json, Value};

pub(crate) fn classify_capability(cap: &Value, pi: Option<(bool, String)>) -> Value {
    let id = cap["id"].as_str().unwrap_or_default();
    let name = cap["name"].as_str().unwrap_or(id);
    let cli = crate::providers::builtin_cli_name(id).unwrap_or(id);
    let (reason, kind, text) = if cap["disabled"] == true {
        (
            Some("disabled"),
            "enable_plugin",
            format!("Enable the {name} plugin in Settings → Plugins, then refresh providers"),
        )
    } else if cap["installed"] != true {
        (
            Some("not_installed"),
            "install",
            if cap["source"] == "plugin" {
                format!("Install or configure {name} using its plugin instructions, then refresh providers")
            } else {
                format!("Install the {name} CLI so `{cli}` is on PATH, then refresh providers")
            },
        )
    } else if cap["auth"] == "unauthenticated" {
        (
            Some("signed_out"),
            "sign_in",
            format!("Sign in to {name} from Settings → Providers, then refresh providers"),
        )
    } else if cap["chat"] != true {
        (
            Some("no_chat"),
            "update",
            format!("Update or configure {name} for Chat support, then refresh providers"),
        )
    } else {
        (None, "configure", String::new())
    };
    let (level, note) = match id {
        "pi" => {
            let (supported, note) = pi.unwrap_or((false, "Pi tool support could not be checked — update Pi for enforced read-only".into()));
            (if supported {"enforced"} else {"prompt"}, note)
        },
        "claude" => ("prompt", "Claude Read/Glob/Grep restriction is requested; confirmed from the session's reported tools when it starts".into()),
        "codex" => ("prompt", "Codex read-only sandbox is requested from advertised options; confirmed when the participant starts".into()),
        "kimi" | "grok" => ("prompt", format!("{name} Plan mode is selected when advertised; confirmed when the participant starts")),
        "opencode" => ("prompt", "OpenCode Plan agent is selected when advertised; read-only is also required by instruction".into()),
        _ => ("prompt", "An advertised Plan mode will be selected when available; otherwise read-only is required by instruction".into()),
    };
    let mut row =
        json!({"provider":id,"usable":reason.is_none(),"readOnly":level,"readOnlyNote":note});
    if let Some(reason) = reason {
        row["reason"] = json!(reason);
        let mut fix = json!({"kind":kind,"text":text});
        if let Some(homepage) = cap["homepage"].as_str() {
            fix["homepage"] = json!(homepage);
        }
        if kind == "sign_in" {
            if let Some(command) = cap.pointer("/signIn/display").and_then(Value::as_str) {
                fix["command"] = json!(command);
            }
        }
        row["fix"] = fix;
    }
    row
}

pub(crate) fn providers(providers: &Providers, requested: Option<&[Value]>) -> Vec<Value> {
    let capabilities = providers.capabilities();
    let ids = requested
        .map(|rows| rows.to_vec())
        .unwrap_or_else(|| capabilities.iter().map(|row| row["id"].clone()).collect());
    ids.iter().map(|id| {
        let Some(cap) = capabilities.iter().find(|cap| cap["id"] == *id) else {
            return json!({"provider":id,"usable":false,"reason":"disabled","fix":{"kind":"enable_plugin","text":"Enable or configure this provider in Settings → Plugins, then refresh providers"},"readOnly":"prompt","readOnlyNote":"Read-only by instruction"});
        };
        let pi = (id == "pi" && cap["installed"] == true && cap["chat"] == true).then(|| {
            let probe = providers.pi_read_only_probe(); (probe.supported, probe.note)
        });
        classify_capability(cap, pi)
    }).collect()
}

pub(crate) fn check(providers: &Providers, params: &Value) -> Value {
    let mut value = crate::group_guard::prerequisites(params["cwd"].as_str());
    value["providers"] = json!(self::providers(
        providers,
        params["providers"].as_array().map(Vec::as_slice)
    ));
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prerequisite_reasons_and_registry_fixes() {
        let base = json!({"id":"fixture","name":"Fixture Agent","installed":true,"chat":true,"source":"plugin","auth":"unknown"});
        assert_eq!(classify_capability(&base, None)["usable"], true);
        for (key, value, reason, kind) in [
            ("installed", json!(false), "not_installed", "install"),
            ("chat", json!(false), "no_chat", "update"),
            ("auth", json!("unauthenticated"), "signed_out", "sign_in"),
            ("disabled", json!(true), "disabled", "enable_plugin"),
        ] {
            let mut cap = base.clone();
            cap[key] = value;
            let row = classify_capability(&cap, None);
            assert_eq!(row["usable"], false);
            assert_eq!(row["reason"], reason);
            assert_eq!(row["fix"]["kind"], kind);
        }
        let mut cap = base;
        cap["auth"] = json!("unauthenticated");
        cap["signIn"] = json!({"display":"fixture login"});
        assert_eq!(
            classify_capability(&cap, None)["fix"]["command"],
            "fixture login"
        );
    }
}
