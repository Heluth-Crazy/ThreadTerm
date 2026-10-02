//! Per-provider proxy settings. Environment overrides are applied to children,
//! never to the daemon process or to a shell profile.
use super::ProviderError;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, RwLock};

const LOCAL_BYPASS: &str = "localhost,127.0.0.1,::1";

#[derive(Clone, Default)]
pub(crate) struct NetworkSettings(Arc<RwLock<GrokNetworkSettings>>);

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrokNetworkSettings {
    #[serde(default)]
    mode: ProxyMode,
    #[serde(default)]
    proxy_url: String,
    #[serde(default)]
    no_proxy: String,
}

#[derive(Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ProxyMode {
    #[default]
    Inherit,
    Custom,
}

fn invalid(message: &str) -> ProviderError {
    ProviderError::new("invalid_provider_proxy", message)
}

fn proxy_url(value: &str) -> Result<String, ProviderError> {
    let value = value.trim();
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| invalid("Enter a valid HTTP or HTTPS proxy address."))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || value.chars().any(char::is_control)
    {
        return Err(invalid(
            "Use an HTTP or HTTPS proxy address with no credentials, path, query, or fragment.",
        ));
    }
    Ok(value.to_owned())
}

fn parse(settings: &Value) -> Result<GrokNetworkSettings, ProviderError> {
    let Some(value) = settings.pointer("/providerNetwork/grok") else {
        return Ok(GrokNetworkSettings::default());
    };
    let mut config: GrokNetworkSettings = serde_json::from_value(value.clone())
        .map_err(|_| invalid("Grok proxy settings are invalid."))?;
    if config.no_proxy.len() > 4096 || config.no_proxy.chars().any(char::is_control) {
        return Err(invalid(
            "Proxy bypass hosts must be a comma-separated single line.",
        ));
    }
    if config.mode == ProxyMode::Custom {
        config.proxy_url = proxy_url(&config.proxy_url)?;
    }
    Ok(config)
}

pub(crate) fn validate_settings(settings: &Value) -> Result<(), ProviderError> {
    parse(settings).map(|_| ())
}

impl NetworkSettings {
    pub(crate) fn update(&self, settings: &Value) -> Result<(), ProviderError> {
        let next = parse(settings)?;
        *self
            .0
            .write()
            .map_err(|_| invalid("Proxy settings are unavailable."))? = next;
        Ok(())
    }

    pub(crate) fn grok_env(&self) -> Result<Vec<(String, String)>, ProviderError> {
        let config = self
            .0
            .read()
            .map_err(|_| invalid("Proxy settings are unavailable."))?;
        environment(&config, |key| std::env::var(key).ok())
    }
}

pub(crate) fn grok_env_for_settings(
    settings: &Value,
) -> Result<Vec<(String, String)>, ProviderError> {
    environment(&parse(settings)?, |key| std::env::var(key).ok())
}

fn environment(
    config: &GrokNetworkSettings,
    inherited: impl Fn(&str) -> Option<String>,
) -> Result<Vec<(String, String)>, ProviderError> {
    let explicit = if config.mode == ProxyMode::Custom {
        Some(config.proxy_url.clone())
    } else {
        // The standard HTTP(S)_PROXY/ALL_PROXY/NO_PROXY environment is already
        // inherited by Command. These aliases opt into one Grok-only endpoint.
        ["THREADTERM_GROK_PROXY", "GROK_FORWARD_PROXY"]
            .into_iter()
            .filter_map(&inherited)
            .find(|value| !value.trim().is_empty())
            .map(|value| proxy_url(&value))
            .transpose()?
    };
    let Some(proxy) = explicit else {
        return Ok(Vec::new());
    };
    let bypass = if config.mode == ProxyMode::Custom && !config.no_proxy.trim().is_empty() {
        config.no_proxy.trim().to_owned()
    } else if config.mode == ProxyMode::Inherit {
        inherited("NO_PROXY")
            .or_else(|| inherited("no_proxy"))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| LOCAL_BYPASS.to_owned())
    } else {
        LOCAL_BYPASS.to_owned()
    };
    let mut overrides = Vec::new();
    // Both cases matter on Unix; Windows deduplicates the names itself.
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "GROK_WEB_FETCH_PROXY",
    ] {
        overrides.push((name.to_owned(), proxy.clone()));
    }
    for name in ["NO_PROXY", "no_proxy"] {
        overrides.push((name.to_owned(), bypass.clone()));
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn inherited_standard_proxy_values_are_left_untouched() {
        let config = parse(&json!({})).unwrap();
        assert!(environment(&config, |key| match key {
            "HTTPS_PROXY" => Some("http://proxy.example:3128".into()),
            "NO_PROXY" => Some("internal.example".into()),
            _ => None,
        })
        .unwrap()
        .is_empty());
    }

    #[test]
    fn grok_alias_is_child_scoped_and_preserves_bypass() {
        let values: HashMap<_, _> = environment(&GrokNetworkSettings::default(), |key| match key {
            "GROK_FORWARD_PROXY" => Some("http://proxy.example:3128".into()),
            "NO_PROXY" => Some("localhost,internal.example".into()),
            _ => None,
        })
        .unwrap()
        .into_iter()
        .collect();
        assert_eq!(values["HTTPS_PROXY"], "http://proxy.example:3128");
        assert_eq!(values["https_proxy"], values["HTTPS_PROXY"]);
        assert_eq!(values["GROK_WEB_FETCH_PROXY"], values["HTTPS_PROXY"]);
        assert_eq!(values["NO_PROXY"], "localhost,internal.example");
    }

    #[test]
    fn custom_settings_override_aliases_and_standard_environment() {
        let config = parse(&json!({"providerNetwork":{"grok":{"mode":"custom","proxyUrl":"http://portable.example:8080","noProxy":"localhost,.example.test"}}})).unwrap();
        let values: HashMap<_, _> =
            environment(&config, |_| Some("http://ignored.example:9999".into()))
                .unwrap()
                .into_iter()
                .collect();
        assert_eq!(values["HTTP_PROXY"], "http://portable.example:8080");
        assert_eq!(values["NO_PROXY"], "localhost,.example.test");
    }

    #[test]
    fn explicit_alias_priority_and_ipv6_are_supported() {
        let values: HashMap<_, _> = environment(&GrokNetworkSettings::default(), |key| match key {
            "THREADTERM_GROK_PROXY" => Some("http://[::1]:8123".into()),
            "GROK_FORWARD_PROXY" => Some("http://ignored.example:9999".into()),
            _ => None,
        })
        .unwrap()
        .into_iter()
        .collect();
        assert_eq!(values["HTTP_PROXY"], "http://[::1]:8123");
        assert_eq!(values["NO_PROXY"], LOCAL_BYPASS);
    }

    #[test]
    fn invalid_saved_proxy_is_rejected_without_echoing_its_value() {
        for endpoint in [
            "",
            "localhost:8080",
            "socks5://localhost:1080",
            "http://secret:password@host:80",
            "http://host/path",
            "http://host?secret=token",
        ] {
            let error = validate_settings(
                &json!({"providerNetwork":{"grok":{"mode":"custom","proxyUrl":endpoint}}}),
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid_provider_proxy");
            assert!(!error.message.contains("password"));
            assert!(!error.message.contains("token"));
        }
    }

    #[test]
    fn updates_are_shared_but_bad_updates_do_not_replace_valid_settings() {
        let settings = NetworkSettings::default();
        let reader = settings.clone();
        settings.update(&json!({"providerNetwork":{"grok":{"mode":"custom","proxyUrl":"https://proxy.example:8443"}}})).unwrap();
        assert!(settings
            .update(&json!({"providerNetwork":{"grok":{"mode":"invalid"}}}))
            .is_err());
        assert!(reader
            .grok_env()
            .unwrap()
            .iter()
            .any(|(key, value)| key == "HTTPS_PROXY" && value == "https://proxy.example:8443"));
    }
}
