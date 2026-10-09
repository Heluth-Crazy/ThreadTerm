//! Declarative agent-plugin discovery and the terminal-only adapter.
//!
//! Plugin folders are data, not executable Rust extensions.  Validation happens
//! before an agent descriptor becomes visible to the provider registry so one
//! bad folder cannot prevent the rest of the runtime from starting.

use crate::providers::{
    common::{command_output, find_executable, validate_native_id, CommandSpec},
    ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCapture,
    TerminalCommand,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const MANIFEST: &str = "threadterm-plugin.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_ICON_BYTES: u64 = 64 * 1024;
const MAX_PLUGINS: usize = 64;
const MAX_AGENTS: usize = 8;
const MAX_BROWSER_BINDINGS: usize = 8;
const MAX_ARGS: usize = 32;
const MAX_ARG_CHARS: usize = 512;
const RESERVED_IDS: &[&str] = &["shell", "custom", "threadterm"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAgentInfo {
    pub id: String,
    pub name: String,
    pub terminal: bool,
    pub chat: bool,
    pub commands: Vec<String>,
}

/// A declarative, runtime-owned preview-tool binding. Plugins describe the
/// provider handoff only; they never supply tool implementations or grants.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBindingInfo {
    pub id: String,
    pub binding_version: u32,
    pub provider_id: String,
    pub requires: BTreeMap<String, u32>,
    pub transport: String,
    pub tools: Vec<String>,
    pub workflow: String,
    pub enabled: bool,
    pub selected: bool,
    pub availability: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub source: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub agents: Vec<PluginAgentInfo>,
    pub browser_bindings: Vec<BrowserBindingInfo>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    pub directory: String,
    pub plugins: Vec<PluginInfo>,
}

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub args: Vec<String>,
    pub resume_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentDescriptor {
    pub id: String,
    pub name: String,
    pub plugin_id: Option<String>,
    pub icon: Option<String>,
    pub homepage: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub version_args: Vec<String>,
    pub terminal: Option<TerminalConfig>,
    pub chat_args: Option<Vec<String>>,
    pub sign_in_args: Option<Vec<String>>,
    pub plugin_dir: Option<PathBuf>,
}

impl AgentDescriptor {
    pub fn command_spec(&self, extra: &[String]) -> Result<CommandSpec, ProviderError> {
        let args = self
            .args
            .iter()
            .chain(extra)
            .map(|arg| self.expand(arg))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(suffix) = self
            .command
            .strip_prefix("{pluginDir}/")
            .or_else(|| self.command.strip_prefix("{pluginDir}\\"))
        {
            let dir = self.plugin_dir.as_deref().ok_or_else(|| {
                ProviderError::new("provider_invalid_config", "plugin directory is unavailable")
            })?;
            // Re-canonicalize at every launch: a plugin folder may have been
            // changed since discovery, including by replacing a child with a
            // symlink that escapes the approved folder.
            let path = safe_plugin_path(dir, suffix)
                .map_err(|message| ProviderError::new("provider_invalid_config", message))?;
            CommandSpec::from_path(launch_path(&path), args)
        } else {
            let command = self.expand(&self.command)?;
            let path = find_executable(&command).ok_or_else(|| {
                ProviderError::unavailable(
                    &self.id,
                    format!("{command} executable was not found on PATH"),
                )
            })?;
            CommandSpec::from_path(path, args)
        }
    }

    fn expand(&self, value: &str) -> Result<String, ProviderError> {
        let Some(dir) = &self.plugin_dir else {
            return Ok(value.to_owned());
        };
        let launch_dir = launch_path(dir);
        let dir = launch_dir.to_string_lossy();
        Ok(value.replace("{pluginDir}", &dir))
    }

    pub fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        if resume_id.is_some() && assign_id.is_some() {
            return Err(ProviderError::new(
                "provider_invalid_request",
                "terminal resume and assignment cannot both be requested",
            ));
        }
        let terminal = self.terminal.as_ref().ok_or_else(|| {
            ProviderError::new(
                "provider_unsupported",
                format!("{} does not support terminal sessions", self.name),
            )
        })?;
        let mut extra = terminal.args.clone();
        if let Some(id) = resume_id {
            validate_native_id(id)?;
            if terminal.resume_args.is_empty() {
                return Err(ProviderError::new(
                    "provider_unsupported",
                    format!("{} does not support terminal resume", self.name),
                ));
            }
            extra.extend(
                terminal
                    .resume_args
                    .iter()
                    .map(|arg| arg.replace("{sessionId}", id)),
            );
        }
        let spec = self.command_spec(&extra)?;
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    pub fn version_probe(&self) -> (bool, Option<String>, Option<String>) {
        let spec = match self.command_spec(&self.version_args) {
            Ok(spec) => spec,
            Err(error) => return (false, None, Some(error.message)),
        };
        match command_output(&spec, Duration::from_secs(5)) {
            Ok(output) => (
                true,
                output
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim().to_owned()),
                None,
            ),
            Err(error) => (false, None, Some(error.message)),
        }
    }

    pub fn sign_in(&self) -> Option<crate::providers::ProviderSignIn> {
        let spec = self.command_spec(&self.sign_in_args.clone()?).ok()?;
        Some(crate::providers::ProviderSignIn {
            executable: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }
}

/// Keep canonical paths for containment checks, but do not pass Windows'
/// verbatim `\\?\` spelling to external CLIs. Node and cmd shims commonly
/// treat it as an ordinary string rather than a filesystem path.
fn launch_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(display_windows_path(&path.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn display_windows_path(value: &str) -> String {
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(path) = value.strip_prefix(r"\\?\") {
        path.to_owned()
    } else {
        value.to_owned()
    }
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    pub list: PluginList,
    pub agents: Vec<AgentDescriptor>,
    pub(crate) browser_bindings: Vec<BrowserBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserBinding {
    pub plugin_id: String,
    pub id: String,
    pub binding_version: u32,
    pub provider_id: String,
    pub requires: BTreeMap<String, u32>,
    pub transport: String,
    pub tools: Vec<String>,
    pub workflow: String,
    enabled: bool,
    selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserBindingResolution {
    None,
    Disabled,
    UnsupportedTransport,
    Conflict,
    Eligible(BrowserBinding),
}

impl PluginRegistry {
    /// The compiled-in plugins only. Used by the native provider constructor,
    /// which intentionally has no data directory to inspect.
    pub(crate) fn bundled() -> Self {
        Self::from_candidates(
            vec![bundled_gemini(), bundled_codex_preview()],
            String::new(),
            &Value::Null,
        )
    }

    pub fn discover(data_dir: &Path, settings: &Value) -> Self {
        let roots = env::var_os("THREADTERM_V3_PLUGIN_DIRS")
            .map(|value| env::split_paths(&value).collect::<Vec<PathBuf>>())
            .unwrap_or_default();
        Self::discover_with_roots(data_dir, settings, &roots)
    }

    pub fn discover_with_roots(data_dir: &Path, settings: &Value, roots: &[PathBuf]) -> Self {
        let directory = data_dir.join("plugins");
        let mut candidates = vec![bundled_gemini(), bundled_codex_preview()];
        let mut folders = BTreeSet::new();
        folders.extend(plugin_folders(&directory, MAX_PLUGINS));
        for root in roots {
            if folders.len() == MAX_PLUGINS {
                break;
            }
            folders.extend(plugin_folders(root, MAX_PLUGINS - folders.len()));
        }
        for folder in folders.into_iter().take(MAX_PLUGINS) {
            candidates.push(read_plugin(&folder));
        }
        Self::from_candidates(
            candidates,
            directory.to_string_lossy().into_owned(),
            settings,
        )
    }

    fn from_candidates(
        mut candidates: Vec<Candidate>,
        directory: String,
        settings: &Value,
    ) -> Self {
        let enabled = settings.get("plugins").and_then(Value::as_object);
        candidates.sort_by(|a, b| {
            a.info
                .id
                .cmp(&b.info.id)
                .then(a.info.source.cmp(&b.info.source))
        });

        let mut accepted_ids: BTreeMap<String, String> = crate::providers::BUILTIN_AGENTS
            .iter()
            .map(|agent| (agent.id.to_owned(), "built-in agent".to_owned()))
            .collect();
        let mut accepted_plugins = BTreeSet::new();
        let mut agents = Vec::new();
        let mut browser_bindings = Vec::new();
        for plugin in &mut candidates {
            let explicit = enabled
                .and_then(|all| all.get(&plugin.info.id))
                .and_then(|entry| entry.get("enabled"))
                .and_then(Value::as_bool);
            plugin.info.enabled = explicit.unwrap_or(plugin.info.source == "bundled");
            if plugin.fatal {
                continue;
            }
            if !accepted_plugins.insert(plugin.info.id.clone()) {
                plugin.info.issues.push(format!(
                    "plugin id '{}' collides with an earlier plugin",
                    plugin.info.id
                ));
                continue;
            }
            let mut candidate_ids = BTreeSet::new();
            for agent in &plugin.descriptors {
                if let Some(owner) = accepted_ids.get(&agent.id) {
                    plugin
                        .info
                        .issues
                        .push(format!("agent id '{}' collides with {owner}", agent.id));
                    plugin.fatal = true;
                    break;
                }
                if !candidate_ids.insert(agent.id.clone()) {
                    plugin.info.issues.push(format!(
                        "agent id '{}' is declared more than once by this plugin",
                        agent.id
                    ));
                    plugin.fatal = true;
                    break;
                }
            }
            if plugin.fatal {
                continue;
            }
            for id in candidate_ids {
                accepted_ids.insert(id, format!("plugin '{}'", plugin.info.id));
            }
            if plugin.info.enabled {
                agents.extend(plugin.descriptors.clone());
            }
            for binding in &mut plugin.browser_bindings {
                binding.enabled = plugin.info.enabled;
                binding.selected = enabled
                    .and_then(|all| all.get(&plugin.info.id))
                    .and_then(|entry| entry.get("browserBindings"))
                    .and_then(|bindings| bindings.get(&binding.id))
                    .and_then(|entry| entry.get("selected"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
            for binding in &mut plugin.info.browser_bindings {
                binding.enabled = plugin.info.enabled;
                binding.selected = enabled
                    .and_then(|all| all.get(&plugin.info.id))
                    .and_then(|entry| entry.get("browserBindings"))
                    .and_then(|bindings| bindings.get(&binding.id))
                    .and_then(|entry| entry.get("selected"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
            browser_bindings.extend(plugin.browser_bindings.clone());
        }
        for plugin in &mut candidates {
            for binding in &mut plugin.info.browser_bindings {
                let matching = browser_bindings
                    .iter()
                    .filter(|candidate| {
                        candidate.provider_id == binding.provider_id
                            && candidate.transport == binding.transport
                    })
                    .collect::<Vec<_>>();
                let enabled = matching
                    .iter()
                    .filter(|candidate| candidate.enabled)
                    .collect::<Vec<_>>();
                binding.availability = if !binding.enabled {
                    "disabled".into()
                } else if !supports_mcp_stdio(&binding.provider_id, &agents) {
                    "unsupported_transport".into()
                } else if enabled.len() == 1
                    || (enabled.len() > 1
                        && enabled
                            .iter()
                            .filter(|candidate| candidate.selected)
                            .count()
                            == 1
                        && binding.selected)
                {
                    "eligible".into()
                } else {
                    "conflict".into()
                };
            }
        }
        Self {
            list: PluginList {
                directory,
                plugins: candidates
                    .into_iter()
                    .map(|candidate| candidate.info)
                    .collect(),
            },
            agents,
            browser_bindings,
        }
    }

    pub fn known_plugin(&self, agent_id: &str) -> Option<&str> {
        self.list
            .plugins
            .iter()
            .find(|plugin| plugin.agents.iter().any(|agent| agent.id == agent_id))
            .map(|plugin| plugin.id.as_str())
    }

    /// Checks whether a binding that was already granted to a live session remains
    /// enabled and usable. Selection and cross-plugin conflicts only decide the
    /// binding for a future session, so they intentionally do not affect this check.
    pub fn browser_binding_enabled(
        &self,
        plugin_id: &str,
        binding_id: &str,
        provider_id: &str,
    ) -> bool {
        self.browser_bindings.iter().any(|binding| {
            binding.plugin_id == plugin_id
                && binding.id == binding_id
                && binding.provider_id == provider_id
                && binding.enabled
                && binding.transport == "mcp-stdio"
                && supports_mcp_stdio(provider_id, &self.agents)
        })
    }

    /// Resolves one provider's preview binding without filesystem-order
    /// precedence. A unique enabled binding is automatic; a conflict requires
    /// exactly one persisted user selection.
    pub fn browser_binding_for_provider(
        &self,
        provider_id: &str,
        transport: &str,
    ) -> BrowserBindingResolution {
        let provider_matches = self
            .browser_bindings
            .iter()
            .filter(|binding| binding.provider_id == provider_id)
            .collect::<Vec<_>>();
        if provider_matches.is_empty() {
            return BrowserBindingResolution::None;
        }
        let transport_matches = provider_matches
            .into_iter()
            .filter(|binding| binding.transport == transport)
            .collect::<Vec<_>>();
        if transport_matches.is_empty() {
            return BrowserBindingResolution::UnsupportedTransport;
        }
        let enabled = transport_matches
            .into_iter()
            .filter(|binding| binding.enabled)
            .collect::<Vec<_>>();
        if enabled.is_empty() {
            return BrowserBindingResolution::Disabled;
        }
        if !supports_mcp_stdio(provider_id, &self.agents) {
            return BrowserBindingResolution::UnsupportedTransport;
        }
        if enabled.len() == 1 {
            return BrowserBindingResolution::Eligible(enabled[0].clone());
        }
        let selected = enabled
            .into_iter()
            .filter(|binding| binding.selected)
            .collect::<Vec<_>>();
        if selected.len() == 1 {
            BrowserBindingResolution::Eligible(selected[0].clone())
        } else {
            BrowserBindingResolution::Conflict
        }
    }
}

fn supports_mcp_stdio(provider_id: &str, agents: &[AgentDescriptor]) -> bool {
    matches!(provider_id, "codex" | "claude" | "kimi" | "grok" | "gemini")
        || agents
            .iter()
            .any(|agent| agent.id == provider_id && agent.chat_args.is_some())
}

#[derive(Debug)]
struct Candidate {
    info: PluginInfo,
    descriptors: Vec<AgentDescriptor>,
    browser_bindings: Vec<BrowserBinding>,
    fatal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    publisher: Option<String>,
    description: Option<String>,
    homepage: Option<String>,
    #[serde(default)]
    contributes: Contributions,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contributions {
    #[serde(default)]
    agents: Vec<ManifestAgent>,
    #[serde(default)]
    browser_bindings: Vec<ManifestBrowserBinding>,
    #[serde(flatten)]
    unknown: BTreeMap<String, Value>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestBrowserBinding {
    id: String,
    binding_version: u32,
    provider_id: String,
    requires: BTreeMap<String, u32>,
    transport: String,
    tools: Vec<String>,
    workflow: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAgent {
    id: String,
    name: String,
    icon: Option<String>,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    version_args: Option<Vec<String>>,
    terminal: Option<Value>,
    chat: Option<Chat>,
    sign_in: Option<SignIn>,
    homepage: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Chat {
    protocol: String,
    #[serde(default)]
    args: Vec<String>,
}
#[derive(Debug, Deserialize)]
struct SignIn {
    #[serde(default)]
    args: Vec<String>,
}

fn bundled_gemini() -> Candidate {
    read_manifest(
        "bundled-gemini",
        None,
        include_str!("../plugins/gemini/threadterm-plugin.json").as_bytes(),
        Some(include_bytes!("../plugins/gemini/icon.svg")),
        "bundled",
    )
}

fn bundled_codex_preview() -> Candidate {
    read_manifest(
        "bundled-codex-preview",
        None,
        include_str!("../plugins/codex-preview/threadterm-plugin.json").as_bytes(),
        None,
        "bundled",
    )
}

fn read_plugin(folder: &Path) -> Candidate {
    let manifest = folder.join(MANIFEST);
    let display = folder.to_string_lossy().into_owned();
    let bytes = match read_limited(&manifest, MAX_MANIFEST_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => return invalid_candidate("unknown", "user", Some(display), error),
    };
    read_manifest(&display, Some(folder), &bytes, None, "user")
}

fn read_manifest(
    label: &str,
    directory: Option<&Path>,
    bytes: &[u8],
    bundled_icon: Option<&[u8]>,
    source: &str,
) -> Candidate {
    let manifest: Manifest = match serde_json::from_slice(bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            return invalid_candidate(
                "unknown",
                source,
                directory.map(|path| path.to_string_lossy().into_owned()),
                format!("invalid manifest: {error}"),
            )
        }
    };
    let path = directory.map(|path| path.to_string_lossy().into_owned());
    let mut info = PluginInfo {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        publisher: manifest.publisher.clone(),
        description: manifest.description.clone(),
        homepage: manifest.homepage.clone(),
        source: source.into(),
        enabled: source == "bundled",
        path,
        agents: Vec::new(),
        browser_bindings: Vec::new(),
        issues: Vec::new(),
    };
    let mut fatal = false;
    if manifest.schema_version != 1 {
        info.issues.push(format!(
            "schemaVersion {} is not supported by this ThreadTerm",
            manifest.schema_version
        ));
        fatal = true;
    }
    if !valid_plugin_id(&manifest.id) {
        info.issues
            .push("plugin id must match ^[a-z0-9][a-z0-9.-]{1,63}$".into());
        fatal = true;
    }
    validate_text(&manifest.name, 60, "name", &mut info.issues);
    fatal |= info.name.is_empty() || info.name.chars().count() > 60 || has_control(&info.name);
    if let Some(value) = &manifest.description {
        validate_text(value, 500, "description", &mut info.issues);
        fatal |= value.is_empty() || value.chars().count() > 500 || has_control(value);
    }
    if manifest.contributes.agents.len() > MAX_AGENTS {
        info.issues
            .push("a plugin can contribute at most 8 agents".into());
        fatal = true;
    }
    if manifest.contributes.browser_bindings.len() > MAX_BROWSER_BINDINGS {
        info.issues
            .push("a plugin can contribute at most 8 browser bindings".into());
        fatal = true;
    }
    for kind in manifest.contributes.unknown.keys() {
        info.issues.push(format!(
            "contribution type '{kind}' is not supported by this ThreadTerm"
        ));
    }
    if fatal {
        return Candidate {
            info,
            descriptors: Vec::new(),
            browser_bindings: Vec::new(),
            fatal,
        };
    }
    let canonical = directory.and_then(|path| path.canonicalize().ok());
    if directory.is_some() && canonical.is_none() {
        info.issues
            .push(format!("cannot canonicalize plugin folder {label}"));
        return Candidate {
            info,
            descriptors: Vec::new(),
            browser_bindings: Vec::new(),
            fatal: true,
        };
    }
    let mut descriptors = Vec::new();
    let mut browser_bindings = Vec::new();
    let mut agent_ids = BTreeSet::new();
    for agent in manifest.contributes.agents {
        if !agent_ids.insert(agent.id.clone()) {
            info.issues.push(format!(
                "agent id '{}' is declared more than once by this plugin",
                agent.id
            ));
            fatal = true;
            continue;
        }
        match validate_agent(
            agent,
            &manifest.id,
            source == "bundled",
            canonical.as_deref(),
            bundled_icon,
            manifest.homepage.as_deref(),
        ) {
            Ok((descriptor, public)) => {
                info.agents.push(public);
                descriptors.push(descriptor);
            }
            Err(error) => {
                info.issues.push(error);
                fatal = true;
            }
        }
    }
    let mut binding_ids = BTreeSet::new();
    for binding in manifest.contributes.browser_bindings {
        if !binding_ids.insert(binding.id.clone()) {
            info.issues.push(format!(
                "browser binding id '{}' is declared more than once by this plugin",
                binding.id
            ));
            continue;
        }
        match validate_browser_binding(binding, &manifest.id) {
            Ok((binding, public)) => {
                info.browser_bindings.push(public);
                browser_bindings.push(binding);
            }
            Err(error) => info.issues.push(error),
        }
    }
    if info.agents.is_empty() && info.browser_bindings.is_empty() {
        info.issues
            .push("plugin contributes zero valid contributions".into());
        fatal = true;
    }
    if fatal {
        descriptors.clear();
        info.agents.clear();
        browser_bindings.clear();
        info.browser_bindings.clear();
    }
    Candidate {
        info,
        descriptors,
        browser_bindings,
        fatal,
    }
}

fn validate_browser_binding(
    binding: ManifestBrowserBinding,
    plugin_id: &str,
) -> Result<(BrowserBinding, BrowserBindingInfo), String> {
    if !valid_binding_id(&binding.id) {
        return Err(format!("browser binding id '{}' is invalid", binding.id));
    }
    if !valid_agent_id(&binding.provider_id) {
        return Err(format!(
            "browser binding providerId '{}' is invalid",
            binding.provider_id
        ));
    }
    if binding.binding_version != 1 {
        return Err(format!(
            "browser binding '{}' version {} is not supported by this ThreadTerm",
            binding.id, binding.binding_version
        ));
    }
    if binding.requires.len() != 1 || binding.requires.get("threadterm.preview") != Some(&1) {
        return Err(format!(
            "browser binding '{}' requires unsupported runtime capabilities",
            binding.id
        ));
    }
    if binding.transport != "mcp-stdio" {
        return Err(format!(
            "browser binding '{}' transport '{}' is not supported",
            binding.id, binding.transport
        ));
    }
    let expected_tools = BTreeSet::from(["preview_present", "preview_status"]);
    let tools = binding
        .tools
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if tools != expected_tools || binding.tools.len() != expected_tools.len() {
        return Err(format!(
            "browser binding '{}' must declare exactly preview_present and preview_status",
            binding.id
        ));
    }
    if binding.workflow != "threadterm.preview.after-server-ready.v1" {
        return Err(format!(
            "browser binding '{}' workflow '{}' is not supported",
            binding.id, binding.workflow
        ));
    }
    let public = BrowserBindingInfo {
        id: binding.id.clone(),
        binding_version: binding.binding_version,
        provider_id: binding.provider_id.clone(),
        requires: binding.requires.clone(),
        transport: binding.transport.clone(),
        tools: binding.tools.clone(),
        workflow: binding.workflow.clone(),
        enabled: false,
        selected: false,
        availability: "disabled".into(),
    };
    let internal = BrowserBinding {
        plugin_id: plugin_id.to_owned(),
        id: binding.id,
        binding_version: binding.binding_version,
        provider_id: binding.provider_id,
        requires: binding.requires,
        transport: binding.transport,
        tools: binding.tools,
        workflow: binding.workflow,
        enabled: false,
        selected: false,
    };
    Ok((internal, public))
}

fn validate_agent(
    agent: ManifestAgent,
    plugin_id: &str,
    bundled: bool,
    directory: Option<&Path>,
    bundled_icon: Option<&[u8]>,
    plugin_homepage: Option<&str>,
) -> Result<(AgentDescriptor, PluginAgentInfo), String> {
    if !valid_agent_id(&agent.id)
        || RESERVED_IDS.contains(&agent.id.as_str())
        || ((crate::providers::BUILTIN_AGENTS
            .iter()
            .any(|builtin| builtin.id == agent.id)
            || agent.id == "gemini")
            && !(bundled && plugin_id == "gemini" && agent.id == "gemini"))
    {
        return Err(format!("agent id '{}' is invalid or reserved", agent.id));
    }
    validate_text(&agent.name, 60, "agent name", &mut Vec::new());
    if agent.name.is_empty() || agent.name.chars().count() > 60 || has_control(&agent.name) {
        return Err("agent name must be 1–60 characters without control characters".into());
    }
    validate_command(&agent.command, directory)?;
    validate_args(&agent.args, "args")?;
    let version_args = agent
        .version_args
        .unwrap_or_else(|| vec!["--version".into()]);
    validate_args(&version_args, "versionArgs")?;
    let terminal = match agent.terminal {
        Some(Value::Bool(false)) => None,
        Some(value) => {
            let value: TerminalWire =
                serde_json::from_value(value).map_err(|_| "terminal must be false or an object")?;
            validate_args(&value.args, "terminal.args")?;
            validate_args(&value.resume_args, "terminal.resumeArgs")?;
            if !value.resume_args.is_empty() {
                validate_resume_args(&value.resume_args)?;
            }
            Some(TerminalConfig {
                args: value.args,
                resume_args: value.resume_args,
            })
        }
        None => Some(TerminalConfig {
            args: Vec::new(),
            resume_args: Vec::new(),
        }),
    };
    let chat_args = match agent.chat {
        Some(chat) if chat.protocol == "acp" => {
            validate_args(&chat.args, "chat.args")?;
            Some(chat.args)
        }
        Some(_) => return Err("chat.protocol must be 'acp' in schema v1".into()),
        None => None,
    };
    let sign_in_args = agent.sign_in.map(|sign_in| sign_in.args);
    if let Some(args) = &sign_in_args {
        validate_args(args, "signIn.args")?;
    }
    let icon = match (directory, agent.icon.as_deref(), bundled_icon) {
        (Some(dir), Some(icon), _) => Some(read_icon(dir, icon)?),
        (None, Some(_), Some(bytes)) => Some(icon_data_url(bytes)?),
        (None, None, _) => None,
        (Some(_), None, _) => None,
        _ => return Err("bundled agent icon is unavailable".into()),
    };
    let descriptor = AgentDescriptor {
        id: agent.id.clone(),
        name: agent.name.clone(),
        plugin_id: Some(plugin_id.to_owned()),
        icon,
        homepage: agent
            .homepage
            .or_else(|| plugin_homepage.map(str::to_owned)),
        command: agent.command,
        args: agent.args,
        version_args,
        terminal,
        chat_args,
        sign_in_args,
        plugin_dir: directory.map(Path::to_owned),
    };
    let commands = public_commands(&descriptor)?;
    let public = PluginAgentInfo {
        id: descriptor.id.clone(),
        name: descriptor.name.clone(),
        terminal: descriptor.terminal.is_some(),
        chat: descriptor.chat_args.is_some(),
        commands,
    };
    Ok((descriptor, public))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWire {
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    resume_args: Vec<String>,
}

fn public_commands(agent: &AgentDescriptor) -> Result<Vec<String>, String> {
    let mut lines = vec![display_line(agent, &agent.args)];
    lines.push(display_line(
        agent,
        &[agent.args.clone(), agent.version_args.clone()].concat(),
    ));
    if let Some(terminal) = &agent.terminal {
        lines.push(display_line(
            agent,
            &[agent.args.clone(), terminal.args.clone()].concat(),
        ));
        if !terminal.resume_args.is_empty() {
            lines.push(display_line(
                agent,
                &[
                    agent.args.clone(),
                    terminal.args.clone(),
                    terminal.resume_args.clone(),
                ]
                .concat(),
            ));
        }
    }
    if let Some(chat) = &agent.chat_args {
        lines.push(display_line(
            agent,
            &[agent.args.clone(), chat.clone()].concat(),
        ));
    }
    if let Some(sign_in) = &agent.sign_in_args {
        lines.push(display_line(
            agent,
            &[agent.args.clone(), sign_in.clone()].concat(),
        ));
    }
    lines.sort();
    lines.dedup();
    Ok(lines)
}
fn display_line(agent: &AgentDescriptor, args: &[String]) -> String {
    std::iter::once(
        agent
            .expand(&agent.command)
            .unwrap_or_else(|_| agent.command.clone()),
    )
    .chain(
        args.iter()
            .map(|arg| agent.expand(arg).unwrap_or_else(|_| arg.clone())),
    )
    .map(|part| part.to_owned())
    .collect::<Vec<_>>()
    .join(" ")
}
fn read_icon(dir: &Path, icon: &str) -> Result<String, String> {
    if !icon.ends_with(".svg") {
        return Err("icon must be an .svg file".into());
    }
    let path = safe_plugin_path(dir, icon)?;
    icon_data_url(&read_limited(&path, MAX_ICON_BYTES)?)
}
fn read_limited(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let file =
        fs::File::open(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(maximum as usize + 1);
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.len() as u64 > maximum {
        Err(if path.file_name().is_some_and(|name| name == MANIFEST) {
            "manifest exceeds 64 KiB".into()
        } else {
            "icon exceeds 64 KiB".into()
        })
    } else {
        Ok(bytes)
    }
}
fn icon_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_ICON_BYTES {
        return Err("icon exceeds 64 KiB".into());
    }
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(bytes)
    ))
}
fn safe_plugin_path(dir: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || is_absolute_like(value)
        || Path::new(value)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("plugin file paths must be relative and must not contain '..'".into());
    }
    let candidate = dir
        .join(value)
        .canonicalize()
        .map_err(|error| format!("cannot resolve plugin file: {error}"))?;
    if !candidate.starts_with(dir) {
        return Err("plugin file must stay inside its plugin folder".into());
    }
    Ok(candidate)
}
fn validate_command(command: &str, dir: Option<&Path>) -> Result<(), String> {
    validate_arg(command, "command")?;
    if command.is_empty() || command.chars().any(char::is_whitespace) {
        return Err("command must be a non-empty executable name without whitespace".into());
    }
    validate_placeholders(command, false)?;
    if command.contains("{sessionId}") {
        return Err("{sessionId} is only allowed in resumeArgs".into());
    }
    if command.contains("{pluginDir}") {
        let dir = dir.ok_or("{pluginDir} is unavailable for this plugin")?;
        let suffix = command
            .strip_prefix("{pluginDir}/")
            .or_else(|| command.strip_prefix("{pluginDir}\\"))
            .ok_or("{pluginDir} must be followed by a relative path")?;
        safe_plugin_path(dir, suffix)?;
    } else if is_absolute_like(command)
        || command.contains('/')
        || command.contains('\\')
        || command.contains("..")
    {
        return Err("command must be a bare executable or {pluginDir}/relative/path".into());
    }
    Ok(())
}
fn validate_args(args: &[String], field: &str) -> Result<(), String> {
    if args.len() > MAX_ARGS {
        return Err(format!("{field} may contain at most {MAX_ARGS} arguments"));
    }
    for arg in args {
        validate_arg(arg, field)?;
        validate_placeholders(arg, field == "terminal.resumeArgs")?;
        if arg.contains("{sessionId}") && field != "terminal.resumeArgs" {
            return Err("{sessionId} is only allowed in resumeArgs".into());
        }
    }
    Ok(())
}
fn validate_placeholders(value: &str, session_allowed: bool) -> Result<(), String> {
    let mut remainder = value.replace("{pluginDir}", "");
    if session_allowed {
        remainder = remainder.replace("{sessionId}", "");
    }
    if remainder.contains('{') || remainder.contains('}') {
        return Err("only {pluginDir} and {sessionId} placeholders are supported".into());
    }
    Ok(())
}
fn is_absolute_like(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || value.as_bytes().get(1) == Some(&b':')
}
fn validate_arg(value: &str, field: &str) -> Result<(), String> {
    if value.chars().count() > MAX_ARG_CHARS || has_control(value) {
        Err(format!("{field} arguments must be at most {MAX_ARG_CHARS} characters without control characters"))
    } else {
        Ok(())
    }
}
fn validate_resume_args(args: &[String]) -> Result<(), String> {
    let count = args
        .iter()
        .map(|arg| arg.matches("{sessionId}").count())
        .sum::<usize>();
    if count == 1 {
        Ok(())
    } else {
        Err("resumeArgs must contain {sessionId} exactly once".into())
    }
}
fn valid_plugin_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}
fn valid_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}
fn valid_binding_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}
fn validate_text(value: &str, max: usize, name: &str, issues: &mut Vec<String>) {
    if value.is_empty() || value.chars().count() > max || has_control(value) {
        issues.push(format!(
            "{name} must be 1–{max} characters without control characters"
        ));
    }
}
fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}
fn plugin_folders(root: &Path, limit: usize) -> Vec<PathBuf> {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .and_then(|_| entry.path().canonicalize().ok())
        })
        .take(limit)
        .collect()
}
fn invalid_candidate(
    id: &str,
    source: &str,
    path: Option<String>,
    issue: impl Into<String>,
) -> Candidate {
    Candidate {
        info: PluginInfo {
            id: id.into(),
            name: id.into(),
            version: "".into(),
            publisher: None,
            description: None,
            homepage: None,
            source: source.into(),
            enabled: source == "bundled",
            path,
            agents: Vec::new(),
            browser_bindings: Vec::new(),
            issues: vec![issue.into()],
        },
        descriptors: Vec::new(),
        browser_bindings: Vec::new(),
        fatal: true,
    }
}

/// Adapter for a manifest agent that only provides a terminal command line.
pub struct ManifestTerminalAdapter {
    descriptor: AgentDescriptor,
}
impl ManifestTerminalAdapter {
    pub fn new(descriptor: AgentDescriptor) -> Self {
        Self { descriptor }
    }
}
impl ProviderAdapter for ManifestTerminalAdapter {
    fn id(&self) -> &str {
        &self.descriptor.id
    }
    fn capability(&self) -> ProviderCapability {
        let (installed, version, reason) = self.descriptor.version_probe();
        ProviderCapability {
            id: self.descriptor.id.clone(),
            name: self.descriptor.name.clone(),
            installed,
            version,
            terminal: installed && self.descriptor.terminal.is_some(),
            chat: false,
            history: false,
            resume: installed
                && self
                    .descriptor
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| !terminal.resume_args.is_empty()),
            terminal_resume_capture: "none",
            reason,
            auth: "unknown".into(),
            source: "plugin",
            plugin_id: self.descriptor.plugin_id.clone(),
            icon: self.descriptor.icon.clone(),
            sign_in: self.descriptor.sign_in(),
            homepage: self.descriptor.homepage.clone(),
        }
    }
    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        self.descriptor.terminal_command(resume_id, assign_id)
    }
    fn terminal_capture(&self) -> TerminalCapture {
        TerminalCapture::None
    }
    fn history_list(
        &self,
        _: Option<&str>,
        _: u32,
        _: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Err(ProviderError::new(
            "provider_unsupported",
            "This plugin agent has no chat history",
        ))
    }
    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        Err(ProviderError::new(
            "provider_unsupported",
            "This plugin agent has no chat history",
        ))
    }
    fn open_chat(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        Err(ProviderError::new(
            "provider_unsupported",
            "This plugin agent does not support chat",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn valid_manifest() -> String {
        r#"{
          "schemaVersion":1,"id":"echo-acp","name":"Echo","version":"0.1.0",
          "contributes":{"agents":[{
            "id":"echo","name":"Echo","icon":"icon.svg","command":"node",
            "args":["{pluginDir}/agent.mjs"],"terminal":{"args":[],"resumeArgs":["--resume","{sessionId}"]},
            "chat":{"protocol":"acp","args":["--acp"]}
          }]}
        }"#.to_owned()
    }

    fn user_candidate(manifest: &str) -> Candidate {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("agent.mjs"), "").unwrap();
        fs::write(temp.path().join("icon.svg"), "<svg/>").unwrap();
        // Keep the directory alive by parsing within this function.
        read_manifest(
            "fixture",
            Some(temp.path()),
            manifest.as_bytes(),
            None,
            "user",
        )
    }

    fn write_plugin(root: &Path, folder: &str, manifest: &str) -> PathBuf {
        let plugin = root.join(folder);
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join(MANIFEST), manifest).unwrap();
        fs::write(plugin.join("agent.mjs"), "").unwrap();
        fs::write(plugin.join("icon.svg"), "<svg/>").unwrap();
        plugin
    }

    #[test]
    fn accepts_a_complete_acp_manifest() {
        let candidate = user_candidate(&valid_manifest());
        assert!(
            candidate.info.issues.is_empty(),
            "{:?}",
            candidate.info.issues
        );
        assert_eq!(candidate.descriptors.len(), 1);
        assert!(candidate.info.agents[0].terminal);
        assert!(candidate.info.agents[0].chat);
        assert_eq!(candidate.info.agents[0].commands.len(), 4);
    }

    fn binding_manifest(id: &str, provider_id: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"id":"{id}","name":"Binding","version":"1","contributes":{{"browserBindings":[{{"id":"preview","bindingVersion":1,"providerId":"{provider_id}","requires":{{"threadterm.preview":1}},"transport":"mcp-stdio","tools":["preview_present","preview_status"],"workflow":"threadterm.preview.after-server-ready.v1"}}]}}}}"#
        )
    }

    #[test]
    fn accepts_binding_only_plugin_and_resolves_a_unique_enabled_binding() {
        let root = tempdir().unwrap();
        write_plugin(
            &root.path().join("plugins"),
            "binding-only",
            &binding_manifest("binding-only", "grok"),
        );
        let registry = PluginRegistry::discover_with_roots(
            root.path(),
            &serde_json::json!({"plugins":{"binding-only":{"enabled":true}}}),
            &[],
        );
        let plugin = registry
            .list
            .plugins
            .iter()
            .find(|plugin| plugin.id == "binding-only")
            .unwrap();
        assert!(plugin.agents.is_empty());
        assert_eq!(plugin.browser_bindings.len(), 1);
        assert_eq!(plugin.browser_bindings[0].availability, "eligible");
        match registry.browser_binding_for_provider("grok", "mcp-stdio") {
            BrowserBindingResolution::Eligible(binding) => {
                assert_eq!(binding.plugin_id, "binding-only");
            }
            other => panic!("unexpected resolution: {other:?}"),
        }
    }

    #[test]
    fn binding_conflicts_need_one_explicit_selection_and_disable_revokes_them() {
        let root = tempdir().unwrap();
        for id in ["first-binding", "second-binding"] {
            write_plugin(
                &root.path().join("plugins"),
                id,
                &binding_manifest(id, "grok"),
            );
        }
        let settings = serde_json::json!({"plugins":{
            "first-binding":{"enabled":true},
            "second-binding":{"enabled":true}
        }});
        let registry = PluginRegistry::discover_with_roots(root.path(), &settings, &[]);
        assert_eq!(
            registry.browser_binding_for_provider("grok", "mcp-stdio"),
            BrowserBindingResolution::Conflict
        );
        assert!(registry.browser_binding_enabled("first-binding", "preview", "grok"));
        let settings = serde_json::json!({"plugins":{
            "first-binding":{"enabled":true,"browserBindings":{"preview":{"selected":true}}},
            "second-binding":{"enabled":true}
        }});
        let registry = PluginRegistry::discover_with_roots(root.path(), &settings, &[]);
        match registry.browser_binding_for_provider("grok", "mcp-stdio") {
            BrowserBindingResolution::Eligible(binding) => {
                assert_eq!(binding.plugin_id, "first-binding")
            }
            other => panic!("unexpected resolution: {other:?}"),
        }
        let disabled = PluginRegistry::discover_with_roots(
            root.path(),
            &serde_json::json!({"plugins":{
                "first-binding":{"enabled":false},
                "second-binding":{"enabled":true}
            }}),
            &[],
        );
        assert!(!disabled.browser_binding_enabled("first-binding", "preview", "grok"));
    }

    #[test]
    fn bindings_without_an_mcp_stdio_provider_are_reported_as_unsupported() {
        let root = tempdir().unwrap();
        write_plugin(
            &root.path().join("plugins"),
            "terminal-only-binding",
            &binding_manifest("terminal-only-binding", "opencode"),
        );
        let registry = PluginRegistry::discover_with_roots(
            root.path(),
            &serde_json::json!({"plugins":{"terminal-only-binding":{"enabled":true}}}),
            &[],
        );
        assert_eq!(
            registry.browser_binding_for_provider("opencode", "mcp-stdio"),
            BrowserBindingResolution::UnsupportedTransport
        );
        let plugin = registry
            .list
            .plugins
            .iter()
            .find(|plugin| plugin.id == "terminal-only-binding")
            .unwrap();
        assert_eq!(plugin.browser_bindings[0].availability, "unsupported_transport");
    }

    #[test]
    fn invalid_browser_bindings_do_not_make_agent_contributions_unavailable() {
        let manifest = valid_manifest().replace(
            "\"agents\":[",
            "\"browserBindings\":[{\"id\":\"bad\",\"bindingVersion\":2,\"providerId\":\"echo\",\"requires\":{\"threadterm.preview\":1},\"transport\":\"mcp-stdio\",\"tools\":[\"preview_present\",\"preview_status\"],\"workflow\":\"threadterm.preview.after-server-ready.v1\"}],\"agents\":[",
        );
        let candidate = user_candidate(&manifest);
        assert!(!candidate.fatal);
        assert_eq!(candidate.info.agents.len(), 1);
        assert!(candidate.info.browser_bindings.is_empty());
        assert!(candidate
            .info
            .issues
            .iter()
            .any(|issue| issue.contains("version 2")));
    }

    #[test]
    fn bundled_codex_preview_is_enabled_and_has_no_agent_descriptor() {
        let registry = PluginRegistry::bundled();
        let plugin = registry
            .list
            .plugins
            .iter()
            .find(|plugin| plugin.id == "codex-preview")
            .unwrap();
        assert!(plugin.enabled);
        assert!(plugin.agents.is_empty());
        assert_eq!(plugin.browser_bindings[0].provider_id, "codex");
    }

    #[test]
    fn rejects_schema_ids_and_placeholder_misuse() {
        for (from, to) in [
            ("\"schemaVersion\":1", "\"schemaVersion\":2"),
            ("\"id\":\"echo-acp\"", "\"id\":\"bad_id\""),
            ("\"id\":\"echo\"", "\"id\":\"codex\""),
            ("\"--acp\"", "\"{sessionId}\""),
        ] {
            let candidate = user_candidate(&valid_manifest().replace(from, to));
            assert!(!candidate.info.issues.is_empty());
        }
    }

    #[test]
    fn rejects_paths_outside_the_plugin_folder_and_unknown_chat_protocol() {
        for (from, to) in [
            (
                "\"command\":\"node\"",
                "\"command\":\"{pluginDir}/../outside.mjs\"",
            ),
            ("\"protocol\":\"acp\"", "\"protocol\":\"other\""),
        ] {
            let candidate = user_candidate(&valid_manifest().replace(from, to));
            assert!(!candidate.info.issues.is_empty());
        }
    }

    #[test]
    fn rejects_invalid_commands_placeholders_and_limits() {
        for (from, to) in [
            ("\"command\":\"node\"", "\"command\":\"\""),
            ("\"command\":\"node\"", "\"command\":\"C:node\""),
            ("\"command\":\"node\"", "\"command\":\"{unknown}\""),
            ("\"--acp\"", "\"--flag={unknown}\""),
        ] {
            let candidate = user_candidate(&valid_manifest().replace(from, to));
            assert!(!candidate.info.issues.is_empty());
        }
        let args = (0..33).map(|_| "\"x\"").collect::<Vec<_>>().join(",");
        let candidate = user_candidate(
            &valid_manifest().replace("[\"{pluginDir}/agent.mjs\"]", &format!("[{args}]")),
        );
        assert!(!candidate.info.issues.is_empty());
    }

    #[test]
    fn rejects_each_argument_list_limit_and_invalid_argument_form() {
        let too_many = (0..33).map(|_| "\"x\"").collect::<Vec<_>>().join(",");
        let too_long = "x".repeat(513);
        let control = "bad\\nvalue";
        for field in [
            "args",
            "versionArgs",
            "terminal.args",
            "terminal.resumeArgs",
            "chat.args",
            "signIn.args",
        ] {
            for value in [
                &format!("[{too_many}]"),
                &format!("[\"{too_long}\"]"),
                &format!("[\"{control}\"]"),
            ] {
                let mut manifest = valid_manifest();
                match field {
                    "args" => manifest = manifest.replace("[\"{pluginDir}/agent.mjs\"]", value),
                    "versionArgs" => {
                        manifest = manifest.replace(
                            "\"terminal\":",
                            &format!("\"versionArgs\":{value},\"terminal\":"),
                        )
                    }
                    "terminal.args" => {
                        manifest = manifest.replace("\"args\":[]", &format!("\"args\":{value}"))
                    }
                    "terminal.resumeArgs" => {
                        manifest = manifest.replace("[\"--resume\",\"{sessionId}\"]", value)
                    }
                    "chat.args" => manifest = manifest.replace("[\"--acp\"]", value),
                    "signIn.args" => {
                        manifest = manifest.replace(
                            "\"chat\":",
                            &format!("\"signIn\":{{\"args\":{value}}},\"chat\":"),
                        )
                    }
                    _ => unreachable!(),
                }
                assert!(user_candidate(&manifest).fatal, "{field}: {value}");
            }
        }
    }

    #[test]
    fn rejects_metadata_agent_and_resume_limits() {
        let replacements = vec![
            (
                "\"name\":\"Echo\"".to_owned(),
                format!("\"name\":\"{}\"", "n".repeat(61)),
            ),
            (
                "\"version\":\"0.1.0\",".to_owned(),
                format!(
                    "\"version\":\"0.1.0\",\"description\":\"{}\",",
                    "d".repeat(501)
                ),
            ),
            (
                "[\"--resume\",\"{sessionId}\"]".to_owned(),
                "[\"--resume\"]".to_owned(),
            ),
            (
                "[\"--resume\",\"{sessionId}\"]".to_owned(),
                "[\"{sessionId}\",\"{sessionId}\"]".to_owned(),
            ),
        ];
        for (from, to) in replacements {
            assert!(user_candidate(&valid_manifest().replace(&from, &to)).fatal);
        }
        for id in [
            "A",
            "a_",
            "shell",
            "custom",
            "threadterm",
            "codex",
            "claude",
            "kimi",
            "opencode",
            "grok",
        ] {
            assert!(
                user_candidate(
                    &valid_manifest().replace("\"id\":\"echo\"", &format!("\"id\":\"{id}\""))
                )
                .fatal,
                "{id}"
            );
        }
    }

    #[test]
    fn rejects_icon_and_manifest_file_limits() {
        let root = tempdir().unwrap();
        let mut boundary = valid_manifest();
        boundary.push_str(&" ".repeat(MAX_MANIFEST_BYTES as usize - boundary.len()));
        let boundary_plugin = write_plugin(root.path(), "manifest-boundary", &boundary);
        assert!(!read_plugin(&boundary_plugin).fatal);
        let plugin = write_plugin(
            root.path(),
            "large-manifest",
            &" ".repeat((MAX_MANIFEST_BYTES + 1) as usize),
        );
        assert!(read_plugin(&plugin).fatal);
        for (icon, setup) in [
            ("icon.png", "<svg/>".to_owned()),
            ("missing.svg", "<svg/>".to_owned()),
            ("icon.svg", "x".repeat((MAX_ICON_BYTES + 1) as usize)),
        ] {
            let folder = format!("icon-{}", icon.replace('.', "-"));
            let plugin = write_plugin(
                root.path(),
                &folder,
                &valid_manifest().replace("icon.svg", icon),
            );
            if icon != "missing.svg" {
                fs::write(plugin.join(icon), setup).unwrap();
            }
            assert!(read_plugin(&plugin).fatal, "{icon}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_icon_symlink_outside_the_plugin_folder() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("outside.svg"), "<svg/>").unwrap();
        let plugin = write_plugin(root.path(), "outside-icon", &valid_manifest());
        fs::remove_file(plugin.join("icon.svg")).unwrap();
        symlink(outside.path().join("outside.svg"), plugin.join("icon.svg")).unwrap();
        assert!(read_plugin(&plugin).fatal);
    }

    #[test]
    fn rejects_too_many_and_duplicate_agents() {
        let agent = r#"{"id":"echo","name":"Echo","command":"node","args":[]}"#;
        let many = std::iter::repeat_n(agent, 9).collect::<Vec<_>>().join(",");
        let too_many = format!(
            r#"{{"schemaVersion":1,"id":"many-agents","name":"Many","version":"1","contributes":{{"agents":[{many}]}}}}"#
        );
        assert!(user_candidate(&too_many).fatal);
        let duplicate = r#"{
          "schemaVersion":1,"id":"duplicate-agents","name":"Duplicate","version":"1",
          "contributes":{"agents":[
            {"id":"echo","name":"Echo","command":"node","args":[]},
            {"id":"echo","name":"Echo again","command":"node","args":[]}
          ]}
        }"#;
        assert!(user_candidate(duplicate).fatal);
    }

    #[test]
    fn scan_is_bounded_to_sixty_four_user_folders() {
        let root = tempdir().unwrap();
        for index in 0..65 {
            let manifest = valid_manifest()
                .replace(
                    "\"id\":\"echo-acp\"",
                    &format!("\"id\":\"plugin-{index:02}\""),
                )
                .replace("\"id\":\"echo\"", &format!("\"id\":\"agent-{index:02}\""));
            write_plugin(
                &root.path().join("plugins"),
                &format!("plugin-{index:02}"),
                &manifest,
            );
        }
        let registry = PluginRegistry::discover_with_roots(root.path(), &Value::Null, &[]);
        assert_eq!(
            registry
                .list
                .plugins
                .iter()
                .filter(|plugin| plugin.source == "user")
                .count(),
            64
        );
    }

    #[test]
    fn invalid_manifest_does_not_reserve_an_unrelated_plugin_id() {
        let root = tempdir().unwrap();
        let plugins = root.path().join("plugins");
        let invalid = plugins.join("broken");
        fs::create_dir_all(&invalid).unwrap();
        fs::write(invalid.join(MANIFEST), "{").unwrap();
        let valid = valid_manifest().replace("\"id\":\"echo-acp\"", "\"id\":\"unknown\"");
        write_plugin(&plugins, "valid", &valid);
        let settings = serde_json::json!({"plugins":{"unknown":{"enabled":true}}});
        let registry = PluginRegistry::discover_with_roots(root.path(), &settings, &[]);
        assert!(registry.agents.iter().any(|agent| agent.id == "echo"));
    }

    #[test]
    fn unknown_contributions_warn_without_disabling_valid_agents() {
        let manifest = valid_manifest().replace("\"agents\":[", "\"themes\":[],\"agents\":[");
        let candidate = user_candidate(&manifest);
        assert!(!candidate.fatal);
        assert_eq!(candidate.descriptors.len(), 1);
        assert_eq!(candidate.info.issues.len(), 1);
    }

    #[test]
    fn terminal_resume_is_optional_and_agent_homepage_inherits_plugin_homepage() {
        let manifest = valid_manifest()
            .replace(
                "\"version\":\"0.1.0\",",
                "\"version\":\"0.1.0\",\"homepage\":\"https://example.test\",",
            )
            .replace(
                "\"terminal\":{\"args\":[],\"resumeArgs\":[\"--resume\",\"{sessionId}\"]}",
                "\"terminal\":{\"args\":[\"--terminal\"]}",
            );
        let candidate = user_candidate(&manifest);
        assert!(
            candidate.info.issues.is_empty(),
            "{:?}",
            candidate.info.issues
        );
        assert_eq!(
            candidate.descriptors[0].terminal.as_ref().unwrap().args,
            vec!["--terminal".to_owned()]
        );
        assert!(candidate.descriptors[0]
            .terminal
            .as_ref()
            .unwrap()
            .resume_args
            .is_empty());
        assert_eq!(
            candidate.descriptors[0].homepage.as_deref(),
            Some("https://example.test")
        );
    }

    #[test]
    fn terminal_only_agent_has_no_chat_capability() {
        let manifest = r#"{
          "schemaVersion":1,"id":"terminal-example","name":"Terminal","version":"1",
          "contributes":{"agents":[{"id":"terminal-example","name":"Terminal","command":"node","args":[]}]}
        }"#;
        let candidate = user_candidate(manifest);
        assert!(
            candidate.info.issues.is_empty(),
            "{:?}",
            candidate.info.issues
        );
        assert!(candidate.descriptors[0].terminal.is_some());
        assert!(candidate.descriptors[0].chat_args.is_none());
    }

    #[test]
    fn plugin_dir_arguments_are_unrestricted_cli_values() {
        let manifest = valid_manifest().replace(
            "[\"{pluginDir}/agent.mjs\"]",
            "[\"--directory={pluginDir}\",\"{pluginDir}/new-output.txt\"]",
        );
        let candidate = user_candidate(&manifest);
        assert!(
            candidate.info.issues.is_empty(),
            "{:?}",
            candidate.info.issues
        );
    }

    #[test]
    fn only_the_bundled_gemini_manifest_may_use_the_gemini_agent_id() {
        let user_manifest = valid_manifest()
            .replace("\"id\":\"echo-acp\"", "\"id\":\"gemini\"")
            .replace("\"id\":\"echo\"", "\"id\":\"gemini\"");
        assert!(user_candidate(&user_manifest).fatal);
        assert!(!bundled_gemini().fatal);
    }

    #[test]
    fn bundled_registry_contains_enabled_gemini_agent_and_codex_binding() {
        let registry = PluginRegistry::bundled();
        assert_eq!(registry.list.directory, "");
        assert_eq!(registry.list.plugins.len(), 2);
        assert!(registry.list.plugins.iter().all(|plugin| plugin.enabled && plugin.issues.is_empty()));
        assert!(registry.list.plugins.iter().any(|plugin| plugin.id == "gemini"));
        assert!(registry.list.plugins.iter().any(|plugin| plugin.id == "codex-preview"));
        assert_eq!(
            registry
                .agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gemini"]
        );
    }

    #[test]
    fn public_commands_include_terminal_and_resume_arguments() {
        let manifest = valid_manifest().replace(
            "\"terminal\":{\"args\":[],\"resumeArgs\":[\"--resume\",\"{sessionId}\"]}",
            "\"terminal\":{\"args\":[\"--terminal\"],\"resumeArgs\":[\"--resume\",\"{sessionId}\"]}",
        );
        let candidate = user_candidate(&manifest);
        assert!(candidate.info.agents[0]
            .commands
            .iter()
            .any(|command| command.contains("--terminal --resume {sessionId}")));
    }

    #[test]
    fn command_path_is_rechecked_at_launch() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("agent.mjs"), "").unwrap();
        let descriptor = AgentDescriptor {
            id: "echo".into(),
            name: "Echo".into(),
            plugin_id: Some("echo-acp".into()),
            icon: None,
            homepage: None,
            command: "{pluginDir}/agent.mjs".into(),
            args: Vec::new(),
            version_args: vec!["--version".into()],
            terminal: Some(TerminalConfig {
                args: Vec::new(),
                resume_args: Vec::new(),
            }),
            chat_args: None,
            sign_in_args: None,
            plugin_dir: Some(temp.path().canonicalize().unwrap()),
        };
        assert!(descriptor.command_spec(&[]).is_ok());
        fs::remove_file(temp.path().join("agent.mjs")).unwrap();
        assert!(descriptor.command_spec(&[]).is_err());
    }

    #[test]
    fn command_composition_expands_plugin_and_session_placeholders_without_spawning() {
        let temp = tempdir().unwrap();
        #[cfg(windows)]
        let executable = "runner.cmd";
        #[cfg(not(windows))]
        let executable = "runner";
        fs::write(temp.path().join(executable), "").unwrap();
        let descriptor = AgentDescriptor {
            id: "echo".into(),
            name: "Echo".into(),
            plugin_id: Some("echo-acp".into()),
            icon: None,
            homepage: None,
            command: format!("{{pluginDir}}/{executable}"),
            args: vec!["--base".into(), "--dir={pluginDir}".into()],
            version_args: vec!["--version".into()],
            terminal: Some(TerminalConfig {
                args: vec!["--terminal".into()],
                resume_args: vec!["--resume".into(), "{sessionId}".into()],
            }),
            chat_args: None,
            sign_in_args: None,
            plugin_dir: Some(temp.path().canonicalize().unwrap()),
        };
        let command = descriptor
            .terminal_command(Some("session-123"), None)
            .unwrap();
        assert!(command.args.ends_with(&[
            "--terminal".into(),
            "--resume".into(),
            "session-123".into()
        ]));
        assert!(command.args.iter().any(|arg| arg.starts_with("--dir=")));
        assert!(descriptor
            .terminal_command(Some("bad\nidentity"), None)
            .is_err());
    }

    #[test]
    fn windows_verbatim_paths_are_normalized_for_plugin_launches() {
        assert_eq!(
            display_windows_path(r"\\?\C:\plugins\echo\agent.mjs"),
            r"C:\plugins\echo\agent.mjs"
        );
        assert_eq!(
            display_windows_path(r"\\?\UNC\server\share\agent.mjs"),
            r"\\server\share\agent.mjs"
        );
        assert_eq!(display_windows_path(r"C:\plugins\echo"), r"C:\plugins\echo");
    }

    #[cfg(unix)]
    #[test]
    fn command_path_rejects_a_symlink_replaced_outside_the_plugin() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(temp.path().join("agent.mjs"), "").unwrap();
        fs::write(outside.path().join("outside.mjs"), "").unwrap();
        let descriptor = AgentDescriptor {
            id: "echo".into(),
            name: "Echo".into(),
            plugin_id: Some("echo-acp".into()),
            icon: None,
            homepage: None,
            command: "{pluginDir}/agent.mjs".into(),
            args: Vec::new(),
            version_args: vec!["--version".into()],
            terminal: Some(TerminalConfig {
                args: Vec::new(),
                resume_args: Vec::new(),
            }),
            chat_args: None,
            sign_in_args: None,
            plugin_dir: Some(temp.path().canonicalize().unwrap()),
        };
        fs::remove_file(temp.path().join("agent.mjs")).unwrap();
        symlink(
            outside.path().join("outside.mjs"),
            temp.path().join("agent.mjs"),
        )
        .unwrap();
        assert!(descriptor.command_spec(&[]).is_err());
    }

    #[test]
    fn disabled_user_plugin_is_known_but_not_contributed() {
        let root = tempdir().unwrap();
        let plugin = root.path().join("plugins").join("echo-acp");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join(MANIFEST), valid_manifest()).unwrap();
        fs::write(plugin.join("agent.mjs"), "").unwrap();
        fs::write(plugin.join("icon.svg"), "<svg/>").unwrap();
        let registry = PluginRegistry::discover_with_roots(root.path(), &Value::Null, &[]);
        assert!(registry.agents.iter().all(|agent| agent.id != "echo"));
        assert_eq!(registry.known_plugin("echo"), Some("echo-acp"));
    }

    #[test]
    fn enabled_user_plugin_contributes_and_collisions_are_rejected() {
        let root = tempdir().unwrap();
        for folder in ["first", "second"] {
            let plugin = root.path().join("plugins").join(folder);
            fs::create_dir_all(&plugin).unwrap();
            fs::write(plugin.join(MANIFEST), valid_manifest()).unwrap();
            fs::write(plugin.join("agent.mjs"), "").unwrap();
            fs::write(plugin.join("icon.svg"), "<svg/>").unwrap();
        }
        let settings = serde_json::json!({"plugins":{"echo-acp":{"enabled":true}}});
        let registry = PluginRegistry::discover_with_roots(root.path(), &settings, &[]);
        assert_eq!(
            registry
                .agents
                .iter()
                .filter(|agent| agent.id == "echo")
                .count(),
            1
        );
        assert!(registry
            .list
            .plugins
            .iter()
            .any(|plugin| !plugin.issues.is_empty()));
        assert!(registry
            .list
            .plugins
            .iter()
            .filter(|plugin| plugin.id == "echo-acp")
            .all(|plugin| plugin.enabled));
    }

    #[test]
    fn plugin_id_order_determines_agent_collision_winner() {
        let root = tempdir().unwrap();
        for (folder, id) in [("z-folder", "alpha"), ("a-folder", "beta")] {
            let plugin = root.path().join("plugins").join(folder);
            fs::create_dir_all(&plugin).unwrap();
            let manifest =
                valid_manifest().replace("\"id\":\"echo-acp\"", &format!("\"id\":\"{id}\""));
            fs::write(plugin.join(MANIFEST), manifest).unwrap();
            fs::write(plugin.join("agent.mjs"), "").unwrap();
            fs::write(plugin.join("icon.svg"), "<svg/>").unwrap();
        }
        let settings =
            serde_json::json!({"plugins":{"alpha":{"enabled":true},"beta":{"enabled":true}}});
        let registry = PluginRegistry::discover_with_roots(root.path(), &settings, &[]);
        assert_eq!(
            registry
                .agents
                .iter()
                .find(|agent| agent.id == "echo")
                .unwrap()
                .plugin_id
                .as_deref(),
            Some("alpha")
        );
        assert!(registry
            .list
            .plugins
            .iter()
            .find(|plugin| plugin.id == "beta")
            .unwrap()
            .issues
            .iter()
            .any(|issue| issue.contains("collides")));
    }
}
