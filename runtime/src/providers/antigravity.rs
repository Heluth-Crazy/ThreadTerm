//! Google Antigravity through the official `agy acp` server (task 11-24, `.trellis/tasks/11-24-antigravity`).
//!
//! Policy: ThreadTerm runs Google's unmodified CLI, lets it sign in by itself and reports its own identity
//! (`clientInfo threadterm`). It never reads or refreshes the CLI's tokens, never calls Google's internal APIs and
//! never claims to be another client. The sign-in method only chooses which credential the CLI is given: nothing
//! for the two Google sign-ins, an API key or a Google Cloud project for the other two.
use super::ProviderError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::RwLock,
};

pub(crate) const ID: &str = "antigravity";
pub(crate) const NAME: &str = "Antigravity";
/// The CLI's command name; its provider id stays `antigravity`.
pub(crate) const CLI: &str = "agy";
pub(crate) const HOMEPAGE: &str = "https://antigravity.google/docs/ide/extensions/acp/";
/// From 1.5.1 `agy acp` offers every model of the account to any ACP client, so ThreadTerm never needs another
/// client's name to reach them.
pub(crate) const MIN_VERSION: [u64; 3] = [1, 5, 1];
/// What `agy acp` answers a session request with until a sign-in method works.
pub(crate) const AUTH_REQUIRED: i64 = -32000;
/// A Google sign-in runs in the browser and may take a while; longer than an ordinary request.
pub(crate) const SIGN_IN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// Inherited variables that would let another credential decide instead of the chosen method. The CLI's own profile
/// (`GEMINI_HOME`, `~/.gemini`) is kept: a sign-in made in a terminal works in ThreadTerm too.
pub(crate) const CLEARED_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
];
const MAX_API_KEY: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) enum AuthMethod {
    #[serde(rename = "oauth-personal")]
    OauthPersonal,
    #[serde(rename = "oauth-business")]
    OauthBusiness,
    #[serde(rename = "gemini-api-key")]
    GeminiApiKey,
    #[serde(rename = "agent-platform")]
    AgentPlatform,
}

impl AuthMethod {
    pub(crate) const ALL: [AuthMethod; 4] =
        [Self::OauthPersonal, Self::OauthBusiness, Self::GeminiApiKey, Self::AgentPlatform];

    /// The ACP `authMethods` id `agy acp` announces for this method (measured with 1.5.16).
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::OauthPersonal => "oauth-personal",
            Self::OauthBusiness => "oauth-business",
            Self::GeminiApiKey => "gemini-api-key",
            Self::AgentPlatform => "agent-platform",
        }
    }

    /// A Google sign-in in the browser, run by the CLI itself.
    pub(crate) fn browser(self) -> bool {
        matches!(self, Self::OauthPersonal | Self::OauthBusiness)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    /// None until the user chooses in Settings → Agents, where choosing a personal Google account shows the
    /// ban-risk notice first (owner decision 11-24). Nothing signs in before that.
    #[serde(default)]
    method: Option<AuthMethod>,
    /// Agent Platform only: the Google Cloud project and location.
    #[serde(default)]
    project: String,
    #[serde(default)]
    location: String,
}

fn invalid(message: &str) -> ProviderError {
    ProviderError::new("invalid_provider_auth", message)
}

fn valid_project(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | ':'))
}

fn valid_location(value: &str) -> bool {
    (1..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn parse(settings: &Value) -> Result<Config, ProviderError> {
    let Some(value) = settings.pointer("/providerAuth/antigravity") else {
        return Ok(Config::default());
    };
    let mut config: Config = serde_json::from_value(value.clone())
        .map_err(|_| invalid("Antigravity sign-in settings are invalid."))?;
    config.project = config.project.trim().to_owned();
    config.location = config.location.trim().to_owned();
    if !config.project.is_empty() && !valid_project(&config.project) {
        return Err(invalid("Enter a Google Cloud project ID: lowercase letters, digits and hyphens."));
    }
    if !config.location.is_empty() && !valid_location(&config.location) {
        return Err(invalid("Enter a Google Cloud location such as global or us-central1."));
    }
    Ok(config)
}

pub(crate) fn validate_settings(settings: &Value) -> Result<(), ProviderError> {
    parse(settings).map(|_| ())
}

/// One sign-in method as the settings row lists it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: &'static str,
    /// The method needs a stored API key (Gemini API key) or accepts one (Agent Platform express mode).
    pub api_key: bool,
    /// The CLI opens Google's sign-in page in the browser.
    pub browser: bool,
}

pub(crate) fn auth_methods() -> Vec<AuthMethodInfo> {
    AuthMethod::ALL
        .iter()
        .map(|method| AuthMethodInfo {
            id: method.id(),
            api_key: matches!(method, AuthMethod::GeminiApiKey | AuthMethod::AgentPlatform),
            browser: method.browser(),
        })
        .collect()
}

/// The chosen method, the API key and the last sign-in outcome.
pub(crate) struct Antigravity {
    config: RwLock<Config>,
    secret: PathBuf,
    /// `Some(true)` after a session opened, `Some(false)` after `agy acp` asked for a sign-in; reset on any change.
    signed_in: RwLock<Option<bool>>,
}

impl Antigravity {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self {
            config: RwLock::new(Config::default()),
            secret: data_dir.join("secrets").join("antigravity-api-key"),
            signed_in: RwLock::new(None),
        }
    }

    /// Applies the settings; true when the method or project changed.
    pub(crate) fn update(&self, settings: &Value) -> Result<bool, ProviderError> {
        let next = parse(settings)?;
        let mut config = self.config.write().map_err(|_| invalid("Antigravity settings are unavailable."))?;
        if *config == next {
            return Ok(false);
        }
        *config = next;
        drop(config);
        self.forget_sign_in();
        Ok(true)
    }

    fn config(&self) -> Config {
        self.config.read().map(|config| config.clone()).unwrap_or_default()
    }

    pub(crate) fn method(&self) -> Option<AuthMethod> {
        self.config().method
    }

    pub(crate) fn api_key_set(&self) -> bool {
        self.secret.is_file()
    }

    /// Stores (or with `None` removes) the API key. It is written once and never handed back to a client.
    pub(crate) fn set_api_key(&self, key: Option<&str>) -> Result<(), ProviderError> {
        self.forget_sign_in();
        let Some(key) = key.map(str::trim).filter(|key| !key.is_empty()) else {
            return match std::fs::remove_file(&self.secret) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(ProviderError::new(
                    "provider_secret_failed",
                    format!("Could not remove the Antigravity API key: {error}"),
                )),
                _ => Ok(()),
            };
        };
        if key.len() > MAX_API_KEY || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(invalid("An API key is one line without spaces."));
        }
        super::secret_store::write(&self.secret, key.as_bytes())
            .map_err(|error| ProviderError::new("provider_secret_failed", format!("Could not store the API key: {error:#}")))
    }

    fn api_key(&self) -> Result<Option<String>, ProviderError> {
        if !self.secret.is_file() {
            return Ok(None);
        }
        let bytes = super::secret_store::read(&self.secret).map_err(|error| {
            ProviderError::new("provider_secret_failed", format!("Could not read the stored API key: {error:#}"))
        })?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| ProviderError::new("provider_secret_failed", "The stored API key is unreadable; enter it again."))
    }

    /// The variables `agy acp` starts with for the chosen method, after [`CLEARED_ENV`] is removed.
    pub(crate) fn launch_env(&self) -> Result<Vec<(String, String)>, ProviderError> {
        let config = self.config();
        let key = match config.method {
            Some(AuthMethod::GeminiApiKey | AuthMethod::AgentPlatform) => self.api_key()?,
            _ => None,
        };
        launch_env(&config, key)
    }

    pub(crate) fn note_sign_in(&self, signed_in: bool) {
        if let Ok(mut value) = self.signed_in.write() {
            *value = Some(signed_in);
        }
    }

    fn forget_sign_in(&self) {
        if let Ok(mut value) = self.signed_in.write() {
            *value = None;
        }
    }

    /// `ProviderCapability.auth`: an API key method is ready once its key is stored; a Google sign-in is known only
    /// after `agy acp` accepted or refused a session, because ThreadTerm never looks at the CLI's credentials.
    pub(crate) fn auth_state(&self) -> &'static str {
        let config = self.config();
        let observed = self.signed_in.read().ok().and_then(|value| *value);
        match (config.method, observed) {
            (None, _) | (_, Some(false)) => "unauthenticated",
            (Some(AuthMethod::GeminiApiKey), _) if !self.api_key_set() => "unauthenticated",
            (Some(AuthMethod::AgentPlatform), _) if config.project.is_empty() => "unauthenticated",
            (_, Some(true)) => "authenticated",
            (Some(AuthMethod::GeminiApiKey), None) => "authenticated",
            _ => "unknown",
        }
    }
}

fn launch_env(config: &Config, key: Option<String>) -> Result<Vec<(String, String)>, ProviderError> {
    let Some(method) = config.method else {
        return Err(ProviderError::new(
            "provider_auth_required",
            "Choose how Antigravity signs in: Settings → Agents → Antigravity sign-in.",
        ));
    };
    match method {
        AuthMethod::OauthPersonal | AuthMethod::OauthBusiness => Ok(Vec::new()),
        AuthMethod::GeminiApiKey => {
            let key = key.ok_or_else(|| {
                ProviderError::new("provider_auth_required", "Enter a Gemini API key for Antigravity in Settings → Agents.")
            })?;
            Ok(vec![("GEMINI_API_KEY".into(), key)])
        }
        AuthMethod::AgentPlatform => {
            if config.project.is_empty() {
                return Err(ProviderError::new(
                    "provider_auth_required",
                    "Enter the Google Cloud project for Antigravity in Settings → Agents.",
                ));
            }
            let location = if config.location.is_empty() { "global" } else { &config.location };
            let mut env = vec![
                ("GOOGLE_CLOUD_PROJECT".to_owned(), config.project.clone()),
                ("GOOGLE_CLOUD_LOCATION".to_owned(), location.to_owned()),
            ];
            // Express mode: an Agent Platform API key; without one the CLI uses Application Default Credentials.
            if let Some(key) = key {
                env.push(("GOOGLE_API_KEY".into(), key));
            }
            Ok(env)
        }
    }
}

/// `agy acp`'s answer to a session request is "Authentication required".
pub(crate) fn is_auth_required(error: &ProviderError) -> bool {
    error.details.as_ref().and_then(|details| details.get("code")).and_then(Value::as_i64) == Some(AUTH_REQUIRED)
}

/// `1.5.16` → `[1, 5, 16]`; anything else (a banner, a build suffix) is read up to the first non-version text.
pub(crate) fn parse_version(text: &str) -> Option<[u64; 3]> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let mut parts = text[start..]
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()?
        .split('.')
        .map(|part| part.parse::<u64>().ok());
    Some([parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)])
}

/// Why the installed CLI cannot chat, when it is older than [`MIN_VERSION`].
pub(crate) fn version_problem(version: Option<&str>) -> Option<String> {
    let found = version.and_then(parse_version)?;
    (found < MIN_VERSION).then(|| {
        format!(
            "Antigravity CLI {} is too old: ThreadTerm needs {}.{}.{} or later. Update it from Settings → Agents.",
            version.unwrap_or_default().trim(),
            MIN_VERSION[0],
            MIN_VERSION[1],
            MIN_VERSION[2]
        )
    })
}

/// Where ThreadTerm installs the CLI (`--agent-install antigravity`): per user, outside any project and data folder.
pub(crate) fn managed_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("ThreadTerm").join("agents").join(ID))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The ThreadTerm-installed CLI when there is one; otherwise `agy` is looked up on PATH.
pub(crate) fn managed_executable() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("THREADTERM_QA_PROVIDER_BIN").is_some() {
        return None; // QA resolves `agy` from its fake provider folder only.
    }
    let path = managed_dir()?.join(if cfg!(windows) { "agy.exe" } else { "antigravity" });
    path.is_file().then_some(path)
}

/// `threadterm-v3-runtime --agent-install antigravity`, run in a terminal tab: Windows only for now.
pub(crate) fn installer_command() -> Option<super::ProviderCommand> {
    managed_dir()?;
    let runtime = std::env::current_exe().ok()?;
    let spec = super::common::CommandSpec::from_path(runtime, vec!["--agent-install".into(), ID.into()]).ok()?;
    Some(super::ProviderCommand::from_spec(spec))
}

/// The executable the adapter launches: the managed install, else the CLI's name for a PATH lookup.
pub(crate) fn command() -> String {
    managed_executable().map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|| CLI.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_start_with_no_method_and_reject_bad_values() {
        assert_eq!(parse(&json!({})).unwrap(), Config::default());
        assert_eq!(Config::default().method, None, "nothing is chosen until the user picks a method");
        let config = parse(&json!({"providerAuth":{"antigravity":{"method":"agent-platform","project":" my-proj-1 ","location":"us-central1"}}})).unwrap();
        assert_eq!((config.method, config.project.as_str(), config.location.as_str()), (Some(AuthMethod::AgentPlatform), "my-proj-1", "us-central1"));
        assert!(parse(&json!({"providerAuth":{"antigravity":{"method":"oauth-other"}}})).is_err());
        assert!(parse(&json!({"providerAuth":{"antigravity":{"method":"gemini-api-key","apiKey":"x"}}})).is_err(), "a key never travels in settings");
        assert!(parse(&json!({"providerAuth":{"antigravity":{"project":"My Project"}}})).is_err());
        assert!(parse(&json!({"providerAuth":{"antigravity":{"location":"us central"}}})).is_err());
    }

    #[test]
    fn each_method_gives_the_cli_only_its_own_credential() {
        let config = |method, project: &str| Config { method: Some(method), project: project.into(), location: String::new() };
        assert_eq!(launch_env(&Config::default(), None).unwrap_err().code, "provider_auth_required", "no method, no launch");
        assert!(launch_env(&config(AuthMethod::OauthPersonal, ""), Some("k".into())).unwrap().is_empty());
        assert!(launch_env(&config(AuthMethod::OauthBusiness, ""), None).unwrap().is_empty());
        assert_eq!(launch_env(&config(AuthMethod::GeminiApiKey, ""), Some("k1".into())).unwrap(), vec![("GEMINI_API_KEY".to_owned(), "k1".to_owned())]);
        assert_eq!(launch_env(&config(AuthMethod::GeminiApiKey, ""), None).unwrap_err().code, "provider_auth_required");
        assert_eq!(launch_env(&config(AuthMethod::AgentPlatform, ""), None).unwrap_err().code, "provider_auth_required");
        assert_eq!(
            launch_env(&config(AuthMethod::AgentPlatform, "p1"), None).unwrap(),
            vec![("GOOGLE_CLOUD_PROJECT".to_owned(), "p1".to_owned()), ("GOOGLE_CLOUD_LOCATION".to_owned(), "global".to_owned())]
        );
        assert_eq!(launch_env(&config(AuthMethod::AgentPlatform, "p1"), Some("k2".into())).unwrap().last().unwrap(), &("GOOGLE_API_KEY".to_owned(), "k2".to_owned()));
    }

    #[test]
    fn methods_match_what_agy_acp_announces() {
        let ids: Vec<_> = auth_methods().iter().map(|method| method.id).collect();
        assert_eq!(ids, ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);
    }

    #[test]
    fn versions_before_1_5_1_cannot_chat() {
        assert_eq!(parse_version("1.5.16\n"), Some([1, 5, 16]));
        assert_eq!(parse_version("agy 1.6"), Some([1, 6, 0]));
        assert_eq!(parse_version("no version"), None);
        assert!(version_problem(Some("1.5.0")).is_some());
        assert!(version_problem(Some("1.4.9")).is_some());
        assert!(version_problem(Some("1.5.1")).is_none());
        assert!(version_problem(Some("2.0.0")).is_none());
        assert!(version_problem(None).is_none(), "an unreadable version does not block");
    }

    #[test]
    fn the_api_key_is_stored_apart_from_settings_and_auth_follows_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = Antigravity::new(dir.path());
        state.update(&json!({"providerAuth":{"antigravity":{"method":"gemini-api-key"}}})).unwrap();
        assert_eq!(state.auth_state(), "unauthenticated");
        assert!(state.set_api_key(Some("bad key")).is_err());
        state.set_api_key(Some(" AIzaTestKey ")).unwrap();
        assert!(state.api_key_set());
        let stored = std::fs::read(dir.path().join("secrets").join("antigravity-api-key")).unwrap();
        #[cfg(windows)]
        assert!(!stored.windows(11).any(|window| window == b"AIzaTestKey"), "the file holds no plain key");
        let _ = stored;
        assert_eq!(state.launch_env().unwrap(), vec![("GEMINI_API_KEY".to_owned(), "AIzaTestKey".to_owned())]);
        assert_eq!(state.auth_state(), "authenticated");
        state.note_sign_in(false);
        assert_eq!(state.auth_state(), "unauthenticated");
        state.set_api_key(None).unwrap();
        assert!(!state.api_key_set());
        state.set_api_key(None).unwrap();
    }

    #[test]
    fn a_google_sign_in_is_known_only_from_what_agy_answered() {
        let dir = tempfile::tempdir().unwrap();
        let state = Antigravity::new(dir.path());
        assert_eq!(state.auth_state(), "unauthenticated", "no method chosen yet");
        state.update(&json!({"providerAuth":{"antigravity":{"method":"oauth-personal"}}})).unwrap();
        assert_eq!(state.auth_state(), "unknown");
        state.note_sign_in(true);
        assert_eq!(state.auth_state(), "authenticated");
        state.update(&json!({"providerAuth":{"antigravity":{"method":"oauth-business"}}})).unwrap();
        assert_eq!(state.auth_state(), "unknown", "a new method forgets the old outcome");
    }

    #[test]
    fn auth_required_is_the_json_rpc_code_agy_sends() {
        let error = ProviderError::new("provider_error", "Authentication required")
            .with_details(json!({"code":-32000,"message":"Authentication required"}));
        assert!(is_auth_required(&error));
        assert!(!is_auth_required(&ProviderError::new("provider_error", "Authentication required")));
    }
}
